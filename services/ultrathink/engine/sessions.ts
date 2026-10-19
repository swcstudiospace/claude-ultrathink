// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Read-only listing of the sessions a connector's state directory holds. A session can live in three places, all
 * keyed by the same id: a server job (`jobs/<id>.json`, written by the headless planner), a client-driven journal
 * (`journal/<id>/meta.json`, written by the grok-bot adapter) and a plan record (`sessions/<id>.json`). A session is
 * listed only when a job or a journal supplies its status: a plan record alone cannot be served by ultrathink_result,
 * so it only enriches the goal and counts of a session found elsewhere. Only summaries leave this module: a one-line
 * goal, counts and a status. Prompts, specifications, answers and error text stay on disk.
 */
import { type Dir, lstatSync, opendirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isFallbackGraph } from "../../../src/think/graph.ts";
import type { ThoughtGraph } from "../../../src/think/types.ts";
import { isSessionId } from "./journal.ts";

export type SessionStatus = "running" | "planned" | "failed" | "invalid" | "skipped";

export interface SessionSummary {
	sessionId: string;
	/** Server jobs report running/planned/failed/invalid/skipped; client-driven sessions report running/planned/invalid/skipped. */
	status: SessionStatus;
	mode: "server" | "client";
	/** Milliseconds since the epoch. */
	updatedAt: number;
	/** One line, at most GOAL_MAX_CHARS characters; empty when nothing safe to show exists yet. */
	goal: string;
	nodeCount: number;
	/** False for a missing graph and for the boilerplate fallback graph. */
	hasGraph: boolean;
}

export const GOAL_MAX_CHARS = 120;
export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 20;

/** Directory entries read per directory; a hostile or runaway directory cannot make a listing unbounded. */
const MAX_DIR_ENTRIES = 5000;
const MAX_CANDIDATES = 200;
/** Larger files are skipped unread: a plan record with every node filled stays far below this. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Text is cut to this many characters before it is normalised, so a megabyte goal costs nothing. */
const GOAL_SCAN_CHARS = 2048;
const JOB_STATUSES: Record<string, true> = { running: true, planned: true, failed: true, invalid: true, skipped: true };
const JSON_SUFFIX = ".json";

interface Sources {
	id: string;
	jobMtime?: number;
	metaMtime?: number;
	recordMtime?: number;
}

interface RecordView {
	/** Goal of a usable (parsed, non-fallback) graph. */
	graphGoal: string;
	original: string;
	nodeCount: number;
	hasGraph: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function clampLimit(limit: unknown): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** First non-blank line, control characters and runs of whitespace collapsed, cut to GOAL_MAX_CHARS characters. */
function oneLine(value: unknown): string {
	if (typeof value !== "string") return "";
	const head = value.slice(0, GOAL_SCAN_CHARS);
	for (const line of head.split(/[\r\n\u2028\u2029]/)) {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed
		const text = line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
		if (text.length === 0) continue;
		if (text.length <= GOAL_MAX_CHARS) return text;
		let cut = text.slice(0, GOAL_MAX_CHARS - 1);
		// Never leave half of a surrogate pair behind.
		const last = cut.charCodeAt(cut.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
		return `${cut.trimEnd()}…`;
	}
	return "";
}

/** Names of a directory, at most MAX_DIR_ENTRIES of them; empty when the directory is missing or unreadable. */
function listNames(dir: string): string[] {
	const names: string[] = [];
	let handle: Dir | undefined;
	try {
		handle = opendirSync(dir);
		for (let entry = handle.readSync(); entry !== null && names.length < MAX_DIR_ENTRIES; entry = handle.readSync()) names.push(entry.name);
	} catch {
		// A partial listing is still a valid listing.
	} finally {
		try {
			handle?.closeSync();
		} catch {
			// Nothing left to release.
		}
	}
	return names;
}

/** Modification time of a regular, reasonably small file that is not a symlink; undefined otherwise. */
function fileMtime(path: string): number | undefined {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
		return Math.trunc(stat.mtimeMs);
	} catch {
		return undefined;
	}
}

function isRealDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

/** Every session id found in any of the three places, with the modification time of each file it was found in. */
function scan(stateDir: string): Sources[] {
	const found = new Map<string, Sources>();
	const entry = (id: string): Sources => {
		let sources = found.get(id);
		if (!sources) {
			sources = { id };
			found.set(id, sources);
		}
		return sources;
	};

	const jobsDir = join(stateDir, "jobs");
	for (const name of listNames(jobsDir)) {
		if (!name.endsWith(JSON_SUFFIX)) continue;
		const id = name.slice(0, -JSON_SUFFIX.length);
		if (!isSessionId(id)) continue;
		const mtime = fileMtime(join(jobsDir, name));
		if (mtime !== undefined) entry(id).jobMtime = mtime;
	}

	const journalRoot = join(stateDir, "journal");
	for (const name of listNames(journalRoot)) {
		if (!isSessionId(name)) continue;
		const dir = join(journalRoot, name);
		if (!isRealDirectory(dir)) continue;
		const mtime = fileMtime(join(dir, "meta.json"));
		if (mtime !== undefined) entry(name).metaMtime = mtime;
	}

	const recordsDir = join(stateDir, "sessions");
	for (const name of listNames(recordsDir)) {
		if (!name.endsWith(JSON_SUFFIX)) continue;
		const id = name.slice(0, -JSON_SUFFIX.length);
		if (!isSessionId(id)) continue;
		const mtime = fileMtime(join(recordsDir, name));
		if (mtime !== undefined) entry(id).recordMtime = mtime;
	}

	return [...found.values()];
}

/** Newest first; the id breaks ties so equal timestamps list the same way on every run. */
function byRecency(a: { id: string; time: number }, b: { id: string; time: number }): number {
	return b.time - a.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function readRecord(path: string): RecordView | undefined {
	const raw = readJson(path);
	if (!isObject(raw) || !isObject(raw.result)) return undefined;
	const view: RecordView = {
		graphGoal: "",
		original: typeof raw.result.original === "string" ? raw.result.original.slice(0, GOAL_SCAN_CHARS) : "",
		nodeCount: 0,
		hasGraph: false,
	};
	const graph = raw.graph;
	// Nodes that are not objects mean a hand-edited or foreign file: it has no graph worth summarising.
	if (isObject(graph) && typeof graph.goal === "string" && Array.isArray(graph.nodes) && graph.nodes.every(isObject) && !isFallbackGraph(graph as unknown as ThoughtGraph)) {
		view.graphGoal = graph.goal.slice(0, GOAL_SCAN_CHARS);
		view.hasGraph = graph.nodes.length > 0;
		view.nodeCount = graph.nodes.length;
	}
	return view;
}

/** Status a client-driven session reports; the same mapping as the planner's result view. */
function clientStatus(status: unknown): SessionStatus {
	return status === "planned" || status === "invalid" || status === "skipped" ? status : "running";
}

function summarize(stateDir: string, sources: Sources): SessionSummary | undefined {
	const { id } = sources;
	const record = sources.recordMtime === undefined ? undefined : readRecord(join(stateDir, "sessions", `${id}${JSON_SUFFIX}`));

	let status: SessionStatus | undefined;
	let mode: "server" | "client" = "server";
	let updatedAt = 0;
	let metaOriginal = "";

	if (sources.jobMtime !== undefined) {
		const job = readJson(join(stateDir, "jobs", `${id}${JSON_SUFFIX}`));
		// The shape check mirrors the planner's own: a file it would refuse to serve is not listed as a job.
		if (isObject(job) && typeof job.status === "string" && Object.hasOwn(JOB_STATUSES, job.status) && typeof job.updatedAt === "number" && Number.isFinite(job.updatedAt)) {
			status = job.status as SessionStatus;
			updatedAt = job.updatedAt;
		}
	}

	if (status === undefined && sources.metaMtime !== undefined) {
		const meta = readJson(join(stateDir, "journal", id, "meta.json"));
		if (isObject(meta)) {
			status = clientStatus(meta.status);
			mode = "client";
			updatedAt = typeof meta.updatedAt === "number" && Number.isFinite(meta.updatedAt) ? meta.updatedAt : sources.metaMtime;
			if (typeof meta.original === "string") metaOriginal = meta.original.slice(0, GOAL_SCAN_CHARS);
		}
	}

	// A plan record with no job and no journal cannot be served by ultrathink_result, so it is not listed.
	if (status === undefined) return undefined;

	const goal = oneLine(record?.graphGoal) || oneLine(record?.original) || oneLine(metaOriginal);
	return { sessionId: id, status, mode, updatedAt: Math.trunc(updatedAt), goal, nodeCount: record?.nodeCount ?? 0, hasGraph: record?.hasGraph ?? false };
}

/** Summaries of the `candidates` most recently touched sessions, newest first by their own timestamp. */
function collect(stateDir: string, candidates: number): SessionSummary[] {
	const newest = scan(stateDir)
		.map((sources) => ({ id: sources.id, time: Math.max(sources.jobMtime ?? 0, sources.metaMtime ?? 0, sources.recordMtime ?? 0), sources }))
		.sort(byRecency)
		.slice(0, candidates);
	const summaries: SessionSummary[] = [];
	for (const { sources } of newest) {
		try {
			const summary = summarize(stateDir, sources);
			if (summary) summaries.push(summary);
		} catch {
			// One unreadable session never hides the others.
		}
	}
	return summaries.map((summary) => ({ id: summary.sessionId, time: summary.updatedAt, summary })).sort(byRecency).map((item) => item.summary);
}

/**
 * The most recent sessions of a state directory, newest first. Never throws: a missing directory, an unreadable or
 * malformed file and a name that is not a session id are all skipped. `limit` is clamped to 1..20 (default 5); at
 * most min(200, limit * 4) sessions are parsed, chosen by file modification time.
 */
export function listSessions(stateDir: string, options: { limit?: number } = {}): SessionSummary[] {
	try {
		const limit = clampLimit(options.limit);
		return collect(stateDir, Math.min(MAX_CANDIDATES, limit * 4)).slice(0, limit);
	} catch {
		return [];
	}
}

/** Id of the newest session whose plan is finished (status "planned"), or undefined when there is none. */
export function newestPlannedSessionId(stateDir: string): string | undefined {
	try {
		return collect(stateDir, MAX_CANDIDATES).find((summary) => summary.status === "planned")?.sessionId;
	} catch {
		return undefined;
	}
}
