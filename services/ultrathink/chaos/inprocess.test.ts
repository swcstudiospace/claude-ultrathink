// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessTarget } from "./inprocess.ts";
import { parsePrometheusValue } from "./observe.ts";
import { type RunResult, runTemplate } from "./run.ts";
import { type ExperimentTemplate, loadTemplates } from "./schema.ts";

const EXPERIMENTS = join(import.meta.dir, "experiments");
const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// The runner's settle poll waits between polls; here one event-loop turn is enough, because the planner's progress is
// driven by the app's own promises and the poll count is bounded by the runner, not by this value.
function yieldTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

function template(id: string): ExperimentTemplate {
	const found = loadTemplates(EXPERIMENTS).find((candidate) => candidate.id === id);
	if (found === undefined) throw new Error(`no template ${id}`);
	return found;
}

function freshStateDir(): string {
	const root = mkdtempSync(join(tmpdir(), "chaos-inprocess-"));
	roots.push(root);
	return root;
}

async function runInProcess(id: string): Promise<{ result: RunResult; metrics: string }> {
	const experiment = template(id);
	const { target, close } = await createInProcessTarget({ template: experiment, stateDir: freshStateDir() });
	try {
		const result = await runTemplate({
			template: experiment,
			target,
			driver: "inprocess",
			sleep: () => yieldTurn(),
			staging: false,
		});
		const metrics = await target.request("GET", "/metrics");
		return { result, metrics: metrics.text };
	} finally {
		await close();
	}
}

describe("in-process driver", () => {
	test("the 5xx storm opens the upstream breaker and the run passes", async () => {
		const { result, metrics } = await runInProcess("upstream-5xx-breaker");

		expect(result.settled).toBe(true);
		expect(result.hypotheses.map((hypothesis) => hypothesis.passed)).toEqual([true, true]);
		expect(result.passed).toBe(true);
		expect(result.score).toBe(100);
		expect(result.rollback).toBe("not_needed");
		expect(parsePrometheusValue(metrics, "ultrathink_upstream_breaker_state", { state: "open" })).toBe(1);
	});

	test("the same template gives the same hypothesis results on every run", async () => {
		const first = await runInProcess("upstream-5xx-breaker");
		const second = await runInProcess("upstream-5xx-breaker");

		const outcome = (run: RunResult) => ({
			settled: run.settled,
			score: run.score,
			passed: run.passed,
			hypotheses: run.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis.passed]),
		});
		expect(outcome(second.result)).toEqual(outcome(first.result));
	});

	test("a silent upstream times out every planner call and the run passes", async () => {
		const { result } = await runInProcess("upstream-latency-timeout");

		expect(result.passed).toBe(true);
		expect(result.hypotheses.map((hypothesis) => hypothesis.id)).toEqual(["calls-time-out", "healthz-200"]);
	});

	test("close can be called twice without throwing", async () => {
		const { close } = await createInProcessTarget({ template: template("upstream-5xx-breaker"), stateDir: freshStateDir() });

		await close();
		await close();
	});

	test("an operator template is refused, since it has no fault plan to inject", async () => {
		const operator = template("sigterm-drain");

		await expect(createInProcessTarget({ template: operator, stateDir: freshStateDir() })).rejects.toThrow(TypeError);
	});
});
