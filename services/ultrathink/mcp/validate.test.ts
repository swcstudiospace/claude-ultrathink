// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { TOOL_DEFINITIONS } from "./mcp.ts";
import { compileSchema, SchemaCompileError, validateAgainst } from "./validate.ts";

// Pins the runtime enforcement of tool input schemas on tools/call arguments (SPE-17437): which schemas compile, which
// arguments pass, and the exact path and reason of every refusal, because the reasons travel back to MCP clients.

/** The shape of ultrathink_result's schema, pinned here so the tests do not move when the real description changes. */
const RESULT_SCHEMA = {
	type: "object",
	properties: {
		sessionId: { type: "string", description: "Session id." },
		waitSeconds: { type: "integer", minimum: 0, maximum: 45, default: 40, title: "Wait" },
		detail: { type: "string", enum: ["brief", "full"], default: "brief" },
	},
	required: ["sessionId"],
	additionalProperties: false,
};

const COMMAND_SCHEMA = {
	type: "object",
	properties: {
		command: { type: "string", maxLength: 100 },
		args: { type: "string", maxLength: 400 },
	},
	required: ["command"],
	additionalProperties: false,
};

const NESTED_SCHEMA = {
	type: "object",
	properties: {
		items: {
			type: "array",
			items: {
				type: "object",
				properties: { name: { type: "string", minLength: 1 }, count: { type: "integer" } },
				required: ["name"],
				additionalProperties: false,
			},
		},
		meta: {
			type: "object",
			properties: { tags: { type: "array", items: { type: "string" } } },
			additionalProperties: false,
		},
	},
	additionalProperties: false,
};

function thrownBy(run: () => void): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("the real tool schemas", () => {
	test("every served tool schema compiles", () => {
		for (const tool of TOOL_DEFINITIONS) expect(() => compileSchema(tool.inputSchema)).not.toThrow();
	});

	test("the real ultrathink_result schema accepts valid arguments and refuses an unknown key", () => {
		const schema = TOOL_DEFINITIONS.find((tool) => tool.name === "ultrathink_result")?.inputSchema;
		const validate = compileSchema(schema);
		expect(validate({ sessionId: "s1", waitSeconds: 10, detail: "full" })).toEqual({ ok: true });
		expect(validate({ sessionId: "s1", extra: 1 })).toEqual({ ok: false, path: "arguments.extra", reason: "unknown property" });
	});
});

describe("validating arguments", () => {
	const validate = compileSchema(RESULT_SCHEMA);

	test("valid arguments pass, with and without the optional properties", () => {
		expect(validate({ sessionId: "abc" })).toEqual({ ok: true });
		expect(validate({ sessionId: "abc", waitSeconds: 0, detail: "brief" })).toEqual({ ok: true });
		expect(validate({ sessionId: "abc", waitSeconds: 45 })).toEqual({ ok: true });
	});

	test("a root that is not an object is refused at arguments", () => {
		for (const root of [undefined, null, "x", 3, true, ["a"]]) {
			expect(validate(root)).toEqual({ ok: false, path: "arguments", reason: "expected object" });
		}
	});

	test("an unknown key is refused with the path to the key", () => {
		expect(validate({ sessionId: "abc", bogus: 1 })).toEqual({ ok: false, path: "arguments.bogus", reason: "unknown property" });
	});

	test("a wrong type names the expected type", () => {
		expect(validate({ sessionId: 7 })).toEqual({ ok: false, path: "arguments.sessionId", reason: "expected string" });
		expect(validate({ sessionId: "abc", waitSeconds: "5" })).toEqual({
			ok: false,
			path: "arguments.waitSeconds",
			reason: "expected integer",
		});
	});

	test("a value outside the enum is refused without echoing it", () => {
		const result = validate({ sessionId: "abc", detail: "verbose-secret" });
		expect(result).toEqual({ ok: false, path: "arguments.detail", reason: "not one of the allowed values" });
		expect(JSON.stringify(result)).not.toContain("verbose-secret");
	});

	test("too long and too short strings name the bound, not the value", () => {
		const check = compileSchema(COMMAND_SCHEMA);
		expect(check({ command: "a".repeat(100) })).toEqual({ ok: true });
		expect(check({ command: "a".repeat(101) })).toEqual({
			ok: false,
			path: "arguments.command",
			reason: "longer than 100 characters",
		});
		expect(check({ command: "ship", args: "b".repeat(401) })).toEqual({
			ok: false,
			path: "arguments.args",
			reason: "longer than 400 characters",
		});
		expect(validateAgainst({ type: "string", minLength: 3 }, "ab")).toEqual({
			ok: false,
			path: "arguments",
			reason: "shorter than 3 characters",
		});
	});

	test("numbers below the minimum or above the maximum are refused", () => {
		expect(validate({ sessionId: "abc", waitSeconds: -1 })).toEqual({
			ok: false,
			path: "arguments.waitSeconds",
			reason: "below minimum 0",
		});
		expect(validate({ sessionId: "abc", waitSeconds: 46 })).toEqual({
			ok: false,
			path: "arguments.waitSeconds",
			reason: "above maximum 45",
		});
	});

	test("integer refuses fractions and non-finite numbers", () => {
		for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(validate({ sessionId: "abc", waitSeconds: value })).toEqual({
				ok: false,
				path: "arguments.waitSeconds",
				reason: "expected integer",
			});
		}
	});

	test("number accepts fractions and refuses NaN and Infinity", () => {
		const schema = { type: "number", minimum: 0.5 };
		expect(validateAgainst(schema, 1.5)).toEqual({ ok: true });
		expect(validateAgainst(schema, 0.25)).toEqual({ ok: false, path: "arguments", reason: "below minimum 0.5" });
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(validateAgainst(schema, value)).toEqual({ ok: false, path: "arguments", reason: "expected number" });
		}
	});

	test("a missing required property is reported at its path", () => {
		expect(validate({ waitSeconds: 1 })).toEqual({
			ok: false,
			path: "arguments.sessionId",
			reason: "missing required property",
		});
		expect(validate({})).toEqual({ ok: false, path: "arguments.sessionId", reason: "missing required property" });
	});

	test("a required property set to null or undefined is present but mistyped", () => {
		expect(validate({ sessionId: null })).toEqual({ ok: false, path: "arguments.sessionId", reason: "expected string" });
	});

	test("nested array items report their index and nested path", () => {
		const check = compileSchema(NESTED_SCHEMA);
		expect(check({ items: [{ name: "a" }, { name: "b", count: 2 }], meta: { tags: ["x"] } })).toEqual({ ok: true });
		expect(check({ items: [{ name: "a" }, { name: "b" }, { count: 1 }] })).toEqual({
			ok: false,
			path: "arguments.items[2].name",
			reason: "missing required property",
		});
		expect(check({ items: [{ name: "" }] })).toEqual({
			ok: false,
			path: "arguments.items[0].name",
			reason: "shorter than 1 characters",
		});
		expect(check({ items: [{ name: "a", count: 1.5 }] })).toEqual({
			ok: false,
			path: "arguments.items[0].count",
			reason: "expected integer",
		});
		expect(check({ items: [{ name: "a", other: 1 }] })).toEqual({
			ok: false,
			path: "arguments.items[0].other",
			reason: "unknown property",
		});
		expect(check({ meta: { tags: ["x", 2] } })).toEqual({ ok: false, path: "arguments.meta.tags[1]", reason: "expected string" });
		expect(check({ items: "nope" })).toEqual({ ok: false, path: "arguments.items", reason: "expected array" });
		expect(check({ meta: [] })).toEqual({ ok: false, path: "arguments.meta", reason: "expected object" });
	});

	test("type arrays accept any listed type and name them all when none matches", () => {
		const schema = { type: ["string", "null"] };
		expect(validateAgainst(schema, "x")).toEqual({ ok: true });
		expect(validateAgainst(schema, null)).toEqual({ ok: true });
		expect(validateAgainst(schema, 1)).toEqual({ ok: false, path: "arguments", reason: "expected string or null" });
	});

	test("the null and boolean types are enforced", () => {
		expect(validateAgainst({ type: "null" }, null)).toEqual({ ok: true });
		expect(validateAgainst({ type: "null" }, undefined)).toEqual({ ok: false, path: "arguments", reason: "expected null" });
		expect(validateAgainst({ type: "boolean" }, 0)).toEqual({ ok: false, path: "arguments", reason: "expected boolean" });
	});

	test("enum members of every primitive kind are compared strictly", () => {
		const schema = { enum: [1, "1", true, null] };
		for (const value of [1, "1", true, null]) expect(validateAgainst(schema, value)).toEqual({ ok: true });
		for (const value of [2, "true", false, undefined, {}]) {
			expect(validateAgainst(schema, value)).toEqual({ ok: false, path: "arguments", reason: "not one of the allowed values" });
		}
	});

	test("a node without type applies its keywords by the value's kind", () => {
		const schema = { minLength: 2, minimum: 10, properties: { a: { type: "string" } }, additionalProperties: false };
		expect(validateAgainst(schema, "ab")).toEqual({ ok: true });
		expect(validateAgainst(schema, "a")).toEqual({ ok: false, path: "arguments", reason: "shorter than 2 characters" });
		expect(validateAgainst(schema, 5)).toEqual({ ok: false, path: "arguments", reason: "below minimum 10" });
		expect(validateAgainst(schema, { b: 1 })).toEqual({ ok: false, path: "arguments.b", reason: "unknown property" });
		expect(validateAgainst(schema, [1, 2, 3])).toEqual({ ok: true });
	});

	test("additionalProperties true or absent allows extra keys; a schema validates their values", () => {
		expect(validateAgainst({ type: "object", properties: {} }, { anything: 1 })).toEqual({ ok: true });
		expect(validateAgainst({ type: "object", additionalProperties: true }, { anything: 1 })).toEqual({ ok: true });
		const typed = { type: "object", additionalProperties: { type: "integer" } };
		expect(validateAgainst(typed, { a: 1, b: 2 })).toEqual({ ok: true });
		expect(validateAgainst(typed, { a: 1, b: "2" })).toEqual({ ok: false, path: "arguments.b", reason: "expected integer" });
	});

	test("__proto__ and constructor are plain unknown properties and never reach the prototype", () => {
		const parsed = JSON.parse('{"sessionId":"abc","__proto__":{"polluted":true}}');
		expect(validate(parsed)).toEqual({ ok: false, path: "arguments.__proto__", reason: "unknown property" });
		expect(validate({ sessionId: "abc", constructor: 1 })).toEqual({
			ok: false,
			path: "arguments.constructor",
			reason: "unknown property",
		});
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		// Only own properties count: an inherited `sessionId` does not satisfy `required`.
		expect(validate(Object.create({ sessionId: "inherited" }))).toEqual({
			ok: false,
			path: "arguments.sessionId",
			reason: "missing required property",
		});
	});

	test("paths quote keys that are not identifiers and shorten very long keys", () => {
		expect(validate({ sessionId: "abc", "not an id": 1 })).toEqual({
			ok: false,
			path: 'arguments["not an id"]',
			reason: "unknown property",
		});
		const long = "k".repeat(200);
		const result = validate({ sessionId: "abc", [long]: 1 });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.path).toBe(`arguments[${JSON.stringify(`${"k".repeat(64)}…`)}]`);
			expect(result.path.length).toBeLessThan(80);
		}
	});

	test("the first failure wins: required before unknown keys, in declaration order", () => {
		expect(validate({ bogus: 1 })).toEqual({ ok: false, path: "arguments.sessionId", reason: "missing required property" });
		expect(validateAgainst({ type: "object", required: ["a", "b"], properties: { a: {}, b: {} } }, { b: 1 })).toEqual({
			ok: false,
			path: "arguments.a",
			reason: "missing required property",
		});
	});

	test("a validator never throws, even for a value whose accessor throws", () => {
		const hostile = Object.defineProperty({ sessionId: "abc" }, "waitSeconds", {
			enumerable: true,
			get() {
				throw new Error("boom");
			},
		});
		expect(validate(hostile)).toEqual({ ok: false, path: "arguments", reason: "invalid arguments" });
	});

	test("ignored annotations do not affect validation", () => {
		const schema = { type: "string", description: "d", default: "zzz", title: "t" };
		expect(validateAgainst(schema, "anything")).toEqual({ ok: true });
	});
});

describe("compiling schemas", () => {
	function compileError(schema: unknown): SchemaCompileError {
		const error = thrownBy(() => compileSchema(schema));
		expect(error).toBeInstanceOf(SchemaCompileError);
		return error as SchemaCompileError;
	}

	test("an unsupported keyword names the keyword and its path", () => {
		const error = compileError({ type: "object", properties: { name: { type: "string", pattern: "^a" } } });
		expect(error.keyword).toBe("pattern");
		expect(error.path).toBe("inputSchema.properties.name");
		expect(error.message).toBe('unsupported keyword "pattern" at inputSchema.properties.name');
		for (const keyword of ["anyOf", "oneOf", "allOf", "not", "$ref", "$schema", "$defs", "const", "format", "requird"]) {
			expect(compileError({ type: "object", [keyword]: [] }).keyword).toBe(keyword);
		}
		expect(compileError({ type: "array", items: { $ref: "#/x" } }).path).toBe("inputSchema.items");
		expect(compileError({ type: "object", additionalProperties: { pattern: "x" } }).path).toBe("inputSchema.additionalProperties");
	});

	test("validateAgainst throws the same compile error", () => {
		expect(thrownBy(() => validateAgainst({ type: "string", pattern: "x" }, "x"))).toBeInstanceOf(SchemaCompileError);
	});

	test("a schema that is not an object is refused", () => {
		for (const schema of [undefined, null, "object", 1, []]) expect(compileError(schema).path).toBe("inputSchema");
		expect(compileError({ type: "object", properties: { a: "string" } }).path).toBe("inputSchema.properties.a");
	});

	test("invalid types, enums, bounds, required and properties are refused", () => {
		expect(compileError({ type: "str" }).keyword).toBe("type");
		expect(compileError({ type: [] }).keyword).toBe("type");
		expect(compileError({ type: ["string", "date"] }).path).toBe("inputSchema.type");
		expect(compileError({ enum: [] }).keyword).toBe("enum");
		expect(compileError({ enum: [{ a: 1 }] }).keyword).toBe("enum");
		expect(compileError({ type: "number", minimum: "0" }).keyword).toBe("minimum");
		expect(compileError({ type: "number", maximum: Number.NaN }).keyword).toBe("maximum");
		expect(compileError({ type: "number", minimum: 2, maximum: 1 }).message).toBe("minimum is greater than maximum at inputSchema.minimum");
		expect(compileError({ type: "string", minLength: -1 }).keyword).toBe("minLength");
		expect(compileError({ type: "string", maxLength: 1.5 }).keyword).toBe("maxLength");
		expect(compileError({ type: "string", minLength: 3, maxLength: 2 }).keyword).toBe("minLength");
		expect(compileError({ type: "object", required: "a" }).keyword).toBe("required");
		expect(compileError({ type: "object", required: [1] }).keyword).toBe("required");
		expect(compileError({ type: "object", properties: {}, required: ["missing"] }).message).toBe(
			'required names "missing", which is not in properties at inputSchema.required',
		);
		expect(compileError({ type: "object", properties: [] }).keyword).toBe("properties");
		expect(compileError({ type: "object", additionalProperties: "no" }).keyword).toBe("additionalProperties");
	});

	test("a cyclic or absurdly deep schema is refused instead of recursing forever", () => {
		const cyclic: Record<string, unknown> = { type: "array" };
		cyclic.items = cyclic;
		expect(compileError(cyclic).message).toContain("deeper than 32 levels");
	});

	test("supported keywords all compile", () => {
		expect(() => compileSchema(RESULT_SCHEMA)).not.toThrow();
		expect(() => compileSchema(NESTED_SCHEMA)).not.toThrow();
		expect(() => compileSchema({})).not.toThrow();
		expect(() => compileSchema({ type: ["integer", "null"], minimum: 0, maximum: 0, enum: [0, null], default: 0 })).not.toThrow();
	});
});
