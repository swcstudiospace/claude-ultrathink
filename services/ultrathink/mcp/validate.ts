// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Runtime enforcement of a tool's inputSchema on the arguments of a tools/call. Pure: no I/O, no logging.
 *
 * The supported schema subset is exactly the one definitions.ts accepts at boot: `type` (one of the JSON Schema
 * primitive types or a non-empty array of them), `properties`, `required`, `additionalProperties` (a boolean or a
 * schema for the extra values), `enum` (primitive members), `minimum`, `maximum`, `minLength`, `maxLength`, `items`
 * and the ignored annotations `description`, `default` and `title`. Everything else (`pattern`, `anyOf`, `$ref`, ...)
 * is refused at compile time with a SchemaCompileError naming the keyword and its path, so a schema the validator
 * cannot enforce never reaches a client.
 *
 * Compile once per tool at startup, then call the returned validator per request: it never throws, and its reasons
 * are short, stable and never echo the argument value, so they are safe to return to clients. Refs SPE-17437.
 */

/** The outcome of validating one argument value. The path points at the offending value, `arguments` for the root. */
export type ValidationResult = { ok: true } | { ok: false; path: string; reason: string };

/** A compiled schema: validates one value (the `arguments` object of a tools/call) and never throws. */
export type Validator = (value: unknown) => ValidationResult;

/** Thrown by compileSchema for a schema outside the supported subset. Never thrown on the request path. */
export class SchemaCompileError extends Error {
	override readonly name = "SchemaCompileError";

	/** Where in the schema the problem is, for example `inputSchema.properties.name`. */
	readonly path: string;
	/** The keyword at fault when one is, for example `pattern`. */
	readonly keyword: string | undefined;

	constructor(path: string, detail: string, keyword?: string) {
		super(`${detail} at ${path}`);
		this.path = path;
		this.keyword = keyword;
	}
}

type SchemaType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

const SCHEMA_TYPES: readonly SchemaType[] = ["string", "number", "integer", "boolean", "object", "array", "null"];
const SCHEMA_KEYWORDS: readonly string[] = [
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
/** Schemas nested deeper than this are refused at compile time; it also stops a cyclic schema object from recursing forever. */
const MAX_SCHEMA_DEPTH = 32;
/** Property names longer than this are shortened in paths so an unknown-key path stays bounded. */
const MAX_PATH_KEY_CHARS = 64;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** The root of every compile-time path; matches the paths definitions.ts reports. */
const SCHEMA_ROOT = "inputSchema";
/** The root of every validation path. */
const ARGUMENTS_ROOT = "arguments";

type Primitive = string | number | boolean | null;

/** The compiled form of one schema node. Absent fields mean the keyword was not declared. */
interface Node {
	types: readonly SchemaType[] | undefined;
	enumValues: readonly Primitive[] | undefined;
	minimum: number | undefined;
	maximum: number | undefined;
	minLength: number | undefined;
	maxLength: number | undefined;
	/** Declared properties, in declaration order. A Map so `__proto__` and `constructor` are plain unknown keys. */
	properties: ReadonlyMap<string, Node> | undefined;
	required: readonly string[] | undefined;
	/** `true` (or absent) allows extra keys, `false` refuses them, a Node validates their values. */
	additional: boolean | Node;
	items: Node | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isPrimitive(value: unknown): value is Primitive {
	return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function matchesType(type: SchemaType, value: unknown): boolean {
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
		case "null":
			return value === null;
	}
}

/** `.key` for identifier-like names, `["key"]` otherwise; long names are shortened so the path stays bounded. */
function keyPath(parent: string, key: string): string {
	const shown = key.length > MAX_PATH_KEY_CHARS ? `${key.slice(0, MAX_PATH_KEY_CHARS)}…` : key;
	return IDENTIFIER.test(shown) ? `${parent}.${shown}` : `${parent}[${JSON.stringify(shown)}]`;
}

function compileTypes(node: Record<string, unknown>, path: string): readonly SchemaType[] | undefined {
	if (!Object.hasOwn(node, "type")) return undefined;
	const list: unknown[] = Array.isArray(node.type) ? node.type : [node.type];
	const valid = list.length > 0 && list.every((type) => typeof type === "string" && SCHEMA_TYPES.includes(type as SchemaType));
	if (!valid) {
		throw new SchemaCompileError(
			`${path}.type`,
			`type must be one of ${SCHEMA_TYPES.join(", ")} or a non-empty array of them`,
			"type",
		);
	}
	return list as SchemaType[];
}

function compileBound(node: Record<string, unknown>, path: string, keyword: string, integer: boolean): number | undefined {
	if (!Object.hasOwn(node, keyword)) return undefined;
	const value = node[keyword];
	if (!isFiniteNumber(value)) throw new SchemaCompileError(`${path}.${keyword}`, `${keyword} must be a finite number`, keyword);
	if (integer && (!Number.isInteger(value) || value < 0)) {
		throw new SchemaCompileError(`${path}.${keyword}`, `${keyword} must be a non-negative integer`, keyword);
	}
	return value;
}

function compileEnum(node: Record<string, unknown>, path: string): readonly Primitive[] | undefined {
	if (!Object.hasOwn(node, "enum")) return undefined;
	const values = node.enum;
	if (!Array.isArray(values) || values.length === 0) {
		throw new SchemaCompileError(`${path}.enum`, "enum must be a non-empty array", "enum");
	}
	if (!values.every(isPrimitive)) {
		throw new SchemaCompileError(`${path}.enum`, "enum members must be strings, numbers, booleans or null", "enum");
	}
	return values;
}

function compileRequired(node: Record<string, unknown>, path: string): readonly string[] | undefined {
	if (!Object.hasOwn(node, "required")) return undefined;
	const { required } = node;
	if (!Array.isArray(required) || !required.every((entry) => typeof entry === "string")) {
		throw new SchemaCompileError(`${path}.required`, "required must be an array of strings", "required");
	}
	return [...new Set(required as string[])];
}

function compileNode(schema: unknown, path: string, depth: number): Node {
	if (!isRecord(schema)) throw new SchemaCompileError(path, "schema must be an object");
	if (depth > MAX_SCHEMA_DEPTH) throw new SchemaCompileError(path, `schema nested deeper than ${MAX_SCHEMA_DEPTH} levels`);
	for (const key of Object.keys(schema)) {
		if (!SCHEMA_KEYWORDS.includes(key)) throw new SchemaCompileError(path, `unsupported keyword ${JSON.stringify(key)}`, key);
	}
	const types = compileTypes(schema, path);
	const minimum = compileBound(schema, path, "minimum", false);
	const maximum = compileBound(schema, path, "maximum", false);
	if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
		throw new SchemaCompileError(`${path}.minimum`, "minimum is greater than maximum", "minimum");
	}
	const minLength = compileBound(schema, path, "minLength", true);
	const maxLength = compileBound(schema, path, "maxLength", true);
	if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
		throw new SchemaCompileError(`${path}.minLength`, "minLength is greater than maxLength", "minLength");
	}

	let properties: Map<string, Node> | undefined;
	if (Object.hasOwn(schema, "properties")) {
		if (!isRecord(schema.properties)) {
			throw new SchemaCompileError(`${path}.properties`, "properties must be an object", "properties");
		}
		properties = new Map();
		for (const [key, child] of Object.entries(schema.properties)) {
			properties.set(key, compileNode(child, `${path}.properties.${key}`, depth + 1));
		}
	}
	const required = compileRequired(schema, path);
	for (const entry of required ?? []) {
		if (!properties?.has(entry)) {
			throw new SchemaCompileError(`${path}.required`, `required names ${JSON.stringify(entry)}, which is not in properties`, "required");
		}
	}

	let additional: boolean | Node = true;
	if (Object.hasOwn(schema, "additionalProperties")) {
		const extra = schema.additionalProperties;
		if (typeof extra === "boolean") additional = extra;
		else if (isRecord(extra)) additional = compileNode(extra, `${path}.additionalProperties`, depth + 1);
		else {
			throw new SchemaCompileError(
				`${path}.additionalProperties`,
				"additionalProperties must be a boolean or a schema object",
				"additionalProperties",
			);
		}
	}
	const items = Object.hasOwn(schema, "items") ? compileNode(schema.items, `${path}.items`, depth + 1) : undefined;

	return { types, enumValues: compileEnum(schema, path), minimum, maximum, minLength, maxLength, properties, required, additional, items };
}

function fail(path: string, reason: string): ValidationResult {
	return { ok: false, path, reason };
}

const OK: ValidationResult = { ok: true };

function validateObject(node: Node, value: Record<string, unknown>, path: string): ValidationResult {
	for (const key of node.required ?? []) {
		if (!Object.hasOwn(value, key)) return fail(keyPath(path, key), "missing required property");
	}
	for (const key of Object.keys(value)) {
		const child = node.properties?.get(key);
		if (child) {
			const result = validateNode(child, value[key], keyPath(path, key));
			if (!result.ok) return result;
		} else if (node.additional === false) {
			return fail(keyPath(path, key), "unknown property");
		} else if (node.additional !== true) {
			const result = validateNode(node.additional, value[key], keyPath(path, key));
			if (!result.ok) return result;
		}
	}
	return OK;
}

/**
 * Validates one value. Keyword checks apply by the value's runtime kind, as in JSON Schema: a node without `type`
 * applies `minLength` only to strings, `properties` only to objects, and so on.
 */
function validateNode(node: Node, value: unknown, path: string): ValidationResult {
	if (node.types && !node.types.some((type) => matchesType(type, value))) {
		return fail(path, `expected ${node.types.join(" or ")}`);
	}
	if (node.enumValues && !node.enumValues.includes(value as Primitive)) return fail(path, "not one of the allowed values");
	if (typeof value === "number") {
		if (node.minimum !== undefined && !(value >= node.minimum)) return fail(path, `below minimum ${node.minimum}`);
		if (node.maximum !== undefined && !(value <= node.maximum)) return fail(path, `above maximum ${node.maximum}`);
	} else if (typeof value === "string") {
		// Lengths are UTF-16 code units, the size a string occupies in the process, not Unicode code points.
		if (node.minLength !== undefined && value.length < node.minLength) {
			return fail(path, `shorter than ${node.minLength} characters`);
		}
		if (node.maxLength !== undefined && value.length > node.maxLength) {
			return fail(path, `longer than ${node.maxLength} characters`);
		}
	} else if (Array.isArray(value)) {
		if (node.items) {
			for (let index = 0; index < value.length; index += 1) {
				const result = validateNode(node.items, value[index], `${path}[${index}]`);
				if (!result.ok) return result;
			}
		}
	} else if (isRecord(value)) {
		return validateObject(node, value, path);
	}
	return OK;
}

/**
 * Compiles a schema into a validator. Compile once per tool at startup: a schema outside the supported subset throws
 * SchemaCompileError there, so the request path never meets one. The validator never throws; the integrator passes
 * the `arguments` of a tools/call (`{}` when the call omits them), and a root that is not an object fails with
 * `{ ok: false, path: "arguments", reason: "expected object" }` when the schema declares `type: "object"`.
 */
export function compileSchema(schema: unknown): Validator {
	const root = compileNode(schema, SCHEMA_ROOT, 0);
	return (value: unknown): ValidationResult => {
		try {
			return validateNode(root, value, ARGUMENTS_ROOT);
		} catch {
			// Unreachable for JSON-parsed input; a value with a throwing accessor is refused rather than crashing the call.
			return fail(ARGUMENTS_ROOT, "invalid arguments");
		}
	};
}

/** Convenience: compile and validate in one step (uncached), for tests and one-off callers. Throws like compileSchema. */
export function validateAgainst(schema: unknown, value: unknown): ValidationResult {
	return compileSchema(schema)(value);
}
