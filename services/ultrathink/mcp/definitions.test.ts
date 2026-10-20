// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { assertToolDefinitions, ToolDefinitionError, validateToolDefinitions } from "./definitions.ts";
import { TOOL_DEFINITIONS, type ToolDefinition, toolDefinitions } from "./mcp.ts";

// Guards that every tool definition the service can serve stays acceptable to strict MCP clients (Claude, Grok).
// The exact names, order and schemas are pinned in mcp.test.ts; this file pins the rules of definitions.ts.

const GOOD_SCHEMA = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false };

function tool(name: string, patch: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		title: "Fixture",
		description: "A fixture tool.",
		inputSchema: GOOD_SCHEMA,
		annotations: { readOnlyHint: true },
		...patch,
	};
}

function withSchema(name: string, patch: Record<string, unknown>): ToolDefinition {
	return tool(name, { inputSchema: { ...GOOD_SCHEMA, ...patch } });
}

function thrownBy(run: () => void): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

// Built at runtime so this file holds no secret-shaped literal.
const SECRET_LIKE = `${"sk-"}${"a1b2c3d4e5f6a7b8c9"}`;

/** A schema whose `properties` nest `levels` deep; definitions.ts has no depth rule, the runtime validator does. */
function deepSchema(levels: number): Record<string, unknown> {
	let node: Record<string, unknown> = { type: "string" };
	for (let level = 0; level < levels; level += 1) node = { type: "object", properties: { next: node }, additionalProperties: false };
	return { ...node, required: [] };
}

describe("the real tool definitions", () => {
	test("the tools served with server planning pass every rule", () => {
		expect(validateToolDefinitions(toolDefinitions(true))).toEqual([]);
		expect(validateToolDefinitions(TOOL_DEFINITIONS)).toEqual([]);
	});

	test("the tools served without server planning pass every rule", () => {
		expect(validateToolDefinitions(toolDefinitions(false))).toEqual([]);
	});

	test("both modes serve the same definitions, and only server planning adds ultrathink_uplift", () => {
		const withPlanning = toolDefinitions(true);
		const withoutPlanning = toolDefinitions(false);
		expect(withPlanning.some((def) => def.name === "ultrathink_uplift")).toBe(true);
		expect(withoutPlanning.some((def) => def.name === "ultrathink_uplift")).toBe(false);
		expect(withoutPlanning).toEqual(withPlanning.filter((def) => def.name !== "ultrathink_uplift"));
	});
});

describe("validateToolDefinitions", () => {
	test("a good tool has no violation", () => {
		const nested = withSchema("nested_good", {
			properties: {
				mode: { type: "string", enum: ["a", "b"], default: "a", title: "Mode", description: "Which one." },
				wait: { type: "integer", minimum: 0, maximum: 5, default: 3 },
				tags: { type: "array", items: { type: "string", maxLength: 10 } },
				note: { type: ["string", "null"] },
			},
			required: [],
		});
		const prose = tool("prose_good", {
			description: "Reads commands/*.md, then calls ultrathink_result. Bearer auth is not used; see /ultrathink-status.",
		});
		expect(validateToolDefinitions([tool("good_tool"), nested, prose])).toEqual([]);
	});

	const bad: { label: string; def: ToolDefinition; rule: string; detail?: string }[] = [
		{ label: "a dotted name", def: tool("bad.dotted"), rule: "name" },
		{ label: "an empty description", def: tool("bad_empty", { description: "   " }), rule: "description" },
		{ label: "a description over 1024 characters", def: tool("bad_long", { description: "word ".repeat(250) }), rule: "description" },
		{
			label: "an absolute path in the description",
			def: tool("bad_path", { description: "Reads /etc/ultrathink/ultrathink.env at start." }),
			rule: "description-path",
		},
		{
			label: "a stack frame in the description",
			def: tool("bad_stack", { description: "Failed.\n    at run (main.ts:12:3)" }),
			rule: "description-stack-trace",
		},
		{
			label: "a secret-like token in the description",
			def: tool("bad_secret", { description: `Call with ${SECRET_LIKE} as the key.` }),
			rule: "description-secret",
		},
		{
			label: "a long mixed letter and digit token in the description",
			def: tool("bad_token", { description: `Key ${"a1".repeat(20)} works.` }),
			rule: "description-secret",
		},
		{ label: "a string required", def: withSchema("bad_required_text", { required: "id" }), rule: "schema-required" },
		{
			label: "a required entry missing from properties",
			def: withSchema("bad_required_missing", { required: ["missing"] }),
			rule: "schema-required",
			detail: "missing",
		},
		{
			label: "a property type typo",
			def: withSchema("bad_type", { properties: { id: { type: "strng" } } }),
			rule: "schema-type",
			detail: "inputSchema.properties.id.type",
		},
		{
			label: "a nested items type typo",
			def: withSchema("bad_items", { properties: { tags: { type: "array", items: { type: "strng" } } }, required: [] }),
			rule: "schema-type",
			detail: "inputSchema.properties.tags.items.type",
		},
		{ label: "an unknown keyword", def: withSchema("bad_keyword", { requird: ["id"] }), rule: "schema-keyword", detail: "requird" },
		{ label: "anyOf at the root", def: withSchema("bad_anyof", { anyOf: [{ required: ["id"] }] }), rule: "schema-keyword", detail: "anyOf" },
		{
			label: "a $ref",
			def: withSchema("bad_ref", { properties: { id: { $ref: "#/$defs/id" } } }),
			rule: "schema-keyword",
			detail: "$ref",
		},
		{
			label: "a default outside its enum",
			def: withSchema("bad_default", { properties: { mode: { type: "string", enum: ["a", "b"], default: "c" } }, required: [] }),
			rule: "schema-default",
		},
		{
			label: "minimum above maximum",
			def: withSchema("bad_bounds", { properties: { wait: { type: "integer", minimum: 9, maximum: 1 } }, required: [] }),
			rule: "schema-bounds",
		},
		{ label: "an empty enum", def: withSchema("bad_enum", { properties: { mode: { type: "string", enum: [] } }, required: [] }), rule: "schema-enum" },
		{ label: "additionalProperties not false at the root", def: withSchema("bad_extra", { additionalProperties: true }), rule: "schema-additional-properties" },
		{ label: "a non-boolean annotation", def: tool("bad_annotation", { annotations: { readOnlyHint: "yes" } }), rule: "annotations" },
		{ label: "an array as _meta", def: tool("bad_meta", { _meta: [] as unknown as Record<string, unknown> }), rule: "meta" },
		{
			label: "a keyword the runtime validator cannot enforce",
			def: withSchema("bad_pattern", { properties: { id: { type: "string", pattern: "^x" } } }),
			rule: "schema-compile",
			detail: "pattern",
		},
		{
			label: "a schema nested deeper than the runtime validator follows",
			def: withSchema("bad_deep", deepSchema(40)),
			rule: "schema-compile",
			detail: "nested deeper than",
		},
	];

	for (const { label, def, rule, detail } of bad) {
		test(`rejects ${label}`, () => {
			const violations = validateToolDefinitions([def]);
			const match = violations.find((violation) => violation.rule === rule);
			expect(match?.tool).toBe(def.name);
			if (detail !== undefined) expect(match?.detail).toContain(detail);
		});
	}

	test("rejects a name used twice in one list and reports the duplicate by name", () => {
		const violations = validateToolDefinitions([tool("twin"), tool("other"), tool("twin")]);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatchObject({ tool: "twin", rule: "name-unique" });
	});

	test("a secret-like match is never echoed in the violation", () => {
		const violations = validateToolDefinitions([tool("bad_secret", { description: `Call with ${SECRET_LIKE}.` })]);
		expect(JSON.stringify(violations)).not.toContain(SECRET_LIKE);
	});

	test("reports in list order, then rule order", () => {
		const violations = validateToolDefinitions([
			tool("bad.first", { description: "" }),
			tool("second_bad", { annotations: { readOnlyHint: 1 } }),
		]);
		expect(violations.map((violation) => `${violation.tool}:${violation.rule}`)).toEqual([
			"bad.first:name",
			"bad.first:description",
			"second_bad:annotations",
		]);
	});
});

describe("assertToolDefinitions", () => {
	test("does not throw for a good list", () => {
		expect(() => assertToolDefinitions([tool("good_tool"), tool("other_good")])).not.toThrow();
	});

	test("throws a ToolDefinitionError naming every bad tool", () => {
		const error = thrownBy(() => assertToolDefinitions([tool("bad.first"), tool("good_tool"), tool("second_bad", { description: "" })]));
		expect(error).toBeInstanceOf(ToolDefinitionError);
		const failure = error as ToolDefinitionError;
		expect(failure.name).toBe("ToolDefinitionError");
		expect(failure.message.startsWith("invalid tool definitions: ")).toBe(true);
		expect(failure.message).toContain("bad.first: name (");
		expect(failure.message).toContain("second_bad: description (");
		expect(failure.violations.map((violation) => violation.tool)).toEqual(["bad.first", "second_bad"]);
	});

	test("reports schema-compile for a definitions array with a keyword the runtime validator cannot enforce", () => {
		const list = [tool("good_tool"), withSchema("bad_anyof_member", { properties: { id: { anyOf: [{ type: "string" }] } } })];
		const error = thrownBy(() => assertToolDefinitions(list)) as ToolDefinitionError;
		expect(error).toBeInstanceOf(ToolDefinitionError);
		const compile = error.violations.filter((violation) => violation.rule === "schema-compile");
		expect(compile).toHaveLength(1);
		expect(compile[0]).toMatchObject({ tool: "bad_anyof_member" });
		expect(compile[0]?.detail).toContain("anyOf");
		expect(compile[0]?.detail).toContain("inputSchema.properties.id");
	});

	test("a schema that only the compile rule refuses still stops the list", () => {
		const error = thrownBy(() => assertToolDefinitions([withSchema("too_deep", deepSchema(40))])) as ToolDefinitionError;
		expect(error.violations.map((violation) => violation.rule)).toEqual(["schema-compile"]);
	});
});
