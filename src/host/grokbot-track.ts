// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Grok Bot tracker bridge. Desk Lead writes Linear/Notion rows through its own connectors, which a Bun process cannot
 * call. So the plugin's real `createTracking` runs against *recording* tool callers: every `save_issue`,
 * `notion-fetch` and `notion-create-pages` call it would make is captured in order, with placeholder refs
 * (`PEND-<n>` identifiers, `https://www.notion.so/pending-<n>` pages) standing in for created rows. Desk Lead executes
 * the calls in order, substituting each placeholder with the real ref an earlier call returned, then `recordRefs`
 * writes the real refs back into the SessionRecord and re-renders `<ISSUES>` in the spec, exactly as
 * `ultrathink-mcp track complete` does.
 *
 * Desk addition: every Linear create carries `project` (default "Kanban"); the plugin has no project setting.
 */
import { readFileSync } from "node:fs";
import type { SessionRecord } from "../claude/state.ts";
import { withFileLock, writeFileAtomic } from "../claude/atomic.ts";
import { createTracking, type ToolCaller } from "../track/create.ts";
import { formatTrackingTodos, injectTrackingXml } from "../track/render.ts";
import { mirrorLast } from "./grokbot-hitl.ts";
import type { IssueRef, TrackingRefs } from "../track/types.ts";

/** Notion Agent Task Graph columns (docs/tracking.md); the dry run reports every one so no property is dropped. */
export const NOTION_COLUMNS = [
	"Item", "Level", "Status", "Linear State", "Graph ID", "Description", "Uplifted Prompt", "Agent", "Thought", "Step",
	"Linear URL", "Issue ID", "Repo", "Branch", "PR URL", "PR #", "PR State", "Checks", "Reviewers", "Completed", "Parent Item", "Sub-Items",
] as const;

export interface RecordedCall {
	seq: number;
	provider: "linear" | "notion";
	tool: string;
	args: Record<string, unknown>;
	/** Placeholders this call's result defines (Linear: one PEND-n; Notion: one per page, in order). */
	defines: string[];
	/** Graph keys the defined placeholders stand for: `n3` (issue), `n3.2` (sub-issue), `task`. */
	keys: string[];
}

export interface TrackPayloads {
	graphId: string;
	linearTeam?: string;
	project?: string;
	notionDataSource?: string;
	calls: RecordedCall[];
	counts: { linearIssues: number; linearSubIssues: number; notionTask: number; notionIssues: number; notionSubIssues: number };
}

const FOOTER_RE = /ultrathink graph \S+ · node (\S+?)(?: · step (\d+))?$/m;

export async function buildTrackPayloads(
	record: SessionRecord,
	options: { linearTeam?: string; notionDataSource?: string; project?: string; agent?: string },
): Promise<TrackPayloads> {
	const recorded = record.plan;
	if (!recorded) throw new Error("session record has no plan");
	// The adapter plans under the prime-agent engine family; the Notion Agent column names the real caller.
	const plan = options.agent ? { ...recorded, task: { ...recorded.task, agent: options.agent } } : recorded;
	const calls: RecordedCall[] = [];
	let linearSeq = 0;
	let notionSeq = 0;
	const linear: ToolCaller = {
		async call(name, args) {
			const seq = calls.length + 1;
			if (name !== "save_issue") {
				calls.push({ seq, provider: "linear", tool: name, args, defines: [], keys: [] });
				return { issues: [] };
			}
			const id = `PEND-${++linearSeq}`;
			const description = typeof args.description === "string" ? args.description : "";
			const match = description.match(FOOTER_RE);
			const key = match ? (match[2] ? `${match[1]}.${match[2]}` : (match[1] as string)) : `?${linearSeq}`;
			const withProject = options.project ? { ...args, project: options.project } : args;
			calls.push({ seq, provider: "linear", tool: name, args: withProject, defines: [id], keys: [key] });
			return { id, identifier: id, url: `https://linear.app/pending/issue/${id}/pending` };
		},
	};
	const notion: ToolCaller = {
		async call(name, args) {
			const seq = calls.length + 1;
			if (name === "notion-fetch") {
				calls.push({ seq, provider: "notion", tool: name, args, defines: [], keys: [] });
				return { properties: Object.fromEntries(NOTION_COLUMNS.map((column) => [column, { type: "rich_text" }])) };
			}
			if (name === "notion-create-pages") {
				const pages = Array.isArray(args.pages) ? (args.pages as Array<{ properties?: Record<string, unknown> }>) : [];
				const urls: string[] = [];
				const keys: string[] = [];
				for (const page of pages) {
					urls.push(`https://www.notion.so/pending-${++notionSeq}`);
					const props = page.properties ?? {};
					const level = String(props.Level ?? "");
					const step = props.Step;
					keys.push(level === "Task" ? "task" : `${String(props.Item ?? "").match(/^\[(n\d+)\]/)?.[1] ?? "?"}${level === "Sub-Issue" && step !== undefined ? `.${String(step)}` : ""}`);
				}
				calls.push({ seq, provider: "notion", tool: name, args, defines: urls, keys });
				return { pages: urls.map((url) => ({ url })) };
			}
			calls.push({ seq, provider: "notion", tool: name, args, defines: [], keys: [] });
			return {};
		},
	};
	await createTracking(plan, record.graph, record.tracking, {
		linear,
		notion,
		...(options.linearTeam ? { linearTeam: options.linearTeam } : {}),
		...(options.notionDataSource ? { notionDataSource: options.notionDataSource.replace(/^collection:\/\//, "") } : {}),
		concurrency: 1,
		budgetMs: 600_000,
	});
	const emitted = calls.filter((call) => call.tool === "save_issue" || call.tool === "notion-create-pages" || call.tool === "notion-fetch");
	const created = (provider: "linear" | "notion", tool: string) => emitted.filter((c) => c.provider === provider && c.tool === tool);
	const linearCreates = created("linear", "save_issue");
	const notionKeys = created("notion", "notion-create-pages").flatMap((c) => c.keys);
	return {
		graphId: plan.graphId,
		...(options.linearTeam ? { linearTeam: options.linearTeam } : {}),
		...(options.project ? { project: options.project } : {}),
		...(options.notionDataSource ? { notionDataSource: options.notionDataSource } : {}),
		calls: emitted,
		counts: {
			linearIssues: linearCreates.filter((c) => !c.keys[0]?.includes(".")).length,
			linearSubIssues: linearCreates.filter((c) => c.keys[0]?.includes(".")).length,
			notionTask: notionKeys.filter((k) => k === "task").length,
			notionIssues: notionKeys.filter((k) => k !== "task" && !k.includes(".")).length,
			notionSubIssues: notionKeys.filter((k) => k.includes(".")).length,
		},
	};
}

export interface RealRefs {
	/** Graph key (`n1`, `n1.3`) → the Linear issue Desk Lead created. */
	linear?: Record<string, IssueRef>;
	/** Graph key (`task`, `n1`, `n1.3`) → Notion page URL. */
	notion?: Record<string, string>;
	errors?: string[];
	/** Which trackers this kickoff was asked to fill. An omitted tracker counts as done. Absent means both. */
	trackers?: { linear?: boolean; notion?: boolean };
}

/** Writes real refs into the record's tracking and re-renders the spec, like `ultrathink-mcp track complete`. */
export function recordRefs(statePath: string, refs: RealRefs, now = Date.now()): { tracking: TrackingRefs; todos: string } {
	return withFileLock(statePath, () => {
		const record = JSON.parse(readFileSync(statePath, "utf8")) as SessionRecord;
		const plan = record.plan;
		if (!plan) throw new Error("session record has no plan");
		const previous = record.tracking;
		const tracking: TrackingRefs = {
			graphId: plan.graphId,
			status: "failed",
			...(previous?.linearTeam ? { linearTeam: previous.linearTeam } : {}),
			linear: { nodes: { ...previous?.linear.nodes }, steps: { ...previous?.linear.steps } },
			notion: { ...(previous?.notion.taskUrl ? { taskUrl: previous.notion.taskUrl } : {}), nodes: { ...previous?.notion.nodes }, steps: { ...previous?.notion.steps } },
			errors: [...(refs.errors ?? [])],
			updatedAt: now,
		};
		for (const [key, ref] of Object.entries(refs.linear ?? {})) {
			if (key.includes(".")) tracking.linear.steps[key] = ref;
			else tracking.linear.nodes[key] = ref;
		}
		for (const [key, url] of Object.entries(refs.notion ?? {})) {
			if (key === "task") tracking.notion.taskUrl = url;
			else if (key.includes(".")) tracking.notion.steps[key] = url;
			else tracking.notion.nodes[key] = url;
		}
		const linearConfigured = refs.trackers ? refs.trackers.linear === true : true;
		const notionConfigured = refs.trackers ? refs.trackers.notion === true : true;
		const linearDone = !linearConfigured || (plan.linearIssues.every((i) => tracking.linear.nodes[i.nodeId]) && plan.linearSubIssues.every((s) => tracking.linear.steps[`${s.nodeId}.${s.step}`]));
		const notionDone = !notionConfigured || (!!tracking.notion.taskUrl && plan.issues.every((r) => tracking.notion.nodes[r.nodeId]) && plan.subIssues.every((r) => tracking.notion.steps[`${r.nodeId}.${r.step}`]));
		const any = Object.keys(tracking.linear.nodes).length + Object.keys(tracking.notion.nodes).length + (tracking.notion.taskUrl ? 1 : 0);
		tracking.status = linearDone && notionDone ? "complete" : any > 0 ? "partial" : "failed";
		record.tracking = tracking;
		const xml = injectTrackingXml(record.result.xml, plan, tracking);
		record.result = { ...record.result, xml };
		writeFileAtomic(statePath, `${JSON.stringify(record, null, 2)}\n`);
		writeFileAtomic(statePath.replace(/\.json$/, ".xml"), xml);
		mirrorLast(statePath, record);
		return { tracking, todos: formatTrackingTodos(plan, tracking) };
	});
}

/**
 * The upstream kickoff skill's optional `graph_register` call (Agent Substrate), built from the tracking refs with absent
 * fields left out. Desk Lead sends it through its desk gateway (`desk_graph_register`). `nodes`/`steps` are omitted
 * unless asked for: the desk gateway currently rejects them (see FULL-REVIEW.md), and the call is idempotent by graph_id.
 */
export function graphRegisterPayload(record: SessionRecord, options: { surface?: string; withNodes?: boolean } = {}): Record<string, unknown> {
	const plan = record.plan;
	if (!plan) throw new Error("session record has no plan");
	const t = record.tracking;
	const task = plan.task as { repo?: string; branch?: string; status?: string };
	const payload: Record<string, unknown> = { graph_id: plan.graphId, surface: options.surface ?? "grok-bot" };
	if (t?.notion.taskUrl) payload.notion_task_page = t.notion.taskUrl;
	if (task.repo) payload.repo = task.repo;
	if (task.branch) payload.branch = task.branch;
	if (task.status) payload.status = task.status;
	if (options.withNodes && t) {
		const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));
		payload.nodes = plan.issues.map((issue) => {
			const ref = t.linear.nodes[issue.nodeId];
			return clean({ node_id: issue.nodeId, linear_issue_id: ref?.id, linear_identifier: ref?.identifier, linear_url: ref?.url, notion_page: t.notion.nodes[issue.nodeId] });
		});
		payload.steps = plan.subIssues.map((sub) => {
			const key = `${sub.nodeId}.${sub.step}`;
			const ref = t.linear.steps[key];
			return clean({ node_id: sub.nodeId, step: sub.step, linear_sub_issue_id: ref?.id, linear_identifier: ref?.identifier, linear_url: ref?.url, notion_page: t.notion.steps[key] });
		});
	}
	return payload;
}
