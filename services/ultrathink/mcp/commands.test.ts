// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ULTRATHINK_VERBS } from "../../../src/uplift/commands.ts";
import {
	CatalogDriftError,
	COMMAND_OVERLAY,
	CONNECTOR_NATIVE_NAMES,
	helpText,
	loadCommandCatalog,
	type OverlayEntry,
	overlayEntry,
	parseFrontmatter,
	REPOSITORY_ROOT,
	resolveCommand,
	toPromptName,
	toToolName,
} from "./commands.ts";
import { loadCatalogWithFallback } from "./connector-host.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repository root holding only the given files; each value is the file's text. */
function fixtureRoot(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "ultrathink-commands-"));
	temporaryRoots.push(root);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

function frontmatter(name: string): string {
	return `---\nname: ${name}\ndescription: ${name} text\n---\n\nBody\n`;
}

/** The connector-native entries, which need no file; fixtures add what a test is about. */
function nativeOverlay(extra: Record<string, OverlayEntry> = {}): Record<string, OverlayEntry> {
	const overlay: Record<string, OverlayEntry> = {};
	for (const name of CONNECTOR_NATIVE_NAMES) {
		const entry = COMMAND_OVERLAY[name];
		if (entry !== undefined) overlay[name] = entry;
	}
	return { ...overlay, ...extra };
}

const UNSUPPORTED: OverlayEntry = { state: "unsupported", tools: [], reason: "r", instead: "i" };

describe("the catalog over the real repository files", () => {
	const catalog = loadCommandCatalog(REPOSITORY_ROOT);

	test("loads and holds exactly the overlay keys, once each", () => {
		const names = catalog.commands.map((command) => command.name);
		expect(new Set(names).size).toBe(names.length);
		expect([...names].sort()).toEqual(Object.keys(COMMAND_OVERLAY).sort());
	});

	test("every command defined by a file is in the catalog and every catalog command is a file or connector-native", () => {
		for (const command of catalog.commands) {
			if (command.sources.length === 0) expect(CONNECTOR_NATIVE_NAMES).toContain(command.name);
			for (const source of command.sources) expect(source.path).toMatch(/(^commands\/[^/]+\.md|\/SKILL\.md)$/);
		}
		expect(catalog.find("ultrathink-quick")?.sources.map((source) => source.kind)).toContain("command");
		expect(catalog.find("ultrathink-teach-admin")?.sources.map((source) => source.kind)).toEqual(["host-skill"]);
		expect(catalog.find("ultrathink")?.sources).toEqual([]);
	});

	test("ULTRATHINK_VERBS are all command files and all in the catalog", () => {
		for (const verb of ULTRATHINK_VERBS) {
			const command = catalog.find(`ultrathink-${verb}`);
			expect(command?.sources.map((source) => source.kind)).toContain("command");
		}
	});

	test("identifiers are valid, canonical and collision-free over every real name", () => {
		const prompts = catalog.commands.map((command) => toPromptName(command.name));
		const tools = catalog.commands.map((command) => command.toolName);
		expect(prompts).toEqual(catalog.commands.map((command) => command.name));
		expect(new Set(tools).size).toBe(tools.length);
		for (const tool of tools) expect(tool).toMatch(/^[a-z0-9_]+$/);
		for (const prompt of prompts) expect(prompt).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
	});

	test("names, descriptions and argument hints of shared commands come from the files", () => {
		const quick = catalog.find("ultrathink-quick");
		expect(quick?.description).toContain("no Ultrathink planning");
		expect(quick?.argumentHint).toBe("<message>");
		const decisions = catalog.find("ultrathink-decisions");
		expect(decisions?.description).toContain("/ultrathink-decisions");
		expect(catalog.find("ultrathink")?.description).not.toBe("");
		for (const command of catalog.commands) expect(command.description).not.toBe("");
	});

	test("every unsupported state has a reason and an alternative and no prompt arguments; every supported one has a summary", () => {
		for (const command of catalog.commands) {
			if (command.state === "unsupported") {
				expect(command.reason?.trim()).toBeTruthy();
				expect(command.instead?.trim()).toBeTruthy();
				expect(command.arguments).toEqual([]);
			} else {
				expect(command.summary?.trim()).toBeTruthy();
			}
		}
	});

	test("the catalog covers every discovered command, and the Cursor plugin skill is one unsupported entry", () => {
		// Plugin skills, Grok Bot skills and plugin command files are all connector commands; each needs one catalog entry.
		const discovered = new Set<string>([
			...readdirSync(join(REPOSITORY_ROOT, "skills")),
			...readdirSync(join(REPOSITORY_ROOT, "hosts/grok-bot/skills")),
			...readdirSync(join(REPOSITORY_ROOT, "commands"))
				.filter((file) => file.endsWith(".md"))
				.map((file) => file.slice(0, -".md".length)),
		]);
		for (const name of discovered) expect(catalog.find(name), name).toBeDefined();
		const cursor = catalog.find("ultrathink-cursor");
		expect(cursor?.state).toBe("unsupported");
		expect(cursor?.reason?.trim()).toBeTruthy();
		expect(cursor?.instead?.trim()).toBeTruthy();
		expect(cursor?.sources.map((source) => source.path).sort()).toEqual([
			"hosts/grok-bot/skills/ultrathink-cursor/SKILL.md",
			"skills/ultrathink-cursor/SKILL.md",
		]);
	});

	test("the locked states of 65-CONTEXT hold", () => {
		const state = (name: string) => catalog.find(name)?.state;
		expect(state("ultrathink")).toBe("native");
		expect(state("ultrathink-plan")).toBe("alias");
		expect(catalog.find("ultrathink-plan")?.aliasOf).toBe("ultrathink");
		for (const name of ["ultrathink-think", "ultrathink-last", "ultrathink-status"]) expect(state(name)).toBe("native");
		expect(state("ultrathink-quick")).toBe("passthrough");
		const unsupported = catalog.commands.filter((command) => command.state === "unsupported").map((command) => command.name);
		expect(unsupported.sort()).toEqual(
			[
				"ultrathink-skip",
				"ultrathink-off",
				"ultrathink-on",
				"ultrathink-track",
				"ultrathink-kickoff",
				"ultrathink-sync",
				"ultrathink-ship",
				"ultrathink-teach",
				"ultrathink-teach-admin",
				"ultrathink-learn",
				"ultrathink-lessons",
				"ultrathink-decisions",
				"ultrathink-hindsight",
				"ultrathink-engine",
				"ultrathink-protocol",
				"ultrathink-hitl",
				"ultrathink-cursor",
			].sort(),
		);
	});
});

describe("the catalog loader refuses drift", () => {
	test("a command file without an overlay entry", () => {
		const root = fixtureRoot({ "commands/ultrathink-foo.md": frontmatter("ultrathink-foo") });
		expect(() => loadCommandCatalog(root, nativeOverlay())).toThrow(/without an overlay entry: ultrathink-foo/);
	});

	test("an overlay key with no source", () => {
		const root = fixtureRoot({});
		expect(() => loadCommandCatalog(root, nativeOverlay({ "ultrathink-ghost": UNSUPPORTED }))).toThrow(
			/without a source: ultrathink-ghost/,
		);
	});

	test("a missing native entry", () => {
		const root = fixtureRoot({});
		const overlay = nativeOverlay();
		delete overlay["ultrathink-last"];
		expect(() => loadCommandCatalog(root, overlay)).toThrow(/without an overlay entry: ultrathink-last/);
	});

	test("two names that map to one prompt name", () => {
		const root = fixtureRoot({
			"skills/a/SKILL.md": frontmatter("Ultrathink-Foo"),
			"hosts/grok-bot/skills/b/SKILL.md": frontmatter("ultrathink-foo"),
		});
		expect(() => loadCommandCatalog(root, nativeOverlay({ "ultrathink-foo": UNSUPPORTED }))).toThrow(
			/map to the prompt name ultrathink-foo/,
		);
	});

	test("two names that map to one tool name", () => {
		const root = fixtureRoot({
			"commands/a.md": frontmatter("ultrathink-a-b"),
			"commands/b.md": frontmatter("ultrathink-a_b"),
		});
		const overlay = nativeOverlay({ "ultrathink-a-b": UNSUPPORTED, "ultrathink-a_b": UNSUPPORTED });
		expect(() => loadCommandCatalog(root, overlay)).toThrow(/map to the tool name ultrathink_a_b/);
	});

	test("a file without a frontmatter name", () => {
		const root = fixtureRoot({ "commands/nameless.md": "---\ndescription: x\n---\n" });
		expect(() => loadCommandCatalog(root, nativeOverlay())).toThrow(/no frontmatter name: commands\/nameless\.md/);
	});

	test("malformed entries: unsupported without reason, alias of an unsupported command, supported without arguments", () => {
		const root = fixtureRoot({
			"commands/ultrathink-bad.md": frontmatter("ultrathink-bad"),
			"commands/ultrathink-loop.md": frontmatter("ultrathink-loop"),
			"commands/ultrathink-bare.md": frontmatter("ultrathink-bare"),
		});
		const overlay = nativeOverlay({
			"ultrathink-bad": { state: "unsupported", tools: [] },
			"ultrathink-loop": { state: "alias", aliasOf: "ultrathink-bad", summary: "s", tools: [], arguments: [] },
			"ultrathink-bare": { state: "passthrough", summary: "s", tools: [] },
		});
		expect(() => loadCommandCatalog(root, overlay)).toThrow(
			/ultrathink-bad: unsupported without a reason.*ultrathink-bad: unsupported without an alternative.*ultrathink-loop: alias target ultrathink-bad.*ultrathink-bare: passthrough without a prompt argument list/,
		);
	});

	test("an empty repository root loads with the native commands only", () => {
		const catalog = loadCommandCatalog(fixtureRoot({}), nativeOverlay());
		expect(catalog.commands.map((command) => command.name)).toEqual([...CONNECTOR_NATIVE_NAMES]);
	});
});

describe("loadCatalogWithFallback", () => {
	test("drift is a CatalogDriftError with a stable code", () => {
		const root = fixtureRoot({ "commands/ultrathink-foo.md": frontmatter("ultrathink-foo") });
		let thrown: unknown;
		try {
			loadCommandCatalog(root, nativeOverlay());
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(CatalogDriftError);
		expect((thrown as CatalogDriftError).code).toBe("CATALOG_DRIFT");
	});

	test("absent source directories fall back to the static overlay and report why", () => {
		const reasons: unknown[] = [];
		const catalog = loadCatalogWithFallback((error) => reasons.push(error), fixtureRoot({}));
		expect(reasons.length).toBe(1);
		expect(catalog.commands.map((command) => command.name)).toEqual(Object.keys(COMMAND_OVERLAY));
	});

	test("present sources load the real catalog without a fallback", () => {
		const reasons: unknown[] = [];
		const catalog = loadCatalogWithFallback((error) => reasons.push(error));
		expect(reasons).toEqual([]);
		expect(catalog.commands.map((command) => command.name)).toEqual(Object.keys(COMMAND_OVERLAY));
		expect(catalog.find("ultrathink-status")?.sources.length).toBeGreaterThan(0);
	});

	test("drift is rethrown, not downgraded to the overlay", () => {
		const root = fixtureRoot({ "commands/ultrathink-foo.md": frontmatter("ultrathink-foo") });
		const reasons: unknown[] = [];
		expect(() => loadCatalogWithFallback((error) => reasons.push(error), root)).toThrow(CatalogDriftError);
		expect(reasons).toEqual([]);
	});

	test("an unreadable source (a file where a directory belongs) is rethrown", () => {
		const root = fixtureRoot({ commands: "not a directory" });
		const reasons: unknown[] = [];
		expect(() => loadCatalogWithFallback((error) => reasons.push(error), root)).toThrow();
		expect(reasons).toEqual([]);
	});
});

describe("toPromptName and toToolName", () => {
	test("namespaced, slashed and upper-case forms map to one name", () => {
		for (const input of ["ultrathink:ultrathink-quick", "/ultrathink-quick", "ULTRATHINK-QUICK", " /Ultrathink:Ultrathink-Quick "]) {
			expect(toPromptName(input)).toBe("ultrathink-quick");
		}
		expect(toPromptName("ultrathink:quick")).toBe("quick");
	});

	test("characters outside [a-z0-9_-] become dashes, repeats collapse and the ends are trimmed", () => {
		expect(toPromptName("ultrathink teach  admin")).toBe("ultrathink-teach-admin");
		expect(toPromptName("--a..b--")).toBe("a-b");
		expect(toPromptName("_a__b_")).toBe("a_b");
		expect(toPromptName("ünï")).toBe("n");
	});

	test("an empty result is an error", () => {
		for (const input of ["", "   ", "/", "///", "ultrathink:", "--__--", "日本語"]) {
			expect(() => toPromptName(input)).toThrow(/invalid command name/);
		}
	});

	test("the tool form replaces dashes with underscores", () => {
		expect(toToolName("ultrathink-quick")).toBe("ultrathink_quick");
		expect(toToolName("/ultrathink:ultrathink-teach-admin")).toBe("ultrathink_teach_admin");
		expect(() => toToolName("//")).toThrow();
	});
});

describe("resolveCommand", () => {
	test("accepts the full name, the short name, a slash, a namespace and any case", () => {
		for (const input of ["ultrathink-think", "think", "/ultrathink-think", "ultrathink:ultrathink-think", "THINK", " /Think "]) {
			const resolved = resolveCommand(input);
			expect(resolved).toMatchObject({ kind: "command", name: "ultrathink-think", target: "ultrathink-think" });
		}
		expect(resolveCommand("ultrathink")).toMatchObject({ kind: "command", name: "ultrathink" });
		expect(resolveCommand("/ULTRATHINK")).toMatchObject({ kind: "command", name: "ultrathink" });
	});

	test("an alias resolves to its target and a passthrough or unsupported command to itself", () => {
		expect(resolveCommand("plan")).toMatchObject({ kind: "command", name: "ultrathink-plan", target: "ultrathink" });
		expect(resolveCommand("quick")).toMatchObject({ kind: "command", name: "ultrathink-quick", target: "ultrathink-quick" });
		const skip = resolveCommand("ultrathink:ultrathink-skip");
		expect(skip.kind === "command" && skip.entry.state).toBe("unsupported");
	});

	test("help is its own resolution and names that only inherit from Object are unknown", () => {
		expect(resolveCommand("help")).toEqual({ kind: "help" });
		expect(resolveCommand("/HELP")).toEqual({ kind: "help" });
		for (const input of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
			expect(resolveCommand(input).kind).toBe("unknown");
		}
	});

	test("unknown names list the closest commands, or the supported ones when nothing is close", () => {
		const close = resolveCommand("thnk");
		expect(close).toEqual({ kind: "unknown", suggestions: expect.arrayContaining(["ultrathink-think"]) });
		const substring = resolveCommand("teac");
		expect(substring.kind === "unknown" && substring.suggestions).toEqual(["ultrathink-teach", "ultrathink-teach-admin"]);
		const far = resolveCommand("zzzzzzzzzzzzzzzz");
		expect(far.kind === "unknown" && far.suggestions).toEqual([
			"ultrathink",
			"ultrathink-plan",
			"ultrathink-think",
			"ultrathink-last",
			"ultrathink-status",
			"ultrathink-quick",
		]);
	});

	test("non-string, empty and oversize input is unknown, not an exception", () => {
		for (const input of [undefined, null, 7, {}, "", "   ", "//", "x".repeat(101)]) {
			expect(resolveCommand(input).kind).toBe("unknown");
		}
	});
});

describe("overlayEntry and helpText", () => {
	test("overlayEntry reads own properties only", () => {
		expect(overlayEntry(COMMAND_OVERLAY, "ultrathink")?.state).toBe("native");
		expect(overlayEntry(COMMAND_OVERLAY, "constructor")).toBeUndefined();
	});

	test("helpText lists every command with its state, and the reason and alternative of unsupported ones", () => {
		const text = helpText();
		for (const [name, entry] of Object.entries(COMMAND_OVERLAY)) {
			expect(text).toContain(`/${name} - `);
			if (entry.state === "unsupported") {
				expect(text).toContain(`unsupported here: ${entry.reason}; instead: ${entry.instead}`);
			} else {
				expect(text).toContain(`/${name} - ${entry.state}: `);
			}
		}
	});
});

describe("parseFrontmatter", () => {
	test("plain, quoted, folded and literal values", () => {
		const text = [
			"---",
			"name: ultrathink-x",
			'description: "Use when #1: quoted \\"text\\""',
			"argument-hint: '<it''s>'",
			"folded: >-",
			"  one two",
			"  three",
			"literal: |",
			"  a",
			"  b",
			"plain: first",
			"  second",
			"---",
			"",
			"name: not-this",
		].join("\n");
		expect(parseFrontmatter(text)).toEqual({
			name: "ultrathink-x",
			description: 'Use when #1: quoted "text"',
			"argument-hint": "<it's>",
			folded: "one two three",
			literal: "a\nb",
			plain: "first second",
		});
	});

	test("CRLF files and files without frontmatter", () => {
		expect(parseFrontmatter("---\r\nname: a\r\ndescription: b c\r\n---\r\n")).toEqual({ name: "a", description: "b c" });
		expect(parseFrontmatter("# Title\nname: a\n")).toEqual({});
		expect(parseFrontmatter("")).toEqual({});
	});
});
