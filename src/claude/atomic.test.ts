// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "./atomic.ts";
import { readSession, type SessionRecord, sessionPath, writeSession } from "./state.ts";

const WORKER = join(import.meta.dir, "atomic.worker.ts");
const POSIX = process.platform !== "win32";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ultrathink-atomic-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Names in `path` that are neither the target nor a lock: temporary files and aside locks must never be left behind. */
function leftovers(path: string): string[] {
	return readdirSync(path).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock") || name.endsWith(".stale"));
}

describe("writeFileAtomic", () => {
	test("writes the file, creates missing directories and leaves nothing else behind", () => {
		const target = join(dir, "a", "b", "state.json");
		writeFileAtomic(target, '{"x":1}\n');
		expect(readFileSync(target, "utf8")).toBe('{"x":1}\n');
		expect(readdirSync(join(dir, "a", "b"))).toEqual(["state.json"]);
		writeFileAtomic(target, new TextEncoder().encode("bytes"));
		expect(readFileSync(target, "utf8")).toBe("bytes");
		expect(readdirSync(join(dir, "a", "b"))).toEqual(["state.json"]);
	});

	test.skipIf(!POSIX)("the file is owner-only and a directory it creates is 0700", () => {
		const target = join(dir, "private", "state.json");
		writeFileAtomic(target, "{}");
		expect(statSync(target).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "private")).mode & 0o777).toBe(0o700);
	});

	test.skipIf(!POSIX)("a world-readable file is replaced by an owner-only one", () => {
		const target = join(dir, "old.json");
		writeFileSync(target, "old", { mode: 0o644 });
		writeFileAtomic(target, "new");
		expect(readFileSync(target, "utf8")).toBe("new");
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	test.skipIf(!POSIX)("honors an explicit mode and dirMode", () => {
		const target = join(dir, "shared", "state.json");
		writeFileAtomic(target, "{}", { mode: 0o640, dirMode: 0o750 });
		expect(statSync(target).mode & 0o777).toBe(0o640);
		expect(statSync(join(dir, "shared")).mode & 0o777).toBe(0o750);
	});

	test("a failing rename keeps the previous content, removes the temporary file and rethrows", () => {
		const target = join(dir, "state.json");
		writeFileAtomic(target, "previous");
		expect(() =>
			writeFileAtomic(target, "replacement", {
				fs: {
					renameSync: () => {
						throw new Error("rename refused");
					},
				},
			}),
		).toThrow("rename refused");
		expect(readFileSync(target, "utf8")).toBe("previous");
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	test("a failing write removes the temporary file and leaves no target behind", () => {
		const target = join(dir, "state.json");
		expect(() =>
			writeFileAtomic(target, "data", {
				fs: {
					fsyncSync: () => {
						throw new Error("disk full");
					},
				},
			}),
		).toThrow("disk full");
		expect(readdirSync(dir)).toEqual([]);
	});

	test("a large value replaces a small one entirely", () => {
		const target = join(dir, "state.json");
		writeFileAtomic(target, "small");
		const large = "x".repeat(2_000_000);
		writeFileAtomic(target, large);
		expect(readFileSync(target, "utf8")).toBe(large);
		writeFileAtomic(target, "small again");
		expect(readFileSync(target, "utf8")).toBe("small again");
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});
});

describe("withFileLock", () => {
	test("runs the callback, returns its value and releases the lock", () => {
		const target = join(dir, "state.json");
		let during = false;
		const value = withFileLock(target, () => {
			during = existsSync(`${target}.lock`);
			return 42;
		});
		expect(value).toBe(42);
		expect(during).toBe(true);
		expect(existsSync(`${target}.lock`)).toBe(false);
	});

	test.skipIf(!POSIX)("the lock file is owner-only", () => {
		const target = join(dir, "state.json");
		let mode = 0;
		withFileLock(target, () => {
			mode = statSync(`${target}.lock`).mode & 0o777;
		});
		expect(mode).toBe(0o600);
	});

	test("a lock left by a crashed process is reclaimed", () => {
		const target = join(dir, "state.json");
		const lock = `${target}.lock`;
		writeFileSync(lock, "dead-process-token");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		const logs: string[] = [];
		const sleeps: number[] = [];
		let ran = false;
		withFileLock(
			target,
			() => {
				ran = true;
				expect(readFileSync(lock, "utf8")).not.toBe("dead-process-token");
			},
			{ log: (message) => logs.push(message), sleep: (ms) => sleeps.push(ms) },
		);
		expect(ran).toBe(true);
		expect(sleeps).toEqual([]);
		expect(logs).toEqual([]);
		expect(leftovers(dir)).toEqual([]);
	});

	test("a crashed mutation owner is reclaimed before the protected record is updated", () => {
		const target = join(dir, "state.json");
		const guard = `${target}.lock.guard`;
		writeFileAtomic(target, "0");
		writeFileAtomic(join(guard, `2147483647.${"a".repeat(32)}`), "");
		const logs: string[] = [];
		withFileLock(target, () => writeFileAtomic(target, String(Number(readFileSync(target, "utf8")) + 1)), {
			log: (message) => logs.push(message),
		});
		expect(readFileSync(target, "utf8")).toBe("1");
		expect(logs).toEqual([]);
		expect(existsSync(guard)).toBe(false);
		expect(leftovers(dir)).toEqual([]);
	});

	test("a live mutation owner stays intact when the generic lock times out and writes unlocked", () => {
		const target = join(dir, "state.json");
		const guard = `${target}.lock.guard`;
		const owner = `${process.pid}.${"b".repeat(32)}`;
		writeFileAtomic(target, "0");
		writeFileAtomic(join(guard, owner), "");
		const logs: string[] = [];
		withFileLock(target, () => writeFileAtomic(target, String(Number(readFileSync(target, "utf8")) + 1)), {
			timeoutMs: 0,
			log: (message) => logs.push(message),
		});
		expect(readFileSync(target, "utf8")).toBe("1");
		expect(readdirSync(guard)).toEqual([owner]);
		expect(logs).toHaveLength(1);
	});

	test("a fresh held lock is waited on, then the callback runs unlocked and the timeout is logged", () => {
		const target = join(dir, "state.json");
		const lock = `${target}.lock`;
		writeFileSync(lock, "other-process-token");
		const start = Date.now();
		let clock = start;
		const sleeps: number[] = [];
		const logs: string[] = [];
		let ran = false;
		const result = withFileLock(
			target,
			() => {
				ran = true;
				return "done";
			},
			{
				timeoutMs: 500,
				pollMs: 100,
				now: () => clock,
				sleep: (ms) => {
					sleeps.push(ms);
					clock += ms;
				},
				log: (message) => logs.push(message),
			},
		);
		expect(result).toBe("done");
		expect(ran).toBe(true);
		expect(sleeps.length).toBeGreaterThan(0);
		expect(sleeps.every((ms) => ms >= 100)).toBe(true);
		expect(clock - start).toBeGreaterThanOrEqual(500);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("state.json.lock");
		// The other holder's lock is not ours to remove.
		expect(readFileSync(lock, "utf8")).toBe("other-process-token");
	});

	test("a lock released while waiting is taken", () => {
		const target = join(dir, "state.json");
		const lock = `${target}.lock`;
		writeFileSync(lock, "other-process-token");
		const logs: string[] = [];
		let held = false;
		withFileLock(
			target,
			() => {
				held = readFileSync(lock, "utf8") !== "other-process-token";
			},
			{
				sleep: () => rmSync(lock),
				log: (message) => logs.push(message),
			},
		);
		expect(held).toBe(true);
		expect(logs).toEqual([]);
		expect(existsSync(lock)).toBe(false);
	});

	test("a callback that throws still releases the lock and the error propagates", () => {
		const target = join(dir, "state.json");
		expect(() =>
			withFileLock(target, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(existsSync(`${target}.lock`)).toBe(false);
	});

	test("a lock replaced by someone else during the callback is not deleted by us", () => {
		const target = join(dir, "state.json");
		const lock = `${target}.lock`;
		withFileLock(target, () => {
			rmSync(lock);
			writeFileSync(lock, "successor-token");
		});
		expect(readFileSync(lock, "utf8")).toBe("successor-token");
	});

	test("a lock that cannot be created degrades to running the callback unlocked", () => {
		const target = join(dir, "no-such-dir", "state.json");
		const logs: string[] = [];
		const value = withFileLock(target, () => "ran", { log: (message) => logs.push(message) });
		expect(value).toBe("ran");
		expect(logs).toHaveLength(1);
		expect(existsSync(join(dir, "no-such-dir"))).toBe(false);
	});
});

describe("concurrent updates through updateSession", () => {
	test("8 processes x 25 increments of one session field end at exactly 200", async () => {
		const stateDir = join(dir, "state");
		const record: SessionRecord & { counter: number } = {
			sessionId: "race",
			at: 1,
			result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
			counter: 0,
		};
		writeSession(stateDir, record);
		const workers = Array.from({ length: 8 }, () =>
			Bun.spawn([process.execPath, WORKER, stateDir, "race", "25"], { stdout: "pipe", stderr: "pipe" }),
		);
		const exits = await Promise.all(workers.map((worker) => worker.exited));
		const errors = await Promise.all(workers.map((worker) => new Response(worker.stderr).text()));
		expect(errors.join("")).toBe("");
		expect(exits).toEqual(Array<number>(8).fill(0));

		const parsed: unknown = JSON.parse(readFileSync(sessionPath(stateDir, "race"), "utf8"));
		expect(parsed).toMatchObject({ sessionId: "race", counter: 200 });
		expect(readSession(stateDir, "race")).toMatchObject({ counter: 200 });
		expect(leftovers(join(stateDir, "sessions"))).toEqual([]);
		expect(leftovers(stateDir)).toEqual([]);
	}, 60_000);

	test("a delayed stale recovery cannot open a live successor's critical section to another writer", async () => {
		const stateDir = join(dir, "state");
		const record: SessionRecord & { counter: number } = {
			sessionId: "stale-race",
			at: 1,
			result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
			counter: 0,
		};
		writeSession(stateDir, record);
		const lock = `${sessionPath(stateDir, record.sessionId)}.lock`;
		writeFileSync(lock, "dead-process-token");
		const old = new Date(Date.now() - 120_000);
		utimesSync(lock, old, old);
		const events = join(dir, "events");
		const signal = (name: string): void => writeFileAtomic(join(events, name), "");
		signal("start");
		const waitFor = (names: string[]): Promise<string> => new Promise((resolve, reject) => {
			const check = (): void => {
				const name = names.find((candidate) => existsSync(join(events, candidate)));
				if (name) {
					watcher.close();
					resolve(name);
				}
			};
			const watcher = watch(events, check);
			watcher.once("error", reject);
			check();
		});
		const spawn = (actor: string) => Bun.spawn(
			[process.execPath, join(import.meta.dir, "atomic.recovery.worker.ts"), stateDir, record.sessionId, events, actor],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const workers = [spawn("delayed")];
		try {
			await waitFor(["snapshot"]);
			workers.push(spawn("first"), spawn("second"));
			await Promise.all([waitFor(["first.attempting"]), waitFor(["second.attempting"])]);
			// Advance only on real child-process events: force the obsolete snapshot, then observe either
			// a protected writer or the stolen-name window before releasing the real session mutations.
			await waitFor(["first.entered", "second.entered", "first.guarded", "second.guarded"]);
			signal("snapshot-go");
			if (await waitFor(["moved", "delayed.entered"]) === "moved") {
				await waitFor(["first.overlap", "second.overlap"]);
			}
			signal("rename-go");
			signal("body-go");
			const exits = await Promise.all(workers.map((worker) => worker.exited));
			const errors = await Promise.all(workers.map((worker) => new Response(worker.stderr).text()));
			expect(errors.join("")).toBe("");
			expect(exits).toEqual([0, 0, 0]);
			expect(readSession(stateDir, record.sessionId)).toMatchObject({ counter: 3 });
			expect(readdirSync(events).filter((name) => name.endsWith(".overlap"))).toEqual([]);
			expect(leftovers(join(stateDir, "sessions"))).toEqual([]);
		} finally {
			signal("snapshot-go");
			signal("rename-go");
			signal("body-go");
			for (const worker of workers) if (worker.exitCode === null) worker.kill();
			await Promise.allSettled(workers.map((worker) => worker.exited));
		}
	}, 60_000);
});
