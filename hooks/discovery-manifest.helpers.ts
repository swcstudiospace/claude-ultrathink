// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isPlainObject } from "../src/decisions/client.ts";
import type { HostId } from "../src/host/types.ts";

// Test-only support for UT-Static-Discovery 1.0.0. Callers supply their trusted checkout root;
// these helpers inspect bounded local resources and declared paths, never execute entrypoints or fetch schemas.

type JsonObject = { [key: string]: unknown };
type Literal = string | boolean;
type HostRecord = { status: string; entrypoints: string[]; delivery: string };
type BotRecord = {
	identity: string;
	status: string;
	adapterPresent: boolean;
	compatibilityVerified: boolean;
	delivery?: string;
	entrypoints?: string[];
};
type Descriptor = {
	$schema: string;
	schemaVersion: string;
	identity: { repository: string; repositoryUrl: string; package: string; plugin: string; marketplace: string };
	description: string;
	capabilities: string[];
	hosts: Record<string, HostRecord>;
	interfaces: {
		jsonPlanner: { transport: string; launcher: string; entrypoint: string; responseType: string };
		controls: { entrypoint: string; canPlan: boolean };
		trackerMcp: { transport: string; entrypoint: string; providers: string[]; canPlan: boolean };
	};
	externalIntegrations: Record<string, BotRecord>;
};

const DESCRIPTOR_FILE = "ultrathink.discovery.json";
const SCHEMA_FILE = "ultrathink.discovery.schema.json";
/** Both discovery resource filenames start with this; no loader may register either one. */
const DISCOVERY_STEM = "ultrathink.discovery";
const DESCRIPTOR_LIMIT = 16_384;
/** Also bounds the loader manifests, which are a few KiB. */
const SCHEMA_LIMIT = 32_768;
/** Host entrypoints, the four interface paths, and the Grok Bot skill entrypoints. */
const MAX_PATH_REFERENCES = 44;
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_POINTER = `./${SCHEMA_FILE}`;
const SCHEMA_VERSION = "1.0.0";
const DESCRIPTION =
	"claude-ultrathink is a cross-agent reasoning plugin providing prompt uplift, Graph of Thought, Chain of Thought and HITL clarifications. Adapters are listed from repository sources. Grok Bot is a skill-protocol adapter: it does not run the engine and has no prompt hook; compatibility is not verified. GPT Dot remains pending and unverified.";
const ROOT_KEYS = ["$schema", "schemaVersion", "identity", "description", "capabilities", "hosts", "interfaces", "externalIntegrations"];
const IDENTITY = {
	repository: "claude-ultrathink",
	repositoryUrl: "https://github.com/swcstudiospace/claude-ultrathink",
	package: "ultrathink",
	plugin: "ultrathink",
	marketplace: "ultrathink",
};
const CAPABILITIES = [
	"prompt-uplift",
	"graph-of-thought",
	"chain-of-thought",
	"hitl-clarifications",
	"local-plan-artifact-handoff",
	"planning-controls",
	"tracker-mcp-relay",
];
const RELAY_SERVICES = ["notion", "linear", "greptile"];
const DELIVERIES = ["hook-additional-context", "local-plan-carrier", "pre-llm-plan-handoff", "extension-inline-or-deferred-aside", "kernel-skill-return"];
/** The exact host mapping. Entrypoints are an inventory of source files, never commands to run. */
const HOST_MAPPING: Record<HostId, { entrypoints: string[]; delivery: string }> = {
	"claude-code": {
		entrypoints: [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "hooks/hooks.json", "hooks/uplift.ts"],
		delivery: "hook-additional-context",
	},
	"grok-build": { entrypoints: ["hooks/uplift.ts", "scripts/setup.ts", "hosts/grok/ultrathink.md"], delivery: "local-plan-carrier" },
	hermes: {
		entrypoints: ["hosts/hermes/plugin.yaml", "hosts/hermes/__init__.py", "hosts/hermes/bridge.py", "hooks/engine.ts"],
		delivery: "pre-llm-plan-handoff",
	},
	muse: { entrypoints: [".muse-plugin/plugin.json", "hooks/muse-prompt", "hooks/uplift.ts"], delivery: "hook-additional-context" },
	omp: { entrypoints: ["package.json", ".omp-plugin/marketplace.json", "src/host/omp.ts"], delivery: "extension-inline-or-deferred-aside" },
	"prime-agent": {
		entrypoints: ["hosts/prime-agent/SKILL.md", "hosts/prime-agent/pyproject.toml", "hosts/prime-agent/src/ultrathink/__init__.py", "hooks/engine.ts"],
		delivery: "kernel-skill-return",
	},
};
const HOST_IDS = Object.keys(HOST_MAPPING) as HostId[];
const JSON_PLANNER = { transport: "json-stdin-stdout", launcher: "bin/run-bun", entrypoint: "hooks/engine.ts", responseType: "PlanResponse" };
const CONTROLS = { entrypoint: "bin/ultrathink", canPlan: false };
/** The trackerMcp literals; its providers are a fixed set checked separately. */
const TRACKER_MCP = { transport: "mcp-stdio-relay", entrypoint: "bin/ultrathink-mcp", canPlan: false };
/** Scalar fields only. Grok Bot's entrypoints are a path list, checked like a host inventory, not as a const. */
const EXTERNAL: Record<string, Record<string, Literal>> = {
	"grok-bot": {
		identity: "documented-product",
		status: "skill-adapter",
		adapterPresent: true,
		compatibilityVerified: false,
		delivery: "skill-protocol",
	},
	"gpt-dot": { identity: "unverified", status: "pending-identity-and-contract", adapterPresent: false, compatibilityVerified: false },
};
const GROK_BOT_ENTRYPOINTS = [
	"hosts/grok-bot/README.md",
	"hosts/grok-bot/ultrathink-protocol/SKILL.md",
	"hosts/grok-bot/commands/ultrathink-off/SKILL.md",
	"hosts/grok-bot/commands/ultrathink-on/SKILL.md",
	"hosts/grok-bot/commands/ultrathink-quick/SKILL.md",
	"hosts/grok-bot/commands/ultrathink-skip/SKILL.md",
	"hosts/grok-bot/commands/ultrathink-status/SKILL.md",
	"hosts/grok-bot/commands/ultrathink-track/SKILL.md",
];
/** Every distinct path the approved descriptor declares: host entrypoints, then the interface paths. */
const NORMATIVE_PATHS = [
	...new Set([
		...HOST_IDS.flatMap((id) => HOST_MAPPING[id].entrypoints),
		...GROK_BOT_ENTRYPOINTS,
		JSON_PLANNER.launcher,
		JSON_PLANNER.entrypoint,
		CONTROLS.entrypoint,
		TRACKER_MCP.entrypoint,
	]),
];
/** Declared-path vectors that the reader's path rules and the schema's relativeFile must both reject: [label, path, reader problem]. */
const BAD_PATHS: [string, string, string][] = [
	["an absolute path", "/abs/hooks/uplift.ts", "is absolute"],
	["a drive-letter path", "C:/hooks/uplift.ts", "is absolute"],
	["a URL", "https://example.invalid/uplift.ts", "contains a colon"],
	["a parent traversal", "../outside/uplift.ts", "has a traversal segment"],
	["an inner traversal", "hooks/../hooks/uplift.ts", "has a traversal segment"],
	["a standalone dot segment", "./hooks/uplift.ts", "has a standalone . segment"],
	["an empty segment", "hooks//uplift.ts", "has an empty segment"],
	["a trailing slash", "hooks/", "has an empty segment"],
	["a backslash", "hooks\\uplift.ts", "contains a backslash"],
	["a NUL character", "hooks/uplift.ts\u0000", "contains a control character"],
	["a newline", "hooks/\nuplift.ts", "contains a control character"],
	["shell interpolation", "${HOME}/uplift.ts", "contains interpolation syntax"],
	["command substitution", "$(id)/uplift.ts", "contains interpolation syntax"],
	["a .planning component", ".planning/PLAN.md", "has a .planning component"],
	["a nested .planning component", "docs/.planning/PLAN.md", "has a .planning component"],
	["a space", "hooks/up lift.ts", "has a character outside A-Z a-z 0-9 . _ - /"],
	["an empty path", "", "is not 1 to 160 characters"],
	["a path over 160 characters", `${"a/".repeat(80)}b`, "is not 1 to 160 characters"],
];
const LOADER_FILES = [
	"package.json",
	".claude-plugin/plugin.json",
	".claude-plugin/marketplace.json",
	".omp-plugin/marketplace.json",
	".muse-plugin/plugin.json",
] as const;
type LoaderFile = (typeof LOADER_FILES)[number];
type Loaders = Record<LoaderFile, unknown>;
/** Descriptor keys a loader format already defines for itself; any other descriptor key on a loader is a graft. */
const LOADER_OWN_KEYS: Record<LoaderFile, readonly string[]> = {
	"package.json": ["description"],
	".claude-plugin/plugin.json": ["description"],
	".claude-plugin/marketplace.json": ["$schema"],
	".omp-plugin/marketplace.json": ["$schema"],
	".muse-plugin/plugin.json": ["schemaVersion", "description", "capabilities"],
};
/** The descriptor's own keys plus the guessed keys the discovery contract names; none may be grafted onto a loader. */
const GRAFT_KEYS = [...ROOT_KEYS, "repositoryIdentity", "supportedHosts", "grokBot", "gptDot", "grok-bot", "gpt-dot", "modelResolver", "discovery"];

/** The value at a path of own keys and array indexes, or undefined. */
function at(value: unknown, ...path: string[]): unknown {
	let node = value;
	for (const key of path) {
		if (Array.isArray(node)) node = node[Number(key)];
		else if (isPlainObject(node) && Object.hasOwn(node, key)) node = node[key];
		else return undefined;
	}
	return node;
}

/** A fresh, mutable copy of the approved 1.0.0 descriptor, assembled from the normative values above. */
function approved(): Descriptor {
	return {
		$schema: SCHEMA_POINTER,
		schemaVersion: SCHEMA_VERSION,
		identity: { ...IDENTITY },
		description: DESCRIPTION,
		capabilities: [...CAPABILITIES],
		hosts: Object.fromEntries(
			HOST_IDS.map((id): [string, HostRecord] => [
				id,
				{ status: "source-present", entrypoints: [...HOST_MAPPING[id].entrypoints], delivery: HOST_MAPPING[id].delivery },
			]),
		),
		interfaces: { jsonPlanner: { ...JSON_PLANNER }, controls: { ...CONTROLS }, trackerMcp: { ...TRACKER_MCP, providers: [...RELAY_SERVICES] } },
		externalIntegrations: Object.fromEntries(
			Object.entries(EXTERNAL).map(([id, record]): [string, BotRecord] => [
				id,
				{
					identity: String(record.identity),
					status: String(record.status),
					adapterPresent: record.adapterPresent === true,
					compatibilityVerified: record.compatibilityVerified === true,
					...(typeof record.delivery === "string" ? { delivery: record.delivery } : {}),
					...(id === "grok-bot" ? { entrypoints: [...GROK_BOT_ENTRYPOINTS] } : {}),
				},
			]),
		),
	};
}

function keyFindings(pointer: string, value: JsonObject, keys: readonly string[]): string[] {
	const where = pointer || "/";
	return [
		...keys.filter((key) => !Object.hasOwn(value, key)).map((key) => `shape: ${where} is missing "${key}"`),
		...Object.keys(value)
			.filter((key) => !keys.includes(key))
			.map((key) => `shape: ${where} has unknown key "${key}"`),
	];
}

/** An object with exactly the expected keys (plus extraKeys checked elsewhere), each equal to its literal. */
function literalFindings(pointer: string, value: unknown, expected: Record<string, Literal>, extraKeys: readonly string[] = []): string[] {
	if (!isPlainObject(value)) return [`shape: ${pointer} must be an object`];
	const findings = keyFindings(pointer, value, [...Object.keys(expected), ...extraKeys]);
	for (const [key, literal] of Object.entries(expected)) {
		if (Object.hasOwn(value, key) && value[key] !== literal) findings.push(`shape: ${pointer}/${key} must be ${JSON.stringify(literal)}`);
	}
	return findings;
}

/** A list holding each label exactly once, in any order. */
function labelSetFindings(pointer: string, value: unknown, labels: readonly string[]): string[] {
	if (!Array.isArray(value)) return [`shape: ${pointer} must be an array`];
	const findings: string[] = [];
	if (value.length !== labels.length) findings.push(`shape: ${pointer} must list exactly ${labels.length} labels`);
	const seen = new Set<string>();
	for (const label of value) {
		if (typeof label !== "string" || !labels.includes(label)) findings.push(`shape: ${pointer} has unknown label ${JSON.stringify(label)}`);
		else if (seen.has(label)) findings.push(`shape: ${pointer} repeats "${label}"`);
		else seen.add(label);
	}
	for (const label of labels) if (!seen.has(label)) findings.push(`shape: ${pointer} is missing "${label}"`);
	return findings;
}

/** Lexical rules for a declared path, applied as data before any file is inspected. */
function pathFindings(pointer: string, value: unknown): string[] {
	if (typeof value !== "string") return [`shape: ${pointer} must be a string`];
	const problems: string[] = [];
	if (value.length < 1 || value.length > 160) problems.push("is not 1 to 160 characters");
	if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) problems.push("contains a control character");
	if (isAbsolute(value) || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) problems.push("is absolute");
	if (value.includes(":")) problems.push("contains a colon");
	if (value.includes("\\")) problems.push("contains a backslash");
	if (/[$`%{}]/.test(value)) problems.push("contains interpolation syntax");
	const segments = value.split("/");
	if (segments.includes("")) problems.push("has an empty segment");
	if (segments.includes("..")) problems.push("has a traversal segment");
	if (segments.includes(".")) problems.push("has a standalone . segment");
	if (segments.includes(".planning")) problems.push("has a .planning component");
	if (/[^A-Za-z0-9._/-]/.test(value)) problems.push("has a character outside A-Z a-z 0-9 . _ - /");
	return problems.map((problem) => `path: ${pointer} ${problem}`);
}

function hostFindings(id: HostId, value: unknown): string[] {
	const pointer = `/hosts/${id}`;
	if (!isPlainObject(value)) return [`shape: ${pointer} must be an object`];
	const { entrypoints, delivery } = HOST_MAPPING[id];
	const findings = keyFindings(pointer, value, ["status", "entrypoints", "delivery"]);
	if (Object.hasOwn(value, "status") && value.status !== "source-present") findings.push(`shape: ${pointer}/status must be "source-present"`);
	if (Object.hasOwn(value, "delivery") && value.delivery !== delivery) findings.push(`shape: ${pointer}/delivery must be "${delivery}"`);
	if (!Object.hasOwn(value, "entrypoints")) return findings;
	const declared = value.entrypoints;
	if (!Array.isArray(declared) || declared.length < 1 || declared.length > 8) return [...findings, `shape: ${pointer}/entrypoints must be an array of 1 to 8 paths`];
	for (const [index, path] of declared.entries()) findings.push(...pathFindings(`${pointer}/entrypoints/${index}`, path));
	if (new Set(declared).size !== declared.length) findings.push(`shape: ${pointer}/entrypoints repeats a path`);
	if (JSON.stringify(declared) !== JSON.stringify(entrypoints)) findings.push(`semantic: ${pointer}/entrypoints must be ${JSON.stringify(entrypoints)}`);
	return findings;
}

function hostsFindings(value: unknown): string[] {
	if (!isPlainObject(value)) return ["shape: /hosts must be an object"];
	const findings: string[] = [];
	for (const key of Object.keys(value)) if (!Object.hasOwn(HOST_MAPPING, key)) findings.push(`shape: /hosts/${key} is not a supported HostId`);
	for (const id of HOST_IDS) {
		if (Object.hasOwn(value, id)) findings.push(...hostFindings(id, value[id]));
		else findings.push(`shape: /hosts is missing "${id}"`);
	}
	return findings;
}

function interfacesFindings(value: unknown): string[] {
	if (!isPlainObject(value)) return ["shape: /interfaces must be an object"];
	const findings = keyFindings("/interfaces", value, ["jsonPlanner", "controls", "trackerMcp"]);
	if (Object.hasOwn(value, "jsonPlanner")) findings.push(...literalFindings("/interfaces/jsonPlanner", value.jsonPlanner, JSON_PLANNER));
	if (Object.hasOwn(value, "controls")) findings.push(...literalFindings("/interfaces/controls", value.controls, CONTROLS));
	if (Object.hasOwn(value, "trackerMcp")) {
		const { trackerMcp } = value;
		findings.push(...literalFindings("/interfaces/trackerMcp", trackerMcp, TRACKER_MCP, ["providers"]));
		if (isPlainObject(trackerMcp) && Object.hasOwn(trackerMcp, "providers")) {
			findings.push(...labelSetFindings("/interfaces/trackerMcp/providers", trackerMcp.providers, RELAY_SERVICES));
		}
	}
	return findings;
}

function grokBotFindings(value: unknown, literals: Record<string, Literal>): string[] {
	const pointer = "/externalIntegrations/grok-bot";
	const findings = literalFindings(pointer, value, literals, ["entrypoints"]);
	if (!isPlainObject(value) || !Object.hasOwn(value, "entrypoints")) return findings;
	const declared = value.entrypoints;
	if (!Array.isArray(declared) || declared.length < 1 || declared.length > 8) {
		return [...findings, `shape: ${pointer}/entrypoints must be an array of 1 to 8 paths`];
	}
	for (const [index, path] of declared.entries()) findings.push(...pathFindings(`${pointer}/entrypoints/${index}`, path));
	if (new Set(declared).size !== declared.length) findings.push(`shape: ${pointer}/entrypoints repeats a path`);
	if (JSON.stringify(declared) !== JSON.stringify(GROK_BOT_ENTRYPOINTS)) {
		findings.push(`semantic: ${pointer}/entrypoints must be ${JSON.stringify(GROK_BOT_ENTRYPOINTS)}`);
	}
	return findings;
}

function externalFindings(value: unknown): string[] {
	if (!isPlainObject(value)) return ["shape: /externalIntegrations must be an object"];
	const findings = keyFindings("/externalIntegrations", value, Object.keys(EXTERNAL));
	for (const [id, record] of Object.entries(EXTERNAL)) {
		if (!Object.hasOwn(value, id)) continue;
		if (id === "grok-bot") findings.push(...grokBotFindings(value[id], record));
		else findings.push(...literalFindings(`/externalIntegrations/${id}`, value[id], record));
	}
	return findings;
}

/**
 * The strict 1.0.0 reader rules: the paired schema's keys, types, consts, enums and bounds, plus the exact host
 * mapping a schema cannot express. Another schemaVersion or $schema pointer is refused before anything else is read.
 */
function descriptorFindings(value: unknown): string[] {
	if (!isPlainObject(value)) return ["shape: / must be a JSON object"];
	const gate: string[] = [];
	if (value.schemaVersion !== SCHEMA_VERSION) gate.push(`shape: /schemaVersion must be "${SCHEMA_VERSION}"`);
	if (value.$schema !== SCHEMA_POINTER) gate.push(`shape: /$schema must be "${SCHEMA_POINTER}"`);
	if (gate.length > 0) return gate;
	const findings = keyFindings("", value, ROOT_KEYS);
	findings.push(...literalFindings("/identity", value.identity, IDENTITY));
	const { description } = value;
	if (typeof description !== "string" || description.length < 1 || description.length > 400) {
		findings.push("shape: /description must be a string of 1 to 400 characters");
	}
	findings.push(...labelSetFindings("/capabilities", value.capabilities, CAPABILITIES));
	findings.push(...hostsFindings(value.hosts));
	findings.push(...interfacesFindings(value.interfaces));
	findings.push(...externalFindings(value.externalIntegrations));
	return findings;
}

/** Every path a valid descriptor declares, duplicates included: host entrypoints plus the four interface paths. */
function declaredPaths(descriptor: Descriptor): string[] {
	const { jsonPlanner, controls, trackerMcp } = descriptor.interfaces;
	const grokEntrypoints = descriptor.externalIntegrations["grok-bot"]?.entrypoints;
	return [
		...Object.values(descriptor.hosts).flatMap((host) => host.entrypoints),
		...(Array.isArray(grokEntrypoints) ? grokEntrypoints : []),
		jsonPlanner.launcher,
		jsonPlanner.entrypoint,
		controls.entrypoint,
		trackerMcp.entrypoint,
	];
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Lexical containment first, then realpath containment (symlinks resolved), then a regular-file check. */
function containmentFinding(root: string, path: string): string | undefined {
	const realRoot = realpathSync(root);
	const lexical = resolve(realRoot, path);
	if (!within(realRoot, lexical)) return `containment: ${path} resolves outside the checkout root`;
	let real: string;
	try {
		real = realpathSync(lexical);
	} catch {
		return `containment: ${path} is missing`;
	}
	if (!within(realRoot, real)) return `containment: ${path} escapes the checkout root through a symlink`;
	if (relative(realRoot, real).split(sep).includes(".planning")) return `containment: ${path} resolves into .planning`;
	if (!statSync(real).isFile()) return `containment: ${path} is not a regular file`;
	return undefined;
}

/** Containment of every declared path: at most 44 references, each distinct path inspected once, nothing walked or run. */
function pathReferenceFindings(root: string, descriptor: Descriptor): string[] {
	const references = declaredPaths(descriptor);
	if (references.length > MAX_PATH_REFERENCES) return [`containment: ${references.length} path references exceed ${MAX_PATH_REFERENCES}`];
	const findings: string[] = [];
	for (const path of new Set(references)) {
		const problem =
			pathFindings("", path).length > 0
				? `containment: ${JSON.stringify(path)} is not inspected: it is not a clean relative file path`
				: containmentFinding(root, path);
		if (problem) findings.push(problem);
	}
	return findings;
}

/**
 * Reads one contained regular file of the trusted root: at most limit + 1 bytes, so anything larger is refused
 * before it is decoded; then strict UTF-8 and JSON.parse.
 */
function readResource(root: string, file: string, limit: number): unknown {
	const problem = containmentFinding(root, file);
	if (problem) throw new Error(problem);
	const fd = openSync(join(root, file), "r");
	const buffer = Buffer.alloc(limit + 1);
	let size = 0;
	try {
		while (size < buffer.length) {
			const read = readSync(fd, buffer, size, buffer.length - size, size);
			if (read === 0) break;
			size += read;
		}
	} finally {
		closeSync(fd);
	}
	if (size > limit) throw new Error(`bounds: ${file} is larger than ${limit} bytes`);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
	} catch {
		throw new Error(`parse: ${file} is not UTF-8`);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`parse: ${file} is not valid JSON`);
	}
}

/** Every object node of a parsed schema with its JSON pointer (an in-memory walk, not a filesystem one). */
function* schemaNodes(node: unknown, pointer: string): Generator<[string, JsonObject]> {
	if (Array.isArray(node)) {
		for (const [index, item] of node.entries()) yield* schemaNodes(item, `${pointer}/${index}`);
	} else if (isPlainObject(node)) {
		yield [pointer, node];
		for (const [key, value] of Object.entries(node)) yield* schemaNodes(value, `${pointer}/${key}`);
	}
}

/** The schema's relativeFile pattern must accept every approved path and reject every bad one its length bounds allow. */
function relativeFileFindings(pattern: unknown): string[] {
	if (typeof pattern !== "string") return ["schema: /$defs/relativeFile/pattern must be a string"];
	let relativeFile: RegExp;
	try {
		relativeFile = new RegExp(pattern, "u");
	} catch {
		return ["schema: /$defs/relativeFile/pattern must be an ECMA-262 regular expression"];
	}
	const findings: string[] = [];
	for (const path of NORMATIVE_PATHS) if (!relativeFile.test(path)) findings.push(`schema: /$defs/relativeFile/pattern rejects ${path}`);
	// Lengths outside 1..160 are the schema's minLength/maxLength job, checked separately.
	for (const [, path] of BAD_PATHS) {
		if (path.length >= 1 && path.length <= 160 && relativeFile.test(path)) findings.push(`schema: /$defs/relativeFile/pattern accepts ${JSON.stringify(path)}`);
	}
	return findings;
}

/**
 * Finite checks that the schema resource is strict (every object node closed, every property required), offline
 * (only internal $refs that resolve) and encodes the same consts, enums, bounds and per-host deliveries as the reader.
 * Not a general JSON Schema engine.
 */
function schemaFindings(schema: unknown): string[] {
	if (!isPlainObject(schema)) return ["schema: / must be a JSON object"];
	const findings: string[] = [];
	const sorted = (value: unknown) => (Array.isArray(value) ? [...value].sort() : value);
	const same = (path: string[], expected: unknown, normalize: (value: unknown) => unknown = (value) => value) => {
		if (JSON.stringify(normalize(at(schema, ...path))) !== JSON.stringify(expected)) findings.push(`schema: /${path.join("/")} must be ${JSON.stringify(expected)}`);
	};
	same(["$schema"], DRAFT_2020_12);
	same(["$id"], SCHEMA_FILE);
	for (const [pointer, node] of schemaNodes(schema, "")) {
		const ref = node.$ref;
		// An internal JSON Pointer ("#/..."), resolved against this in-memory schema; never fetched.
		const target =
			typeof ref === "string" && ref.startsWith("#/")
				? at(schema, ...ref.slice(2).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~")))
				: undefined;
		if (Object.hasOwn(node, "$ref") && target === undefined) findings.push(`schema: ${pointer}/$ref must be an internal reference that resolves`);
		if (node.type !== "object") continue;
		if (node.additionalProperties !== false) findings.push(`schema: ${pointer}/additionalProperties must be false`);
		const properties = isPlainObject(node.properties) ? Object.keys(node.properties).sort() : [];
		if (JSON.stringify(sorted(node.required)) !== JSON.stringify(properties)) findings.push(`schema: ${pointer}/required must list exactly its properties`);
	}
	same(["required"], [...ROOT_KEYS].sort(), sorted);
	same(["properties", "$schema", "const"], SCHEMA_POINTER);
	same(["properties", "schemaVersion", "const"], SCHEMA_VERSION);
	for (const [key, value] of Object.entries(IDENTITY)) same(["properties", "identity", "properties", key, "const"], value);
	same(["properties", "description", "minLength"], 1);
	same(["properties", "description", "maxLength"], 400);
	same(["properties", "capabilities", "items", "enum"], [...CAPABILITIES].sort(), sorted);
	for (const [key, value] of Object.entries({ minItems: 7, maxItems: 7, uniqueItems: true })) same(["properties", "capabilities", key], value);
	same(["properties", "hosts", "required"], [...HOST_IDS].sort(), sorted);
	for (const id of HOST_IDS) {
		same(["properties", "hosts", "properties", id, "allOf", "0", "$ref"], "#/$defs/hostAdapter");
		same(["properties", "hosts", "properties", id, "allOf", "1", "properties", "delivery", "const"], HOST_MAPPING[id].delivery);
	}
	for (const [name, literals] of Object.entries({ jsonPlanner: JSON_PLANNER, controls: CONTROLS, trackerMcp: TRACKER_MCP })) {
		for (const [key, value] of Object.entries(literals)) same(["properties", "interfaces", "properties", name, "properties", key, "const"], value);
	}
	const providers = ["properties", "interfaces", "properties", "trackerMcp", "properties", "providers"];
	same([...providers, "items", "enum"], [...RELAY_SERVICES].sort(), sorted);
	for (const [key, value] of Object.entries({ minItems: 3, maxItems: 3, uniqueItems: true })) same([...providers, key], value);
	for (const [id, record] of Object.entries(EXTERNAL)) {
		for (const [key, value] of Object.entries(record)) same(["properties", "externalIntegrations", "properties", id, "properties", key, "const"], value);
	}
	const grokEntrypoints = ["properties", "externalIntegrations", "properties", "grok-bot", "properties", "entrypoints"];
	same([...grokEntrypoints, "items", "$ref"], "#/$defs/relativeFile");
	for (const [key, value] of Object.entries({ minItems: 1, maxItems: 8, uniqueItems: true })) same([...grokEntrypoints, key], value);
	same(["$defs", "hostAdapter", "properties", "status", "const"], "source-present");
	same(["$defs", "hostAdapter", "properties", "delivery", "enum"], [...DELIVERIES].sort(), sorted);
	const entrypoints = ["$defs", "hostAdapter", "properties", "entrypoints"];
	same([...entrypoints, "items", "$ref"], "#/$defs/relativeFile");
	for (const [key, value] of Object.entries({ minItems: 1, maxItems: 8, uniqueItems: true })) same([...entrypoints, key], value);
	same(["$defs", "relativeFile", "minLength"], 1);
	same(["$defs", "relativeFile", "maxLength"], 160);
	findings.push(...relativeFileFindings(at(schema, "$defs", "relativeFile", "pattern")));
	return findings;
}

/** Descriptor keys on a loader object that its own format does not define. */
function graftedKeys(doc: unknown, own: readonly string[]): string[] {
	if (!isPlainObject(doc)) return [];
	const record = doc;
	return GRAFT_KEYS.filter((key) => Object.hasOwn(record, key) && !own.includes(key));
}

function readLoaders(root: string): Loaders {
	const loaders = {} as Loaders;
	for (const file of LOADER_FILES) loaders[file] = readResource(root, file, SCHEMA_LIMIT);
	return loaders;
}

/**
 * Read-only loader identity: ultrathink names, the claude-ultrathink repository, the Omp/pi extension and the Muse
 * identity stay as they are, no descriptor key is grafted on, and the descriptor is neither an Omp/pi extension nor a
 * Muse capability.
 */
function loaderFindings(root: string, loaders: Loaders): string[] {
	const findings: string[] = [];
	const check = (file: LoaderFile, ok: boolean, rule: string) => {
		if (!ok) findings.push(`loader: ${file} ${rule}`);
	};
	const pkg = loaders["package.json"];
	check("package.json", at(pkg, "name") === "ultrathink", 'name must stay "ultrathink"');
	const repositoryUrl = String(at(pkg, "repository", "url")).replace(/^git\+/, "").replace(/\.git$/, "");
	check("package.json", repositoryUrl === IDENTITY.repositoryUrl, "repository.url must stay the claude-ultrathink repository");
	for (const field of ["omp", "pi"]) {
		const extensions = at(pkg, field, "extensions");
		const entries: string[] = Array.isArray(extensions) ? extensions.map(String) : [];
		check("package.json", entries.includes("./src/host/omp.ts"), `${field}.extensions must keep ./src/host/omp.ts`);
		check("package.json", !entries.some((entry) => entry.includes(DISCOVERY_STEM)), `${field}.extensions must not load the discovery descriptor`);
	}
	const claude = loaders[".claude-plugin/plugin.json"];
	check(".claude-plugin/plugin.json", at(claude, "name") === "ultrathink", 'name must stay "ultrathink"');
	check(".claude-plugin/plugin.json", at(claude, "repository") === IDENTITY.repositoryUrl, "repository must stay the claude-ultrathink repository");
	for (const file of [".claude-plugin/marketplace.json", ".omp-plugin/marketplace.json"] as const) {
		check(file, at(loaders[file], "name") === "ultrathink", 'name must stay "ultrathink"');
		check(file, at(loaders[file], "plugins", "0", "name") === "ultrathink", 'plugins[0].name must stay "ultrathink"');
		for (const key of graftedKeys(at(loaders[file], "plugins", "0"), ["description"])) {
			findings.push(`loader: ${file} plugins[0] must not carry the descriptor key "${key}"`);
		}
	}
	const muse = loaders[".muse-plugin/plugin.json"];
	check(".muse-plugin/plugin.json", at(muse, "schemaVersion") === 1, "schemaVersion must stay 1");
	check(".muse-plugin/plugin.json", at(muse, "name") === "ultrathink", 'name must stay "ultrathink"');
	check(".muse-plugin/plugin.json", at(muse, "displayName") === "Ultrathink", 'displayName must stay "Ultrathink"');
	for (const kind of ["skills", "commands"]) {
		const entries = at(muse, "capabilities", kind);
		check(".muse-plugin/plugin.json", Array.isArray(entries) && entries.length > 0, `capabilities.${kind} must stay a non-empty list`);
		for (const entry of Array.isArray(entries) ? entries : []) {
			const path = at(entry, "path");
			const problem = typeof path === "string" && pathFindings("", path).length === 0 ? containmentFinding(root, path) : "it is not a clean relative file path";
			check(".muse-plugin/plugin.json", problem === undefined, `capabilities.${kind} path ${JSON.stringify(path)} must exist: ${problem}`);
		}
	}
	check(".muse-plugin/plugin.json", !String(JSON.stringify(at(muse, "capabilities"))).includes(DISCOVERY_STEM), "capabilities must not include the discovery descriptor");
	for (const file of LOADER_FILES) {
		for (const key of graftedKeys(loaders[file], LOADER_OWN_KEYS[file])) findings.push(`loader: ${file} must not carry the descriptor key "${key}"`);
	}
	return findings;
}

export type { Descriptor, JsonObject, LoaderFile };
export {
	approved,
	at,
	BAD_PATHS,
	CAPABILITIES,
	containmentFinding,
	declaredPaths,
	DESCRIPTOR_FILE,
	DESCRIPTOR_LIMIT,
	descriptorFindings,
	DRAFT_2020_12,
	HOST_MAPPING,
	IDENTITY,
	loaderFindings,
	MAX_PATH_REFERENCES,
	NORMATIVE_PATHS,
	pathReferenceFindings,
	readLoaders,
	readResource,
	SCHEMA_FILE,
	SCHEMA_LIMIT,
	SCHEMA_POINTER,
	SCHEMA_VERSION,
	schemaFindings,
};
