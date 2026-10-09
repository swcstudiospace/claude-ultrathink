// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The one way ultrathink persists a state file and the one cross-process lock around a read-modify-write.
 * Hooks are short-lived processes that overlap, so an in-process mutex cannot protect a session file, and a plain
 * `writeFileSync` leaves a truncated file behind when the process dies mid-write. Session records hold verbatim
 * prompts, so files are owner-only (`0600` in `0700` directories). Constraint: never throw for a lock problem and
 * never block a prompt; a lock that cannot be taken in time degrades to running the callback unlocked.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The synchronous file calls `writeFileAtomic` needs, so a test can make one of them fail. */
export interface AtomicFs {
	mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
	openSync(path: string, flags: string, mode: number): number;
	writeSync(fd: number, data: Uint8Array): number;
	fsyncSync(fd: number): void;
	closeSync(fd: number): void;
	renameSync(from: string, to: string): void;
	unlinkSync(path: string): void;
}

export interface AtomicWriteOptions {
	/** File mode of the new file (default 0o600). */
	mode?: number;
	/** Mode of directories this call creates (default 0o700). */
	dirMode?: number;
	/** Overrides for individual file calls (default: node:fs). */
	fs?: Partial<AtomicFs>;
}

const NODE_FS: AtomicFs = { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync };

const TEXT = new TextEncoder();

/**
 * Replaces `path` with `data`: a temporary file in the same directory is written and flushed, then renamed over the
 * target, so a reader sees the old file or the new one and never a partial one. On failure the temporary file is
 * removed and the original error is rethrown.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
	const fs: AtomicFs = { ...NODE_FS, ...options.fs };
	const dir = dirname(path);
	const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	const bytes = typeof data === "string" ? TEXT.encode(data) : data;
	let fd: number | undefined;
	try {
		fs.mkdirSync(dir, { recursive: true, mode: options.dirMode ?? 0o700 });
		fd = fs.openSync(tmp, "wx", options.mode ?? 0o600);
		let offset = 0;
		while (offset < bytes.length) offset += fs.writeSync(fd, bytes.subarray(offset));
		fs.fsyncSync(fd);
		const done = fd;
		fd = undefined;
		fs.closeSync(done);
		fs.renameSync(tmp, path);
	} catch (error) {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// the original error is the one to report
			}
		}
		try {
			fs.unlinkSync(tmp);
		} catch {
			// the temporary file may not exist yet
		}
		throw error;
	}
}

export interface LockOptions {
	/** A lock file older than this is a crashed holder's and is reclaimed (default 10 s). */
	staleMs?: number;
	/** How long to wait for a held lock before running unlocked (default 2 s). */
	timeoutMs?: number;
	/** Base wait between attempts (default 15 ms, plus up to the same again as jitter). */
	pollMs?: number;
	now?: () => number;
	/** Blocks for the given milliseconds (default: `Atomics.wait`, so a one-shot hook can wait without async). */
	sleep?: (ms: number) => void;
	/** Receives one line when the lock could not be taken and the callback ran unlocked. */
	log?: (message: string) => void;
}

function blockingSleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

type Reclaim = "reclaimed" | "fresh" | "gone";

/**
 * Moves a stale lock (older than `staleMs`) aside so a crashed holder stops blocking, then discards it. Of several
 * processes that all see it stale, exactly one rename succeeds; the losers see the name vanish and retry.
 *
 * Compare-and-swap on lock identity: between reading the lock and moving it, another waiter may have reclaimed the
 * stale token and retaken the name, so the file moved aside is checked against the exact stale token seen. A file
 * holding any other token is a successor's live lock and is put back, never discarded.
 */
function reclaimStale(lockPath: string, staleMs: number, now: () => number): Reclaim {
	let staleToken: string;
	try {
		if (now() - statSync(lockPath).mtimeMs <= staleMs) return "fresh";
		staleToken = readFileSync(lockPath, "utf8");
	} catch (error) {
		return errorCode(error) === "ENOENT" ? "gone" : "fresh";
	}
	const aside = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		renameSync(lockPath, aside);
	} catch (error) {
		return errorCode(error) === "ENOENT" ? "gone" : "fresh";
	}
	try {
		// Only the exact stale token seen above may be discarded. Any other token (or a fresh mtime) means the
		// lock was reclaimed and retaken between our read and our rename: the file aside is a live lock.
		if (readFileSync(aside, "utf8") === staleToken && now() - statSync(aside).mtimeMs > staleMs) {
			try {
				unlinkSync(aside);
			} catch {
				// a leftover .tmp file is harmless
			}
			return "reclaimed";
		}
	} catch {
		// The aside copy cannot be verified; fall through and try to put the name back.
	}
	restoreStolen(lockPath, aside);
	return "fresh";
}

/**
 * Puts a live lock that was mistakenly moved aside back under its name. A third process may have claimed the free
 * name meanwhile, and its token must never be overwritten: `linkSync` atomically refuses when the name exists, so
 * the restore either lands in a free name or is dropped in favor of the current holder.
 */
function restoreStolen(lockPath: string, aside: string): void {
	try {
		linkSync(aside, lockPath);
		try {
			unlinkSync(aside);
		} catch {
			// the lock itself is back in place; a leftover .tmp file is harmless
		}
		return;
	} catch (error) {
		if (errorCode(error) !== "EEXIST") {
			// Hard links may be unsupported: fall back to a rename, but only into a still-free name.
			let free = false;
			try {
				readFileSync(lockPath, "utf8");
			} catch (readError) {
				free = errorCode(readError) === "ENOENT";
			}
			if (free) {
				try {
					renameSync(aside, lockPath);
					return;
				} catch {
					// fall through and clean up below
				}
			}
		}
		// The name is held by someone else now; drop our copy rather than overwrite their token.
		try {
			unlinkSync(aside);
		} catch {
			// a leftover .tmp file is harmless
		}
	}
}

/** Returns our token once the lock file is ours, or undefined when the callback should run unlocked. */
function acquire(lockPath: string, options: LockOptions): string | undefined {
	const staleMs = options.staleMs ?? 10_000;
	const timeoutMs = options.timeoutMs ?? 2_000;
	const pollMs = options.pollMs ?? 15;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? blockingSleep;
	const token = randomBytes(16).toString("hex");
	const started = now();
	for (let attempt = 0; ; attempt++) {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			try {
				writeSync(fd, token);
			} catch (error) {
				try {
					unlinkSync(lockPath);
				} catch {
					// best effort
				}
				throw error;
			} finally {
				closeSync(fd);
			}
			return token;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				options.log?.(`lock unavailable for ${basename(lockPath)}, writing unlocked: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			}
		}
		// A reclaimed or vanished lock is worth an immediate retry; the cap keeps a flapping lock from spinning forever.
		if (reclaimStale(lockPath, staleMs, now) !== "fresh" && attempt < 1_000) continue;
		if (now() - started >= timeoutMs) {
			options.log?.(`lock ${basename(lockPath)} still held after ${timeoutMs} ms, writing unlocked`);
			return undefined;
		}
		sleep(pollMs + Math.floor(Math.random() * (pollMs + 1)));
	}
}

function release(lockPath: string, token: string): void {
	try {
		if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
	} catch {
		// the lock is already gone or no longer ours
	}
}

/**
 * Runs `fn` while holding `<target>.lock`, so overlapping processes take turns on one read-modify-write. A stale or
 * unobtainable lock never blocks: past `timeoutMs`, or on any lock bookkeeping error, `fn` runs unlocked. Errors
 * thrown by `fn` propagate. `fn` must not take the same lock again.
 */
export function withFileLock<T>(target: string, fn: () => T, options: LockOptions = {}): T {
	const lockPath = `${target}.lock`;
	const token = acquire(lockPath, options);
	if (token === undefined) return fn();
	try {
		return fn();
	} finally {
		release(lockPath, token);
	}
}
