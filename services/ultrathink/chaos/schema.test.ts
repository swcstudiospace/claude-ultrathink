// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FaultPlan } from "./faults.ts";
import { FAILURE_MODES, loadTemplates, parseTemplate } from "./schema.ts";

const EXPERIMENTS = join(import.meta.dir, "experiments");
const VALID_LOAD = { method: "GET", path: "/healthz", requests: 1, concurrency: 1 };
const VALID_HYPOTHESIS = { id: "healthz-200", name: "healthz answers", check: "status", path: "/healthz", equals: 200 } as const;
const VALID_PLAN: FaultPlan = { steps: [{ count: "forever", fault: { kind: "blackhole" } }] };

function inprocess(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "sample-template",
		title: "Sample",
		failureMode: "upstream_5xx",
		kind: "inprocess",
		plan: structuredClone(VALID_PLAN),
		load: { ...VALID_LOAD },
		hypotheses: [{ ...VALID_HYPOTHESIS }],
		rollbackOnFail: false,
		...overrides,
	};
}

function operator(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "sample-operator",
		title: "Sample",
		failureMode: "sigterm_drain",
		kind: "operator",
		operatorStep: "Send SIGTERM to the unit's main process.",
		load: { ...VALID_LOAD },
		hypotheses: [{ ...VALID_HYPOTHESIS }],
		rollbackOnFail: true,
		...overrides,
	};
}

function expectRejected(value: unknown, type: new (message?: string) => Error, field: string): void {
	let caught: unknown;
	try {
		parseTemplate(value, "case.json");
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(type);
	const message = (caught as Error).message;
	expect(message.startsWith("case.json: ")).toBe(true);
	expect(message).toContain(field);
}

const scratch: string[] = [];

function scratchDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "chaos-schema-"));
	scratch.push(dir);
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(dir, name), text);
	}
	return dir;
}

afterEach(() => {
	for (const dir of scratch.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("loadTemplates on the real experiments directory", () => {
	test("loads every template with unique ids, sorted by id, and each file validates on its own", () => {
		const templates = loadTemplates(EXPERIMENTS);
		const ids = templates.map((template) => template.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual([...ids].sort());
		for (const file of readdirSync(EXPERIMENTS).filter((name) => name.endsWith(".json"))) {
			const json = JSON.parse(readFileSync(join(EXPERIMENTS, file), "utf8"));
			expect(() => parseTemplate(json, file)).not.toThrow();
		}
	});

	test("every failure mode is covered by exactly one template", () => {
		const templates = loadTemplates(EXPERIMENTS);
		for (const mode of FAILURE_MODES) {
			expect(templates.filter((template) => template.failureMode === mode)).toHaveLength(1);
		}
		expect(templates).toHaveLength(FAILURE_MODES.length);
	});

	test("the three in-process templates are the 5xx, latency and saturation modes; the rest are operator", () => {
		const templates = loadTemplates(EXPERIMENTS);
		const inprocessModes = templates
			.filter((template) => template.kind === "inprocess")
			.map((template) => template.failureMode)
			.sort();
		expect(inprocessModes).toEqual(["inflight_saturation", "upstream_5xx", "upstream_latency"]);
		expect(templates.filter((template) => template.kind === "operator")).toHaveLength(4);
	});
});

describe("loadTemplates from a directory", () => {
	test("sorts by id regardless of file name and ignores files that are not .json", () => {
		const dir = scratchDir({
			"a.json": JSON.stringify(inprocess({ id: "zeta-template" })),
			"b.json": JSON.stringify(inprocess({ id: "alpha-template" })),
			"notes.txt": "not a template",
		});
		expect(loadTemplates(dir).map((template) => template.id)).toEqual(["alpha-template", "zeta-template"]);
	});

	test("rejects duplicate ids", () => {
		const dir = scratchDir({
			"one.json": JSON.stringify(inprocess({ id: "same-template" })),
			"two.json": JSON.stringify(inprocess({ id: "same-template" })),
		});
		expect(() => loadTemplates(dir)).toThrow("duplicates");
	});

	test("rejects a file that is not JSON, naming the file", () => {
		const dir = scratchDir({ "broken.json": "{ not json" });
		expect(() => loadTemplates(dir)).toThrow("broken.json: not valid JSON");
	});
});

describe("parseTemplate rejects invalid templates", () => {
	test("load.requests 0", () => {
		expectRejected(inprocess({ load: { ...VALID_LOAD, requests: 0 } }), RangeError, "load.requests");
	});

	test("load.concurrency 33", () => {
		expectRejected(inprocess({ load: { ...VALID_LOAD, concurrency: 33 } }), RangeError, "load.concurrency");
	});

	test("unknown hypothesis check", () => {
		expectRejected(inprocess({ hypotheses: [{ ...VALID_HYPOTHESIS, check: "header" }] }), TypeError, "hypotheses[0].check");
	});

	test("unknown metric op", () => {
		const metric = {
			id: "calls",
			name: "calls counted",
			check: "metric",
			metric: "ultrathink_planner_calls_total",
			op: "gt",
			value: 1,
		};
		expectRejected(inprocess({ hypotheses: [metric] }), TypeError, "hypotheses[0].op");
	});

	test("duplicate hypothesis ids", () => {
		const second = { ...VALID_HYPOTHESIS, equals: 503 };
		expectRejected(inprocess({ hypotheses: [{ ...VALID_HYPOTHESIS }, second] }), TypeError, "hypotheses[1].id");
	});

	test("rollbackOnFail that is not a boolean", () => {
		expectRejected(inprocess({ rollbackOnFail: "yes" }), TypeError, "rollbackOnFail");
	});

	test("an id with uppercase letters", () => {
		expectRejected(inprocess({ id: "Upper-case" }), TypeError, "id");
	});

	test("settle.atLeast negative", () => {
		const settle = { metric: "ultrathink_planner_calls_total", atLeast: -1 };
		expectRejected(inprocess({ settle }), RangeError, "settle.atLeast");
	});

	test("a plan on an operator template", () => {
		expectRejected(operator({ plan: structuredClone(VALID_PLAN) }), TypeError, "plan is only allowed");
	});

	test("an inprocess template without a plan", () => {
		expectRejected({ ...inprocess(), plan: undefined }, TypeError, "plan is required");
	});

	test("an operator template without operatorStep", () => {
		expectRejected({ ...operator(), operatorStep: undefined }, TypeError, "operatorStep is required");
	});

	test("an inprocess template with operatorStep", () => {
		expectRejected(inprocess({ operatorStep: "Send SIGTERM." }), TypeError, "operatorStep is only allowed");
	});

	test("a plan with a zero step count names the plan path", () => {
		const plan = { steps: [{ count: 0, fault: { kind: "pass" } }] };
		expectRejected(inprocess({ plan }), RangeError, "plan: steps[0].count");
	});

	test("a GET load with a body", () => {
		expectRejected(inprocess({ load: { ...VALID_LOAD, body: { a: 1 } } }), TypeError, "load.body");
	});

	test("an unknown top-level field", () => {
		expectRejected(inprocess({ surprise: true }), TypeError, "surprise");
	});
});

describe("parseTemplate accepts valid templates", () => {
	test("a minimal in-process template", () => {
		const template = parseTemplate(inprocess(), "minimal.json");
		expect(template.id).toBe("sample-template");
		expect(template.kind).toBe("inprocess");
		expect(template.plan).toEqual(VALID_PLAN);
		expect(template.hypotheses).toEqual([VALID_HYPOTHESIS]);
	});

	test("a minimal operator template", () => {
		const template = parseTemplate(operator(), "minimal-operator.json");
		expect(template.kind).toBe("operator");
		expect(template.operatorStep).toBe("Send SIGTERM to the unit's main process.");
		expect(template.plan).toBeUndefined();
	});

	test("a metric hypothesis with labels and a settle block", () => {
		const metric = {
			id: "breaker-open",
			name: "breaker open",
			check: "metric",
			metric: "ultrathink_upstream_breaker_state",
			labels: { state: "open" },
			op: "eq",
			value: 1,
		} as const;
		const template = parseTemplate(
			inprocess({
				hypotheses: [metric],
				settle: { metric: "ultrathink_planner_calls_total", labels: { outcome: "upstream_unavailable" }, atLeast: 2 },
			}),
			"metric.json",
		);
		expect(template.hypotheses).toEqual([metric]);
		expect(template.settle).toEqual({ metric: "ultrathink_planner_calls_total", labels: { outcome: "upstream_unavailable" }, atLeast: 2 });
	});
});
