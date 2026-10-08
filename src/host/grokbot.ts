// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Grok Bot (Desk Lead) native host adapter.
 *
 * The planner's orchestration (`planPrompt` → `runPromptSubmit`) runs unchanged. The one thing swapped is the completer:
 * instead of shelling out to a CLI model, every completion request is written to a journal as a *pending request*
 * (the plugin's own system prompt verbatim + the user payload) and the run is cancelled cleanly at the next stage
 * boundary through the flight's AbortSignal (no fallback, no degraded output, no state write). The host model (Desk Lead)
 * answers the request by following that system prompt exactly; the answer is validated with the plugin's own parsers
 * plus strict desk checks, stored, and the run is resumed. Answered requests replay from the journal, so a resume
 * reaches the next unanswered request. Jev (OpenRouter Decisions) responses are journalled too, so resumes are
 * deterministic and never pay twice.
 *
 * Additive only: no HostId is added (the discovery contract pins `grok-bot` as an external integration); the adapter
 * plans under the no-hook `prime-agent` engine family with its own state directory, and labels its resolution
 * `host:grok-bot`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CLARIFY_SYSTEM_PROMPT } from "../hitl/prompts.ts";
import { normalizeClarifications } from "../hitl/pipeline.ts";
import { sessionPath, type SessionRecord } from "../claude/state.ts";
import { DISTILL_SYSTEM } from "../teach/observe.ts";
import { extractJsonObject, isFallbackGraph, normalizeGraph, parseNodeFill } from "../think/graph.ts";
import { COT_SYSTEM_PROMPT, GRAPH_SYSTEM_PROMPT } from "../think/prompts.ts";
import { MAX_NODES, MAX_RATIONALE_CHARS, MAX_STEPS, MIN_NODES, MIN_STEPS, type ThoughtNode } from "../think/types.ts";
import { nodeStepTitles, splitRationaleSteps } from "../track/plan.ts";
import { UPLIFT_SYSTEM_PROMPT } from "../uplift/prompt.ts";
import { escapeXml, sanitizeUpliftXml } from "../uplift/xml.ts";
import type { ModelResolution, SelectedEngine } from "./engine.ts";
import { type PlanResponse, planPrompt } from "./plan.ts";

export const GROKBOT_LABEL = "host:grok-bot";
/** The no-hook engine family the adapter plans under (state dir is always explicit). */
export const GROKBOT_ENGINE_HOST = "prime-agent" as const;
export const DENSITY_BAND: Readonly<Record<string, readonly [number, number]>> = {
	BUILD_PROMPT: [40, 64],
	CHANGE_PROMPT: [40, 64],
};
const MAX_ANSWER_CHARS = 200_000;
const ROOTS = ["BUILD_PROMPT", "FIX_PROMPT", "RESEARCH_PROMPT", "CHANGE_PROMPT", "UPLIFTED_PROMPT"];
const REQUIRED_SECTIONS = [["SYSTEM_ROLE"], ["CONTEXT", "APP_CONTEXT"], ["SCOPE"], ["CONSTRAINTS"], ["ACCEPTANCE_CRITERIA"], ["OUT_OF_SCOPE"]];

export function grokbotStateDir(env: Record<string, string | undefined> = process.env): string {
	const override = env.ULTRATHINK_STATE_DIR?.trim();
	if (override) return override;
	const base = env.XDG_STATE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "state");
	return join(base, "ultrathink-grokbot");
}

/** The resolution record every grok-bot plan carries: the host model, never a CLI or wire model. */
export function hostResolution(): ModelResolution {
	return {
		version: "1.0.0",
		state: "override",
		host: GROKBOT_ENGINE_HOST,
		source: "host-override",
		reason: "explicit-model",
		engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
		modelKnown: false,
		label: GROKBOT_LABEL,
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Journal

export type Stage = "uplift" | "graph" | "cot" | "clarify" | "distill" | "other";

export interface PendingRequest {
	key: string;
	stage: Stage;
	nodeId?: string;
	nodeKind?: string;
	nodeTitle?: string;
	system: string;
	user: string;
	createdAt: number;
}

export interface JournalMeta {
	sessionId: string;
	original?: string;
	cwd?: string;
	transcriptPath?: string;
	status?: "needs-model" | "planned" | "skipped" | "invalid";
	deepened?: boolean;
	updatedAt?: number;
}

export function sanitizeId(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

export function journalDir(stateDir: string, sessionId: string): string {
	return join(stateDir, "journal", sanitizeId(sessionId));
}

export function requestKey(system: string, user: string): string {
	return createHash("sha256").update(system).update("\u0000").update(user).digest("hex").slice(0, 32);
}

function writeAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, path);
}

export function readMeta(dir: string): JournalMeta | undefined {
	try {
		return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as JournalMeta;
	} catch {
		return undefined;
	}
}

export function writeMeta(dir: string, meta: JournalMeta): void {
	writeAtomic(join(dir, "meta.json"), `${JSON.stringify({ ...meta, updatedAt: Date.now() }, null, 2)}\n`);
}

export function stageOf(system: string): Stage {
	if (system === UPLIFT_SYSTEM_PROMPT) return "uplift";
	if (system === GRAPH_SYSTEM_PROMPT) return "graph";
	if (system === COT_SYSTEM_PROMPT) return "cot";
	if (system.startsWith(CLARIFY_SYSTEM_PROMPT.slice(0, 48))) return "clarify";
	if (system === DISTILL_SYSTEM) return "distill";
	return "other";
}

const CURRENT_NODE_RE = /<current_node id="([^"]+)" kind="([^"]+)" title="([^"]*)">/;

export function describeRequest(system: string, user: string, now = Date.now()): PendingRequest {
	const stage = stageOf(system);
	const request: PendingRequest = { key: requestKey(system, user), stage, system, user, createdAt: now };
	if (stage === "cot") {
		const match = user.match(CURRENT_NODE_RE);
		if (match) {
			request.nodeId = match[1];
			request.nodeKind = match[2];
			request.nodeTitle = match[3];
		}
	}
	return request;
}

export function listPending(dir: string): PendingRequest[] {
	const folder = join(dir, "pending");
	if (!existsSync(folder)) return [];
	return readdirSync(folder)
		.filter((name) => name.endsWith(".json"))
		.map((name) => JSON.parse(readFileSync(join(folder, name), "utf8")) as PendingRequest)
		.sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
}

export function readAnswer(dir: string, key: string): string | undefined {
	const path = join(dir, "answers", `${key}.txt`);
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export interface JournalCompleter {
	complete: (system: string, user: string, signal?: AbortSignal) => Promise<string>;
	/** Requests that were missing an answer in this run. */
	missed: () => PendingRequest[];
	/** Requests answered from the journal in this run. */
	replayed: () => number;
}

function abortError(): Error {
	const error = new Error("ultrathink: waiting for the host model");
	error.name = "AbortError";
	return error;
}

/**
 * On a journal hit returns the stored answer. On a miss writes the pending request, schedules `controller.abort()`
 * after `debounceMs` (so sibling requests of the same dependency level are collected in one pass) and rejects with an
 * AbortError once the flight is cancelled.
 */
export function createJournalCompleter(opts: { dir: string; controller?: AbortController; debounceMs?: number; now?: () => number }): JournalCompleter {
	const missed: PendingRequest[] = [];
	let replayed = 0;
	let scheduled = false;
	const complete = async (system: string, user: string, signal?: AbortSignal): Promise<string> => {
		const key = requestKey(system, user);
		const answer = readAnswer(opts.dir, key);
		if (answer !== undefined) {
			replayed++;
			return answer;
		}
		const request = describeRequest(system, user, (opts.now ?? Date.now)());
		writeAtomic(join(opts.dir, "pending", `${key}.json`), `${JSON.stringify(request, null, 2)}\n`);
		missed.push(request);
		const controller = opts.controller;
		if (!controller) throw abortError();
		if (!scheduled) {
			scheduled = true;
			setTimeout(() => controller.abort(), opts.debounceMs ?? 250);
		}
		const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		if (lifetime.aborted) throw abortError();
		await new Promise<void>((resolve) => lifetime.addEventListener("abort", () => resolve(), { once: true }));
		throw abortError();
	};
	return { complete, missed: () => [...missed], replayed: () => replayed };
}

// ---------------------------------------------------------------------------------------------------------------------
// Jev (Decisions) fetch journal

const DECISION_HOSTS = ["openrouter.ai"];

function decisionsUrl(input: unknown): string | undefined {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : undefined;
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		return DECISION_HOSTS.includes(url.hostname) && url.pathname.includes("decision") ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Wraps `globalThis.fetch` for Decisions API calls only: a journalled response (keyed by URL + request body, never
 * headers) replays; a fresh one is stored on success. Returns the restore function. Credentials are never written.
 */
export function installDecisionsJournal(dir: string, base: typeof fetch = globalThis.fetch): () => void {
	const original = globalThis.fetch;
	const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
		const url = decisionsUrl(input);
		const body = typeof init?.body === "string" ? init.body : undefined;
		if (!url || body === undefined || (init?.method ?? "GET").toUpperCase() !== "POST") return base(input, init);
		const key = createHash("sha256").update(url).update("\u0000").update(body).digest("hex").slice(0, 32);
		const path = join(dir, "decisions", `${key}.json`);
		if (existsSync(path)) {
			const saved = JSON.parse(readFileSync(path, "utf8")) as { status: number; body: string };
			return new Response(saved.body, { status: saved.status, headers: { "content-type": "application/json" } });
		}
		const response = await base(input, init);
		const text = await response.text();
		if (response.ok) writeAtomic(path, `${JSON.stringify({ status: response.status, body: text, at: Date.now() })}\n`);
		return new Response(text, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
	};
	globalThis.fetch = Object.assign(wrapped, { preconnect: original.preconnect }) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Validators: the plugin's own parsers, plus strict desk checks. A failed answer is never stored.

export interface Validation {
	ok: boolean;
	errors: string[];
	info?: Record<string, unknown>;
}

function sectionPresent(xml: string, names: string[]): boolean {
	return names.some((name) => new RegExp(`<${name}\\b`, "i").test(xml));
}

export function validateUplift(raw: string, original: string): Validation {
	const errors: string[] = [];
	const xml = sanitizeUpliftXml(raw, original);
	if (!xml) return { ok: false, errors: ["not an uplift XML document (root must be one of the uplift roots)"] };
	const root = xml.match(/^<([A-Za-z_]+)/)?.[1] ?? "";
	if (!ROOTS.includes(root)) errors.push(`root <${root}> is not one of ${ROOTS.join(", ")}`);
	if (!xml.includes(`<ORIGINAL>${escapeXml(original)}</ORIGINAL>`)) errors.push("ORIGINAL must hold the user's request verbatim (XML-escaped), byte for byte");
	for (const names of REQUIRED_SECTIONS) if (!sectionPresent(xml, names)) errors.push(`missing required section ${names.join(" or ")}`);
	return { ok: errors.length === 0, errors, info: { root, chars: xml.length } };
}

export function validateGraph(raw: string, original: string): Validation {
	const errors: string[] = [];
	const parsed = extractJsonObject(raw);
	const nodes = (parsed as { nodes?: unknown } | undefined)?.nodes;
	if (!Array.isArray(nodes)) return { ok: false, errors: ["graph JSON must have a nodes array"] };
	if (nodes.length < MIN_NODES || nodes.length > MAX_NODES) errors.push(`graph must have ${MIN_NODES}-${MAX_NODES} nodes (got ${nodes.length})`);
	const graph = normalizeGraph(parsed, original, MIN_NODES, MAX_NODES);
	if (isFallbackGraph(graph)) errors.push("graph normalized to the fallback graph");
	if (graph.nodes.length !== nodes.length) errors.push(`normalization changed the node count (${nodes.length} -> ${graph.nodes.length})`);
	const kinds = graph.nodes.map((node) => node.kind);
	if (kinds[0] !== "understand") errors.push("n1 must be kind understand");
	if (kinds[kinds.length - 1] !== "synthesize") errors.push("the last node must be kind synthesize");
	if (!kinds.includes("critique")) errors.push("at least one critique node is required");
	return { ok: errors.length === 0, errors, info: { nodes: graph.nodes.length } };
}

export function validateNodeFill(raw: string, kind: string | undefined): Validation {
	const errors: string[] = [];
	const fill = parseNodeFill(raw);
	const steps = splitRationaleSteps(fill.thinking);
	if (!/<rationale>/i.test(raw) || !/<conclusion>/i.test(raw)) errors.push("answer must be <node><rationale>…</rationale><conclusion>…</conclusion></node>");
	if (/&(?:lt|gt|amp|quot|apos);/.test(raw)) errors.push("do not XML-escape node text: parseNodeFill reads it raw, so entities would reach Linear and Notion verbatim");
	if (steps.length < MIN_STEPS || steps.length > MAX_STEPS) errors.push(`rationale must have ${MIN_STEPS}-${MAX_STEPS} numbered steps (got ${steps.length})`);
	if (fill.thinking.length > MAX_RATIONALE_CHARS) errors.push(`rationale exceeds ${MAX_RATIONALE_CHARS} chars (${fill.thinking.length})`);
	const limit = kind === "synthesize" ? 3000 : 1200;
	if (fill.conclusion.length > limit) errors.push(`conclusion exceeds ${limit} chars (${fill.conclusion.length})`);
	if (kind === "synthesize") {
		if (!/^\s*WORKFLOW\s*$/m.test(fill.conclusion)) errors.push("synthesize conclusion needs a WORKFLOW section");
		if (!/^\s*Wave \d+/m.test(fill.conclusion)) errors.push("synthesize WORKFLOW needs Wave lines");
		if ((fill.conclusion.match(/^\s*Verify:/gm) ?? []).length !== 1) errors.push("synthesize WORKFLOW must end with exactly one Verify: line");
	}
	if (kind === "critique" && !/Open questions:/.test(fill.conclusion)) errors.push('critique conclusion must end with an "Open questions:" list');
	return { ok: errors.length === 0, errors, info: { steps: steps.length, rationaleChars: fill.thinking.length, conclusionChars: fill.conclusion.length } };
}

export function validateClarify(raw: string, maxQuestions = 4): Validation {
	const parsed = extractJsonObject(raw);
	if (!parsed || typeof parsed !== "object") return { ok: false, errors: ["clarify answer must be a JSON object"] };
	const questions = normalizeClarifications(parsed, maxQuestions);
	const rawCount = Array.isArray((parsed as { questions?: unknown }).questions) ? ((parsed as { questions: unknown[] }).questions.length) : -1;
	const errors: string[] = [];
	if (rawCount < 0) errors.push('clarify JSON needs a "questions" array (may be empty)');
	if (rawCount > maxQuestions) errors.push(`at most ${maxQuestions} questions (got ${rawCount})`);
	if (rawCount > 0 && questions.length === 0) errors.push("no question survived normalization");
	return { ok: errors.length === 0, errors, info: { questions: questions.length } };
}

export function validateDistill(raw: string): Validation {
	const parsed = extractJsonObject(raw);
	return parsed && typeof parsed === "object" ? { ok: true, errors: [] } : { ok: false, errors: ["distill answer must be JSON"] };
}

export function validateAnswer(request: PendingRequest, raw: string, original: string | undefined): Validation {
	if (!raw.trim()) return { ok: false, errors: ["empty answer"] };
	if (raw.length > MAX_ANSWER_CHARS) return { ok: false, errors: ["answer too large"] };
	switch (request.stage) {
		case "uplift":
			return original === undefined ? { ok: false, errors: ["session has no recorded original"] } : validateUplift(raw, original);
		case "graph":
			return validateGraph(raw, original ?? "");
		case "cot":
			return validateNodeFill(raw, request.nodeKind);
		case "clarify":
			return validateClarify(raw);
		case "distill":
			return validateDistill(raw);
		default:
			return { ok: true, errors: [] };
	}
}

/** Validates then stores an answer and removes its pending file. `replace` overwrites an existing answer (deepen). */
export function storeAnswer(dir: string, key: string, raw: string, options: { replace?: boolean } = {}): Validation {
	const pendingPath = join(dir, "pending", `${key}.json`);
	const answerPath = join(dir, "answers", `${key}.txt`);
	let request: PendingRequest | undefined;
	if (existsSync(pendingPath)) request = JSON.parse(readFileSync(pendingPath, "utf8")) as PendingRequest;
	else if (options.replace && existsSync(join(dir, "requests", `${key}.json`))) request = JSON.parse(readFileSync(join(dir, "requests", `${key}.json`), "utf8")) as PendingRequest;
	if (!request) return { ok: false, errors: [`no pending request ${key}`] };
	if (existsSync(answerPath) && !options.replace) return { ok: false, errors: [`request ${key} is already answered (use --replace)`] };
	const result = validateAnswer(request, raw, readMeta(dir)?.original);
	if (!result.ok) return result;
	writeAtomic(answerPath, raw);
	writeAtomic(join(dir, "requests", `${key}.json`), `${JSON.stringify(request, null, 2)}\n`);
	rmSync(pendingPath, { force: true });
	return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Plan driver

export interface PlanCheck {
	ok: boolean;
	errors: string[];
	root?: string;
	nodes: number;
	stepsPerNode: Record<string, number>;
	totalSteps: number;
	band?: readonly [number, number];
	belowBand: boolean;
	degraded: string[];
}

export function checkRecord(record: SessionRecord): PlanCheck {
	const errors: string[] = [];
	const nodes: ThoughtNode[] = record.graph?.nodes ?? [];
	const stepsPerNode: Record<string, number> = {};
	for (const node of nodes) stepsPerNode[node.id] = nodeStepTitles(node).length;
	const totalSteps = Object.values(stepsPerNode).reduce((sum, n) => sum + n, 0);
	const degraded = record.degraded ?? [];
	if (record.result.source !== "llm") errors.push(`uplift source is ${record.result.source}`);
	if (degraded.length > 0) errors.push(`degraded stages: ${degraded.join(", ")}`);
	if (nodes.length < MIN_NODES || nodes.length > MAX_NODES) errors.push(`graph has ${nodes.length} nodes`);
	for (const [id, n] of Object.entries(stepsPerNode)) if (n < MIN_STEPS || n > MAX_STEPS) errors.push(`${id} has ${n} steps`);
	const root = record.result.root;
	const band = DENSITY_BAND[root];
	const belowBand = !!band && totalSteps < band[0];
	return { ok: errors.length === 0, errors, root, nodes: nodes.length, stepsPerNode, totalSteps, ...(band ? { band } : {}), belowBand, degraded };
}

/**
 * Grok Bot keeps recent turns as simple `{"role":"user"|"assistant","content":"..."}` lines; the plugin's transcript
 * reader only takes Claude Code entries (`{"type":"user","message":{"role","content"}}`) and silently ignores anything
 * else. Writes a Claude-shaped copy into the session journal and returns its path; Claude-shaped lines pass through.
 * An unreadable file yields an empty copy (no conversation context, as the plugin does).
 */
export function normalizeTranscript(source: string, dir: string): string {
	let text = "";
	try {
		text = readFileSync(source, "utf8");
	} catch {
		text = "";
	}
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const rec = entry as { type?: unknown; role?: unknown; content?: unknown; message?: unknown };
		if ((rec.type === "user" || rec.type === "assistant") && rec.message && typeof rec.message === "object") {
			out.push(trimmed);
			continue;
		}
		if ((rec.role === "user" || rec.role === "assistant") && (typeof rec.content === "string" || Array.isArray(rec.content))) {
			out.push(JSON.stringify({ type: rec.role, message: { role: rec.role, content: rec.content } }));
		}
	}
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "transcript.claude.jsonl");
	writeFileSync(path, out.length ? `${out.join("\n")}\n` : "");
	return path;
}

export interface GrokbotPlanInput {
	sessionId: string;
	prompt: string;
	cwd: string;
	transcriptPath?: string;
	stateDir?: string;
	env?: Record<string, string | undefined>;
	debounceMs?: number;
	/** Re-run a planned session (after `answer --replace`); mints a new graph id. Without it a planned session is returned as is. */
	replan?: boolean;
}

export interface GrokbotPlanResult {
	status: "needs-model" | "planned" | "invalid" | "skipped";
	sessionId: string;
	journal: string;
	pending: Array<Pick<PendingRequest, "key" | "stage" | "nodeId" | "nodeKind" | "nodeTitle">>;
	replayed: number;
	skipped?: string;
	response?: PlanResponse;
	check?: PlanCheck;
}

export async function runGrokbotPlan(input: GrokbotPlanInput): Promise<GrokbotPlanResult> {
	const env = { ...(input.env ?? process.env), ULTRATHINK_SHIP: "0", ULTRATHINK_HOST: GROKBOT_ENGINE_HOST };
	const stateDir = input.stateDir ?? grokbotStateDir(env);
	const dir = journalDir(stateDir, input.sessionId);
	const meta = readMeta(dir);
	if (meta?.original !== undefined && meta.original !== input.prompt) throw new Error("session already holds a different original prompt; use a new session id");
	const existing = sessionPath(stateDir, input.sessionId);
	if (meta?.status === "planned" && !input.replan && existsSync(existing)) {
		const record = JSON.parse(readFileSync(existing, "utf8")) as SessionRecord;
		return { status: "planned", sessionId: input.sessionId, journal: dir, pending: [], replayed: 0, check: checkRecord(record), response: { statePath: existing, specPath: existing.replace(/\.json$/, ".xml") } as PlanResponse };
	}
	writeMeta(dir, { ...meta, sessionId: input.sessionId, original: input.prompt, cwd: input.cwd, ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}), status: "needs-model" });
	rmSync(join(dir, "pending"), { recursive: true, force: true });
	const controller = new AbortController();
	const journal = createJournalCompleter({ dir, controller, debounceMs: input.debounceMs });
	const restore = installDecisionsJournal(dir);
	const resolution = hostResolution();
	let response: PlanResponse;
	try {
		response = await planPrompt(
			{ host: GROKBOT_ENGINE_HOST, session_id: input.sessionId, prompt: input.prompt, cwd: input.cwd, ...(input.transcriptPath ? { transcript_path: normalizeTranscript(input.transcriptPath, dir) } : {}) },
			env,
			{
				stateDir,
				signal: controller.signal,
				selectEngine: async (): Promise<SelectedEngine> => ({ label: GROKBOT_LABEL, complete: journal.complete, error: () => undefined, resolution }),
				createTracker: () => undefined,
			},
		);
	} finally {
		restore();
	}
	const missed = journal.missed();
	const base = { sessionId: input.sessionId, journal: dir, replayed: journal.replayed(), pending: missed.map(({ key, stage, nodeId, nodeKind, nodeTitle }) => ({ key, stage, nodeId, nodeKind, nodeTitle })) };
	if (missed.length > 0) {
		writeMeta(dir, { ...readMeta(dir), sessionId: input.sessionId, status: "needs-model" });
		return { status: "needs-model", ...base };
	}
	if (response.skipped || !response.statePath) {
		writeMeta(dir, { ...readMeta(dir), sessionId: input.sessionId, status: "skipped" });
		return { status: "skipped", ...base, ...(response.skipped ? { skipped: response.skipped } : {}), response };
	}
	const record = JSON.parse(readFileSync(response.statePath, "utf8")) as SessionRecord;
	const check = checkRecord(record);
	const status = check.ok ? "planned" : "invalid";
	writeMeta(dir, { ...readMeta(dir), sessionId: input.sessionId, status });
	return { status, ...base, response, check };
}

/** Nodes to deepen when a BUILD/CHANGE plan lands below its density band: fewest steps first. */
export function deepenTargets(check: PlanCheck): string[] {
	if (!check.belowBand || !check.band) return [];
	let missing = check.band[0] - check.totalSteps;
	const targets: string[] = [];
	for (const [id, n] of Object.entries(check.stepsPerNode).sort((a, b) => a[1] - b[1])) {
		if (missing <= 0) break;
		const room = MAX_STEPS - n;
		if (room <= 0) continue;
		targets.push(id);
		missing -= room;
	}
	return targets;
}
