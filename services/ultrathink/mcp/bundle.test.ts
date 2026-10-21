// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Parity and hygiene of the Claude plugin bundle in plugins/ultrathink-connector/. The bundle must offer exactly the
 * commands the connector supports, tell Claude which tools to call, list the connector as a url-only http server,
 * and carry nothing that looks like a credential. Read-only: nothing here writes or builds the archive.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { COMMAND_OVERLAY, parseFrontmatter, REPOSITORY_ROOT } from "./commands.ts";
import { renderPrompt } from "./prompts.ts";
import { CONNECTOR_TOOL_DEFINITIONS } from "./tools-connector.ts";

const BUNDLE = join(REPOSITORY_ROOT, "plugins", "ultrathink-connector");
const COMMANDS_DIRECTORY = join(BUNDLE, "commands");

const supported = Object.entries(COMMAND_OVERLAY).filter(([, entry]) => entry.state !== "unsupported");
const unsupported = Object.entries(COMMAND_OVERLAY).filter(([, entry]) => entry.state === "unsupported");

/** The tool names a plan command spells out for the client-driven path, on top of the catalog's own list. */
const CLIENT_DRIVEN_TOOLS = ["ultrathink_pending", "ultrathink_show", "ultrathink_answer", "ultrathink_status"];

function read(relative: string): string {
	return readFileSync(join(BUNDLE, relative), "utf8");
}

function commandFiles(): string[] {
	return readdirSync(COMMANDS_DIRECTORY)
		.filter((file) => file.endsWith(".md"))
		.sort();
}

/** Every file of the bundle as a path relative to it, leaving out a built dist/. */
function bundleFiles(): string[] {
	return readdirSync(BUNDLE, { recursive: true, encoding: "utf8" })
		.filter((path) => !path.split(/[\\/]/).includes("dist"))
		.filter((path) => statSync(join(BUNDLE, path)).isFile())
		.sort();
}

describe("plugin bundle commands", () => {
	test("the command files are exactly the supported catalog commands", () => {
		const files = commandFiles()
			.map((file) => file.slice(0, -".md".length))
			.sort();
		expect(files).toEqual(supported.map(([name]) => name).sort());
	});

	test("every command has a description, and an argument-hint where the catalog takes arguments", () => {
		for (const [name, entry] of supported) {
			const fields = parseFrontmatter(read(`commands/${name}.md`));
			expect(fields.description ?? "", `${name} description`).not.toBe("");
			if ((entry.arguments ?? []).length > 0) {
				expect(fields["argument-hint"] ?? "", `${name} argument-hint`).not.toBe("");
			}
		}
	});

	test("every command body names the tools the catalog lists for it", () => {
		for (const [name, entry] of supported) {
			const body = read(`commands/${name}.md`);
			for (const tool of entry.tools) expect(body, `${name} names ${tool}`).toContain(`\`${tool}\``);
			if (entry.tools.includes("ultrathink_plan")) {
				for (const tool of CLIENT_DRIVEN_TOOLS) expect(body, `${name} names ${tool}`).toContain(`\`${tool}\``);
			}
			if (entry.arguments !== undefined && entry.arguments.length > 0) {
				expect(body, `${name} reads the user's text`).toContain("$ARGUMENTS");
			}
		}
	});

	test("a command only names tools of its own catalog entry", () => {
		const known = [...Object.values(COMMAND_OVERLAY).flatMap((entry) => entry.tools), ...CLIENT_DRIVEN_TOOLS];
		for (const [name, entry] of supported) {
			// The client-driven plan flow also draws the card with ultrathink_graph (CLIENT_GRAPH_RULE); the overlay lists the entry tools only.
			const allowed = entry.tools.includes("ultrathink_plan") ? [...entry.tools, ...CLIENT_DRIVEN_TOOLS, "ultrathink_graph"] : entry.tools;
			for (const tool of read(`commands/${name}.md`).match(/ultrathink_[a-z]+/g) ?? []) {
				expect(known, `${name} mentions the unknown tool ${tool}`).toContain(tool);
				expect(allowed, `${name} mentions ${tool}, which its catalog entry does not list`).toContain(tool);
			}
		}
	});

	test("every statement of how /ultrathink-last resolves the newest planned session agrees", () => {
		expect(read("commands/ultrathink-last.md")).toContain("`ultrathink_graph` with no arguments");
		expect(read("skills/ultrathink-connector/SKILL.md")).toContain("`ultrathink_graph` with no arguments");
		const rendered = renderPrompt("ultrathink-last", {});
		if (!rendered.ok) throw new Error("expected the ultrathink-last prompt");
		const promptText = rendered.messages.map((message) => message.content.text).join("\n");
		expect(promptText).toContain("ultrathink_graph with no arguments");
		const routing = readFileSync(join(REPOSITORY_ROOT, "services", "ultrathink", "mcp", "mcp.ts"), "utf8");
		expect(routing).toContain("/ultrathink-last calls ultrathink_graph with no arguments");
		const graphTool = CONNECTOR_TOOL_DEFINITIONS.find((tool) => tool.name === "ultrathink_graph");
		expect(graphTool?.description).toContain("/ultrathink-last");
	});

	test("plan commands show the wave tree first and stop on failed, invalid or skipped", () => {
		for (const name of ["ultrathink", "ultrathink-plan"]) {
			const body = read(`commands/${name}.md`);
			expect(body).toContain("wave tree");
			expect(body).toContain("failed, invalid or skipped");
			expect(body).toContain("sessionId");
			expect(body).toContain("40 seconds");
		}
	});

	test("ultrathink-quick calls no ultrathink tool", () => {
		expect(read("commands/ultrathink-quick.md")).not.toMatch(/ultrathink_[a-z]+/);
	});
});

describe("plugin bundle manifest and connector", () => {
	test("plugin.json names the plugin, its version and license", () => {
		const manifest: unknown = JSON.parse(read(".claude-plugin/plugin.json"));
		expect(manifest).toMatchObject({
			name: "ultrathink-connector",
			version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
			license: "AGPL-3.0-or-later",
			description: expect.any(String),
		});
		expect(readdirSync(join(BUNDLE, ".claude-plugin"))).toEqual(["plugin.json"]);
	});

	test(".mcp.json holds one url-only http server and nothing else", () => {
		const parsed: unknown = JSON.parse(read(".mcp.json"));
		expect(parsed).toEqual({
			mcpServers: { ultrathink: { type: "http", url: "https://ultrathink.swcstudio.space/mcp" } },
		});
	});

	test("the built zip stays out of git and the README names it", () => {
		expect(read(".gitignore").trim()).toBe("dist/");
		expect(read("README.md")).toContain("ultrathink-connector-<version>.zip");
	});

	const canBuild = Bun.which("zip") !== null || Bun.which("python3") !== null;
	const canList = Bun.which("unzip") !== null || Bun.which("python3") !== null;
	test.skipIf(!canBuild || !canList)(
		"running package.sh packs exactly the allowlist, whatever else sits in the working tree (skipped without zip or python3 to build, or unzip or python3 to list)",
		async () => {
			const copy = mkdtempSync(join(tmpdir(), "ut-bundle-"));
			try {
				cpSync(BUNDLE, copy, { recursive: true, filter: (source) => basename(source) !== "dist" });
				// Files that must stay out: a secret, an editor backup, a test, a dotfile in skills/ and a non-markdown file in commands/.
				writeFileSync(join(copy, ".env"), "SECRET=1\n");
				writeFileSync(join(copy, "notes.txt"), "scratch\n");
				writeFileSync(join(copy, "commands", "draft.md.bak"), "x\n");
				writeFileSync(join(copy, "commands", "helper.test.md"), "x\n");
				writeFileSync(join(copy, "skills", "ultrathink-connector", ".hidden"), "x\n");
				writeFileSync(join(copy, "skills", "ultrathink-connector", "skill.test.ts"), "x\n");

				const build = Bun.spawn(["sh", "package.sh"], { cwd: copy, stdout: "pipe", stderr: "pipe" });
				const [built, failure, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
				expect(code, failure).toBe(0);
				const archive = built.trim().split("\n").at(-1) ?? "";
				expect(archive).toMatch(/ultrathink-connector-\d+\.\d+\.\d+\.zip$/);

				const lister =
					Bun.which("unzip") !== null
						? ["unzip", "-Z1", archive]
						: ["python3", "-c", "import sys, zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", archive];
				const list = Bun.spawn(lister, { stdout: "pipe", stderr: "pipe" });
				const [listed, listFailure, listCode] = await Promise.all([new Response(list.stdout).text(), new Response(list.stderr).text(), list.exited]);
				expect(listCode, listFailure).toBe(0);
				const expected = [
					".claude-plugin/plugin.json",
					".mcp.json",
					"README.md",
					...commandFiles().map((file) => `commands/${file}`),
					"skills/ultrathink-connector/SKILL.md",
				].sort();
				expect(
					listed
						.split("\n")
						.filter((name) => name !== "")
						.sort(),
				).toEqual(expected);
			} finally {
				rmSync(copy, { recursive: true, force: true });
			}
		},
	);

	// The python3 fallback must keep the directory prefixes; `python3 -m zipfile -c` stores bare basenames.
	const noZipTools = ["dirname", "mkdir", "rm", "find", "sort", "grep", "sed", "printf", "cat", "python3"];
	const noZipPaths = noZipTools.map((tool) => [tool, Bun.which(tool)] as const);
	const canRunWithoutZip = noZipPaths.every(([, found]) => found !== null) && Bun.which("python3") !== null;
	test.skipIf(!canRunWithoutZip)(
		"package.sh without zip(1) still keeps the .claude-plugin/, commands/ and skills/ prefixes (skipped without python3 or the POSIX tools it calls)",
		async () => {
			const copy = mkdtempSync(join(tmpdir(), "ut-bundle-nozip-"));
			const tools = mkdtempSync(join(tmpdir(), "ut-bundle-tools-"));
			try {
				cpSync(BUNDLE, copy, { recursive: true, filter: (source) => basename(source) !== "dist" });
				// A PATH holding only the tools package.sh calls, and not zip, forces the python3 branch.
				for (const [tool, found] of noZipPaths) {
					if (found !== null) symlinkSync(found, join(tools, tool));
				}
				expect(existsSync(join(tools, "zip"))).toBe(false);

				const build = Bun.spawn(["/bin/sh", "package.sh"], { cwd: copy, env: { PATH: tools }, stdout: "pipe", stderr: "pipe" });
				const [built, failure, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
				expect(code, failure).toBe(0);
				const archive = built.trim().split("\n").at(-1) ?? "";
				expect(archive).toMatch(/ultrathink-connector-\d+\.\d+\.\d+\.zip$/);

				const python = Bun.which("python3") ?? "python3";
				const list = Bun.spawn([python, "-c", "import sys, zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", archive], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const [listed, listFailure, listCode] = await Promise.all([new Response(list.stdout).text(), new Response(list.stderr).text(), list.exited]);
				expect(listCode, listFailure).toBe(0);
				const expected = [
					".claude-plugin/plugin.json",
					".mcp.json",
					"README.md",
					...commandFiles().map((file) => `commands/${file}`),
					"skills/ultrathink-connector/SKILL.md",
				].sort();
				expect(
					listed
						.split("\n")
						.filter((name) => name !== "")
						.sort(),
				).toEqual(expected);
			} finally {
				rmSync(copy, { recursive: true, force: true });
				rmSync(tools, { recursive: true, force: true });
			}
		},
	);
});

describe("plugin bundle skill", () => {
	const skill = (): string => read("skills/ultrathink-connector/SKILL.md"); // four call sites, one path

	test("the skill has the name of its folder and a description", () => {
		const fields = parseFrontmatter(skill());
		expect(fields.name).toBe("ultrathink-connector");
		expect(fields.description ?? "").not.toBe("");
	});

	test("the skill names every unsupported command with its reason and alternative", () => {
		const text = skill();
		for (const [name, entry] of unsupported) {
			expect(text, `${name}`).toContain(`/${name}\``);
			expect(text, `${name} reason`).toContain(entry.reason ?? "unreachable");
			expect(text, `${name} alternative`).toContain(entry.instead ?? "unreachable");
		}
	});

	test("the skill names every supported command and every connector tool it relies on", () => {
		const text = skill();
		for (const [name] of supported) expect(text, name).toContain(`/${name}`);
		const tools = Object.values(COMMAND_OVERLAY).flatMap((entry) => entry.tools);
		for (const tool of [...tools, ...CLIENT_DRIVEN_TOOLS, "ultrathink_command"]) expect(text, tool).toContain(tool);
	});

	test("the skill marks what is not verified", () => {
		expect(skill()).toContain("What is not verified");
		expect(read("README.md")).toContain("Not verified live");
	});
});

describe("plugin bundle hygiene", () => {
	test("no file of the bundle looks like a key, a header or a token", () => {
		const files = bundleFiles();
		expect(files.length).toBeGreaterThan(8);
		for (const file of files) {
			const text = read(file);
			expect(text, `${file} x-connector-key`).not.toMatch(/x-connector-key/i);
			expect(text, `${file} bearer`).not.toContain("Bearer ");
			expect(text, `${file} long hex string`).not.toMatch(/[0-9a-f]{32,}/i);
		}
	});

	test("the bundle has no test files, no archive and no executable hooks or binaries", () => {
		for (const file of bundleFiles()) expect(file, file).not.toMatch(/\.test\./);
		for (const absent of ["bin", "hooks", "agents"]) expect(existsSync(join(BUNDLE, absent)), absent).toBe(false);
	});

	test("the root plugin does not reference the bundle and its manifest stays the root one", () => {
		const rootManifestPath = join(REPOSITORY_ROOT, ".claude-plugin", "plugin.json");
		const rootManifest = readFileSync(rootManifestPath, "utf8");
		expect(rootManifest).not.toContain("ultrathink-connector");
		expect(JSON.parse(rootManifest)).toMatchObject({ name: "ultrathink" });
		expect(existsSync(join(REPOSITORY_ROOT, ".mcp.json"))).toBe(false);
		for (const file of readdirSync(join(REPOSITORY_ROOT, "commands"))) {
			expect(file, "bundle commands live in the bundle, not in the root plugin").not.toBe("ultrathink-connector.md");
		}
	});
});
