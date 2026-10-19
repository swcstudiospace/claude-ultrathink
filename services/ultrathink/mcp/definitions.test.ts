// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { TOOL_DEFINITIONS, type ToolDefinition, toolDefinitions } from "./mcp.ts";

// Guards that every tool definition the service can serve stays acceptable to strict MCP clients (Claude, Grok).
// The exact names, order and schemas are pinned in mcp.test.ts; this file pins only the rules a client enforces.

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const FORBIDDEN_TOP_LEVEL = ["anyOf", "oneOf", "allOf", "not", "enum"];
const FORBIDDEN_ANYWHERE = ["$schema", "$ref", "$defs"];

function matchesType(type: unknown, value: unknown): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "integer":
			return Number.isInteger(value);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return true;
	}
}

/** Every path in the schema tree whose object carries a key a strict client rejects. */
function forbiddenKeys(node: unknown, path: string): string[] {
	if (Array.isArray(node)) return node.flatMap((item, index) => forbiddenKeys(item, `${path}[${index}]`));
	if (typeof node !== "object" || node === null) return [];
	return Object.entries(node).flatMap(([key, child]) => [
		...(FORBIDDEN_ANYWHERE.includes(key) ? [`${path}.${key}`] : []),
		...forbiddenKeys(child, `${path}.${key}`),
	]);
}

function defaultViolations(property: string, schema: Record<string, unknown>): string[] {
	if (!("default" in schema)) return [];
	const value = schema.default;
	const problems: string[] = [];
	if (!matchesType(schema.type, value)) problems.push(`default of ${property} is not of type ${String(schema.type)}`);
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) problems.push(`default of ${property} is not in its enum`);
	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) problems.push(`default of ${property} is below its minimum`);
		if (typeof schema.maximum === "number" && value > schema.maximum) problems.push(`default of ${property} is above its maximum`);
	}
	return problems;
}

/** The reasons a strict client could refuse this tool; each starts with the tool name. */
function lintTool(def: ToolDefinition): string[] {
	const problems: string[] = [];
	const schema = def.inputSchema;
	if (!NAME_PATTERN.test(def.name)) problems.push("name does not match ^[a-zA-Z0-9_-]{1,64}$");
	if (typeof def.description !== "string" || def.description.trim() === "" || def.description !== def.description.trim()) {
		problems.push("description is not a non-empty trimmed string");
	}
	if (schema.type !== "object") problems.push("inputSchema.type is not object");
	if (schema.additionalProperties !== false) problems.push("inputSchema.additionalProperties is not false");
	for (const key of FORBIDDEN_TOP_LEVEL) {
		if (key in schema) problems.push(`inputSchema has a top-level ${key}`);
	}
	for (const path of forbiddenKeys(schema, "inputSchema")) problems.push(`${path} is not allowed`);
	const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
	const required = Array.isArray(schema.required) ? schema.required : [];
	for (const entry of required) {
		if (typeof entry !== "string" || !(entry in properties)) problems.push(`required entry ${String(entry)} is not in properties`);
	}
	for (const [property, value] of Object.entries(properties)) {
		problems.push(...defaultViolations(property, value));
	}
	for (const [key, value] of Object.entries(def.annotations)) {
		if (typeof value !== "boolean") problems.push(`annotation ${key} is not a boolean`);
	}
	return problems.map((problem) => `${def.name}: ${problem}`);
}

function lintList(list: readonly ToolDefinition[]): string[] {
	const names = list.map((tool) => tool.name);
	const duplicates = names.filter((name, index) => names.indexOf(name) !== index).map((name) => `${name}: name is listed twice`);
	return [...list.flatMap(lintTool), ...duplicates];
}

function fixture(name: string, inputSchema: Record<string, unknown>): ToolDefinition {
	return { name, title: "Fixture", description: "A fixture tool.", inputSchema, annotations: { readOnlyHint: true } };
}

const GOOD_SCHEMA = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false };

describe("tool definitions stay acceptable to strict MCP clients", () => {
	test("the tools served with server planning pass every rule", () => {
		expect(lintList(toolDefinitions(true))).toEqual([]);
		expect(lintList(TOOL_DEFINITIONS)).toEqual([]);
	});

	test("the tools served without server planning pass every rule", () => {
		expect(lintList(toolDefinitions(false))).toEqual([]);
	});

	test("both modes serve the same definitions, and only server planning adds ultrathink_uplift", () => {
		const withPlanning = toolDefinitions(true);
		const withoutPlanning = toolDefinitions(false);
		expect(withPlanning.some((tool) => tool.name === "ultrathink_uplift")).toBe(true);
		expect(withoutPlanning.some((tool) => tool.name === "ultrathink_uplift")).toBe(false);
		expect(withoutPlanning).toEqual(withPlanning.filter((tool) => tool.name !== "ultrathink_uplift"));
	});
});

describe("lintTool", () => {
	test("a good tool has no violation", () => {
		expect(lintTool(fixture("good_tool", GOOD_SCHEMA))).toEqual([]);
	});

	test("each bad fixture is reported by name", () => {
		const bad = [
			fixture("bad.dotted", GOOD_SCHEMA),
			fixture("bad_required", { ...GOOD_SCHEMA, required: ["missing"] }),
			fixture("bad_anyof", { ...GOOD_SCHEMA, anyOf: [{ required: ["id"] }] }),
			fixture("bad_ref", { ...GOOD_SCHEMA, properties: { id: { $ref: "#/$defs/id" } } }),
		];
		for (const tool of bad) {
			const violations = lintTool(tool);
			expect(violations.length).toBeGreaterThan(0);
			for (const violation of violations) expect(violation.startsWith(`${tool.name}: `)).toBe(true);
		}
	});

	test("a default outside its own enum or range is reported", () => {
		const properties = { mode: { type: "string", enum: ["a", "b"], default: "c" }, wait: { type: "integer", minimum: 0, maximum: 5, default: 9 } };
		const violations = lintTool(fixture("bad_default", { ...GOOD_SCHEMA, properties, required: [] }));
		expect(violations).toHaveLength(2);
	});
});
