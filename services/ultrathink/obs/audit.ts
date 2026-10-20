// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Tamper-evident security audit trail (Refs SPE-17437).
 *
 * An append-only JSON Lines file, one record per line, each record carrying the SHA-256 of the previous record so
 * that editing, removing or reordering any line breaks the chain from that line on. The file is created `0600` and
 * every append is fsynced; security events are rare, so durability wins over throughput.
 *
 * The log is tamper-evident, not tamper-proof: whoever can rewrite the whole file can recompute the whole chain, and
 * removing records from the *end* is only visible against an externally kept `lastHash`. Operators who need that
 * guarantee ship the `verify()` result (or `audit-cli.ts verify`) off-host periodically.
 */

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";

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
	| "rate_limited";

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
];

/** One line of the file. `hash = sha256hex(prev + "\n" + canonical({seq, ts, event, prev, fields}))` with sorted keys. */
export interface AuditRecord {
	/** 1-based, dense, continues across reopen. */
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

/** The `node:fs` surface the log uses; injectable so tests can simulate I/O failures without touching permissions. */
export type AuditFs = Pick<typeof nodeFs, "openSync" | "closeSync" | "readSync" | "writeSync" | "fsyncSync" | "fchmodSync" | "renameSync" | "existsSync">;

export interface AuditLogOptions {
	/** Path of the JSON Lines file. Its directory must already exist and be writable. */
	path: string;
	/** Clock in epoch milliseconds; defaults to `Date.now`. */
	now?: () => number;
	/**
	 * Receives every failure the log swallows: a quarantined file on open, a dropped record on write failure. Each
	 * distinct write-failure message is reported once until a later append succeeds. The callback must not throw;
	 * if it does, the error is discarded.
	 */
	onError?: (error: Error) => void;
	/** File-system hooks; defaults to `node:fs`. */
	fs?: AuditFs;
}

export type AuditVerification =
	| { ok: true; records: number; lastHash: string }
	| {
			ok: false;
			/** Records that verified before the break. */
			records: number;
			/** 1-based line number of the first bad record; 0 when the file could not be opened or read (I/O, not tampering). */
			brokenAt: number;
			reason: string;
	  };

export interface AuditLog {
	readonly path: string;
	/**
	 * Appends one record and fsyncs it. Never throws: on I/O failure the record is dropped (fail-open: the request
	 * that caused the event continues) and `onError` is called once per distinct failure message. Unknown values in
	 * `fields` are dropped (only finite numbers, booleans and strings are kept), keys that look like secrets are
	 * dropped, strings are clipped to 256 characters with control characters removed, and at most 32 keys are kept.
	 */
	record(event: AuditEvent, fields?: Record<string, unknown>): void;
	/** Full scan of the file on disk, constant memory per line. Reads with the log's `fs` hooks. */
	verify(): AuditVerification;
	/** Further `record()` calls are dropped (reported once through `onError`). Idempotent. */
	close(): void;
}

/** 64 zeros: the `prev` of the first record. */
export const GENESIS_HASH = "0".repeat(64);
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
function checkLine(line: string, expectedSeq: number, expectedPrev: string): { hash: string } | { reason: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { reason: "not valid JSON" };
	}
	if (!isPlainObject(parsed)) return { reason: "record is not an object" };
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
	return { hash };
}

// Streams the file in fixed-size chunks and checks each line in turn; memory is bounded by the longest single line.
// I/O failures (cannot open or read) report `brokenAt: 0`; `records` then says how far the scan got.
function scanChain(path: string, fs: AuditFs): AuditVerification {
	let fd: number;
	try {
		if (!fs.existsSync(path)) return { ok: true, records: 0, lastHash: GENESIS_HASH };
		fd = fs.openSync(path, "r");
	} catch (error) {
		return { ok: false, records: 0, brokenAt: 0, reason: `cannot open: ${errorOf(error).message}` };
	}
	let records = 0;
	let prev = GENESIS_HASH;
	const broken = (reason: string): AuditVerification => ({ ok: false, records, brokenAt: records + 1, reason });
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
				const lineBytes = pendingBytes + tail.length;
				if (lineBytes > MAX_LINE_BYTES) return broken("record exceeds the maximum line length");
				const line = pending.length === 0 ? tail.toString("utf8") : Buffer.concat([...pending, tail]).toString("utf8");
				pending.length = 0;
				pendingBytes = 0;
				const checked = checkLine(line, records + 1, prev);
				if ("reason" in checked) return broken(checked.reason);
				records += 1;
				prev = checked.hash;
				start = i + 1;
			}
			if (start < read) {
				if (pendingBytes + (read - start) > MAX_LINE_BYTES) return broken("record exceeds the maximum line length");
				pending.push(Buffer.from(chunk.subarray(start, read)));
				pendingBytes += read - start;
			}
		}
		if (pendingBytes > 0) return broken("truncated last record (no trailing newline)");
		return { ok: true, records, lastHash: prev };
	} catch (error) {
		return { ok: false, records, brokenAt: 0, reason: `cannot read: ${errorOf(error).message}` };
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			// Nothing left to release.
		}
	}
}

/**
 * Verifies the chain in the file at `path` without writing anything. A missing file is an empty, intact chain. A
 * file that cannot be opened or read is reported as broken at record 0 (an I/O problem, not tampering). Usable by
 * `audit-cli.ts` and by external monitoring.
 */
export function verifyAuditFile(path: string): AuditVerification {
	return scanChain(path, nodeFs);
}

function writeAll(fs: AuditFs, fd: number, data: Buffer): void {
	let offset = 0;
	while (offset < data.length) {
		offset += fs.writeSync(fd, data, offset, data.length - offset);
	}
}

/**
 * Opens (or creates, `0600`) the audit file and continues its chain. An existing file is verified first; a broken
 * one (truncated by a crash, edited, reordered) is moved to `${path}.corrupt-<now>` and reported through `onError`,
 * and a fresh chain starts at seq 1. Throws only for invalid options and for the cases where the process would run
 * without an audit trail: the file cannot be opened for append (missing or non-writable directory), an existing
 * file cannot be read, or a broken file cannot be quarantined. Startup fails fast instead of silently losing events.
 */
export function createAuditLog(options: AuditLogOptions): AuditLog {
	if (typeof options !== "object" || options === null) throw new Error("audit log: options must be an object");
	if (typeof options.path !== "string" || options.path.trim().length === 0) throw new Error("audit log: path must be a non-empty string");
	if (options.now !== undefined && typeof options.now !== "function") throw new Error("audit log: now must be a function");
	if (options.onError !== undefined && typeof options.onError !== "function") throw new Error("audit log: onError must be a function");
	const path = options.path;
	const now = options.now ?? Date.now;
	const fs = options.fs ?? nodeFs;
	const onError = options.onError;
	const reported = new Set<string>();
	let closed = false;

	const report = (error: Error): void => {
		if (!onError) return;
		try {
			onError(error);
		} catch {
			// The error sink is best effort.
		}
	};
	const reportOnce = (error: Error): void => {
		if (reported.has(error.message)) return;
		reported.add(error.message);
		report(error);
	};

	let seq = 0;
	let prev = GENESIS_HASH;
	const scan = scanChain(path, fs);
	if (scan.ok) {
		seq = scan.records;
		prev = scan.lastHash;
	} else if (scan.brokenAt === 0) {
		// Unreadable, not tampered: quarantining could hide a good file, so refuse to start without an audit trail.
		throw new Error(`audit log: cannot verify ${path}: ${scan.reason}`);
	} else {
		const quarantine = `${path}.corrupt-${stamp(now).replace(/[:.]/g, "-")}`;
		try {
			fs.renameSync(path, quarantine);
		} catch (error) {
			throw new Error(`audit log: ${path} is broken at record ${scan.brokenAt} (${scan.reason}) and cannot be quarantined: ${errorOf(error).message}`);
		}
		report(new Error(`audit log: ${path} broken at record ${scan.brokenAt} (${scan.reason}); moved to ${quarantine}, starting a new chain`));
	}

	// Open for append once: the directory is writable (or startup fails), the file exists and is private.
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

	return {
		path,
		record(event, fields) {
			if (closed) {
				reportOnce(new Error("audit log: record after close dropped"));
				return;
			}
			const nextSeq = seq + 1;
			const ts = stamp(now);
			const clean = sanitizeFields(fields);
			const hash = hashRecord(nextSeq, ts, event, prev, clean);
			const line: AuditRecord = { seq: nextSeq, ts, event, prev, hash, fields: clean };
			const data = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
			// Reopened per append (O_APPEND): a rotated or removed file is recreated instead of written into an unlinked inode.
			let fd: number | undefined;
			try {
				fd = fs.openSync(path, "a", 0o600);
				writeAll(fs, fd, data);
				fs.fsyncSync(fd);
			} catch (error) {
				reportOnce(new Error(`audit log: record dropped: ${errorOf(error).message}`));
				return;
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
			reported.clear();
		},
		verify() {
			return scanChain(path, fs);
		},
		close() {
			closed = true;
		},
	};
}
