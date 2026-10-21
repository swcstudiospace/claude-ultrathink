// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type FaultPlan, parseFaultPlan } from "./faults.ts";

/** Closed set. Each mode is covered by exactly one template in `experiments/`. */
export const FAILURE_MODES = [
	"upstream_5xx",
	"upstream_latency",
	"inflight_saturation",
	"sigterm_drain",
	"persistence_unavailable",
	"audit_corrupt",
	"stale_journal",
] as const;

export type FailureMode = (typeof FAILURE_MODES)[number];

export type Hypothesis =
	| { id: string; name: string; check: "status"; path: string; equals: number }
	| { id: string; name: string; check: "body"; path: string; field: string; equals: string | number | boolean }
	| { id: string; name: string; check: "metric"; metric: string; labels?: Record<string, string>; op: "gte" | "lte" | "eq"; value: number };

export interface ExperimentTemplate {
	id: string;
	title: string;
	failureMode: FailureMode;
	kind: "inprocess" | "operator";
	plan?: FaultPlan;
	operatorStep?: string;
	notes?: string;
	config?: { breakerFailures?: number; breakerOpenMs?: number; maxInflight?: number; timeoutMs?: number };
	load: { method: "GET" | "POST"; path: string; body?: unknown; requests: number; concurrency: number };
	settle?: { metric: string; labels?: Record<string, string>; atLeast: number };
	hypotheses: Hypothesis[];
	rollbackOnFail: boolean;
}

type Fields = Record<string, unknown>;

const KINDS = ["inprocess", "operator"] as const;
const METHODS = ["GET", "POST"] as const;
const HYPOTHESIS_CHECKS = ["status", "body", "metric"] as const;
const OPS = ["gte", "lte", "eq"] as const;

const TEMPLATE_KEYS = [
	"id",
	"title",
	"failureMode",
	"kind",
	"plan",
	"operatorStep",
	"notes",
	"config",
	"load",
	"settle",
	"hypotheses",
	"rollbackOnFail",
];
const CONFIG_KEYS = ["breakerFailures", "breakerOpenMs", "maxInflight", "timeoutMs"];
const LOAD_KEYS = ["method", "path", "body", "requests", "concurrency"];
const SETTLE_KEYS = ["metric", "labels", "atLeast"];
const HYPOTHESIS_KEYS: Record<(typeof HYPOTHESIS_CHECKS)[number], readonly string[]> = {
	status: ["id", "name", "check", "path", "equals"],
	body: ["id", "name", "check", "path", "field", "equals"],
	metric: ["id", "name", "check", "metric", "labels", "op", "value"],
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const HYPOTHESIS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const METRIC_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const REQUEST_PATH_PATTERN = /^\/(?!\/)\S*$/;

const MAX_HYPOTHESES = 20;
const MAX_REQUESTS = 500;
const MAX_CONCURRENCY = 32;
const MAX_TEXT = 4000;

function asRecord(value: unknown, path: string): Fields {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${path} must be an object`);
	}
	return value as Fields;
}

function rejectUnknown(fields: Fields, path: string, allowed: readonly string[]): void {
	for (const key of Object.keys(fields)) {
		if (!allowed.includes(key)) {
			throw new TypeError(`${path}.${key} is not a known field`);
		}
	}
}

function asString(value: unknown, path: string, min: number, max: number, pattern?: RegExp): string {
	if (typeof value !== "string") {
		throw new TypeError(`${path} must be a string`);
	}
	if (value.length < min || value.length > max) {
		throw new RangeError(`${path} must be ${min} to ${max} characters`);
	}
	if (pattern !== undefined && !pattern.test(value)) {
		throw new TypeError(`${path} must match ${pattern.source}`);
	}
	return value;
}

function asInteger(value: unknown, path: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new TypeError(`${path} must be an integer`);
	}
	if (value < min || value > max) {
		throw new RangeError(`${path} must be between ${min} and ${max}`);
	}
	return value;
}

function asFiniteNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${path} must be a finite number`);
	}
	return value;
}

function asBoolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") {
		throw new TypeError(`${path} must be true or false`);
	}
	return value;
}

function asEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw new TypeError(`${path} must be one of ${allowed.join(", ")}`);
	}
	return value as T;
}

function asArray(value: unknown, path: string, min: number, max: number): unknown[] {
	if (!Array.isArray(value)) {
		throw new TypeError(`${path} must be an array`);
	}
	if (value.length < min || value.length > max) {
		throw new RangeError(`${path} must hold ${min} to ${max} entries`);
	}
	return value;
}

function asLabels(value: unknown, path: string): Record<string, string> {
	const fields = asRecord(value, path);
	const labels: Record<string, string> = {};
	for (const [name, label] of Object.entries(fields)) {
		if (!LABEL_PATTERN.test(name)) {
			throw new TypeError(`${path}.${name} is not a valid label name`);
		}
		labels[name] = asString(label, `${path}.${name}`, 1, 200);
	}
	return labels;
}

function asRequestPath(value: unknown, path: string): string {
	return asString(value, path, 1, 200, REQUEST_PATH_PATTERN);
}

function asScalar(value: unknown, path: string): string | number | boolean {
	if (typeof value === "string") {
		return asString(value, path, 0, 500);
	}
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	throw new TypeError(`${path} must be a string, number or boolean`);
}

function parseHypothesis(value: unknown, path: string): Hypothesis {
	const fields = asRecord(value, path);
	const id = asString(fields.id, `${path}.id`, 1, 64, HYPOTHESIS_ID_PATTERN);
	const name = asString(fields.name, `${path}.name`, 1, 200);
	const check = asEnum(fields.check, `${path}.check`, HYPOTHESIS_CHECKS);
	rejectUnknown(fields, path, HYPOTHESIS_KEYS[check]);
	switch (check) {
		case "status":
			return {
				id,
				name,
				check,
				path: asRequestPath(fields.path, `${path}.path`),
				equals: asInteger(fields.equals, `${path}.equals`, 100, 599),
			};
		case "body":
			return {
				id,
				name,
				check,
				path: asRequestPath(fields.path, `${path}.path`),
				field: asString(fields.field, `${path}.field`, 1, 100),
				equals: asScalar(fields.equals, `${path}.equals`),
			};
		case "metric": {
			const hypothesis: Hypothesis = {
				id,
				name,
				check,
				metric: asString(fields.metric, `${path}.metric`, 1, 200, METRIC_PATTERN),
				op: asEnum(fields.op, `${path}.op`, OPS),
				value: asFiniteNumber(fields.value, `${path}.value`),
			};
			return fields.labels === undefined ? hypothesis : { ...hypothesis, labels: asLabels(fields.labels, `${path}.labels`) };
		}
	}
}

function parseHypotheses(value: unknown): Hypothesis[] {
	const entries = asArray(value, "hypotheses", 1, MAX_HYPOTHESES);
	const seen = new Set<string>();
	return entries.map((entry, index) => {
		const hypothesis = parseHypothesis(entry, `hypotheses[${index}]`);
		if (seen.has(hypothesis.id)) {
			throw new TypeError(`hypotheses[${index}].id duplicates an earlier hypothesis id`);
		}
		seen.add(hypothesis.id);
		return hypothesis;
	});
}

function parseLoad(value: unknown): ExperimentTemplate["load"] {
	const fields = asRecord(value, "load");
	rejectUnknown(fields, "load", LOAD_KEYS);
	const method = asEnum(fields.method, "load.method", METHODS);
	const load: ExperimentTemplate["load"] = {
		method,
		path: asRequestPath(fields.path, "load.path"),
		requests: asInteger(fields.requests, "load.requests", 1, MAX_REQUESTS),
		concurrency: asInteger(fields.concurrency, "load.concurrency", 1, MAX_CONCURRENCY),
	};
	if (fields.body !== undefined) {
		if (method === "GET") {
			throw new TypeError("load.body is not allowed with GET");
		}
		load.body = fields.body;
	}
	return load;
}

function parseSettle(value: unknown): NonNullable<ExperimentTemplate["settle"]> {
	const fields = asRecord(value, "settle");
	rejectUnknown(fields, "settle", SETTLE_KEYS);
	const settle = {
		metric: asString(fields.metric, "settle.metric", 1, 200, METRIC_PATTERN),
		atLeast: asInteger(fields.atLeast, "settle.atLeast", 0, Number.MAX_SAFE_INTEGER),
	};
	return fields.labels === undefined ? settle : { ...settle, labels: asLabels(fields.labels, "settle.labels") };
}

function parseConfig(value: unknown): NonNullable<ExperimentTemplate["config"]> {
	const fields = asRecord(value, "config");
	rejectUnknown(fields, "config", CONFIG_KEYS);
	const config: NonNullable<ExperimentTemplate["config"]> = {};
	// breakerFailures 0 disables the breaker (config.ts ULTRATHINK_BREAKER_FAILURES).
	if (fields.breakerFailures !== undefined) {
		config.breakerFailures = asInteger(fields.breakerFailures, "config.breakerFailures", 0, 100);
	}
	if (fields.breakerOpenMs !== undefined) {
		config.breakerOpenMs = asInteger(fields.breakerOpenMs, "config.breakerOpenMs", 1, 600000);
	}
	if (fields.maxInflight !== undefined) {
		config.maxInflight = asInteger(fields.maxInflight, "config.maxInflight", 1, 10000);
	}
	if (fields.timeoutMs !== undefined) {
		config.timeoutMs = asInteger(fields.timeoutMs, "config.timeoutMs", 1, 600000);
	}
	return config;
}

function parsePlan(value: unknown): FaultPlan {
	asRecord(value, "plan");
	try {
		return parseFaultPlan(value);
	} catch (error) {
		if (error instanceof TypeError || error instanceof RangeError) {
			error.message = `plan: ${error.message}`;
		}
		throw error;
	}
}

function buildTemplate(json: unknown): ExperimentTemplate {
	const fields = asRecord(json, "template");
	rejectUnknown(fields, "template", TEMPLATE_KEYS);
	const id = asString(fields.id, "id", 3, 64, ID_PATTERN);
	const title = asString(fields.title, "title", 1, 200);
	const failureMode = asEnum(fields.failureMode, "failureMode", FAILURE_MODES);
	const kind = asEnum(fields.kind, "kind", KINDS);
	const load = parseLoad(fields.load);
	const hypotheses = parseHypotheses(fields.hypotheses);
	const rollbackOnFail = asBoolean(fields.rollbackOnFail, "rollbackOnFail");
	const notes = fields.notes === undefined ? undefined : asString(fields.notes, "notes", 1, MAX_TEXT);
	const settle = fields.settle === undefined ? undefined : parseSettle(fields.settle);
	const shared = {
		id,
		title,
		failureMode,
		load,
		hypotheses,
		rollbackOnFail,
		...(notes === undefined ? {} : { notes }),
		...(settle === undefined ? {} : { settle }),
	};

	if (kind === "inprocess") {
		if (fields.plan === undefined) {
			throw new TypeError("plan is required on an inprocess template");
		}
		if (fields.operatorStep !== undefined) {
			throw new TypeError("operatorStep is only allowed on an operator template");
		}
		const config = fields.config === undefined ? undefined : parseConfig(fields.config);
		return {
			...shared,
			kind,
			plan: parsePlan(fields.plan),
			...(config === undefined ? {} : { config }),
		};
	}
	if (fields.plan !== undefined) {
		throw new TypeError("plan is only allowed on an inprocess template");
	}
	if (fields.config !== undefined) {
		throw new TypeError("config is only allowed on an inprocess template");
	}
	if (fields.operatorStep === undefined) {
		throw new TypeError("operatorStep is required on an operator template");
	}
	return {
		...shared,
		kind,
		operatorStep: asString(fields.operatorStep, "operatorStep", 1, MAX_TEXT),
	};
}

/**
 * Validates untrusted JSON into an ExperimentTemplate. Wrong shapes throw `TypeError`, out-of-range values throw
 * `RangeError`. The message starts with `source` and names the field path (for example `load.requests`), never the value.
 */
export function parseTemplate(json: unknown, source: string): ExperimentTemplate {
	try {
		return buildTemplate(json);
	} catch (error) {
		if (error instanceof TypeError || error instanceof RangeError) {
			error.message = `${source}: ${error.message}`;
		}
		throw error;
	}
}

function parseJsonFile(source: string): unknown {
	const text = readFileSync(source, "utf8");
	try {
		return JSON.parse(text);
	} catch {
		throw new SyntaxError(`${source}: not valid JSON`);
	}
}

/**
 * Reads every `*.json` file in `dir`, in file-name order, validates each one, and returns the templates sorted by id.
 * Duplicate ids are rejected; other files are ignored.
 */
export function loadTemplates(dir: string): ExperimentTemplate[] {
	const names = readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name)
		.sort();
	const sourceById = new Map<string, string>();
	const templates: ExperimentTemplate[] = [];
	for (const name of names) {
		const source = join(dir, name);
		const template = parseTemplate(parseJsonFile(source), source);
		const first = sourceById.get(template.id);
		if (first !== undefined) {
			throw new TypeError(`${source}: id "${template.id}" duplicates ${first}`);
		}
		sourceById.set(template.id, source);
		templates.push(template);
	}
	return templates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
