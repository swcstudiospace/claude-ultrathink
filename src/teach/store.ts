// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The local Teachable Moments store: one JSON file per moment and one per pending Hindsight write (the outbox), under
 * `<stateDir>/teach`. One file per record, written to a temp file and renamed, means several hosts and detached
 * `observe` processes can share it without a lock: the worst case is one writer's update winning. The store itself is
 * synchronous fs only, so a hook can use it without an event loop; `listRecentMoments`/`readMoment` are the async,
 * bounded readers for plan-time lookups that must stay responsive. Corrupt or foreign files are skipped, never thrown.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isPlanningPath } from "../host/paths.ts";
import { redactLine } from "./redact.ts";
import {
	MOMENT_KINDS,
	MOMENT_ORIGINS,
	MOMENT_STATUSES,
	type OutboxEntry,
	type OutboxOp,
	type TeachableMoment,
	type TeachStore,
} from "./types.ts";

/** Ids become file names: no separators, no leading dot-dot tricks, bounded length. */
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 6 * 60 * 60_000;

export function storeDir(stateDir: string): string {
	return join(stateDir, "teach");
}

export function isValidId(id: unknown): id is string {
	return typeof id === "string" && ID_PATTERN.test(id) && id !== "." && id !== "..";
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A moment from untrusted JSON: undefined unless it is a schema-2 moment whose id is the file's id. */
function parseMoment(raw: unknown, id: string): TeachableMoment | undefined {
	if (!isRecord(raw) || raw.id !== id || raw.schema !== 2) return undefined;
	const { name, body, kind, status, origin, dedupeKey, createdAt, lastSeenAt } = raw;
	if (typeof name !== "string" || typeof body !== "string" || typeof dedupeKey !== "string") return undefined;
	if (typeof createdAt !== "string" || typeof lastSeenAt !== "string") return undefined;
	if (!MOMENT_KINDS.includes(kind as TeachableMoment["kind"])) return undefined;
	if (!MOMENT_STATUSES.includes(status as TeachableMoment["status"])) return undefined;
	if (!MOMENT_ORIGINS.includes(origin as TeachableMoment["origin"])) return undefined;
	const moment: TeachableMoment = {
		id,
		name,
		description: str(raw.description),
		body,
		sourcePhase: str(raw.sourcePhase),
		sourceArtifacts: strings(raw.sourceArtifacts),
		createdAt,
		tags: strings(raw.tags),
		relatedIds: strings(raw.relatedIds),
		schema: 2,
		kind: kind as TeachableMoment["kind"],
		status: status as TeachableMoment["status"],
		origin: origin as TeachableMoment["origin"],
		project: str(raw.project, "unknown"),
		host: str(raw.host, "unknown"),
		confidence: num(raw.confidence, 1),
		occurrences: Math.max(1, Math.floor(num(raw.occurrences, 1))),
		lastSeenAt,
		dedupeKey,
		recalled: Math.max(0, Math.floor(num(raw.recalled, 0))),
	};
	if (typeof raw.supersedes === "string") moment.supersedes = raw.supersedes;
	const retained = raw.retained;
	if (isRecord(retained) && typeof retained.at === "string" && typeof retained.bank === "string" && typeof retained.documentId === "string") {
		moment.retained = { at: retained.at, bank: retained.bank, documentId: retained.documentId };
	}
	const promoted = raw.promoted;
	if (isRecord(promoted) && typeof promoted.at === "string" && typeof promoted.skill === "string" && typeof promoted.target === "string") {
		moment.promoted = { at: promoted.at, skill: promoted.skill, target: promoted.target as NonNullable<TeachableMoment["promoted"]>["target"] };
		if (typeof promoted.path === "string") moment.promoted.path = promoted.path;
	}
	return moment;
}

function parseOp(raw: unknown): OutboxOp | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw.op === "retain" && isValidId(raw.momentId)) return { op: "retain", momentId: raw.momentId };
	if (raw.op === "delete" && typeof raw.documentId === "string") return { op: "delete", documentId: raw.documentId };
	if (raw.op === "tags" && typeof raw.documentId === "string" && Array.isArray(raw.tags)) {
		return { op: "tags", documentId: raw.documentId, tags: strings(raw.tags) };
	}
	return undefined;
}

function parseEntry(raw: unknown, id: string): OutboxEntry | undefined {
	if (!isRecord(raw) || raw.id !== id) return undefined;
	const op = parseOp(raw.op);
	if (!op) return undefined;
	const entry: OutboxEntry = {
		id,
		op,
		attempts: Math.max(0, Math.floor(num(raw.attempts, 0))),
		nextAt: num(raw.nextAt, 0),
		enqueuedAt: num(raw.enqueuedAt, 0),
	};
	if (typeof raw.lastError === "string") entry.lastError = raw.lastError;
	return entry;
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Temp file in the same directory, then rename: readers see the old or the new record, never half of one. */
function writeAtomic(dir: string, id: string, value: unknown): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, `.${id}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temp, join(dir, `${id}.json`));
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

function recordIds(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((file) => file.endsWith(".json"))
			.map((file) => file.slice(0, -".json".length))
			.filter(isValidId);
	} catch {
		return [];
	}
}

/** One moment file read asynchronously; undefined when it is missing, not a regular file, larger than `maxBytes` or invalid. */
async function readMomentFile(momentsDir: string, id: string, maxBytes: number): Promise<TeachableMoment | undefined> {
	try {
		const path = join(momentsDir, `${id}.json`);
		const stat = await lstat(path);
		if (!stat.isFile() || stat.size > maxBytes) return undefined;
		const bytes = await readFile(path);
		if (bytes.length > maxBytes) return undefined;
		return parseMoment(JSON.parse(bytes.toString("utf8")), id);
	} catch {
		return undefined;
	}
}

/** One moment of the store at `dir` (`<stateDir>/teach`), read asynchronously with a size cap. */
export async function readMoment(dir: string, id: string, maxBytes: number): Promise<TeachableMoment | undefined> {
	return isValidId(id) ? readMomentFile(join(dir, "moments"), id, maxBytes) : undefined;
}

/**
 * The newest moments of the store at `dir` by file mtime (every write renames a fresh file into place): at most `max`
 * files, each at most `maxBytes`, symlinks skipped. Async between files and stops early, with what it has, once `signal`
 * aborts; the caller checks the signal.
 */
export async function listRecentMoments(
	dir: string,
	options: { max: number; maxBytes: number; signal?: AbortSignal },
): Promise<TeachableMoment[]> {
	const momentsDir = join(dir, "moments");
	let files: string[];
	try {
		files = await readdir(momentsDir);
	} catch {
		return [];
	}
	const entries: { id: string; mtimeMs: number }[] = [];
	for (const file of files) {
		if (options.signal?.aborted) return [];
		if (!file.endsWith(".json")) continue;
		const id = file.slice(0, -".json".length);
		if (!isValidId(id)) continue;
		try {
			const stat = await lstat(join(momentsDir, file));
			if (stat.isFile() && stat.size <= options.maxBytes) entries.push({ id, mtimeMs: stat.mtimeMs });
		} catch {
			// removed meanwhile
		}
	}
	entries.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
	const moments: TeachableMoment[] = [];
	for (const { id } of entries.slice(0, Math.max(0, options.max))) {
		if (options.signal?.aborted) break;
		const moment = await readMomentFile(momentsDir, id, options.maxBytes);
		if (moment) moments.push(moment);
	}
	return moments;
}

function opKey(op: OutboxOp): string {
	return JSON.stringify(op);
}

export function openStore(dir: string): TeachStore {
	if (isPlanningPath(dir)) throw new Error("the teach store must not live under .planning");
	const momentsDir = join(dir, "moments");
	const outboxDir = join(dir, "outbox");

	const read = (id: string): TeachableMoment | undefined => (isValidId(id) ? parseMoment(readJson(join(momentsDir, `${id}.json`)), id) : undefined);

	const readEntry = (id: string): OutboxEntry | undefined => (isValidId(id) ? parseEntry(readJson(join(outboxDir, `${id}.json`)), id) : undefined);

	function list(): TeachableMoment[] {
		const moments: TeachableMoment[] = [];
		for (const id of recordIds(momentsDir)) {
			const moment = read(id);
			if (moment) moments.push(moment);
		}
		return moments.sort(
			(a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : 1),
		);
	}

	function outbox(): OutboxEntry[] {
		const entries: OutboxEntry[] = [];
		for (const id of recordIds(outboxDir)) {
			const entry = readEntry(id);
			if (entry) entries.push(entry);
		}
		return entries.sort((a, b) => a.enqueuedAt - b.enqueuedAt || (a.id < b.id ? -1 : 1));
	}

	function put(moment: TeachableMoment): void {
		if (!isValidId(moment.id)) throw new Error("invalid moment id");
		writeAtomic(momentsDir, moment.id, moment);
	}

	return {
		dir,
		list,
		get: read,
		findByDedupeKey(key) {
			const matches = list().filter((moment) => moment.dedupeKey === key);
			return matches.find((moment) => moment.status !== "superseded") ?? matches[0];
		},
		put,
		remove(id) {
			if (!isValidId(id) || !existsSync(join(momentsDir, `${id}.json`))) return false;
			rmSync(join(momentsDir, `${id}.json`), { force: true });
			return true;
		},
		bumpRecalled(ids) {
			for (const id of new Set(ids)) {
				const moment = read(id);
				if (!moment) continue;
				try {
					put({ ...moment, recalled: moment.recalled + 1 });
				} catch {
					// a counter is not worth failing a plan for
				}
			}
		},
		enqueue(op, now) {
			const key = opKey(op);
			const existing = outbox().find((entry) => opKey(entry.op) === key);
			if (existing) return existing;
			const id = `${now.toString(36)}-${randomBytes(4).toString("hex")}`;
			const entry: OutboxEntry = { id, op, attempts: 0, nextAt: now, enqueuedAt: now };
			writeAtomic(outboxDir, id, entry);
			return entry;
		},
		outbox,
		ack(entryId) {
			if (isValidId(entryId)) rmSync(join(outboxDir, `${entryId}.json`), { force: true });
		},
		fail(entryId, reason, now) {
			const entry = readEntry(entryId);
			if (!entry) return;
			const attempts = entry.attempts + 1;
			const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
			const lastError = redactLine(reason);
			writeAtomic(outboxDir, entryId, { ...entry, attempts, nextAt: now + delay, lastError });
		},
	};
}
