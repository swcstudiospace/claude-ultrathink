// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliDeps, runCli } from "./cli.ts";
import { appendHistory } from "./history.ts";
import type { HttpFetch } from "./observe.ts";
import type { RunResult } from "./run.ts";

const EXPERIMENTS = join(import.meta.dir, "experiments");
const ROLLBACK = ["deploy/ultrathink-release.sh", "rollback"];
const roots: string[] = [];

// The runner's settle poll waits between polls; one event-loop turn is enough, since the planner progresses on the app's own promises.
function yieldTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshDir(): string {
	const root = mkdtempSync(join(tmpdir(), "chaos-cli-"));
	roots.push(root);
	return root;
}

interface Harness {
	deps: CliDeps;
	stdout: () => string;
	stderr: () => string;
	/** Every side effect in call order: confirmations, requests and rollback argvs. */
	events: string[];
	historyPath: string;
}

interface HarnessOptions {
	env?: Record<string, string | undefined>;
	confirm?: CliDeps["confirm"];
	sleep?: CliDeps["sleep"];
	/** HTTP status for a path; defaults to 200 everywhere. */
	statusFor?: (path: string) => number;
}

function harness(options: HarnessOptions = {}): Harness {
	const dir = freshDir();
	const out: string[] = [];
	const err: string[] = [];
	const events: string[] = [];
	const statusFor = options.statusFor ?? (() => 200);
	const fetchImpl: HttpFetch = async (url) => {
		const path = new URL(url).pathname;
		events.push(`fetch ${path}`);
		return new Response("{}", { status: statusFor(path) });
	};
	const historyPath = join(dir, "history.jsonl");
	const deps: CliDeps = {
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		env: options.env ?? {},
		fetch: fetchImpl,
		exec: async (argv) => {
			events.push(`exec ${argv.join(" ")}`);
			return 0;
		},
		confirm:
			options.confirm ??
			(async () => {
				events.push("confirm");
			}),
		now: () => new Date("2026-10-21T00:00:00.000Z"),
		sleep: options.sleep ?? (() => Promise.resolve()),
		templatesDir: EXPERIMENTS,
		historyPath,
	};
	return { deps, stdout: () => out.join(""), stderr: () => err.join(""), events, historyPath };
}

function runRecord(templateId: string, score: number): RunResult {
	return {
		templateId,
		driver: "inprocess",
		startedAt: "2026-10-21T00:00:00.000Z",
		finishedAt: "2026-10-21T00:00:01.000Z",
		settled: true,
		hypotheses: [],
		passed: score === 100,
		score,
		rollback: "not_needed",
	};
}

describe("templates", () => {
	test("lists all seven templates, one per failure mode", async () => {
		const h = harness();

		const code = await runCli(["templates"], h.deps);

		expect(code).toBe(0);
		const ids = h.stdout().trim().split("\n").map((line) => line.split("\t")[0]);
		expect(ids).toEqual([
			"audit-corrupt",
			"inflight-saturation",
			"persistence-unavailable",
			"sigterm-drain",
			"stale-journal-retention",
			"upstream-5xx-breaker",
			"upstream-latency-timeout",
		]);
	});
});

describe("run: gates and usage", () => {
	test("http driver off loopback without staging exits 2 and sends no request", async () => {
		const h = harness();

		const code = await runCli(["run", "audit-corrupt", "--driver", "http", "--base-url", "https://example.com"], h.deps);

		expect(code).toBe(2);
		expect(h.events).toEqual([]);
		expect(h.stderr()).toContain("ULTRATHINK_CHAOS_ENV=staging");
		expect(existsSync(h.historyPath)).toBe(false);
	});

	test("http driver off loopback with staging set reaches the target", async () => {
		const h = harness({ env: { ULTRATHINK_CHAOS_ENV: "staging" } });

		const code = await runCli(["run", "audit-corrupt", "--driver", "http", "--base-url", "https://example.com"], h.deps);

		expect(code).toBe(0);
		expect(h.events).toEqual(["confirm", "fetch /healthz", "fetch /readyz", "fetch /healthz"]);
	});

	test("http driver without a base URL exits 2", async () => {
		const h = harness();

		expect(await runCli(["run", "audit-corrupt", "--driver", "http"], h.deps)).toBe(2);
		expect(h.events).toEqual([]);
	});

	test("a rollback argv that is not JSON exits 2", async () => {
		const h = harness();

		const code = await runCli(
			["run", "audit-corrupt", "--driver", "http", "--base-url", "http://127.0.0.1:9", "--rollback-argv", "not json"],
			h.deps,
		);

		expect(code).toBe(2);
		expect(h.events).toEqual([]);
	});

	test("an empty rollback argv exits 2", async () => {
		const h = harness();

		const code = await runCli(
			["run", "audit-corrupt", "--driver", "http", "--base-url", "http://127.0.0.1:9", "--rollback-argv", "[]"],
			h.deps,
		);

		expect(code).toBe(2);
		expect(h.events).toEqual([]);
	});

	test("an in-process template given the http driver exits 2", async () => {
		const h = harness();

		expect(await runCli(["run", "upstream-5xx-breaker", "--driver", "http", "--base-url", "http://127.0.0.1:9"], h.deps)).toBe(2);
		expect(h.events).toEqual([]);
	});

	test("an unknown command or template exits 2", async () => {
		expect(await runCli(["frobnicate"], harness().deps)).toBe(2);
		expect(await runCli(["run", "no-such-template", "--driver", "inprocess"], harness().deps)).toBe(2);
	});
});

describe("run: operator template over http", () => {
	test("confirmation comes before any request, and a passing run is recorded", async () => {
		const h = harness();

		const code = await runCli(["run", "audit-corrupt", "--driver", "http", "--base-url", "http://127.0.0.1:9"], h.deps);

		expect(code).toBe(0);
		expect(h.events[0]).toBe("confirm");
		expect(h.stdout()).toContain("Operator step, to be performed by hand");
		expect(h.stdout()).toContain("audit-corrupt via http: PASSED");
		expect(readFileSync(h.historyPath, "utf8").trim().split("\n")).toHaveLength(1);
	});

	test("a rejected confirmation sends no load and records no history", async () => {
		const h = harness({
			confirm: async () => {
				throw new Error("operator step not confirmed; no load was sent");
			},
		});

		const code = await runCli(["run", "audit-corrupt", "--driver", "http", "--base-url", "http://127.0.0.1:9"], h.deps);

		expect(code).toBe(2);
		expect(h.events.some((event) => event.startsWith("fetch"))).toBe(false);
		expect(h.stderr()).toContain("no load was sent");
		expect(existsSync(h.historyPath)).toBe(false);
	});

	test("a failed hypothesis exits 1, and rollback runs once when staging and argv are given", async () => {
		const h = harness({ env: { ULTRATHINK_CHAOS_ENV: "staging" }, statusFor: (path) => (path === "/readyz" ? 503 : 200) });

		const code = await runCli(
			["run", "audit-corrupt", "--driver", "http", "--base-url", "http://127.0.0.1:9", "--rollback-argv", JSON.stringify(ROLLBACK)],
			h.deps,
		);

		expect(code).toBe(1);
		expect(h.events.filter((event) => event.startsWith("exec"))).toEqual([`exec ${ROLLBACK.join(" ")}`]);
		expect(h.stdout()).toContain("rollback invoked (exit 0)");
	});

	test("the same failure outside staging does not run rollback", async () => {
		const h = harness({ statusFor: (path) => (path === "/readyz" ? 503 : 200) });

		const code = await runCli(
			["run", "audit-corrupt", "--driver", "http", "--base-url", "http://127.0.0.1:9", "--rollback-argv", JSON.stringify(ROLLBACK)],
			h.deps,
		);

		expect(code).toBe(1);
		expect(h.events.some((event) => event.startsWith("exec"))).toBe(false);
		expect(h.stdout()).toContain("rollback skipped:not_staging");
	});
});

describe("run: in-process template", () => {
	test("upstream-5xx-breaker passes end to end and writes one history line", async () => {
		const h = harness({ sleep: yieldTurn });

		const code = await runCli(["run", "upstream-5xx-breaker", "--driver", "inprocess"], h.deps);

		expect(code).toBe(0);
		expect(h.stdout()).toContain("upstream-5xx-breaker via inprocess: PASSED");
		expect(readFileSync(h.historyPath, "utf8").trim().split("\n")).toHaveLength(1);
	});
});

describe("score", () => {
	test("prints the mean and slope of a fixture history", async () => {
		const h = harness();
		for (const score of [60, 70, 80]) appendHistory(h.historyPath, runRecord("upstream-5xx-breaker", score));

		const code = await runCli(["score", "upstream-5xx-breaker"], h.deps);

		expect(code).toBe(0);
		expect(h.stdout()).toContain("runs 3");
		expect(h.stdout()).toContain("mean 70");
		expect(h.stdout()).toContain("trend slope 10");
		expect(h.stdout()).toContain("latest 80");
	});

	test("with no runs it reports none without failing", async () => {
		const h = harness();

		expect(await runCli(["score", "upstream-5xx-breaker"], h.deps)).toBe(0);
		expect(h.stdout()).toContain("no runs recorded");
	});
});

describe("run: production-safety gate", () => {
	test("a production URL is refused on the gate before the template is checked", async () => {
		const h = harness();

		const code = await runCli(["run", "upstream-5xx-breaker", "--driver", "http", "--base-url", "https://ultrathink.swcstudio.space"], h.deps);

		expect(code).toBe(2);
		expect(h.stderr()).toContain("ULTRATHINK_CHAOS_ENV=staging");
		expect(h.events).toEqual([]);
	});
});
