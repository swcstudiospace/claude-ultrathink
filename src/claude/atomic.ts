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
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
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
	/** A lock file older than this is reclaimed as an expired lease (default 10 s). */
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

const SLEEP_WORD = new Int32Array(new SharedArrayBuffer(4));

function blockingSleep(ms: number): void {
	Atomics.wait(SLEEP_WORD, 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function discardGuard(path: string, owner: string): void {
	try {
		unlinkSync(join(path, owner));
	} catch {
		return;
	}
	try {
		rmdirSync(path);
	} catch {
		// A successor may already have atomically replaced the now-empty directory.
	}
}

const GUARD_OWNER = /^[1-9]\d*\.[a-f0-9]{32}$/;

function deadGuardOwner(owner: string): boolean {
	if (!GUARD_OWNER.test(owner)) return false;
	try {
		process.kill(Number.parseInt(owner, 10), 0);
		return false;
	} catch (error) {
		return errorCode(error) === "ESRCH";
	}
}

function reclaimDeadGuard(path: string): void {
	try {
		const owners = readdirSync(path);
		const owner = owners[0];
		if (owners.length !== 1 || !owner || !deadGuardOwner(owner)) return;
		discardGuard(path, owner);
	} catch {
		// An unverifiable owner remains held.
	}
}

/** Removes only a prepared guard candidate whose immutable named owner is dead; a dry run changes nothing. */
export function removeDeadLockCandidate(path: string, dryRun = false): boolean {
	const owner = basename(path).match(/\.lock\.guard\.([1-9]\d*\.[a-f0-9]{32})\.tmp$/)?.[1];
	if (!owner || !deadGuardOwner(owner)) return false;
	try {
		if (!lstatSync(path).isDirectory()) return false;
		const entries = readdirSync(path);
		if (entries.length > 1 || (entries.length === 1 && entries[0] !== owner)) return false;
		if (entries.length === 1) {
			const marker = lstatSync(join(path, owner));
			if (!marker.isFile() || marker.size !== 0) return false;
		}
		if (dryRun) return true;
		if (entries.length === 1) unlinkSync(join(path, owner));
		rmdirSync(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

/**
 * Serializes lock-name creation, reclamation and release, not the protected RMW itself. A prepared nonempty
 * directory is renamed into the guard name atomically; it cannot replace another owner's nonempty directory.
 * Dead-owner recovery unlinks only that owner's unique entry, so a delayed recovery cannot remove a successor.
 * Returns undefined when busy; other filesystem errors and callback errors propagate to the caller's policy.
 */
export function withLockMutation<T>(lockPath: string, fn: () => T): T | undefined {
	const guard = `${lockPath}.guard`;
	const owner = `${process.pid}.${randomBytes(16).toString("hex")}`;
	const candidate = `${guard}.${owner}.tmp`;
	let fd: number | undefined;
	let prepared = false;
	let claimed = false;
	try {
		mkdirSync(candidate, { mode: 0o700 });
		prepared = true;
		fd = openSync(join(candidate, owner), "wx", 0o600);
		closeSync(fd);
		fd = undefined;
		try {
			renameSync(candidate, guard);
		} catch (error) {
			if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOTEMPTY") throw error;
			reclaimDeadGuard(guard);
			try {
				renameSync(candidate, guard);
			} catch (retryError) {
				if (errorCode(retryError) === "EEXIST" || errorCode(retryError) === "ENOTEMPTY") return undefined;
				throw retryError;
			}
		}
		claimed = true;
		return fn();
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* best effort after a preparation error */ }
		}
		if (claimed) discardGuard(guard, owner);
		else if (prepared) {
			try { unlinkSync(join(candidate, owner)); } catch { /* preparation may not have reached the file */ }
			try { rmdirSync(candidate); } catch { /* orphan pruning can reclaim the dead owner's prepared candidate */ }
		}
	}
}

type Reclaim = "reclaimed" | "fresh" | "gone";

/** Called only while holding the mutation guard, so the stale name cannot become a successor during deletion. */
function reclaimStale(lockPath: string, staleMs: number, now: () => number): Reclaim {
	try {
		if (now() - statSync(lockPath).mtimeMs <= staleMs) return "fresh";
		unlinkSync(lockPath);
		return "reclaimed";
	} catch (error) {
		return errorCode(error) === "ENOENT" ? "gone" : "fresh";
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
		let retry: string | boolean | undefined;
		try {
			retry = withLockMutation(lockPath, () => {
				try {
					const fd = openSync(lockPath, "wx", 0o600);
					try {
						writeSync(fd, token);
					} catch (error) {
						try { unlinkSync(lockPath); } catch { /* best effort */ }
						throw error;
					} finally {
						closeSync(fd);
					}
					return token;
				} catch (error) {
					if (errorCode(error) !== "EEXIST") throw error;
				}
				return reclaimStale(lockPath, staleMs, now) !== "fresh";
			});
		} catch (error) {
			options.log?.(`lock unavailable for ${basename(lockPath)}, writing unlocked: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
		if (typeof retry === "string") return retry;
		// Reclaimed names retry immediately, but every retry takes the same mutation guard.
		if (retry === true && attempt < 1_000) continue;
		if (now() - started >= timeoutMs) {
			options.log?.(`lock ${basename(lockPath)} still held after ${timeoutMs} ms, writing unlocked`);
			return undefined;
		}
		sleep(pollMs + Math.floor(Math.random() * (pollMs + 1)));
	}
}

function release(lockPath: string, token: string, options: LockOptions): void {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? blockingSleep;
	const started = now();
	for (let attempt = 0; attempt < 1_000; attempt++) {
		try {
			if (withLockMutation(lockPath, () => {
				try {
					if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
				} catch {
					// The lock is already gone or no longer ours.
				}
				return true;
			})) return;
		} catch {
			return;
		}
		if (now() - started >= (options.timeoutMs ?? 2_000)) return;
		sleep(options.pollMs ?? 15);
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
		release(lockPath, token, options);
	}
}
