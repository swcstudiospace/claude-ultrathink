// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject } from "../src/decisions/client.ts";
import { HOSTS, isHostId } from "../src/host/types.ts";
import type { Descriptor, JsonObject, LoaderFile } from "./discovery-manifest.helpers.ts";
import {
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
} from "./discovery-manifest.helpers.ts";

// Static discovery (UT-Static-Discovery 1.0.0). Only the two root discovery resources and the known loader
// manifests are read, through one bounded and contained reader. Nothing here executes or imports an entrypoint,
// fetches (the schema's $schema URI is compared, never resolved) or writes outside OS temp dirs it removes.
// A pass proves parsing, strict shape, source identity and containment; not installation, inference or bot support.

/** The trusted checkout root is this test's own checkout, never a path taken from metadata. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A disposable checkout in the OS temp dir: every approved path as an empty regular file, a .planning file and a sibling outside dir. */
function fixture(): { root: string; outside: string } {
	const base = mkdtempSync(join(tmpdir(), "ultrathink-discovery-"));
	dirs.push(base);
	const root = join(base, "checkout");
	const outside = join(base, "outside");
	for (const path of [...NORMATIVE_PATHS, ".planning/PLAN.md"]) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), "");
	}
	mkdirSync(outside);
	writeFileSync(join(outside, "target.ts"), "");
	return { root, outside };
}

describe("published discovery resources", () => {
	test("both root resources are contained regular files within 16384 and 32768 bytes that parse to JSON objects", () => {
		expect(isPlainObject(readResource(ROOT, DESCRIPTOR_FILE, DESCRIPTOR_LIMIT))).toBe(true);
		expect(isPlainObject(readResource(ROOT, SCHEMA_FILE, SCHEMA_LIMIT))).toBe(true);
	});

	test("the descriptor passes every strict shape rule and the exact host mapping", () => {
		expect(descriptorFindings(readResource(ROOT, DESCRIPTOR_FILE, DESCRIPTOR_LIMIT))).toEqual([]);
	});

	test("the schema is a strict, offline Draft 2020-12 resource that encodes the same contract as the reader", () => {
		expect(schemaFindings(readResource(ROOT, SCHEMA_FILE, SCHEMA_LIMIT))).toEqual([]);
	});

	test("the hosts are exactly the supported HostIds, and neither external bot label is a HostId", () => {
		const descriptor = readResource(ROOT, DESCRIPTOR_FILE, DESCRIPTOR_LIMIT);
		expect(descriptorFindings(descriptor)).toEqual([]);
		const { hosts, externalIntegrations } = descriptor as Descriptor;
		expect(Object.keys(hosts).sort()).toEqual([...HOSTS].sort());
		for (const label of Object.keys(externalIntegrations)) expect(isHostId(label)).toBe(false);
	});

	test("every declared path is a contained regular file of the checkout, each checked once and never executed", () => {
		const descriptor = readResource(ROOT, DESCRIPTOR_FILE, DESCRIPTOR_LIMIT);
		expect(descriptorFindings(descriptor)).toEqual([]);
		expect(declaredPaths(descriptor as Descriptor).length).toBeLessThanOrEqual(MAX_PATH_REFERENCES);
		expect(pathReferenceFindings(ROOT, descriptor as Descriptor)).toEqual([]);
	});
});

describe("loader manifests, read-only", () => {
	test("keep the ultrathink names, the claude-ultrathink repository, the Omp and pi extension and the Muse identity, with nothing grafted from the descriptor", () => {
		expect(loaderFindings(ROOT, readLoaders(ROOT))).toEqual([]);
	});

	test.each<[string, (loaders: Record<LoaderFile, JsonObject>) => void, string]>([
		["a renamed package", (l) => Object.assign(l["package.json"], { name: "claude-ultrathink" }), 'loader: package.json name must stay "ultrathink"'],
		[
			"another package repository",
			(l) => Object.assign(l["package.json"], { repository: { type: "git", url: "git+https://github.com/swcstudiospace/ultrathink.git" } }),
			"loader: package.json repository.url must stay the claude-ultrathink repository",
		],
		[
			"the descriptor as the Omp extension",
			(l) => Object.assign(l["package.json"].omp as JsonObject, { extensions: [`./${DESCRIPTOR_FILE}`] }),
			"loader: package.json omp.extensions must keep ./src/host/omp.ts",
		],
		[
			"the descriptor added as a pi extension",
			(l) => ((l["package.json"].pi as JsonObject).extensions as string[]).push(`./${DESCRIPTOR_FILE}`),
			"loader: package.json pi.extensions must not load the discovery descriptor",
		],
		[
			"a Claude plugin pointing at another repository",
			(l) => Object.assign(l[".claude-plugin/plugin.json"], { repository: "https://github.com/swcstudiospace/ultrathink" }),
			"loader: .claude-plugin/plugin.json repository must stay the claude-ultrathink repository",
		],
		[
			"a renamed Omp marketplace plugin",
			(l) => Object.assign((l[".omp-plugin/marketplace.json"].plugins as JsonObject[])[0], { name: "claude-ultrathink" }),
			'loader: .omp-plugin/marketplace.json plugins[0].name must stay "ultrathink"',
		],
		[
			"a changed Muse display name",
			(l) => Object.assign(l[".muse-plugin/plugin.json"], { displayName: "Claude Ultrathink" }),
			'loader: .muse-plugin/plugin.json displayName must stay "Ultrathink"',
		],
		[
			"a Muse schemaVersion in descriptor form",
			(l) => Object.assign(l[".muse-plugin/plugin.json"], { schemaVersion: SCHEMA_VERSION }),
			"loader: .muse-plugin/plugin.json schemaVersion must stay 1",
		],
		[
			"a missing Muse skill file",
			(l) => Object.assign(((l[".muse-plugin/plugin.json"].capabilities as JsonObject).skills as JsonObject[])[0], { path: "skills/missing/SKILL.md" }),
			'loader: .muse-plugin/plugin.json capabilities.skills path "skills/missing/SKILL.md" must exist: containment: skills/missing/SKILL.md is missing',
		],
		[
			"the descriptor as a Muse capability",
			(l) => ((l[".muse-plugin/plugin.json"].capabilities as JsonObject).skills as JsonObject[]).push({ id: "ultrathink-discovery", path: DESCRIPTOR_FILE }),
			"loader: .muse-plugin/plugin.json capabilities must not include the discovery descriptor",
		],
		[
			"supportedHosts grafted onto the Claude marketplace",
			(l) => Object.assign(l[".claude-plugin/marketplace.json"], { supportedHosts: ["grok-bot"] }),
			'loader: .claude-plugin/marketplace.json must not carry the descriptor key "supportedHosts"',
		],
		["descriptor hosts grafted onto package.json", (l) => Object.assign(l["package.json"], { hosts: {} }), 'loader: package.json must not carry the descriptor key "hosts"'],
		[
			"descriptor capabilities grafted onto the Claude plugin",
			(l) => Object.assign(l[".claude-plugin/plugin.json"], { capabilities: ["prompt-uplift"] }),
			'loader: .claude-plugin/plugin.json must not carry the descriptor key "capabilities"',
		],
		[
			"externalIntegrations grafted onto the Omp marketplace plugin entry",
			(l) => Object.assign((l[".omp-plugin/marketplace.json"].plugins as JsonObject[])[0], { externalIntegrations: {} }),
			'loader: .omp-plugin/marketplace.json plugins[0] must not carry the descriptor key "externalIntegrations"',
		],
	])("%s fails", (_label, edit, finding) => {
		const loaders = readLoaders(ROOT);
		edit(loaders as Record<LoaderFile, JsonObject>);
		expect(loaderFindings(ROOT, loaders)).toContain(finding);
	});
});

describe("descriptor negative vectors", () => {
	test("the approved descriptor passes, so each vector fails only for its own edit", () => {
		expect(descriptorFindings(approved())).toEqual([]);
	});

	test.each([1, 400])("a description of %i characters satisfies the length bounds", (length) => {
		const descriptor = approved();
		descriptor.description = "x".repeat(length);
		expect(descriptorFindings(descriptor)).toEqual([]);
	});

	test.each<[string, (descriptor: Descriptor) => void, string]>([
		["an absent schemaVersion", (d) => Reflect.deleteProperty(d, "schemaVersion"), 'shape: /schemaVersion must be "1.0.0"'],
		["an unknown schemaVersion", (d) => Object.assign(d, { schemaVersion: "2.0.0" }), 'shape: /schemaVersion must be "1.0.0"'],
		["a numeric schemaVersion", (d) => Object.assign(d, { schemaVersion: 1 }), 'shape: /schemaVersion must be "1.0.0"'],
		["a remote $schema", (d) => Object.assign(d, { $schema: DRAFT_2020_12 }), `shape: /$schema must be "${SCHEMA_POINTER}"`],
		["an unknown root field", (d) => Object.assign(d, { mcpServers: [] }), 'shape: / has unknown key "mcpServers"'],
		["an unknown identity field", (d) => Object.assign(d.identity, { alias: "claude-ultrathink" }), 'shape: /identity has unknown key "alias"'],
		["an unknown host field", (d) => Object.assign(d.hosts.omp, { verified: true }), 'shape: /hosts/omp has unknown key "verified"'],
		["an unknown interface field", (d) => Object.assign(d.interfaces.controls, { command: "plan" }), 'shape: /interfaces/controls has unknown key "command"'],
		["an unknown bot field", (d) => Object.assign(d.externalIntegrations["gpt-dot"], { publisher: "unknown" }), 'shape: /externalIntegrations/gpt-dot has unknown key "publisher"'],
		["a renamed repository", (d) => Object.assign(d.identity, { repository: "ultrathink" }), 'shape: /identity/repository must be "claude-ultrathink"'],
		[
			"another repository URL",
			(d) => Object.assign(d.identity, { repositoryUrl: "https://github.com/swcstudiospace/ultrathink" }),
			`shape: /identity/repositoryUrl must be "${IDENTITY.repositoryUrl}"`,
		],
		["a renamed package loader", (d) => Object.assign(d.identity, { package: "claude-ultrathink" }), 'shape: /identity/package must be "ultrathink"'],
		["a renamed plugin loader", (d) => Object.assign(d.identity, { plugin: "Ultrathink" }), 'shape: /identity/plugin must be "ultrathink"'],
		["a renamed marketplace loader", (d) => Object.assign(d.identity, { marketplace: "claude-ultrathink" }), 'shape: /identity/marketplace must be "ultrathink"'],
		[
			"a grok-bot host",
			(d) => Object.assign(d.hosts, { "grok-bot": { status: "source-present", entrypoints: ["hooks/engine.ts"], delivery: "pre-llm-plan-handoff" } }),
			"shape: /hosts/grok-bot is not a supported HostId",
		],
		[
			"a gpt-dot host",
			(d) => Object.assign(d.hosts, { "gpt-dot": { status: "source-present", entrypoints: ["hooks/engine.ts"], delivery: "pre-llm-plan-handoff" } }),
			"shape: /hosts/gpt-dot is not a supported HostId",
		],
		["a missing host", (d) => Reflect.deleteProperty(d.hosts, "hermes"), 'shape: /hosts is missing "hermes"'],
		["a host claiming more than source presence", (d) => Object.assign(d.hosts["grok-build"], { status: "verified" }), 'shape: /hosts/grok-build/status must be "source-present"'],
		["a wrong delivery", (d) => Object.assign(d.hosts.muse, { delivery: "local-plan-carrier" }), 'shape: /hosts/muse/delivery must be "hook-additional-context"'],
		["an unknown delivery", (d) => Object.assign(d.hosts.omp, { delivery: "remote-planner" }), 'shape: /hosts/omp/delivery must be "extension-inline-or-deferred-aside"'],
		[
			"the Omp marketplace in place of package.json",
			(d) => Object.assign(d.hosts.omp, { entrypoints: [".omp-plugin/marketplace.json", "src/host/omp.ts"] }),
			`semantic: /hosts/omp/entrypoints must be ${JSON.stringify(HOST_MAPPING.omp.entrypoints)}`,
		],
		[
			"swapped Grok Build and Muse entrypoints",
			(d) => {
				[d.hosts["grok-build"].entrypoints, d.hosts.muse.entrypoints] = [d.hosts.muse.entrypoints, d.hosts["grok-build"].entrypoints];
			},
			`semantic: /hosts/grok-build/entrypoints must be ${JSON.stringify(HOST_MAPPING["grok-build"].entrypoints)}`,
		],
		[
			"an extra existing file",
			(d) => d.hosts.hermes.entrypoints.push("bin/run-bun"),
			`semantic: /hosts/hermes/entrypoints must be ${JSON.stringify(HOST_MAPPING.hermes.entrypoints)}`,
		],
		["a repeated entrypoint", (d) => d.hosts["claude-code"].entrypoints.splice(3, 1, "hooks/hooks.json"), "shape: /hosts/claude-code/entrypoints repeats a path"],
		["no entrypoints", (d) => Object.assign(d.hosts.muse, { entrypoints: [] }), "shape: /hosts/muse/entrypoints must be an array of 1 to 8 paths"],
		[
			"nine entrypoints",
			(d) => Object.assign(d.hosts.omp, { entrypoints: Array.from({ length: 9 }, (_, index) => `src/host/file-${index}.ts`) }),
			"shape: /hosts/omp/entrypoints must be an array of 1 to 8 paths",
		],
		[
			"a missing capability",
			(d) => Object.assign(d, { capabilities: CAPABILITIES.filter((label) => label !== "planning-controls") }),
			'shape: /capabilities is missing "planning-controls"',
		],
		["a repeated capability", (d) => d.capabilities.splice(6, 1, "prompt-uplift"), 'shape: /capabilities repeats "prompt-uplift"'],
		["an unknown capability", (d) => d.capabilities.splice(6, 1, "planning-mcp-server"), 'shape: /capabilities has unknown label "planning-mcp-server"'],
		["a missing relay service", (d) => Object.assign(d.interfaces.trackerMcp, { providers: ["notion", "linear"] }), 'shape: /interfaces/trackerMcp/providers is missing "greptile"'],
		[
			"a repeated relay service",
			(d) => Object.assign(d.interfaces.trackerMcp, { providers: ["notion", "linear", "linear"] }),
			'shape: /interfaces/trackerMcp/providers repeats "linear"',
		],
		["a planning relay service", (d) => d.interfaces.trackerMcp.providers.push("ultrathink"), 'shape: /interfaces/trackerMcp/providers has unknown label "ultrathink"'],
		["controls that can plan", (d) => Object.assign(d.interfaces.controls, { canPlan: true }), "shape: /interfaces/controls/canPlan must be false"],
		["a tracker relay that can plan", (d) => Object.assign(d.interfaces.trackerMcp, { canPlan: true }), "shape: /interfaces/trackerMcp/canPlan must be false"],
		[
			"a networked planner transport",
			(d) => Object.assign(d.interfaces.jsonPlanner, { transport: "mcp-streamable-http" }),
			'shape: /interfaces/jsonPlanner/transport must be "json-stdin-stdout"',
		],
		["Grok Bot adapterPresent false", (d) => Object.assign(d.externalIntegrations["grok-bot"], { adapterPresent: false }), "shape: /externalIntegrations/grok-bot/adapterPresent must be true"],
		[
			"a Grok Bot delivery that is not the skill protocol",
			(d) => Object.assign(d.externalIntegrations["grok-bot"], { delivery: "hook-additional-context" }),
			'shape: /externalIntegrations/grok-bot/delivery must be "skill-protocol"',
		],
		[
			"Grok Bot compatibilityVerified true",
			(d) => Object.assign(d.externalIntegrations["grok-bot"], { compatibilityVerified: true }),
			"shape: /externalIntegrations/grok-bot/compatibilityVerified must be false",
		],
		["GPT Dot adapterPresent true", (d) => Object.assign(d.externalIntegrations["gpt-dot"], { adapterPresent: true }), "shape: /externalIntegrations/gpt-dot/adapterPresent must be false"],
		[
			"GPT Dot compatibilityVerified true",
			(d) => Object.assign(d.externalIntegrations["gpt-dot"], { compatibilityVerified: true }),
			"shape: /externalIntegrations/gpt-dot/compatibilityVerified must be false",
		],
		[
			"a Grok Bot contract claimed as settled",
			(d) => Object.assign(d.externalIntegrations["grok-bot"], { status: "compatible" }),
			'shape: /externalIntegrations/grok-bot/status must be "skill-adapter"',
		],
		[
			"an invented GPT Dot identity",
			(d) => Object.assign(d.externalIntegrations["gpt-dot"], { identity: "documented-product" }),
			'shape: /externalIntegrations/gpt-dot/identity must be "unverified"',
		],
		["a missing bot record", (d) => Reflect.deleteProperty(d.externalIntegrations, "gpt-dot"), 'shape: /externalIntegrations is missing "gpt-dot"'],
		["an empty description", (d) => Object.assign(d, { description: "" }), "shape: /description must be a string of 1 to 400 characters"],
		["a description over 400 characters", (d) => Object.assign(d, { description: "x".repeat(401) }), "shape: /description must be a string of 1 to 400 characters"],
	])("%s fails", (_label, edit, finding) => {
		const descriptor = approved();
		edit(descriptor);
		expect(descriptorFindings(descriptor)).toContain(finding);
	});

	test.each(BAD_PATHS)("%s as a declared entrypoint fails the path rules", (_label, path, problem) => {
		const descriptor = approved();
		descriptor.hosts.muse.entrypoints[1] = path;
		expect(descriptorFindings(descriptor)).toContain(`path: /hosts/muse/entrypoints/1 ${problem}`);
	});

	test.each(BAD_PATHS)("%s as a Grok Bot entrypoint fails the path rules", (_label, path, problem) => {
		const descriptor = approved();
		const entrypoints = descriptor.externalIntegrations["grok-bot"]?.entrypoints;
		if (!entrypoints) throw new Error("the approved grok-bot record has no entrypoints");
		entrypoints[0] = path;
		expect(descriptorFindings(descriptor)).toContain(`path: /externalIntegrations/grok-bot/entrypoints/0 ${problem}`);
	});
});

describe("declared-path containment in a disposable checkout", () => {
	test("a checkout holding every declared path as a regular file passes, and a symlink that stays inside is resolved and allowed", () => {
		const { root } = fixture();
		expect(pathReferenceFindings(root, approved())).toEqual([]);
		rmSync(join(root, "hooks/uplift.ts"));
		symlinkSync("engine.ts", join(root, "hooks/uplift.ts"));
		expect(pathReferenceFindings(root, approved())).toEqual([]);
	});

	test.each<[string, (root: string, outside: string) => void, string[]]>([
		[
			"a file symlink that escapes the checkout",
			(root, outside) => {
				rmSync(join(root, "hooks/engine.ts"));
				symlinkSync(join(outside, "target.ts"), join(root, "hooks/engine.ts"));
			},
			["containment: hooks/engine.ts escapes the checkout root through a symlink"],
		],
		[
			"a directory symlink that escapes the checkout",
			(root, outside) => {
				mkdirSync(join(outside, "hermes"));
				for (const name of ["plugin.yaml", "__init__.py", "bridge.py"]) writeFileSync(join(outside, "hermes", name), "");
				rmSync(join(root, "hosts/hermes"), { recursive: true });
				symlinkSync(join(outside, "hermes"), join(root, "hosts/hermes"));
			},
			[
				"containment: hosts/hermes/plugin.yaml escapes the checkout root through a symlink",
				"containment: hosts/hermes/__init__.py escapes the checkout root through a symlink",
				"containment: hosts/hermes/bridge.py escapes the checkout root through a symlink",
			],
		],
		[
			"a symlink into .planning",
			(root) => {
				rmSync(join(root, "src/host/omp.ts"));
				symlinkSync("../../.planning/PLAN.md", join(root, "src/host/omp.ts"));
			},
			["containment: src/host/omp.ts resolves into .planning"],
		],
		["a missing file", (root) => rmSync(join(root, "hosts/grok/ultrathink.md")), ["containment: hosts/grok/ultrathink.md is missing"]],
		[
			"a dangling symlink",
			(root) => {
				rmSync(join(root, "bin/ultrathink"));
				symlinkSync("nowhere", join(root, "bin/ultrathink"));
			},
			["containment: bin/ultrathink is missing"],
		],
		[
			"a directory",
			(root) => {
				rmSync(join(root, "bin/ultrathink-mcp"));
				mkdirSync(join(root, "bin/ultrathink-mcp"));
			},
			["containment: bin/ultrathink-mcp is not a regular file"],
		],
	])("%s is rejected and every other declared path still passes", (_label, damage, expected) => {
		const { root, outside } = fixture();
		damage(root, outside);
		expect(pathReferenceFindings(root, approved())).toEqual(expected);
	});

	test("containment rejects a lexical escape before resolving it, and an unclean declared path is never inspected", () => {
		const { root } = fixture();
		expect(containmentFinding(root, "../outside/target.ts")).toBe("containment: ../outside/target.ts resolves outside the checkout root");
		const descriptor = approved();
		descriptor.hosts.omp.entrypoints[2] = "../outside/target.ts";
		expect(pathReferenceFindings(root, descriptor)).toEqual(['containment: "../outside/target.ts" is not inspected: it is not a clean relative file path']);
	});

	test("more than 44 path references are refused without inspecting any of them", () => {
		const { root } = fixture();
		const descriptor = approved();
		descriptor.hosts.omp.entrypoints = Array.from({ length: 41 }, (_, index) => `src/host/file-${index}.ts`);
		const references = declaredPaths(descriptor).length;
		expect(references).toBeGreaterThan(MAX_PATH_REFERENCES);
		expect(pathReferenceFindings(root, descriptor)).toEqual([`containment: ${references} path references exceed ${MAX_PATH_REFERENCES}`]);
	});
});

describe("bounded resource reading in a disposable checkout", () => {
	test("a descriptor of exactly 16384 bytes is read; one byte more, or far more, is refused before it is parsed", () => {
		const { root } = fixture();
		const path = join(root, DESCRIPTOR_FILE);
		const json = JSON.stringify(approved());
		writeFileSync(path, json.padEnd(DESCRIPTOR_LIMIT, " "));
		expect(descriptorFindings(readResource(root, DESCRIPTOR_FILE, DESCRIPTOR_LIMIT))).toEqual([]);
		for (const content of [json.padEnd(DESCRIPTOR_LIMIT + 1, " "), "{".repeat(4 * DESCRIPTOR_LIMIT)]) {
			writeFileSync(path, content);
			expect(() => readResource(root, DESCRIPTOR_FILE, DESCRIPTOR_LIMIT)).toThrow(`bounds: ${DESCRIPTOR_FILE} is larger than ${DESCRIPTOR_LIMIT} bytes`);
		}
	});

	test("a schema of exactly 32768 bytes is read; one byte more is refused", () => {
		const { root } = fixture();
		const path = join(root, SCHEMA_FILE);
		const json = JSON.stringify(readResource(ROOT, SCHEMA_FILE, SCHEMA_LIMIT));
		writeFileSync(path, json.padEnd(SCHEMA_LIMIT, " "));
		expect(schemaFindings(readResource(root, SCHEMA_FILE, SCHEMA_LIMIT))).toEqual([]);
		writeFileSync(path, json.padEnd(SCHEMA_LIMIT + 1, " "));
		expect(() => readResource(root, SCHEMA_FILE, SCHEMA_LIMIT)).toThrow(`bounds: ${SCHEMA_FILE} is larger than ${SCHEMA_LIMIT} bytes`);
	});

	test.each<[string, string | Uint8Array, string]>([
		["malformed JSON", '{"schemaVersion": "1.0.0",', `parse: ${DESCRIPTOR_FILE} is not valid JSON`],
		["bytes that are not UTF-8", new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), `parse: ${DESCRIPTOR_FILE} is not UTF-8`],
	])("%s is refused", (_label, content, error) => {
		const { root } = fixture();
		writeFileSync(join(root, DESCRIPTOR_FILE), content);
		expect(() => readResource(root, DESCRIPTOR_FILE, DESCRIPTOR_LIMIT)).toThrow(error);
	});

	test.each(["null", "[]", '[{"schemaVersion": "1.0.0"}]', '"1.0.0"'])("a descriptor that parses to %s is not an object", (content) => {
		const { root } = fixture();
		writeFileSync(join(root, DESCRIPTOR_FILE), content);
		expect(descriptorFindings(readResource(root, DESCRIPTOR_FILE, DESCRIPTOR_LIMIT))).toEqual(["shape: / must be a JSON object"]);
	});

	test.each<[string, (root: string, outside: string) => void, string]>([
		["a missing descriptor", () => {}, `containment: ${DESCRIPTOR_FILE} is missing`],
		[
			"a descriptor symlinked outside the checkout",
			(root, outside) => {
				writeFileSync(join(outside, DESCRIPTOR_FILE), JSON.stringify(approved()));
				symlinkSync(join(outside, DESCRIPTOR_FILE), join(root, DESCRIPTOR_FILE));
			},
			`containment: ${DESCRIPTOR_FILE} escapes the checkout root through a symlink`,
		],
		["a descriptor that is a directory", (root) => mkdirSync(join(root, DESCRIPTOR_FILE)), `containment: ${DESCRIPTOR_FILE} is not a regular file`],
	])("%s is never read", (_label, arrange, error) => {
		const { root, outside } = fixture();
		arrange(root, outside);
		expect(() => readResource(root, DESCRIPTOR_FILE, DESCRIPTOR_LIMIT)).toThrow(error);
	});
});

describe("schema negative vectors", () => {
	const node = (schema: JsonObject, ...path: string[]) => at(schema, ...path) as JsonObject;

	test.each<[string, (schema: JsonObject) => void, string]>([
		["a draft-07 $schema", (s) => Object.assign(s, { $schema: "http://json-schema.org/draft-07/schema#" }), `schema: /$schema must be "${DRAFT_2020_12}"`],
		["a remote $id", (s) => Object.assign(s, { $id: "https://example.invalid/ultrathink.discovery.schema.json" }), `schema: /$id must be "${SCHEMA_FILE}"`],
		[
			"a remote $ref",
			(s) => Object.assign(node(s, "properties", "hosts", "properties", "omp", "allOf", "0"), { $ref: "https://example.invalid/host.schema.json" }),
			"schema: /properties/hosts/properties/omp/allOf/0/$ref must be an internal reference that resolves",
		],
		[
			"a dangling internal $ref",
			(s) => Object.assign(node(s, "$defs", "hostAdapter", "properties", "entrypoints", "items"), { $ref: "#/$defs/missingFile" }),
			"schema: /$defs/hostAdapter/properties/entrypoints/items/$ref must be an internal reference that resolves",
		],
		[
			"a nested object without additionalProperties",
			(s) => Reflect.deleteProperty(node(s, "properties", "interfaces", "properties", "controls"), "additionalProperties"),
			"schema: /properties/interfaces/properties/controls/additionalProperties must be false",
		],
		[
			"a nested object open to extra keys",
			(s) => Object.assign(node(s, "properties", "externalIntegrations", "properties", "gpt-dot"), { additionalProperties: true }),
			"schema: /properties/externalIntegrations/properties/gpt-dot/additionalProperties must be false",
		],
		[
			"an optional identity field",
			(s) => Object.assign(node(s, "properties", "identity"), { required: ["repository"] }),
			"schema: /properties/identity/required must list exactly its properties",
		],
		[
			"Grok Bot denied an adapter",
			(s) => Object.assign(node(s, "properties", "externalIntegrations", "properties", "grok-bot", "properties", "adapterPresent"), { const: false }),
			"schema: /properties/externalIntegrations/properties/grok-bot/properties/adapterPresent/const must be true",
		],
		[
			"Grok Bot left on the pending contract",
			(s) => Object.assign(node(s, "properties", "externalIntegrations", "properties", "grok-bot", "properties", "status"), { const: "pending-contract" }),
			'schema: /properties/externalIntegrations/properties/grok-bot/properties/status/const must be "skill-adapter"',
		],
		[
			"GPT Dot allowed verified compatibility",
			(s) => Object.assign(node(s, "properties", "externalIntegrations", "properties", "gpt-dot", "properties", "compatibilityVerified"), { const: true }),
			"schema: /properties/externalIntegrations/properties/gpt-dot/properties/compatibilityVerified/const must be false",
		],
		[
			"another Omp delivery",
			(s) => Object.assign(node(s, "properties", "hosts", "properties", "omp", "allOf", "1", "properties", "delivery"), { const: "hook-additional-context" }),
			'schema: /properties/hosts/properties/omp/allOf/1/properties/delivery/const must be "extension-inline-or-deferred-aside"',
		],
		[
			"a permissive relativeFile pattern",
			(s) => Object.assign(node(s, "$defs", "relativeFile"), { pattern: ".*" }),
			'schema: /$defs/relativeFile/pattern accepts "/abs/hooks/uplift.ts"',
		],
	])("%s fails", (_label, edit, finding) => {
		const schema = readResource(ROOT, SCHEMA_FILE, SCHEMA_LIMIT);
		if (!isPlainObject(schema)) throw new Error("the published schema is not a JSON object");
		edit(schema);
		expect(schemaFindings(schema)).toContain(finding);
	});
});
