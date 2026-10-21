// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Validation of the tool definitions an MCP server lists. Pure: no I/O, no logging. The HTTP server and the stdio
 * connector call assertToolDefinitions at startup so a bad definition stops the process instead of reaching a strict
 * client (Claude, Grok) that refuses the whole tools/list.
 */

// Type-only import: mcp.ts and the entry points import this module, a runtime import would be a cycle.
import type { ToolDefinition } from "./mcp.ts";
import { compileSchema, SchemaCompileError } from "./validate.ts";

export interface ToolDefinitionViolation {
	tool: string;
	/** Short stable id of the broken rule, for example `name` or `schema-required`. */
	rule: string;
	/** What is wrong. Never repeats a secret-like match. */
	detail: string;
}

export class ToolDefinitionError extends Error {
	override readonly name = "ToolDefinitionError";

	constructor(readonly violations: ToolDefinitionViolation[]) {
		super(`invalid tool definitions: ${violations.map((v) => `${v.tool}: ${v.rule} (${v.detail})`).join("; ")}`);
	}
}

type Report = (rule: string, detail: string) => void;

/** The Anthropic tool-name pattern. */
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
/** A conservative guard under the tightest cap reported for function descriptions; it is not a documented client limit. */
const MAX_DESCRIPTION_CHARS = 1024;

// Not prose: a path starting at a system directory (not preceded by a word character, so `commands/*.md` and `and/etc/` pass).
const ABSOLUTE_PATH =
	/(?<![\w.~-])(?:\/(?:home|root|etc|var|opt|usr|tmp|Users|srv|mnt|proc|sys|bin|sbin|lib)\/|[A-Za-z]:[\\/])/;
// `    at file:12:3` on its own line, or `at fn (file:12:3)` inside a sentence.
const STACK_FRAME = /(?:^[ \t]*at\s+\S[^\n]*|\bat\s+\S+\s+\([^)\n]*):\d+:\d+\)?/m;
const SECRET_PATTERNS: readonly { kind: string; pattern: RegExp }[] = [
	{ kind: "an sk- prefixed token", pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/ },
	{ kind: "a GitHub prefixed token", pattern: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/ },
	{ kind: "an xox prefixed token", pattern: /(?<![A-Za-z0-9])xox[a-z]-[A-Za-z0-9-]{16,}/ },
	{ kind: "a Bearer credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/ },
];
const LONG_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;

const SCHEMA_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];
// The keywords every schema node may carry; anything else is a violation (this catches typos such as `requird`).
const SCHEMA_KEYWORDS = [
	"type",
	"properties",
	"required",
	"additionalProperties",
	"description",
	"enum",
	"default",
	"minimum",
	"maximum",
	"minLength",
	"maxLength",
	"items",
	"title",
];
const FORBIDDEN_AT_ROOT = ["anyOf", "oneOf", "allOf", "not", "enum"];
const FORBIDDEN_ANYWHERE = ["$schema", "$ref", "$defs"];
const BOUND_KEYS = ["minimum", "maximum", "minLength", "maxLength"];
const BOUND_PAIRS = [
	["minimum", "maximum"],
	["minLength", "maxLength"],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function matchesType(types: readonly string[], value: unknown): boolean {
	return types.some((type) => {
		switch (type) {
			case "string":
				return typeof value === "string";
			case "integer":
				return Number.isInteger(value);
			case "number":
				return isFiniteNumber(value);
			case "boolean":
				return typeof value === "boolean";
			case "array":
				return Array.isArray(value);
			case "object":
				return isRecord(value);
			default:
				return value === null;
		}
	});
}

function secretKind(text: string): string | undefined {
	const known = SECRET_PATTERNS.find(({ pattern }) => pattern.test(text));
	if (known) return known.kind;
	const mixed = (text.match(LONG_TOKEN) ?? []).some((run) => /[A-Za-z]/.test(run) && /\d/.test(run));
	return mixed ? "a long token that mixes letters and digits" : undefined;
}

function checkDescription(description: unknown, add: Report): void {
	if (typeof description !== "string" || description.trim() === "") {
		add("description", "must be a non-empty string");
		return;
	}
	if (description.length > MAX_DESCRIPTION_CHARS) {
		add("description", `is ${description.length} characters, over the ${MAX_DESCRIPTION_CHARS} limit`);
	}
	if (ABSOLUTE_PATH.test(description)) add("description-path", "contains an absolute filesystem path");
	if (STACK_FRAME.test(description)) add("description-stack-trace", "contains a stack-trace frame");
	const secret = secretKind(description);
	if (secret) add("description-secret", `contains ${secret}`);
}

/** The node's declared types, or undefined when it declares none or an invalid one (reported). */
function declaredTypes(node: Record<string, unknown>, path: string, add: Report): string[] | undefined {
	if (node.type === undefined) return undefined;
	const list: unknown[] = Array.isArray(node.type) ? node.type : [node.type];
	if (list.length > 0 && list.every((type) => typeof type === "string" && SCHEMA_TYPES.includes(type))) {
		return list as string[];
	}
	add("schema-type", `${path}.type must be one of ${SCHEMA_TYPES.join(", ")} or a non-empty array of them`);
	return undefined;
}

function checkRequired(node: Record<string, unknown>, path: string, add: Report): void {
	if (!("required" in node)) return;
	const { required } = node;
	if (!Array.isArray(required) || !required.every((entry) => typeof entry === "string")) {
		add("schema-required", `${path}.required must be an array of strings`);
		return;
	}
	if (new Set(required).size !== required.length) add("schema-required", `${path}.required has duplicate entries`);
	const known = isRecord(node.properties) ? node.properties : {};
	for (const entry of required) {
		if (!Object.hasOwn(known, entry)) add("schema-required", `${path}.required names ${entry}, which is not in properties`);
	}
}

function checkBounds(node: Record<string, unknown>, path: string, add: Report): void {
	for (const key of BOUND_KEYS) {
		if (key in node && !isFiniteNumber(node[key])) add("schema-bounds", `${path}.${key} must be a finite number`);
	}
	for (const [low, high] of BOUND_PAIRS) {
		const [a, b] = [node[low], node[high]];
		if (isFiniteNumber(a) && isFiniteNumber(b) && a > b) add("schema-bounds", `${path}.${low} is greater than ${high}`);
	}
}

function checkDefault(node: Record<string, unknown>, types: string[] | undefined, path: string, add: Report): void {
	if (!("default" in node)) return;
	const value = node.default;
	if (types && !matchesType(types, value)) add("schema-default", `${path}.default does not match the type`);
	if (Array.isArray(node.enum) && !node.enum.includes(value)) add("schema-default", `${path}.default is not in the enum`);
	let measured: [size: number, low: unknown, high: unknown] | undefined;
	if (typeof value === "number") measured = [value, node.minimum, node.maximum];
	else if (typeof value === "string") measured = [value.length, node.minLength, node.maxLength];
	if (!measured) return;
	const [size, low, high] = measured;
	if (isFiniteNumber(low) && size < low) add("schema-default", `${path}.default is below the lower bound`);
	if (isFiniteNumber(high) && size > high) add("schema-default", `${path}.default is above the upper bound`);
}

function checkNode(node: unknown, path: string, isRoot: boolean, add: Report): void {
	if (!isRecord(node)) {
		add("schema-type", `${path} must be a schema object`);
		return;
	}
	for (const key of Object.keys(node)) {
		if (FORBIDDEN_ANYWHERE.includes(key)) add("schema-keyword", `${path}.${key} is not allowed anywhere in an input schema`);
		else if (isRoot && FORBIDDEN_AT_ROOT.includes(key)) add("schema-keyword", `${path}.${key} is not allowed at the schema root`);
		else if (!SCHEMA_KEYWORDS.includes(key)) add("schema-keyword", `unknown keyword ${key} at ${path}`);
	}
	const types = declaredTypes(node, path, add);
	if ("properties" in node) {
		if (isRecord(node.properties)) {
			for (const [key, child] of Object.entries(node.properties)) checkNode(child, `${path}.properties.${key}`, false, add);
		} else {
			add("schema-properties", `${path}.properties must be an object`);
		}
	}
	checkRequired(node, path, add);
	if ("enum" in node) {
		const values = node.enum;
		if (!Array.isArray(values) || values.length === 0) add("schema-enum", `${path}.enum must be a non-empty array`);
		else if (types && !values.every((value) => matchesType(types, value))) {
			add("schema-enum", `${path}.enum has a member that does not match the type`);
		}
	}
	if ("items" in node) checkNode(node.items, `${path}.items`, false, add);
	checkBounds(node, path, add);
	checkDefault(node, types, path, add);
	const extra = node.additionalProperties;
	if (isRoot && extra !== false) add("schema-additional-properties", `${path}.additionalProperties must be false`);
	else if (isRecord(extra)) checkNode(extra, `${path}.additionalProperties`, false, add);
	else if (extra !== undefined && typeof extra !== "boolean") {
		add("schema-additional-properties", `${path}.additionalProperties must be a boolean or a schema object`);
	}
}

function checkInputSchema(schema: unknown, add: Report): void {
	if (!isRecord(schema)) {
		add("schema-type", "inputSchema must be an object");
		return;
	}
	if (schema.type !== "object") add("schema-type", 'inputSchema.type must be "object"');
	checkNode(schema, "inputSchema", true, add);
	checkCompiles(schema, add);
}

/**
 * The schema must compile for the runtime validator mcp.ts runs on every tools/call: a schema it cannot enforce
 * would list a contract the server does not keep. Reported on top of the rule-level findings, with the keyword path.
 */
function checkCompiles(schema: Record<string, unknown>, add: Report): void {
	try {
		compileSchema(schema);
	} catch (error) {
		if (!(error instanceof SchemaCompileError)) throw error;
		add("schema-compile", `the runtime validator cannot enforce it: ${error.message}`);
	}
}

/** The ways the list could be refused by a strict client; empty when it is fine. Order: list order, then rule order. */
export function validateToolDefinitions(list: readonly ToolDefinition[]): ToolDefinitionViolation[] {
	const violations: ToolDefinitionViolation[] = [];
	const seen = new Set<string>();
	for (const def of list) {
		const tool = typeof def.name === "string" && def.name !== "" ? def.name : "<unnamed>";
		const add: Report = (rule, detail) => violations.push({ tool, rule, detail });
		if (typeof def.name !== "string" || !NAME_PATTERN.test(def.name)) add("name", "must match ^[a-zA-Z0-9_-]{1,64}$");
		if (typeof def.name === "string") {
			if (seen.has(def.name)) add("name-unique", "is listed more than once");
			seen.add(def.name);
		}
		checkDescription(def.description, add);
		checkInputSchema(def.inputSchema, add);
		if (def.annotations !== undefined) {
			if (!isRecord(def.annotations)) add("annotations", "must be an object");
			else {
				for (const [key, value] of Object.entries(def.annotations)) {
					if (typeof value !== "boolean") add("annotations", `${key} must be a boolean`);
				}
			}
		}
		if (def._meta !== undefined && !isRecord(def._meta)) add("meta", "_meta must be an object");
	}
	return violations;
}

/** Throws ToolDefinitionError with every violation; returns when the list is fine. */
export function assertToolDefinitions(list: readonly ToolDefinition[]): void {
	const violations = validateToolDefinitions(list);
	if (violations.length > 0) throw new ToolDefinitionError(violations);
}
