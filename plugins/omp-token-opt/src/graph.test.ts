import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { graphStamp, runGraphify, setGraphifyBinForTests } from "./graph.ts";
import type { LeaseOutcome } from "./shared-cache.ts";

describe("runGraphify", () => {
	test("missing binary returns an error string and a cache hit does not spawn", async () => {
		const root = mkdtempSync(join(tmpdir(), "graphify-"));
		const binDir = join(root, "bin");
		mkdirSync(binDir);
		const log = join(root, "calls");
		const script = join(binDir, "graphify");
		writeFileSync(script, `#!/bin/sh\necho call >> ${JSON.stringify(log)}\necho ok\nexit 0\n`);
		chmodSync(script, 0o755);
		try {
			setGraphifyBinForTests(null);
			const missing = await runGraphify(root, ["query", "absent"]);
			expect(missing.exitCode).toBe(127);
			expect(missing.cached).toBe(false);
			expect(missing.text).toContain("not found");
			expect(missing.ms).toBeGreaterThanOrEqual(0);

			setGraphifyBinForTests(script);
			const cwd = join(root, "proj");
			mkdirSync(cwd);
			const first = await runGraphify(cwd, ["query", "same"]);
			const second = await runGraphify(cwd, ["query", "same"]);
			expect(first.cached).toBe(false);
			expect(first.exitCode).toBe(0);
			expect(second.cached).toBe(true);
			expect(second.text).toBe(first.text);
			expect(second.exitCode).toBe(0);
			expect(second.ms).toBeGreaterThanOrEqual(0);
			expect(readFileSync(log, "utf8").trim().split("\n").filter(Boolean)).toEqual(["call"]);

			writeFileSync(script, `#!/bin/sh\necho call >> ${JSON.stringify(log)}\necho no\nexit 1\n`);
			const fail1 = await runGraphify(cwd, ["explain", "missing"]);
			const fail2 = await runGraphify(cwd, ["explain", "missing"]);
			expect(fail1.cached).toBe(false);
			expect(fail2.cached).toBe(false);
			expect(readFileSync(log, "utf8").trim().split("\n").filter(Boolean)).toEqual(["call", "call", "call"]);
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("missing graph.json with override unset does not spawn; a set override still spawns", async () => {
		const root = mkdtempSync(join(tmpdir(), "graphify-miss-"));
		const binDir = join(root, "bin");
		mkdirSync(binDir);
		const log = join(root, "calls");
		const script = join(binDir, "graphify");
		writeFileSync(script, `#!/bin/sh\necho call >> ${JSON.stringify(log)}\necho ok\nexit 0\n`);
		chmodSync(script, 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = `${binDir}${previousPath ? `:${previousPath}` : ""}`;
		try {
			setGraphifyBinForTests(undefined);
			const cwd = join(root, "proj");
			mkdirSync(cwd);
			const missing = await runGraphify(cwd, ["query", "where"]);
			expect(missing.exitCode).toBe(2);
			expect(missing.cached).toBe(false);
			expect(missing.text).toBe("graphify: no graph.json; run graphify extract first");
			expect(existsSync(log)).toBe(false);

			setGraphifyBinForTests(script);
			const spawned = await runGraphify(cwd, ["path", "a", "b"]);
			expect(spawned.exitCode).toBe(0);
			expect(spawned.cached).toBe(false);
			expect(readFileSync(log, "utf8").trim()).toBe("call");
		} finally {
			process.env.PATH = previousPath;
			setGraphifyBinForTests(null);
		}
	});
});

describe("runGraphify options", () => {
	function fixture(prefix: string): { cwd: string; bin: string; log: string } {
		const root = mkdtempSync(join(tmpdir(), prefix));
		const binDir = join(root, "bin");
		mkdirSync(binDir);
		const log = join(root, "calls");
		const bin = join(binDir, "graphify");
		writeFileSync(bin, `#!/bin/sh\necho call >> ${JSON.stringify(log)}\necho "n=$(wc -l < ${JSON.stringify(log)} | tr -d ' ') argv=$*"\nexit 0\n`);
		chmodSync(bin, 0o755);
		const cwd = join(root, "proj");
		mkdirSync(cwd);
		return { cwd, bin, log };
	}

	function writeGraph(cwd: string, body: string, mtimeSeconds: number): void {
		const dir = join(cwd, "graphify-out");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "graph.json");
		writeFileSync(file, body);
		utimesSync(file, mtimeSeconds, mtimeSeconds);
	}

	function spawns(log: string): number {
		return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
	}

	test("keyed cache refetches after graph.json changes while flag-off keeps the old cached text", async () => {
		const { cwd, bin, log } = fixture("graphify-stamp-");
		writeGraph(cwd, "v1", 1_700_000_000);
		try {
			setGraphifyBinForTests(bin);
			const flagOff1 = await runGraphify(cwd, ["query", "q"]);
			expect(flagOff1.cached).toBe(false);
			expect(flagOff1.text).toContain("n=1");

			writeGraph(cwd, "version-two", 1_700_000_100);
			const keyed1 = await runGraphify(cwd, ["query", "q"], undefined, { keyedCache: true });
			expect(keyed1.cached).toBe(false);
			expect(keyed1.text).toContain("n=2");
			const keyed2 = await runGraphify(cwd, ["query", "q"], undefined, { keyedCache: true });
			expect(keyed2.cached).toBe(true);
			expect(keyed2.text).toBe(keyed1.text);

			const flagOff2 = await runGraphify(cwd, ["query", "q"]);
			expect(flagOff2.cached).toBe(true);
			expect(flagOff2.text).toBe(flagOff1.text);
			expect(spawns(log)).toBe(2);
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("graphStamp is none without graph.json and changes when graph.json is rewritten", async () => {
		const { cwd } = fixture("graphify-stamp-fn-");
		try {
			expect(graphStamp(cwd)).toBe("none");
			writeGraph(cwd, "abc", 1_700_000_000);
			const first = graphStamp(cwd);
			expect(first).toMatch(/^3:\d+(\.\d+)?$/);
			writeGraph(cwd, "abcdef", 1_700_000_100);
			expect(graphStamp(cwd)).not.toBe(first);
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("keyed cache with no graph.json bypasses the cache: identical calls spawn again and L2 is untouched", async () => {
		const { cwd, bin, log } = fixture("graphify-none-");
		const l2Calls = { get: 0, set: 0 };
		const l2 = {
			get: async (): Promise<string | null> => {
				l2Calls.get++;
				return "stale";
			},
			set: async (): Promise<void> => {
				l2Calls.set++;
			},
		};
		try {
			setGraphifyBinForTests(bin);
			const first = await runGraphify(cwd, ["query", "q"], undefined, { keyedCache: true, l2 });
			const second = await runGraphify(cwd, ["query", "q"], undefined, { keyedCache: true, l2 });
			expect(first.cached).toBe(false);
			expect(second.cached).toBe(false);
			expect(second.text).toContain("n=2");
			expect(spawns(log)).toBe(2);
			expect(l2Calls).toEqual({ get: 0, set: 0 });
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("keyed cache separates different args", async () => {
		const { cwd, bin, log } = fixture("graphify-args-");
		writeGraph(cwd, "graph", 1_700_000_000);
		try {
			setGraphifyBinForTests(bin);
			const alpha = await runGraphify(cwd, ["query", "alpha"], undefined, { keyedCache: true });
			const beta = await runGraphify(cwd, ["query", "beta"], undefined, { keyedCache: true });
			expect(alpha.cached).toBe(false);
			expect(beta.cached).toBe(false);
			expect(alpha.text).toContain("argv=query alpha");
			expect(beta.text).toContain("argv=query beta");
			expect(beta.text).not.toBe(alpha.text);
			const alphaAgain = await runGraphify(cwd, ["query", "alpha"], undefined, { keyedCache: true });
			expect(alphaAgain.cached).toBe(true);
			expect(alphaAgain.text).toBe(alpha.text);
			expect(spawns(log)).toBe(2);
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("L2 get that throws or rejects and set that throws never fail the query", async () => {
		const { cwd, bin } = fixture("graphify-l2err-");
		writeGraph(cwd, "graph", 1_700_000_000);
		const rejecting = {
			get: async (): Promise<string | null> => {
				throw new Error("l2 down");
			},
			set: async (): Promise<void> => {
				throw new Error("l2 down");
			},
		};
		const throwing = {
			get: (): Promise<string | null> => {
				throw new Error("sync l2 down");
			},
			set: (): Promise<void> => {
				throw new Error("sync l2 down");
			},
		};
		try {
			setGraphifyBinForTests(bin);
			const a = await runGraphify(cwd, ["query", "a"], undefined, { keyedCache: true, l2: rejecting });
			expect(a.exitCode).toBe(0);
			expect(a.cached).toBe(false);
			expect(a.text).toContain("argv=query a");
			const b = await runGraphify(cwd, ["query", "b"], undefined, { keyedCache: true, l2: throwing });
			expect(b.exitCode).toBe(0);
			expect(b.cached).toBe(false);
			expect(b.text).toContain("argv=query b");
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("L2 get that never resolves gives up near 300 ms and the query still runs", async () => {
		const { cwd, bin } = fixture("graphify-hang-");
		writeGraph(cwd, "graph", 1_700_000_000);
		const hanging = {
			get: (): Promise<string | null> => new Promise<string | null>(() => {}),
			set: async (): Promise<void> => {},
		};
		try {
			setGraphifyBinForTests(bin);
			const started = Date.now();
			const result = await runGraphify(cwd, ["query", "hang"], undefined, { keyedCache: true, l2: hanging });
			const took = Date.now() - started;
			expect(result.exitCode).toBe(0);
			expect(result.cached).toBe(false);
			expect(result.text).toContain("argv=query hang");
			expect(took).toBeGreaterThanOrEqual(250);
			expect(took).toBeLessThan(300 + 1000);
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("L2 write-through stores the JSON key string; an L2 hit answers without spawning and fills L1", async () => {
		const { cwd, bin, log } = fixture("graphify-l2-");
		writeGraph(cwd, "graph", 1_700_000_000);
		const shared = new Map<string, string>();
		const l2 = {
			get: async (key: string): Promise<string | null> => shared.get(key) ?? null,
			set: async (key: string, value: string): Promise<void> => {
				shared.set(key, value);
			},
		};
		try {
			setGraphifyBinForTests(bin);
			const fresh = await runGraphify(cwd, ["query", "fresh"], undefined, { keyedCache: true, l2 });
			expect(fresh.cached).toBe(false);
			const freshKey = JSON.stringify([cwd, ["query", "fresh"], graphStamp(cwd)]);
			expect(shared.get(freshKey)).toBe(fresh.text);

			const sharedKey = JSON.stringify([cwd, ["query", "shared"], graphStamp(cwd)]);
			shared.set(sharedKey, "from-l2");
			const hit = await runGraphify(cwd, ["query", "shared"], undefined, { keyedCache: true, l2 });
			expect(hit.text).toBe("from-l2");
			expect(hit.exitCode).toBe(0);
			expect(hit.cached).toBe(true);
			const l1 = await runGraphify(cwd, ["query", "shared"], undefined, { keyedCache: true });
			expect(l1.text).toBe("from-l2");
			expect(l1.cached).toBe(true);
			expect(spawns(log)).toBe(1);
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("budget appends --budget N to query argv only; invalid budgets are ignored and do not split the cache", async () => {
		const { cwd, bin } = fixture("graphify-budget-");
		writeGraph(cwd, "graph", 1_700_000_000);
		try {
			setGraphifyBinForTests(bin);
			const query = await runGraphify(cwd, ["query", "q"], undefined, { budget: 50 });
			expect(query.text).toContain("argv=query q --budget 50");
			const path = await runGraphify(cwd, ["path", "a", "b"], undefined, { budget: 50 });
			expect(path.text).toContain("argv=path a b");
			expect(path.text).not.toContain("--budget");
			const explain = await runGraphify(cwd, ["explain", "x"], undefined, { budget: 50 });
			expect(explain.text).toContain("argv=explain x");
			expect(explain.text).not.toContain("--budget");

			const plain = await runGraphify(cwd, ["query", "q"]);
			expect(plain.cached).toBe(false);
			expect(plain.text).toContain("argv=query q");
			expect(plain.text).not.toContain("--budget");

			for (const budget of [0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
				const result = await runGraphify(cwd, ["query", "bad"], undefined, { budget });
				expect(result.text).not.toContain("--budget");
			}
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("singleflight: two concurrent calls for one key spawn once; the other takes the stored result", async () => {
		const { cwd, bin, log } = fixture("graphify-flight-");
		writeGraph(cwd, "graph", 1_700_000_000);
		const shared = new Map<string, string>();
		const leases = new Set<string>();
		const l2 = {
			get: async (key: string): Promise<string | null> => shared.get(key) ?? null,
			set: async (key: string, value: string): Promise<void> => {
				shared.set(key, value);
			},
			acquire: async (key: string): Promise<LeaseOutcome> => {
				if (leases.has(key)) return "held";
				leases.add(key);
				return "granted";
			},
		};
		try {
			setGraphifyBinForTests(bin);
			const [a, b] = await Promise.all([
				runGraphify(cwd, ["query", "race"], undefined, { keyedCache: true, l2 }),
				runGraphify(cwd, ["query", "race"], undefined, { keyedCache: true, l2 }),
			]);
			const resultKey = JSON.stringify([cwd, ["query", "race"], graphStamp(cwd)]);
			expect(spawns(log)).toBe(1);
			expect(a.exitCode).toBe(0);
			expect(b.exitCode).toBe(0);
			expect(a.text).toBe(b.text);
			expect(a.text).toContain("argv=query race");
			expect(a.cached !== b.cached).toBe(true);
			// The lease lives beside the result key; the result key holds only graphify output.
			expect([...leases]).toEqual([`${resultKey}:lease`]);
			expect([...shared.keys()]).toEqual([resultKey]);
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("without acquire, concurrent calls for one key both spawn as before", async () => {
		const { cwd, bin, log } = fixture("graphify-flight-off-");
		writeGraph(cwd, "graph", 1_700_000_000);
		const shared = new Map<string, string>();
		const l2 = {
			get: async (key: string): Promise<string | null> => shared.get(key) ?? null,
			set: async (key: string, value: string): Promise<void> => {
				shared.set(key, value);
			},
		};
		try {
			setGraphifyBinForTests(bin);
			const [a, b] = await Promise.all([
				runGraphify(cwd, ["query", "open"], undefined, { keyedCache: true, l2 }),
				runGraphify(cwd, ["query", "open"], undefined, { keyedCache: true, l2 }),
			]);
			expect(a.cached).toBe(false);
			expect(b.cached).toBe(false);
			expect(spawns(log)).toBe(2);
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("singleflight: an acquire that throws, rejects or hangs still answers with a spawn", async () => {
		const { cwd, bin } = fixture("graphify-flight-err-");
		writeGraph(cwd, "graph", 1_700_000_000);
		const get = async (): Promise<string | null> => null;
		const set = async (): Promise<void> => {};
		const throwing = {
			get,
			set,
			acquire: (): Promise<LeaseOutcome> => {
				throw new Error("sync acquire down");
			},
		};
		const rejecting = {
			get,
			set,
			acquire: async (): Promise<LeaseOutcome> => {
				throw new Error("acquire down");
			},
		};
		const hanging = {
			get,
			set,
			acquire: (): Promise<LeaseOutcome> => new Promise<LeaseOutcome>(() => {}),
		};
		try {
			setGraphifyBinForTests(bin);
			const started = Date.now();
			const results = [
				await runGraphify(cwd, ["query", "throw"], undefined, { keyedCache: true, l2: throwing }),
				await runGraphify(cwd, ["query", "reject"], undefined, { keyedCache: true, l2: rejecting }),
				await runGraphify(cwd, ["query", "hang"], undefined, { keyedCache: true, l2: hanging }),
			];
			expect(Date.now() - started).toBeLessThan(2000);
			expect(results.map((r) => r.exitCode)).toEqual([0, 0, 0]);
			expect(results.map((r) => r.cached)).toEqual([false, false, false]);
			expect(results.map((r) => r.text.includes("argv=query"))).toEqual([true, true, true]);
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("singleflight: a waiter that never sees a hit spawns after WAIT_MS and returns the spawn text", async () => {
		const { cwd, bin, log } = fixture("graphify-flight-wait-");
		writeGraph(cwd, "graph", 1_700_000_000);
		const l2 = {
			get: async (): Promise<string | null> => null,
			set: async (): Promise<void> => {},
			acquire: async (): Promise<LeaseOutcome> => "held",
		};
		try {
			setGraphifyBinForTests(bin);
			// WAIT_MS is a module constant on a real clock; the poll loop has no injectable timer, so the wait is real.
			const started = Date.now();
			const result = await runGraphify(cwd, ["query", "lonely"], undefined, { keyedCache: true, l2 });
			const took = Date.now() - started;
			expect(result.exitCode).toBe(0);
			expect(result.cached).toBe(false);
			expect(result.text).toContain("argv=query lonely");
			expect(took).toBeGreaterThanOrEqual(1900);
			expect(took).toBeLessThan(3000);
			expect(spawns(log)).toBe(1);
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("singleflight: an unavailable lease spawns at once even when the L2 get never resolves", async () => {
		const { cwd, bin, log } = fixture("graphify-flight-down-");
		writeGraph(cwd, "graph", 1_700_000_000);
		const l2 = {
			// The stalled read is bounded by L2_TIMEOUT_MS (300 ms); the lease reports unavailable.
			get: (): Promise<string | null> => new Promise<string | null>(() => {}),
			set: async (): Promise<void> => {},
			acquire: async (): Promise<LeaseOutcome> => "unavailable",
		};
		try {
			setGraphifyBinForTests(bin);
			// Real clock on purpose: the L2 timeout is a module constant, so the bound is measured on wall time.
			const started = Date.now();
			const result = await runGraphify(cwd, ["query", "outage"], undefined, { keyedCache: true, l2 });
			const took = Date.now() - started;
			expect(result.exitCode).toBe(0);
			expect(result.cached).toBe(false);
			expect(result.text).toContain("argv=query outage");
			// Before the fix an unavailable lease waited the full WAIT_MS (2000 ms) on top of the stalled read.
			expect(took).toBeLessThan(1000);
			expect(spawns(log)).toBe(1);
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("singleflight: a waiter that sees the stored result mid-wait returns it cached without spawning", async () => {
		const { cwd, bin, log } = fixture("graphify-flight-hit-");
		writeGraph(cwd, "graph", 1_700_000_000);
		const resultKey = JSON.stringify([cwd, ["query", "late"], graphStamp(cwd)]);
		let reads = 0;
		const l2 = {
			// Reads: one L2 miss before the lease, then polls. The fourth read is the other caller's result.
			get: async (key: string): Promise<string | null> => {
				reads += 1;
				return key === resultKey && reads >= 4 ? "from-other-caller" : null;
			},
			set: async (): Promise<void> => {},
			acquire: async (): Promise<LeaseOutcome> => "held",
		};
		try {
			setGraphifyBinForTests(bin);
			const result = await runGraphify(cwd, ["query", "late"], undefined, { keyedCache: true, l2 });
			expect(result.text).toBe("from-other-caller");
			expect(result.exitCode).toBe(0);
			expect(result.cached).toBe(true);
			expect(reads).toBe(4);
			expect(spawns(log)).toBe(0);
		} finally {
			setGraphifyBinForTests(null);
		}
	});
});
