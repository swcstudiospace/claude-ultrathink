// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Creates the tracker rows for a TrackPlan (Linear issues/sub-issues, Notion rows) through
 * MCP tool callers. Idempotent against `existing`, bounded by one budget signal, never throws.
 */
import type { ThoughtGraph } from "../think/types.ts";
import type { ProgressSink } from "../host/progress.ts";
import type { IssueRef, TrackingRefs, TrackPlan } from "./types.ts";

export interface ToolCaller {
	/** Resolves structuredContent, else JSON-parsed first text content, else the raw text; throws on isError/transport error. */
	call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export function stepKey(nodeId: string, step: number): string {
	return `${nodeId}.${step}`;
}

export interface CreateTrackingDeps {
	linear?: ToolCaller;
	notion?: ToolCaller;
	/** Linear team; unset = Linear not configured: no Linear calls, and its rows do not count toward `status`. */
	linearTeam?: string;
	/** Notion data source uuid, without the `collection://` prefix; unset = Notion not configured, like `linearTeam`. */
	notionDataSource?: string;
	concurrency: number;
	budgetMs: number;
	now?: () => number;
	log?: (message: string) => void;
	/** Receives a `track` event after every creation, adoption pass and failure; errors thrown by it are ignored. */
	progress?: ProgressSink;
}

const LINEAR_URL_RE = /https:\/\/linear\.app\/\S+?\/issue\/[A-Z][A-Z0-9]*-\d+[^\s"')\]]*/;
const IDENTIFIER_RE = /\b[A-Z][A-Z0-9]*-\d+\b/;
const NOTION_URL_RE = /https:\/\/(?:www\.)?notion\.(?:so|site)\/[^\s"')\]<>]+/g;
const NOTION_BATCH = 25;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toText(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

/** Pulls id/identifier/url out of a save_issue result; undefined when identifier or url is missing. */
export function extractIssueRef(result: unknown, title: string): IssueRef | undefined {
	let record = asRecord(result);
	if (!record && typeof result === "string") {
		try {
			record = asRecord(JSON.parse(result));
		} catch {
			record = undefined;
		}
	}
	const candidates = [record, asRecord(record?.issue)].filter((entry): entry is Record<string, unknown> => !!entry);
	let id: string | undefined;
	let identifier: string | undefined;
	let url: string | undefined;
	for (const candidate of candidates) {
		identifier ??= str(candidate.identifier);
		url ??= str(candidate.url);
		id ??= str(candidate.id);
	}
	const text = toText(result);
	url ??= text.match(LINEAR_URL_RE)?.[0];
	identifier ??= (url ?? "").match(IDENTIFIER_RE)?.[0] ?? text.match(IDENTIFIER_RE)?.[0];
	if (!identifier || !url) return undefined;
	return { id: id ?? identifier, identifier, url, title };
}

function shortError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim().slice(0, 160) || "error";
}

/** Races `promise` with the signal so a caller that ignores the signal cannot outlive the budget. */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("budget exhausted"));
	const { promise: raced, resolve, reject } = Promise.withResolvers<T>();
	const onAbort = () => reject(new Error("budget exhausted"));
	signal.addEventListener("abort", onAbort, { once: true });
	promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	return raced;
}

async function runPool<T>(items: T[], limit: number, signal: AbortSignal, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length && !signal.aborted) {
			const item = items[next++] as T;
			await work(item);
		}
	};
	const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
	await Promise.all(Array.from({ length: size }, worker));
}

function footer(graphId: string, nodeId: string, step?: number): string {
	return `ultrathink graph ${graphId} · node ${nodeId}${step === undefined ? "" : ` · step ${step}`}`;
}

/** Dependency levels for the plan's nodes (graph order when no graph). */
function nodeLevels(nodeIds: string[], graph: ThoughtGraph | undefined): string[][] {
	const inPlan = new Set(nodeIds);
	const deps = new Map<string, string[]>();
	for (const node of graph?.nodes ?? []) deps.set(node.id, node.dependsOn.filter((dep) => inPlan.has(dep) && dep !== node.id));
	const level = new Map<string, number>();
	const visiting = new Set<string>();
	const depth = (id: string): number => {
		const known = level.get(id);
		if (known !== undefined) return known;
		if (visiting.has(id)) return 0;
		visiting.add(id);
		const value = Math.max(-1, ...(deps.get(id) ?? []).map(depth)) + 1;
		visiting.delete(id);
		level.set(id, value);
		return value;
	};
	const levels: string[][] = [];
	for (const id of nodeIds) (levels[depth(id)] ??= []).push(id);
	return levels.filter((entry) => entry.length > 0);
}

/** Property names every ultrathink Agent Task Graph data source has; a parsed schema without them was not understood. */
const CORE_PROPERTIES = ["Item", "Level", "Graph ID"] as const;

function collectSchemaNames(result: unknown): Set<string> {
	const names = new Set<string>();
	const texts: string[] = [];
	const walk = (value: unknown, depth: number): void => {
		if (depth > 8) return;
		if (typeof value === "string") {
			texts.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) walk(entry, depth + 1);
			return;
		}
		const record = asRecord(value);
		if (!record) return;
		for (const [key, child] of Object.entries(record)) {
			if (key === "properties" || key === "schema") {
				const props = asRecord(child);
				if (props) for (const name of Object.keys(props)) names.add(name);
				if (Array.isArray(child)) {
					for (const entry of child) {
						const name = str(asRecord(entry)?.name);
						if (name) names.add(name);
					}
				}
			}
			walk(child, depth + 1);
		}
	};
	walk(result, 0);
	// A text payload carries the schema as JSON inside markup, e.g. `{ text: "…<data-source-state>{…}</data-source-state>…" }`.
	// Scan each string leaf itself: stringifying the whole result would escape the quotes the patterns rely on.
	for (const text of [...texts]) {
		for (const match of text.matchAll(/"([^"\\\n]{1,80})"\s*:\s*\{[^{}]*?"type"\s*:/g)) names.add(match[1] as string);
		const blocks = [...text.matchAll(/<([\w-]+)>\s*(\{[\s\S]*?\})\s*<\/\1>/g)].map((match) => match[2] as string);
		for (const block of [...blocks, ...(text.match(/\{[\s\S]*\}/g) ?? [])]) {
			try {
				walk(JSON.parse(block), 0);
			} catch {
				// not JSON
			}
		}
	}
	names.delete("type");
	return names;
}

function notionUrls(result: unknown): string[] {
	const record = asRecord(result);
	const structured = Array.isArray(result) ? result : Array.isArray(record?.pages) ? (record.pages as unknown[]) : undefined;
	if (structured && structured.length > 0) {
		const urls = structured.map((entry) => str(asRecord(entry)?.url));
		if (urls.every((url) => url !== undefined)) return urls as string[];
	}
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const match of toText(result).matchAll(NOTION_URL_RE)) {
		const url = match[0].replace(/[.,;]+$/, "");
		if (seen.has(url)) continue;
		seen.add(url);
		urls.push(url);
	}
	return urls;
}

/** Finds the first array of records in a list-style result: array, or {issues|nodes|results|rows|pages: [...]}. */
function listEntries(result: unknown): Record<string, unknown>[] {
	let value = result;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return [];
		}
	}
	const record = asRecord(value);
	const list = Array.isArray(value)
		? value
		: (["issues", "nodes", "results", "rows", "pages", "data"].map((key) => record?.[key]).find(Array.isArray) as unknown[] | undefined);
	return (list ?? []).map(asRecord).filter((entry): entry is Record<string, unknown> => !!entry);
}

type IssueEmitter = (
	provider: "linear" | "notion",
	nodeId: string,
	step: number | undefined,
	ref: { identifier?: string; url: string },
) => void;

/** Re-run only: adopts Linear issues already carrying this graph's description footer. Non-fatal. */
async function adoptLinear(
	plan: TrackPlan,
	refs: TrackingRefs,
	linear: ToolCaller,
	signal: AbortSignal,
	emitIssue: IssueEmitter,
): Promise<void> {
	const result = await withSignal(linear.call("list_issues", { query: `ultrathink graph ${plan.graphId}`, limit: 250 }, signal), signal);
	const graphPattern = plan.graphId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`ultrathink graph ${graphPattern} · node (\\S+?)(?: · step (\\d+))?\\s*$`, "m");
	for (const issue of listEntries(result)) {
		const match = str(issue.description)?.match(re);
		if (!match) continue;
		const nodeId = match[1] as string;
		const title = str(issue.title) ?? "";
		const ref = extractIssueRef(issue, title);
		if (!ref) continue;
		if (match[2] === undefined) {
			if (refs.linear.nodes[nodeId]) continue;
			refs.linear.nodes[nodeId] = ref;
			emitIssue("linear", nodeId, undefined, ref);
		} else {
			const step = Number(match[2]);
			const key = stepKey(nodeId, step);
			if (refs.linear.steps[key]) continue;
			refs.linear.steps[key] = ref;
			emitIssue("linear", nodeId, step, ref);
		}
	}
}

/** Re-run only: adopts Notion rows already tagged with this graph's Graph ID. Non-fatal. */
async function adoptNotion(plan: TrackPlan, refs: TrackingRefs, notion: ToolCaller, dataSource: string, signal: AbortSignal): Promise<void> {
	const collection = `collection://${dataSource}`;
	const result = await withSignal(
		notion.call(
			"notion-query-data-sources",
			{
				data: {
					data_source_urls: [collection],
					query: `SELECT url, "Level", "Item", "Step" FROM "${collection}" WHERE "Graph ID" = ?`,
					params: [plan.graphId],
				},
			},
			signal,
		),
		signal,
	);
	for (const row of listEntries(result)) {
		const url = str(row.url);
		const level = str(row.Level);
		if (!url || !level) continue;
		if (level === "Task") {
			refs.notion.taskUrl ??= url;
			continue;
		}
		const nodeId = str(row.Item)?.match(/^\[([^\]]+)\]/)?.[1];
		if (!nodeId) continue;
		if (level === "Issue") refs.notion.nodes[nodeId] ??= url;
		else if (level === "Sub-Issue") {
			const step = Number(row.Step);
			if (Number.isFinite(step)) refs.notion.steps[stepKey(nodeId, step)] ??= url;
		}
	}
}

export async function createTracking(
	plan: TrackPlan,
	graph: ThoughtGraph | undefined,
	existing: TrackingRefs | undefined,
	deps: CreateTrackingDeps,
): Promise<TrackingRefs> {
	const now = deps.now ?? Date.now;
	const refs: TrackingRefs = {
		graphId: plan.graphId,
		status: "failed",
		...(deps.linearTeam ? { linearTeam: deps.linearTeam } : {}),
		linear: { nodes: { ...existing?.linear.nodes }, steps: { ...existing?.linear.steps } },
		notion: { taskUrl: existing?.notion.taskUrl, nodes: { ...existing?.notion.nodes }, steps: { ...existing?.notion.steps } },
		errors: [],
		updatedAt: now(),
	};
	if (refs.notion.taskUrl === undefined) delete refs.notion.taskUrl;
	const controller = new AbortController();
	const signal = controller.signal;
	const timer = setTimeout(() => controller.abort(), Math.max(0, deps.budgetMs));
	const emit = (error?: string) => {
		if (!deps.progress) return;
		try {
			deps.progress({
				type: "track",
				at: Date.now(),
				...(deps.linearTeam
					? {
							linear: {
								nodes: [Object.keys(refs.linear.nodes).length, plan.linearIssues.length],
								steps: [Object.keys(refs.linear.steps).length, plan.linearSubIssues.length],
							},
						}
					: {}),
				...(deps.notionDataSource
					? {
							notion: {
								task: !!refs.notion.taskUrl,
								nodes: [Object.keys(refs.notion.nodes).length, plan.issues.length],
								steps: [Object.keys(refs.notion.steps).length, plan.subIssues.length],
							},
						}
					: {}),
				...(error === undefined ? {} : { error }),
			});
		} catch {
			// a broken progress sink must never affect tracking
		}
	};
	const emitIssue: IssueEmitter = (provider, nodeId, step, ref) => {
		if (!deps.progress) return;
		try {
			deps.progress({
				type: "issue",
				at: Date.now(),
				provider,
				nodeId,
				...(step === undefined ? {} : { step }),
				...(ref.identifier === undefined ? {} : { identifier: ref.identifier }),
				url: ref.url,
			});
		} catch {
			// a broken progress sink must never affect tracking
		}
	};
	const fail = (message: string) => {
		refs.errors.push(message);
		deps.log?.(message);
		emit(message);
	};
	try {
		if (existing) {
			if (deps.linear && deps.linearTeam) await adoptLinear(plan, refs, deps.linear, signal, emitIssue).catch(() => undefined);
			if (deps.notion && deps.notionDataSource) await adoptNotion(plan, refs, deps.notion, deps.notionDataSource, signal).catch(() => undefined);
			emit();
		}
		if (deps.linearTeam) await createLinear(plan, graph, refs, deps, signal, fail, emit, emitIssue);
		if (deps.notionDataSource) await createNotion(plan, refs, deps, signal, fail, emit, emitIssue);
	} catch (error) {
		fail(`tracking: ${shortError(error)}`);
	} finally {
		clearTimeout(timer);
	}
	if (signal.aborted) fail("tracking: budget exhausted");
	refs.status = trackingStatus(plan, refs, !!deps.linearTeam, !!deps.notionDataSource);
	refs.updatedAt = now();
	return refs;
}

/** Unconfigured providers count as done: their rows are never created, so they are not missing. */
function trackingStatus(plan: TrackPlan, refs: TrackingRefs, linearConfigured: boolean, notionConfigured: boolean): TrackingRefs["status"] {
	const linearDone =
		!linearConfigured ||
		(plan.linearIssues.every((issue) => refs.linear.nodes[issue.nodeId]) &&
			plan.linearSubIssues.every((sub) => refs.linear.steps[stepKey(sub.nodeId, sub.step)]));
	const notionDone =
		!notionConfigured ||
		(!!refs.notion.taskUrl &&
			plan.issues.every((row) => refs.notion.nodes[row.nodeId]) &&
			plan.subIssues.every((row) => refs.notion.steps[stepKey(row.nodeId, row.step)]));
	if (linearDone && notionDone) return "complete";
	const any =
		Object.keys(refs.linear.nodes).length +
		Object.keys(refs.linear.steps).length +
		Object.keys(refs.notion.nodes).length +
		Object.keys(refs.notion.steps).length +
		(refs.notion.taskUrl ? 1 : 0);
	return any > 0 ? "partial" : "failed";
}

async function createLinear(
	plan: TrackPlan,
	graph: ThoughtGraph | undefined,
	refs: TrackingRefs,
	deps: CreateTrackingDeps,
	signal: AbortSignal,
	fail: (message: string) => void,
	emit: () => void,
	emitIssue: IssueEmitter,
): Promise<void> {
	const pendingNodes = plan.linearIssues.filter((issue) => !refs.linear.nodes[issue.nodeId]);
	const pendingSteps = plan.linearSubIssues.filter((sub) => !refs.linear.steps[stepKey(sub.nodeId, sub.step)]);
	if (pendingNodes.length === 0 && pendingSteps.length === 0) return;
	const linear = deps.linear;
	if (!linear) {
		fail("linear: login required");
		return;
	}
	const byNode = new Map(plan.linearIssues.map((issue) => [issue.nodeId, issue]));
	const dependsOn = new Map((graph?.nodes ?? []).map((node) => [node.id, node.dependsOn.filter((dep) => dep !== node.id && byNode.has(dep))]));
	const save = async (label: string, title: string, args: Record<string, unknown>): Promise<IssueRef | undefined> => {
		try {
			const result = await withSignal(linear.call("save_issue", args, signal), signal);
			const ref = extractIssueRef(result, title);
			if (!ref) fail(`linear ${label}: no identifier in result`);
			return ref;
		} catch (error) {
			fail(`linear ${label}: ${shortError(error)}`);
			return undefined;
		}
	};

	for (const level of nodeLevels(plan.linearIssues.map((issue) => issue.nodeId), graph)) {
		if (signal.aborted) return;
		const todo = level.filter((id) => !refs.linear.nodes[id]);
		await runPool(todo, deps.concurrency, signal, async (nodeId) => {
			const issue = byNode.get(nodeId);
			if (!issue) return;
			const title = issue.title.startsWith(`[${nodeId}]`) ? issue.title : `[${nodeId}] ${issue.title}`;
			const nodeDeps = dependsOn.get(nodeId) ?? [];
			if (nodeDeps.some((dep) => !refs.linear.nodes[dep])) {
				fail(`linear ${nodeId}: dependency missing`);
				return;
			}
			const blockedBy = nodeDeps.map((dep) => (refs.linear.nodes[dep] as IssueRef).identifier);
			const args: Record<string, unknown> = {
				team: deps.linearTeam,
				title,
				description: `${issue.description}\n\n${footer(plan.graphId, nodeId)}`,
			};
			if (blockedBy.length > 0) args.blockedBy = blockedBy;
			const ref = await save(nodeId, title, args);
			if (ref) {
				refs.linear.nodes[nodeId] = ref;
				emitIssue("linear", nodeId, undefined, ref);
				emit();
			}
		});
	}

	const steps = plan.linearSubIssues.filter((sub) => {
		if (refs.linear.steps[stepKey(sub.nodeId, sub.step)]) return false;
		if (refs.linear.nodes[sub.nodeId]) return true;
		fail(`linear ${stepKey(sub.nodeId, sub.step)}: parent missing`);
		return false;
	});
	await runPool(steps, deps.concurrency, signal, async (sub) => {
		const key = stepKey(sub.nodeId, sub.step);
		const parent = refs.linear.nodes[sub.nodeId] as IssueRef;
		const ref = await save(key, sub.title, {
			team: deps.linearTeam,
			title: sub.title,
			description: `${sub.description}\n\n${footer(plan.graphId, sub.nodeId, sub.step)}`,
			parentId: parent.identifier,
		});
		if (ref) {
			refs.linear.steps[key] = ref;
			emitIssue("linear", sub.nodeId, sub.step, ref);
			emit();
		}
	});
}

async function createNotion(
	plan: TrackPlan,
	refs: TrackingRefs,
	deps: CreateTrackingDeps,
	signal: AbortSignal,
	fail: (message: string) => void,
	emit: () => void,
	emitIssue: IssueEmitter,
): Promise<void> {
	const nodeRows = plan.issues.filter((row) => !refs.notion.nodes[row.nodeId]);
	const stepRows = plan.subIssues.filter((row) => !refs.notion.steps[stepKey(row.nodeId, row.step)]);
	if (refs.notion.taskUrl && nodeRows.length === 0 && stepRows.length === 0) return;
	const notion = deps.notion;
	if (!notion) {
		fail("notion: login required");
		return;
	}
	if (signal.aborted) return;
	const call = (name: string, args: Record<string, unknown>) => withSignal(notion.call(name, args, signal), signal);

	let names: Set<string>;
	try {
		names = collectSchemaNames(await call("notion-fetch", { id: `collection://${deps.notionDataSource}` }));
	} catch (error) {
		fail(`notion schema: ${shortError(error)}`);
		return;
	}
	// A schema read that misses the core names was not understood; sending only recognised names would then create empty rows.
	// Send the core names anyway, so a truly different data source fails loudly instead.
	if (!CORE_PROPERTIES.every((name) => names.has(name))) for (const name of CORE_PROPERTIES) names.add(name);
	const props = (values: Record<string, string | number | undefined>): Record<string, unknown> => {
		const out: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(values)) {
			if (value === undefined || value === "" || !names.has(name)) continue;
			out[name] = value;
		}
		return out;
	};
	const create = async (label: string, pages: Array<{ properties: Record<string, unknown>; content?: string }>): Promise<string[] | undefined> => {
		try {
			const urls = notionUrls(
				await call("notion-create-pages", { parent: { data_source_id: deps.notionDataSource }, pages, allow_async: false }),
			);
			if (urls.length !== pages.length) {
				fail(`notion ${label}: expected ${pages.length} page urls, got ${urls.length}`);
				return undefined;
			}
			return urls;
		} catch (error) {
			fail(`notion ${label}: ${shortError(error)}`);
			return undefined;
		}
	};
	const { task } = plan;

	if (!refs.notion.taskUrl) {
		const urls = await create("task", [
			{
				properties: props({
					Item: task.item,
					Level: "Task",
					Description: task.description,
					"Uplifted Prompt": task.upliftedPrompt,
					Agent: task.agent,
					Status: task.status,
					"Linear State": task.linearState,
					Repo: task.repo,
					Branch: task.branch,
					"Graph ID": plan.graphId,
				}),
			},
		]);
		if (!urls) return;
		refs.notion.taskUrl = urls[0];
		emit();
	}
	const taskUrl = refs.notion.taskUrl as string;

	if (nodeRows.length > 0 && !signal.aborted) {
		const pages = nodeRows.map((row) => {
			const linear = refs.linear.nodes[row.nodeId];
			return {
				properties: props({
					Item: row.item,
					Level: "Issue",
					Agent: task.agent,
					Status: task.status,
					"Linear State": task.linearState,
					"Graph ID": plan.graphId,
					Thought: row.thought,
					"Parent Item": JSON.stringify([taskUrl]),
					"Linear URL": linear?.url,
					"Issue ID": linear?.identifier,
				}),
			};
		});
		const urls = await create("nodes", pages);
		if (urls) {
			nodeRows.forEach((row, index) => {
				const url = urls[index] as string;
				refs.notion.nodes[row.nodeId] = url;
				emitIssue("notion", row.nodeId, undefined, { url });
			});
			emit();
		}
	}

	const ready = stepRows.filter((row) => {
		if (refs.notion.nodes[row.nodeId]) return true;
		fail(`notion ${stepKey(row.nodeId, row.step)}: parent missing`);
		return false;
	});
	const batches: (typeof ready)[] = [];
	for (let index = 0; index < ready.length; index += NOTION_BATCH) batches.push(ready.slice(index, index + NOTION_BATCH));
	await runPool(batches, deps.concurrency, signal, async (batch) => {
		const pages = batch.map((row) => {
			const linear = refs.linear.steps[stepKey(row.nodeId, row.step)];
			return {
				properties: props({
					Item: row.item,
					Level: "Sub-Issue",
					Agent: task.agent,
					Status: task.status,
					"Linear State": task.linearState,
					"Graph ID": plan.graphId,
					Thought: row.thought,
					Step: row.step,
					"Parent Item": JSON.stringify([refs.notion.nodes[row.nodeId]]),
					"Linear URL": linear?.url,
					"Issue ID": linear?.identifier,
				}),
			};
		});
		const first = batch[0] as (typeof ready)[number];
		const urls = await create(`steps ${stepKey(first.nodeId, first.step)}+`, pages);
		if (urls) {
			batch.forEach((row, index) => {
				const url = urls[index] as string;
				refs.notion.steps[stepKey(row.nodeId, row.step)] = url;
				emitIssue("notion", row.nodeId, row.step, { url });
			});
			emit();
		}
	});
}
