// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Tamper-evident security audit trail (Refs SPE-17437).
 *
 * An append-only JSON Lines file, one record per line, each record carrying the SHA-256 of the previous record so
 * that editing, removing or reordering any line breaks the chain from that line on. The file is created `0600` and
 * every append is fsynced; security events are rare, so durability wins over throughput.
 *
 * Phase 68 adds three things to the chain:
 * - Merkle anchors (CONTEXT D1, D2): after every `anchorEvery` records the log appends an `audit_anchor` whose root
 *   commits to every record before it (see `audit-merkle.ts`). An in-place edit of an earlier record is caught by the
 *   anchor even when the attacker recomputes the chain hashes. A full rewrite that recomputes the anchors too is only
 *   caught by a copy held elsewhere (`audit-cli.ts verify --expect <seq>:<hash>`).
 * - Sealed segments (CONTEXT D9): when the active file would exceed `segmentBytes` it is renamed to
 *   `audit-<firstSeq>-<lastSeq>.jsonl` and made read-only. The chain continues across the files.
 * - Retention (CONTEXT D10): `prune()` deletes the oldest sealed segments past a cutoff and records the boundary in an
 *   `audit_retention_pruned` event, carrying the anchor frontier, so the remaining chain still verifies and its anchors
 *   keep covering every record.
 *
 * The log is tamper-evident, not tamper-proof: whoever can rewrite the whole file can recompute the whole chain, and
 * removing records from the *end* is only visible against an externally kept `lastHash`. Operators who need that
 * guarantee ship the `verify()` result (or `audit-cli.ts verify`) off-host periodically.
 */

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";
import { createFrontier, type FrontierState, type MerkleFrontier, seedFrontier } from "./audit-merkle.ts";
import { listSegments, sealedName } from "./audit-segments.ts";
import type { Fingerprint } from "./audit-watch.ts";

/** Security events the service records. New events append here; verification accepts any string event so old files still verify. */
export type AuditEvent =
	| "login_ok"
	| "login_failed"
	| "logout"
	| "client_registered"
	| "consent_approved"
	| "consent_denied"
	| "code_exchanged"
	| "token_refreshed"
	| "refresh_reuse_detected"
	| "token_revoked"
	| "rate_limited"
	| "abuse_penalty"
	| "audit_anchor"
	| "anomaly_detected"
	| "audit_tamper_detected"
	| "audit_retention_pruned";

export const AUDIT_EVENTS: readonly AuditEvent[] = [
	"login_ok",
	"login_failed",
	"logout",
	"client_registered",
	"consent_approved",
	"consent_denied",
	"code_exchanged",
	"token_refreshed",
	"refresh_reuse_detected",
	"token_revoked",
	"rate_limited",
	"abuse_penalty",
	"audit_anchor",
	"anomaly_detected",
	"audit_tamper_detected",
	"audit_retention_pruned",
];

/** One line of the file. `hash = sha256hex(prev + "\n" + canonical({seq, ts, event, prev, fields}))` with sorted keys. */
export interface AuditRecord {
	/** 1-based, dense, continues across reopen and across sealed segments. */
	seq: number;
	/** ISO-8601 UTC timestamp of the append. */
	ts: string;
	event: AuditEvent;
	/** Hash of the previous record; 64 zeros for the first one. */
	prev: string;
	hash: string;
	/** Sanitized context: primitives only, no secret-looking keys, strings clipped (see `record()`). */
	fields: Record<string, string | number | boolean>;
}

/** A change that loses nothing, or a routine retention prune, reported through `onNotice`. */
export type AuditNoticeKind = "moved_to" | "changed_outside" | "pruned";

/** A notice from the audit log. Branch on `kind`; `message` is text for logs and its wording may change. */
export interface AuditNotice {
	kind: AuditNoticeKind;
	message: string;
}

/** The `node:fs` surface the log uses; injectable so tests can simulate I/O failures without touching permissions. */
export type AuditFs = Pick<
	typeof nodeFs,
	"openSync" | "closeSync" | "readSync" | "writeSync" | "fsyncSync" | "fchmodSync" | "renameSync" | "existsSync" | "statSync" | "truncateSync" | "readdirSync" | "unlinkSync"
>;

export interface AuditLogOptions {
	/** Path of the JSON Lines file. Its directory must already exist and be writable. */
	path: string;
	/** Clock in epoch milliseconds; defaults to `Date.now`. */
	now?: () => number;
	/**
	 * Receives every failure that loses or may lose an event: each dropped record, and a file that cannot be verified or
	 * quarantined. Every drop is reported; a caller that writes log lines deduplicates them. The callback must not throw;
	 * if it does, the error is discarded.
	 */
	onError?: (error: Error) => void;
	/**
	 * Receives changes that lose nothing: a broken file moved aside (its records are kept in the moved copy) and a file
	 * adopted after an outside change. A caller logs these; they are not counted as lost events. Branch on `kind`, never
	 * on `message`.
	 */
	onNotice?: (notice: AuditNotice) => void;
	/**
	 * Receives each record once it is fsynced and the in-memory state is updated, including anchors, in seq order.
	 * Dropped records are never passed. A `record()` call made from inside this callback is allowed. An exception is
	 * reported through `onError` and the record stays in the chain.
	 */
	onAppend?: (record: AuditRecord) => void;
	/** Appends an `audit_anchor` after this many non-anchor records (integer 1..1000000); default 1000. */
	anchorEvery?: number;
	/**
	 * Seals the active file into `audit-<firstSeq>-<lastSeq>.jsonl` before an append that would take it past this many
	 * bytes (integer, at least 1 MiB); default 64 MiB. A record larger than the limit is still written.
	 */
	segmentBytes?: number;
	/** File-system hooks; defaults to `node:fs`. */
	fs?: AuditFs;
}

export type AuditVerification =
	| { ok: true; records: number; lastHash: string }
	| {
			ok: false;
			/** Records that verified before the break. */
			records: number;
			/**
			 * Global seq of the first bad record (its 1-based position in the chain when the chain starts at genesis);
			 * 0 when the file could not be opened or read (I/O, not tampering) or when a pruned prefix cannot be verified.
			 */
			brokenAt: number;
			reason: string;
	  };

export interface AuditLog {
	readonly path: string;
	/**
	 * Appends one record and fsyncs it. Never throws: on I/O failure the record is dropped (fail-open: the request
	 * that caused the event continues) and `onError` is called for each dropped record. Unknown values in
	 * `fields` are dropped (only finite numbers, booleans and strings are kept), keys that look like secrets are
	 * dropped, strings are clipped to 256 characters with control characters removed, and at most 32 keys are kept.
	 * The events `audit_anchor` and `audit_retention_pruned` are reserved for the log itself and are dropped when passed here.
	 */
	record(event: AuditEvent, fields?: Record<string, unknown>): void;
	/** Full scan of the chain on disk (sealed segments and the active file), constant memory per line. Reads with the log's `fs` hooks. */
	verify(): AuditVerification;
	/** Sequence number and hash of the last acknowledged record; `{seq: 0, hash: GENESIS_HASH}` for an empty chain. */
	head(): { seq: number; hash: string };
	/** Identity of the active file as this log last left it (size, mtime, inode); undefined when it does not exist. */
	fingerprint(): Fingerprint | undefined;
	/**
	 * Deletes sealed segments whose last record is older than `cutoffMs`, oldest first, and records the boundary in an
	 * `audit_retention_pruned` event. The event carries the anchor frontier over every deleted record, so anchors written
	 * later still cover the whole chain. The active file and `.corrupt-*` evidence are never removed. Returns how many
	 * segments were deleted; with none eligible nothing is written. Skipped (and reported) when the chain does not verify.
	 * The event is written and fsynced before any segment is deleted; when it cannot be written, nothing is deleted.
	 */
	prune(cutoffMs: number): { segments: number };
	/** Further `record()` calls are dropped, and each one is reported through `onError`. Idempotent. */
	close(): void;
}

/** 64 zeros: the `prev` of the first record. */
export const GENESIS_HASH = "0".repeat(64);
const ANCHOR_EVENT = "audit_anchor";
const RETENTION_EVENT = "audit_retention_pruned";
const DEFAULT_ANCHOR_EVERY = 1000;
const MAX_ANCHOR_EVERY = 1_000_000;
const MIN_SEGMENT_BYTES = 1024 * 1024;
const DEFAULT_SEGMENT_BYTES = 64 * 1024 * 1024;
const MAX_STRING = 256;
const MAX_KEYS = 32;
/** Longer lines than this cannot have been written by `record()`; the scan stops instead of buffering them. */
const MAX_LINE_BYTES = 1024 * 1024;
const READ_CHUNK = 64 * 1024;
// Same pattern as the logger's SECRET_KEY (obs/log.ts); copied so the two modules stay decoupled.
const SECRET_KEY = /secret|password|token|authorization|api[-_]?key|cookie|connector/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/g;
const HEX64 = /^[0-9a-f]{64}$/;
/** The exact key set of a record line, sorted. A line with any other key was not written by this log. */
const RECORD_KEYS: readonly string[] = ["event", "fields", "hash", "prev", "seq", "ts"];

type Primitive = string | number | boolean;

export function auditPath(stateDir: string): string {
	return `${stateDir}/audit.jsonl`;
}

function cleanString(value: string): string {
	const stripped = value.replace(CONTROL, "");
	return stripped.length > MAX_STRING ? `${stripped.slice(0, MAX_STRING - 1)}\u2026` : stripped;
}

function sanitizeFields(fields: Record<string, unknown> | undefined): Record<string, Primitive> {
	const out: Record<string, Primitive> = {};
	if (fields === null || typeof fields !== "object") return out;
	let kept = 0;
	for (const rawKey of Object.keys(fields)) {
		if (kept >= MAX_KEYS) break;
		if (SECRET_KEY.test(rawKey)) continue;
		const key = cleanString(rawKey);
		if (key.length === 0 || key in out) continue;
		let raw: unknown;
		try {
			raw = fields[rawKey];
		} catch {
			continue;
		}
		let value: Primitive;
		if (typeof raw === "string") value = cleanString(raw);
		else if (typeof raw === "boolean") value = raw;
		else if (typeof raw === "number" && Number.isFinite(raw)) value = raw;
		else continue;
		out[key] = value;
		kept += 1;
	}
	return out;
}

/** JSON with object keys sorted at every level, so the hash does not depend on insertion order. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
}

function hashRecord(seq: number, ts: string, event: string, prev: string, fields: Record<string, Primitive>): string {
	const body = canonical({ seq, ts, event, prev, fields });
	return createHash("sha256").update(`${prev}\n${body}`).digest("hex");
}

function stamp(now: () => number): string {
	try {
		const ms = now();
		if (Number.isFinite(ms)) return new Date(ms).toISOString();
	} catch {
		// Fall through to the wall clock.
	}
	return new Date().toISOString();
}

function errorOf(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Parses one line against the expected position in the chain; returns the reason it does not belong there.
function checkLine(line: string, expectedSeq: number, expectedPrev: string): { hash: string; ts: string; event: string; fields: Record<string, Primitive> } | { reason: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { reason: "not valid JSON" };
	}
	if (!isPlainObject(parsed)) return { reason: "record is not an object" };
	const keys = Object.keys(parsed).sort();
	if (keys.length !== RECORD_KEYS.length || keys.some((key, i) => key !== RECORD_KEYS[i])) return { reason: "record does not have exactly the keys seq, ts, event, prev, hash and fields" };
	// Only the writer's serialization is accepted: a duplicate key or extra whitespace changes the bytes but not the parsed object.
	if (JSON.stringify(parsed) !== line) return { reason: "line is not the canonical serialization of its record (duplicate keys or extra whitespace)" };
	const { seq, ts, event, prev, hash, fields } = parsed;
	if (typeof seq !== "number" || !Number.isInteger(seq)) return { reason: "seq is not an integer" };
	if (seq !== expectedSeq) return { reason: `seq ${seq} where ${expectedSeq} was expected` };
	if (typeof ts !== "string") return { reason: "ts is not a string" };
	if (typeof event !== "string" || event.length === 0) return { reason: "event is not a string" };
	if (typeof prev !== "string" || !HEX64.test(prev)) return { reason: "prev is not a sha256 hex digest" };
	if (prev !== expectedPrev) return { reason: "prev does not match the previous record's hash" };
	if (typeof hash !== "string" || !HEX64.test(hash)) return { reason: "hash is not a sha256 hex digest" };
	if (!isPlainObject(fields)) return { reason: "fields is not an object" };
	const flat: Record<string, Primitive> = {};
	for (const key of Object.keys(fields)) {
		const value = fields[key];
		if (typeof value !== "string" && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) {
			return { reason: `field ${JSON.stringify(key)} is not a primitive` };
		}
		flat[key] = value;
	}
	if (hashRecord(seq, ts, event, prev, flat) !== hash) return { reason: "hash does not match the record" };
	return { hash, ts, event, fields: flat };
}

/** The seq and prev of a line that parses as a record, without checking anything else. */
function peekHead(line: string): { seq: number; prev: string } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isPlainObject(parsed)) return undefined;
	const { seq, prev } = parsed;
	if (typeof seq !== "number" || !Number.isInteger(seq) || typeof prev !== "string") return undefined;
	return { seq, prev };
}

/** One file of the chain as scanned: the records it holds and where they end. */
interface ScannedFile {
	path: string;
	firstSeq: number;
	lastSeq: number;
	lastTs: string;
	lastHash: string;
	/** Frontier over every record through `lastSeq`: what an audit_retention_pruned record carries when this file is removed. */
	frontier: FrontierState;
}

/** What a scan of the chain found: the public verdict plus the state a writer needs to continue the chain. */
interface ChainScan {
	verification: AuditVerification;
	/** Global seq of the last verified record; 0 for an empty chain. */
	lastSeq: number;
	/** Hash of the last verified record; the genesis hash for an empty chain. */
	lastHash: string;
	/** Frontier over every verified record hash, anchors included. */
	frontier: MerkleFrontier;
	/**
	 * Non-anchor records since the last anchor (or since the start of the retained chain). The writer paces its own anchors
	 * with this count. Known limit: verification does not enforce the cadence, since `verifyAuditFile` takes no `anchorEvery`;
	 * a chain written with another cadence still verifies.
	 */
	sinceAnchor: number;
	/** Global seq of the first record in the active file, or `lastSeq + 1` when the active file holds none. */
	activeFirst: number;
	/** The file where verification failed; the active path when the chain verifies. */
	brokenIn: string;
	/** Every file that holds records, in chain order (sealed segments first, the active file last). */
	files: ScannedFile[];
}

interface ScanOptions {
	/** Sees every verified record in order, with its global seq and hash. */
	onRecord?: (seq: number, hash: string) => void;
	/** Reads the sealed segments only; used to continue after the active file was quarantined. */
	sealedOnly?: boolean;
}

type ScanStep = { kind: "ok" } | { kind: "broken"; reason: string } | { kind: "io"; reason: string };

// Calls `onLine` with each newline-terminated line of `file` in order, reading fixed-size chunks. The read stops at the
// first line `onLine` rejects, which is reported as broken. Memory is bounded by the longest line.
function eachLine(file: string, fs: AuditFs, onLine: (line: string) => string | undefined): ScanStep {
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch (error) {
		return { kind: "io", reason: `cannot open: ${errorOf(error).message}` };
	}
	try {
		const chunk = Buffer.allocUnsafe(READ_CHUNK);
		const pending: Buffer[] = [];
		let pendingBytes = 0;
		for (;;) {
			const read = fs.readSync(fd, chunk, 0, chunk.length, null);
			if (read === 0) break;
			let start = 0;
			for (let i = 0; i < read; i += 1) {
				if (chunk[i] !== 0x0a) continue;
				const tail = chunk.subarray(start, i);
				if (pendingBytes + tail.length > MAX_LINE_BYTES) return { kind: "broken", reason: "record exceeds the maximum line length" };
				const line = pending.length === 0 ? tail.toString("utf8") : Buffer.concat([...pending, tail]).toString("utf8");
				pending.length = 0;
				pendingBytes = 0;
				const reason = onLine(line);
				if (reason !== undefined) return { kind: "broken", reason };
				start = i + 1;
			}
			if (start < read) {
				if (pendingBytes + (read - start) > MAX_LINE_BYTES) return { kind: "broken", reason: "record exceeds the maximum line length" };
				pending.push(Buffer.from(chunk.subarray(start, read)));
				pendingBytes += read - start;
			}
		}
		if (pendingBytes > 0) return { kind: "broken", reason: "truncated last record (no trailing newline)" };
		return { kind: "ok" };
	} catch (error) {
		return { kind: "io", reason: `cannot read: ${errorOf(error).message}` };
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			// Nothing left to release.
		}
	}
}

/** The `fields` of the retained audit_retention_pruned record that names the boundary, or the first file failure met looking for it. */
function findBoundaryRecord(files: readonly string[], fs: AuditFs, throughSeq: number, throughHash: string): { fields?: Record<string, unknown>; failure?: string } {
	const found: { fields?: Record<string, unknown> } = {};
	let failure: string | undefined;
	for (const file of files) {
		const step = eachLine(file, fs, (line) => {
			if (found.fields !== undefined || !line.includes(RETENTION_EVENT)) return undefined;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return undefined;
			}
			if (isPlainObject(parsed) && parsed.event === RETENTION_EVENT && isPlainObject(parsed.fields)) {
				if (parsed.fields.throughSeq === throughSeq && parsed.fields.throughHash === throughHash) found.fields = parsed.fields;
			}
			return undefined;
		});
		if (step.kind !== "ok" && failure === undefined) failure = step.reason;
	}
	return found.fields !== undefined ? { fields: found.fields } : { failure };
}

/** The frontier that a `frontier` field carries (the JSON of a {@link FrontierState}), or undefined when it is missing or invalid. */
function decodeFrontier(text: unknown): { frontier: MerkleFrontier; text: string } | undefined {
	if (typeof text !== "string") return undefined;
	try {
		return { frontier: seedFrontier(JSON.parse(text) as FrontierState), text };
	} catch {
		return undefined;
	}
}

type PrunedPrefix = { kind: "seeded"; frontier: MerkleFrontier; text: string } | { kind: "failed"; verdict: Extract<AuditVerification, { ok: false }> };

/**
 * Resolves a chain whose first retained record `head` is not seq 1. The boundary is the retained audit_retention_pruned
 * record that names it, and its `frontier` seeds the anchor frontier, so anchors after the boundary are checked against
 * every record before it. A missing record is the break a chain from genesis reports. A record whose frontier is missing
 * or invalid, and a file that cannot be read while looking for it, leave the chain unverifiable (brokenAt 0, fail closed).
 */
function resolvePrunedPrefix(head: { seq: number; prev: string }, files: readonly string[], fs: AuditFs): PrunedPrefix {
	const found = findBoundaryRecord(files, fs, head.seq - 1, head.prev);
	if (found.fields === undefined) {
		if (found.failure !== undefined) {
			return { kind: "failed", verdict: { ok: false, records: 0, brokenAt: 0, reason: `cannot verify the records before seq ${head.seq}: ${found.failure}` } };
		}
		return { kind: "failed", verdict: { ok: false, records: 0, brokenAt: 1, reason: `seq ${head.seq} where 1 was expected` } };
	}
	const seeded = decodeFrontier(found.fields.frontier);
	if (seeded === undefined) {
		return { kind: "failed", verdict: { ok: false, records: 0, brokenAt: 0, reason: `the audit_retention_pruned record for seq ${head.seq - 1} has no valid frontier; the records before seq ${head.seq} cannot be verified` } };
	}
	if (seeded.frontier.size !== head.seq - 1) {
		return { kind: "failed", verdict: { ok: false, records: 0, brokenAt: 0, reason: `the audit_retention_pruned record for seq ${head.seq - 1} carries a frontier over ${seeded.frontier.size} records; the records before seq ${head.seq} cannot be verified` } };
	}
	return { kind: "seeded", ...seeded };
}

// Streams each file of the chain in fixed-size chunks and checks each line in turn; memory is bounded by the longest line.
// I/O failures (cannot open or read) report `brokenAt: 0`; `records` then says how far the scan got.
function scanChain(path: string, fs: AuditFs, options: ScanOptions = {}): ChainScan {
	const chainFiles = listSegments(path, fs).map((segment) => segment.path);
	if (!options.sealedOnly && fs.existsSync(path)) chainFiles.push(path);
	let frontier = createFrontier();
	const files: ScannedFile[] = [];
	let count = 0;
	let lastSeq = 0;
	let prev = GENESIS_HASH;
	let sinceAnchor = 0;
	let started = false;
	let boundary: { throughSeq: number; throughHash: string; frontier: string; file: string } | undefined;
	let halt: AuditVerification | undefined;

	const finish = (verification: AuditVerification, brokenIn: string): ChainScan => {
		const active = files.find((f) => f.path === path);
		return {
			verification,
			lastSeq,
			lastHash: prev,
			frontier,
			sinceAnchor,
			activeFirst: active?.firstSeq ?? lastSeq + 1,
			brokenIn,
			files,
		};
	};

	// Checks one line at its place in the chain. Returns the reason it fails, or its seq, timestamp and hash.
	const acceptLine = (line: string, file: string): { reason: string } | { seq: number; ts: string; hash: string } => {
		if (!started) {
			started = true;
			const head = peekHead(line);
			if (head !== undefined && head.seq > 1) {
				const pruned = resolvePrunedPrefix(head, chainFiles, fs);
				if (pruned.kind === "failed") {
					halt = pruned.verdict;
					return { reason: pruned.verdict.reason };
				}
				lastSeq = head.seq - 1;
				prev = head.prev;
				frontier = pruned.frontier;
				boundary = { throughSeq: lastSeq, throughHash: prev, frontier: pruned.text, file };
			}
		}
		const checked = checkLine(line, lastSeq + 1, prev);
		if ("reason" in checked) return { reason: checked.reason };
		if (checked.event === ANCHOR_EVENT) {
			// An anchor commits to every record before it: its root must equal the frontier before its own hash joins it.
			if (checked.fields.through !== lastSeq || checked.fields.root !== frontier.root()) {
				return { reason: `anchor root does not match records through ${lastSeq}` };
			}
			sinceAnchor = 0;
		} else {
			sinceAnchor += 1;
		}
		if (
			boundary !== undefined &&
			checked.event === RETENTION_EVENT &&
			checked.fields.throughSeq === boundary.throughSeq &&
			checked.fields.throughHash === boundary.throughHash &&
			checked.fields.frontier === boundary.frontier
		) {
			boundary = undefined;
		}
		frontier.push(checked.hash);
		lastSeq += 1;
		count += 1;
		prev = checked.hash;
		options.onRecord?.(lastSeq, checked.hash);
		return { seq: lastSeq, ts: checked.ts, hash: checked.hash };
	};

	const scanFile = (file: string): ScanStep => {
		let firstSeq = 0;
		let fileLastSeq = 0;
		let fileLastTs = "";
		let fileLastHash = GENESIS_HASH;
		const step = eachLine(file, fs, (line) => {
			const accepted = acceptLine(line, file);
			if ("reason" in accepted) return accepted.reason;
			if (firstSeq === 0) firstSeq = accepted.seq;
			fileLastSeq = accepted.seq;
			fileLastTs = accepted.ts;
			fileLastHash = accepted.hash;
			return undefined;
		});
		if (step.kind === "ok" && firstSeq > 0) {
			files.push({ path: file, firstSeq, lastSeq: fileLastSeq, lastTs: fileLastTs, lastHash: fileLastHash, frontier: frontier.snapshot() });
		}
		return step;
	};

	for (const file of chainFiles) {
		const step = scanFile(file);
		if (halt !== undefined) return finish(halt, file);
		if (step.kind === "io") return finish({ ok: false, records: count, brokenAt: 0, reason: step.reason }, file);
		if (step.kind === "broken") return finish({ ok: false, records: count, brokenAt: lastSeq + 1, reason: step.reason }, file);
	}
	if (boundary !== undefined) {
		// The reason is the one a chain from genesis gives, so a file that merely lost its head reads the same as before.
		return finish({ ok: false, records: 0, brokenAt: 1, reason: `seq ${boundary.throughSeq + 1} where 1 was expected` }, boundary.file);
	}
	return finish({ ok: true, records: count, lastHash: prev }, path);
}

/**
 * Verifies the chain at `path` without writing anything: the sealed segments next to it and the file itself. A missing
 * file is an empty, intact chain. A file that cannot be opened or read is reported as broken at record 0 (an I/O
 * problem, not tampering). Usable by `audit-cli.ts` and by external monitoring.
 */
export function verifyAuditFile(path: string): AuditVerification {
	return scanChain(path, nodeFs).verification;
}

/**
 * Hashes of the records at the given seqs in the chain at `path`. A seq with no record is absent from the map. The
 * chain is scanned without checking the result, so callers verify it first (`verifyAuditFile`).
 */
export function recordHashes(path: string, seqs: readonly number[]): Map<number, string> {
	const wanted = new Set(seqs);
	const found = new Map<number, string>();
	scanChain(path, nodeFs, {
		onRecord: (seq, hash) => {
			if (wanted.has(seq)) found.set(seq, hash);
		},
	});
	return found;
}

function writeAll(fs: AuditFs, fd: number, data: Buffer): void {
	let offset = 0;
	while (offset < data.length) {
		offset += fs.writeSync(fd, data, offset, data.length - offset);
	}
}

/** Size of a file, or undefined when it does not exist. */
function sizeOf(path: string, fs: AuditFs): number | undefined {
	try {
		return fs.statSync(path).size;
	} catch {
		return undefined;
	}
}

/** Identity of a file (size, mtime, inode), or undefined when it does not exist. */
function fingerprintOf(path: string, fs: AuditFs): Fingerprint | undefined {
	try {
		const stat = fs.statSync(path);
		return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
	} catch {
		return undefined;
	}
}

/** Fsyncs the directory that holds `path`, so a file created or renamed there survives a crash. Throws on failure. */
function fsyncDirectory(fs: AuditFs, path: string): void {
	const dirFd = fs.openSync(dirname(path), "r");
	try {
		fs.fsyncSync(dirFd);
	} finally {
		fs.closeSync(dirFd);
	}
}

/** True when two file identities describe the same state; two absent files match. */
function sameIdentity(a: Fingerprint | undefined, b: Fingerprint | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/**
 * Opens (or creates, `0600`) the audit file and continues its chain. An existing chain is verified first; a broken
 * active file (truncated by a crash, edited, reordered) is moved to `${path}.corrupt-<now>` and reported through
 * `onNotice`, and the chain continues after the sealed segments that still verify (a fresh chain when there are none).
 * Throws only for invalid options and for the cases where the process would run without an audit trail: the file cannot
 * be opened for append (missing or non-writable directory), an existing file cannot be read, a broken file cannot be
 * quarantined, or a sealed segment is broken. Startup fails fast instead of silently losing events.
 */
export function createAuditLog(options: AuditLogOptions): AuditLog {
	if (typeof options !== "object" || options === null) throw new Error("audit log: options must be an object");
	if (typeof options.path !== "string" || options.path.trim().length === 0) throw new Error("audit log: path must be a non-empty string");
	if (options.now !== undefined && typeof options.now !== "function") throw new Error("audit log: now must be a function");
	if (options.onError !== undefined && typeof options.onError !== "function") throw new Error("audit log: onError must be a function");
	if (options.onNotice !== undefined && typeof options.onNotice !== "function") throw new Error("audit log: onNotice must be a function");
	if (options.onAppend !== undefined && typeof options.onAppend !== "function") throw new Error("audit log: onAppend must be a function");
	if (options.anchorEvery !== undefined && !(Number.isInteger(options.anchorEvery) && options.anchorEvery >= 1 && options.anchorEvery <= MAX_ANCHOR_EVERY)) {
		throw new Error("audit log: anchorEvery must be an integer 1..1000000");
	}
	if (options.segmentBytes !== undefined && !(Number.isInteger(options.segmentBytes) && options.segmentBytes >= MIN_SEGMENT_BYTES)) {
		throw new Error("audit log: segmentBytes must be an integer of at least 1048576");
	}
	const path = options.path;
	const now = options.now ?? Date.now;
	const fs = options.fs ?? nodeFs;
	const onError = options.onError;
	const onNotice = options.onNotice;
	const onAppend = options.onAppend;
	const anchorEvery = options.anchorEvery ?? DEFAULT_ANCHOR_EVERY;
	const segmentBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
	let closed = false;

	const report = (error: Error): void => {
		if (!onError) return;
		try {
			onError(error);
		} catch {
			// The error sink is best effort.
		}
	};

	const notify = (kind: AuditNoticeKind, message: string): void => {
		if (!onNotice) return;
		try {
			onNotice({ kind, message });
		} catch {
			// The notice sink is best effort.
		}
	};

	let seq = 0;
	let prev = GENESIS_HASH;
	let frontier = createFrontier();
	let sinceAnchor = 0;
	let activeFirst = 1;
	let fingerprint: Fingerprint | undefined;
	// The identity of the active file as this log last left it. Undefined means the disk must be read before the next append.
	let expected: { fp: Fingerprint | undefined } | undefined;

	// The single point where the file identity is refreshed; every path that changes the active file calls it.
	const refreshFingerprint = (): void => {
		fingerprint = fingerprintOf(path, fs);
		expected = { fp: fingerprint };
	};

	const adopt = (scan: ChainScan): void => {
		seq = scan.lastSeq;
		prev = scan.lastHash;
		frontier = scan.frontier;
		sinceAnchor = scan.sinceAnchor;
		activeFirst = scan.activeFirst;
	};

	/**
	 * Moves a broken active file aside and continues after the sealed segments, which must verify on their own. Returns
	 * the reason the log cannot continue (a broken sealed segment, or a file that cannot be quarantined), or undefined
	 * once the state is adopted. Nothing is moved unless the sealed segments verify.
	 */
	function recoverFrom(check: ChainScan): string | undefined {
		const verdict = check.verification;
		if (verdict.ok) return undefined;
		if (check.brokenIn !== path) {
			return `sealed segment ${check.brokenIn} is broken at record ${verdict.brokenAt} (${verdict.reason}); the chain cannot continue`;
		}
		const sealed = scanChain(path, fs, { sealedOnly: true });
		if (!sealed.verification.ok) return `the sealed segments do not verify: ${sealed.verification.reason}`;
		const quarantine = `${path}.corrupt-${stamp(now).replace(/[:.]/g, "-")}`;
		try {
			fs.renameSync(path, quarantine);
		} catch (error) {
			return `${path} is broken at record ${verdict.brokenAt} (${verdict.reason}) and cannot be quarantined: ${errorOf(error).message}`;
		}
		const next = sealed.lastSeq > 0 ? "continuing after the sealed segments" : "starting a new chain";
		notify("moved_to", `audit log: ${path} broken at record ${verdict.brokenAt} (${verdict.reason}); moved to ${quarantine}, ${next}`);
		adopt(sealed);
		return undefined;
	}

	const startup = scanChain(path, fs);
	if (startup.verification.ok) {
		adopt(startup);
	} else if (startup.verification.brokenAt === 0) {
		// Unreadable, not tampered: quarantining could hide a good file, so refuse to start without an audit trail.
		throw new Error(`audit log: cannot verify ${path}: ${startup.verification.reason}`);
	} else {
		const reason = recoverFrom(startup);
		if (reason !== undefined) throw new Error(`audit log: ${reason}`);
	}

	// Open for append once: the directory is writable (or startup fails), the file exists and is private.
	const existed = sizeOf(path, fs) !== undefined;
	let probe: number;
	try {
		probe = fs.openSync(path, "a", 0o600);
	} catch (error) {
		throw new Error(`audit log: cannot open ${path} for append: ${errorOf(error).message}`);
	}
	try {
		fs.fchmodSync(probe, 0o600);
	} catch {
		// Not the owner: the mode set at creation stands.
	} finally {
		fs.closeSync(probe);
	}
	if (!existed) {
		try {
			fsyncDirectory(fs, path);
		} catch (error) {
			throw new Error(`audit log: cannot sync the directory of ${path}: ${errorOf(error).message}`);
		}
	}

	refreshFingerprint();

	/**
	 * Re-reads the chain from disk and adopts it, so an outside change (a rotated, removed or edited file) does not break
	 * the chain. A chain that no longer verifies is repaired as at startup. False when the record must be dropped.
	 */
	function adoptDisk(): boolean {
		const check = scanChain(path, fs);
		const verdict = check.verification;
		if (verdict.ok) {
			if (check.lastSeq !== seq || check.lastHash !== prev) {
				notify("changed_outside", `audit log: ${path} changed outside the service; continuing from the file on disk`);
			}
			adopt(check);
			refreshFingerprint();
			return true;
		}
		if (verdict.brokenAt === 0) {
			report(new Error(`audit log: cannot verify ${path}: ${verdict.reason}; record dropped`));
			expected = undefined;
			return false;
		}
		const reason = recoverFrom(check);
		if (reason !== undefined) {
			report(new Error(`audit log: ${reason}; record dropped`));
			expected = undefined;
			return false;
		}
		refreshFingerprint();
		return true;
	}

	/** Brings the in-memory state in line with the file before a write. False when the record must be dropped. */
	function ensureDisk(): boolean {
		if (expected !== undefined && sameIdentity(fingerprintOf(path, fs), expected.fp)) return true;
		return adoptDisk();
	}

	/**
	 * Renames the full active file to `audit-<activeFirst>-<seq>.jsonl`, makes it read-only and syncs the directory. Returns
	 * false when the rename fails; the caller then keeps appending to the active file.
	 */
	function seal(): boolean {
		const name = sealedName(activeFirst, seq);
		const target = join(dirname(path), name);
		if (fs.existsSync(target)) {
			report(new Error(`audit log: cannot seal ${path}: ${name} already exists; appending to the active file`));
			return false;
		}
		try {
			fs.renameSync(path, target);
		} catch (error) {
			report(new Error(`audit log: cannot seal ${path} as ${name}: ${errorOf(error).message}; appending to the active file`));
			return false;
		}
		try {
			const fd = fs.openSync(target, "r");
			try {
				fs.fchmodSync(fd, 0o400);
			} finally {
				fs.closeSync(fd);
			}
		} catch (error) {
			report(new Error(`audit log: ${name} is sealed but not read-only: ${errorOf(error).message}`));
		}
		try {
			fsyncDirectory(fs, path);
		} catch (error) {
			report(new Error(`audit log: ${name} is sealed but the directory was not synced: ${errorOf(error).message}`));
		}
		activeFirst = seq + 1;
		expected = undefined;
		return true;
	}

	/**
	 * Writes one chained line and fsyncs it, then updates the state. Returns the line, or undefined when it was dropped
	 * (and reported). Anchors and ordinary records both go through here; callers own the anchor counter and streaming.
	 */
	function appendLine(event: AuditEvent, fields: Record<string, Primitive>, label: string): AuditRecord | undefined {
		if (!ensureDisk()) return undefined;
		const nextSeq = seq + 1;
		const ts = stamp(now);
		const hash = hashRecord(nextSeq, ts, event, prev, fields);
		const line: AuditRecord = { seq: nextSeq, ts, event, prev, hash, fields };
		const data = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
		const sizeBefore = sizeOf(path, fs);
		let before = sizeBefore ?? 0;
		let created = sizeBefore === undefined;
		// Only a non-empty active file is sealed, so a record larger than the limit never leaves an empty segment behind.
		if (before > 0 && before + data.length > segmentBytes && seal()) {
			before = 0;
			created = true;
		}
		// Reopened per append (O_APPEND): a rotated or removed file is recreated instead of written into an unlinked inode.
		let fd: number | undefined;
		try {
			fd = fs.openSync(path, "a", 0o600);
			writeAll(fs, fd, data);
			fs.fsyncSync(fd);
			// A file this append created is durable only once its directory entry is synced too.
			if (created) fsyncDirectory(fs, path);
		} catch (error) {
			report(new Error(`audit log: ${label} dropped: ${errorOf(error).message}`));
			// Roll back whatever part of the record reached the file, so the chain on disk still ends at the last acknowledged record.
			let truncated = true;
			try {
				fs.truncateSync(path, before);
			} catch {
				truncated = false;
			}
			refreshFingerprint();
			if (!truncated) expected = undefined;
			return undefined;
		} finally {
			if (fd !== undefined) {
				try {
					fs.closeSync(fd);
				} catch {
					// The data is already synced.
				}
			}
		}
		seq = nextSeq;
		prev = hash;
		frontier.push(hash);
		refreshFingerprint();
		return line;
	}

	/** Passes an acknowledged record to the streaming hook. Its exceptions are reported; the record stays in the chain. */
	function notifyAppended(line: AuditRecord): void {
		if (!onAppend) return;
		try {
			onAppend(line);
		} catch (error) {
			report(new Error(`audit log: onAppend failed for record ${line.seq}: ${errorOf(error).message}`));
		}
	}

	/** Counts an acknowledged ordinary record toward the next anchor, streams it, and anchors when due. */
	function commit(line: AuditRecord): void {
		sinceAnchor += 1;
		notifyAppended(line);
		anchorIfDue();
	}

	/** Appends `audit_anchor` once `anchorEvery` non-anchor records have been written. A failed anchor is retried after the next record. */
	function anchorIfDue(): void {
		if (closed || sinceAnchor < anchorEvery) return;
		if (!ensureDisk() || sinceAnchor < anchorEvery) return;
		// `through` names the record before the anchor, and `root` commits to every record up to it.
		const line = appendLine(ANCHOR_EVENT, { through: seq, root: frontier.root() }, "anchor");
		if (line === undefined) return;
		sinceAnchor = 0;
		notifyAppended(line);
	}

	/**
	 * Writes one `audit_retention_pruned` record naming `files` as deleted: the first and last seq, the hash of the last one,
	 * and the anchor frontier over every record through it. Undefined when the record was dropped (and reported).
	 */
	function retain(files: readonly ScannedFile[]): AuditRecord | undefined {
		const last = files[files.length - 1] as ScannedFile;
		const line = appendLine(RETENTION_EVENT, { segments: files.length, fromSeq: files[0]?.firstSeq ?? 0, throughSeq: last.lastSeq, throughHash: last.lastHash, frontier: JSON.stringify(last.frontier) }, "retention record");
		if (line !== undefined) commit(line);
		return line;
	}

	/** Deletes the eligible sealed segments and records the boundary; see `AuditLog.prune`. */
	function prune(cutoffMs: number): { segments: number } {
		if (closed) {
			report(new Error("audit log: prune after close dropped"));
			return { segments: 0 };
		}
		if (!ensureDisk()) return { segments: 0 };
		const scan = scanChain(path, fs);
		const verdict = scan.verification;
		if (!verdict.ok) {
			report(new Error(`audit log: prune skipped: ${path} does not verify: ${verdict.reason}`));
			return { segments: 0 };
		}
		const eligible: ScannedFile[] = [];
		for (const file of scan.files) {
			if (file.path === path || !(Date.parse(file.lastTs) < cutoffMs)) break;
			eligible.push(file);
		}
		if (eligible.length === 0) return { segments: 0 };
		// The boundary is written and fsynced before the first delete. If it cannot be written, nothing is deleted.
		if (retain(eligible) === undefined) return { segments: 0 };
		const removed: ScannedFile[] = [];
		for (const file of eligible) {
			try {
				fs.unlinkSync(file.path);
			} catch (error) {
				report(new Error(`audit log: prune stopped at ${file.path}: ${errorOf(error).message}`));
				break;
			}
			removed.push(file);
		}
		const through = removed.at(-1);
		// Nothing was deleted: the record above names segments that are still present. Its frontier is still correct, so
		// verification is unaffected, and the next prune writes its own record.
		if (through === undefined) return { segments: 0 };
		// A delete failed after the boundary was written, so the chain now starts after `through`, which that record does not
		// name. A second record names it, so the chain on disk still verifies.
		if (removed.length < eligible.length) retain(removed);
		notify("pruned", `audit log: pruned ${removed.length} sealed segment(s) through record ${through.lastSeq}`);
		return { segments: removed.length };
	}

	return {
		path,
		record(event, fields) {
			if (closed) {
				report(new Error("audit log: record after close dropped"));
				return;
			}
			if (event === ANCHOR_EVENT || event === RETENTION_EVENT) {
				report(new Error(`audit log: ${event} is written by the log only; record dropped`));
				return;
			}
			const line = appendLine(event, sanitizeFields(fields), "record");
			if (line === undefined) return;
			commit(line);
		},
		verify() {
			return scanChain(path, fs).verification;
		},
		head() {
			return { seq, hash: prev };
		},
		fingerprint() {
			return fingerprint;
		},
		prune,
		close() {
			closed = true;
		},
	};
}
