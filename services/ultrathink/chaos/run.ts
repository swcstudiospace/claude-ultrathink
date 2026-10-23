// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { type ChaosTarget, parsePrometheusValue } from "./observe.ts";
import type { ExperimentTemplate, Hypothesis } from "./schema.ts";
import { scoreRun } from "./score.ts";

export interface HypothesisResult {
	id: string;
	passed: boolean;
	observed?: string | number;
	reason?: string;
}

export type RollbackStatus =
	| "not_needed"
	| "invoked"
	| "failed"
	| "skipped:not_staging"
	| "skipped:not_http"
	| "skipped:not_requested";

export interface RunResult {
	templateId: string;
	driver: "inprocess" | "http";
	startedAt: string;
	finishedAt: string;
	settled: boolean | "not_configured";
	hypotheses: HypothesisResult[];
	passed: boolean;
	score: number;
	rollback: RollbackStatus;
	rollbackExitCode?: number;
}

export interface HistoryRecord extends RunResult {
	seq: number;
}

export interface RunOptions {
	template: ExperimentTemplate;
	target: ChaosTarget;
	driver: "inprocess" | "http";
	sleep: (ms: number) => Promise<void>;
	/** Shown the operator step before any load. Required for operator templates. A rejection aborts the run. */
	confirm?: (step: string) => Promise<void>;
	rollbackArgv?: string[];
	staging: boolean;
	exec?: (argv: string[]) => Promise<number>;
	now?: () => Date;
}

type Settle = NonNullable<ExperimentTemplate["settle"]>;
type RollbackOutcome = { status: RollbackStatus; exitCode?: number };

const SETTLE_POLLS = 200;
const SETTLE_INTERVAL_MS = 10;

/**
 * Runs one template against `target`: confirm (operator only), load, settle, evaluate hypotheses, score, then the
 * rollback decision. Load responses are not judged; a non-2xx or a thrown load request does not fail the run, because
 * faults make those expected. A settle that never completes still evaluates hypotheses, but the run cannot pass.
 */
export async function runTemplate(options: RunOptions): Promise<RunResult> {
	const { template, target, driver, sleep } = options;
	const now = options.now ?? (() => new Date());
	const startedAt = now().toISOString();

	if (template.kind === "operator") {
		if (!options.confirm || template.operatorStep === undefined) {
			throw new Error(`operator template ${template.id} needs a confirm step before load`);
		}
		await options.confirm(template.operatorStep);
	}

	await issueLoad(target, template.load);

	const settled = template.settle ? await settleMetric(target, template.settle, sleep) : "not_configured";

	const hypotheses: HypothesisResult[] = [];
	for (const hypothesis of template.hypotheses) hypotheses.push(await evaluate(target, hypothesis));

	const score = scoreRun(hypotheses);
	// A settle that never completed means recovery was never observed, so the run cannot pass.
	const passed = settled !== false && hypotheses.every((hypothesis) => hypothesis.passed);
	const rollback = await decideRollback(options, passed);
	const finishedAt = now().toISOString();

	return {
		templateId: template.id,
		driver,
		startedAt,
		finishedAt,
		settled,
		hypotheses,
		passed,
		score,
		rollback: rollback.status,
		...(rollback.exitCode === undefined ? {} : { rollbackExitCode: rollback.exitCode }),
	};
}

// Workers pull request indexes from one counter, so exactly `requests` calls are issued.
async function issueLoad(target: ChaosTarget, load: ExperimentTemplate["load"]): Promise<void> {
	let issued = 0;
	const worker = async (): Promise<void> => {
		while (issued < load.requests) {
			issued += 1;
			await target.request(load.method, load.path, load.body).catch(() => undefined);
		}
	};
	await Promise.all(Array.from({ length: Math.min(load.concurrency, load.requests) }, worker));
}

// Polls /metrics at most SETTLE_POLLS times. A poll that cannot read the metric counts as not yet reached.
async function settleMetric(target: ChaosTarget, settle: Settle, sleep: (ms: number) => Promise<void>): Promise<boolean> {
	for (let poll = 0; poll < SETTLE_POLLS; poll += 1) {
		if (poll > 0) await sleep(SETTLE_INTERVAL_MS);
		const value = await readMetric(target, settle.metric, settle.labels).catch(() => undefined);
		if (value !== undefined && value >= settle.atLeast) return true;
	}
	return false;
}

async function readMetric(target: ChaosTarget, metric: string, labels?: Record<string, string>): Promise<number | undefined> {
	const response = await target.request("GET", "/metrics");
	return parsePrometheusValue(response.text, metric, labels);
}

// A request that throws is a failed hypothesis with a reason, never an exception out of the run.
async function evaluate(target: ChaosTarget, hypothesis: Hypothesis): Promise<HypothesisResult> {
	try {
		return await checkHypothesis(target, hypothesis);
	} catch (error) {
		const detail = error instanceof Error ? error.message : "unknown error";
		return verdict(hypothesis.id, false, undefined, `request failed: ${detail}`);
	}
}

async function checkHypothesis(target: ChaosTarget, hypothesis: Hypothesis): Promise<HypothesisResult> {
	switch (hypothesis.check) {
		case "status": {
			const response = await target.request("GET", hypothesis.path);
			return verdict(
				hypothesis.id,
				response.status === hypothesis.equals,
				response.status,
				`status ${response.status}, expected ${hypothesis.equals}`,
			);
		}
		case "body":
			return checkBody(target, hypothesis);
		case "metric": {
			const value = await readMetric(target, hypothesis.metric, hypothesis.labels);
			if (value === undefined) return verdict(hypothesis.id, false, undefined, "metric absent");
			return verdict(
				hypothesis.id,
				compare(value, hypothesis.op, hypothesis.value),
				value,
				`value ${value} is not ${hypothesis.op} ${hypothesis.value}`,
			);
		}
	}
}

async function checkBody(target: ChaosTarget, hypothesis: Extract<Hypothesis, { check: "body" }>): Promise<HypothesisResult> {
	const { id, path, field, equals } = hypothesis;
	const response = await target.request("GET", path);
	let body: unknown;
	try {
		body = JSON.parse(response.text);
	} catch {
		return verdict(id, false, undefined, "body is not JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body) || !(field in body)) {
		return verdict(id, false, undefined, `field ${field} absent`);
	}
	const value: unknown = Reflect.get(body, field);
	if (!isScalar(value)) return verdict(id, false, undefined, `field ${field} is not a scalar`);
	const observed = typeof value === "boolean" ? String(value) : value;
	return verdict(id, value === equals, observed, `field ${field} is ${String(value)}, expected ${String(equals)}`);
}

// A passing result carries what was observed; a failing one also carries the reason.
function verdict(id: string, passed: boolean, observed: string | number | undefined, failure: string): HypothesisResult {
	return passed ? { id, passed, observed } : { id, passed, observed, reason: failure };
}

function compare(observed: number, op: "gte" | "lte" | "eq", expected: number): boolean {
	switch (op) {
		case "gte":
			return observed >= expected;
		case "lte":
			return observed <= expected;
		case "eq":
			return observed === expected;
	}
}

function isScalar(value: unknown): value is string | number | boolean {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

// Rollback runs only for a failed run, on an http driver, against a staging environment, when requested by both the
// caller (argv) and the template (rollbackOnFail). Decision order follows the chaos contract.
async function decideRollback(options: RunOptions, passed: boolean): Promise<RollbackOutcome> {
	if (passed) return { status: "not_needed" };
	const { rollbackArgv, template } = options;
	if (!rollbackArgv || !template.rollbackOnFail) return { status: "skipped:not_requested" };
	if (options.driver !== "http") return { status: "skipped:not_http" };
	if (!options.staging) return { status: "skipped:not_staging" };
	if (!options.exec) return { status: "failed" };
	try {
		const exitCode = await options.exec(rollbackArgv);
		return exitCode === 0 ? { status: "invoked", exitCode } : { status: "failed", exitCode };
	} catch {
		return { status: "failed" };
	}
}
