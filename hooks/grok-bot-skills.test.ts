// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Grok Bot ships skills, not a host adapter. These checks read the skill files and the discovery record.
// They do not execute a skill, start Bun as a planner, or contact a service.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GROK_ROOT = join(ROOT, "hosts/grok-bot");
const PROTOCOL = join(GROK_ROOT, "ultrathink-protocol/SKILL.md");

type Frontmatter = { keys: string[]; values: Record<string, string>; body: string };

/** PyYAML, not a first-colon split: an unquoted colon in `description` must fail this parse. */
function frontmatter(text: string, file: string): Frontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
	if (!match?.[1] || match[2] === undefined) throw new Error(`${file} is missing YAML frontmatter`);
	const parsed = spawnSync("python3", ["-c", "import json,sys,yaml; json.dump(yaml.safe_load(sys.stdin.read()), sys.stdout)"], {
		input: match[1],
		encoding: "utf8",
	});
	if (parsed.status !== 0) throw new Error(`${file} frontmatter is not valid YAML: ${parsed.stderr}`);
	const doc: unknown = JSON.parse(parsed.stdout);
	if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${file} frontmatter is not a YAML mapping`);
	const record = doc as Record<string, unknown>;
	const values: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		if (typeof value !== "string") throw new Error(`${file} frontmatter key ${key} is not a string`);
		values[key] = value;
	}
	return { keys: Object.keys(record), values, body: match[2] };
}

function skillFiles(): string[] {
	const files = [PROTOCOL];
	const commands = join(GROK_ROOT, "commands");
	for (const name of readdirSync(commands).sort()) {
		const skill = join(commands, name, "SKILL.md");
		if (!statSync(skill).isFile()) throw new Error(`${skill} is not a regular file`);
		files.push(skill);
	}
	return files;
}

describe("Grok Bot skills", () => {
	test("one command skill exists for each commands/*.md file, and no extra command skill exists", () => {
		const fromCommands = readdirSync(join(ROOT, "commands"))
			.filter((name) => name.endsWith(".md"))
			.map((name) => name.slice(0, -".md".length))
			.sort();
		const fromSkills = readdirSync(join(GROK_ROOT, "commands")).sort();
		expect(fromSkills).toEqual(fromCommands);
		for (const name of fromSkills) {
			expect(statSync(join(GROK_ROOT, "commands", name, "SKILL.md")).isFile()).toBe(true);
		}
	});

	test("every skill frontmatter has exactly name and description, and name matches the folder", () => {
		for (const file of skillFiles()) {
			const parsed = frontmatter(readFileSync(file, "utf8"), file);
			expect(parsed.keys).toEqual(["name", "description"]);
			const folder = file.split("/").at(-2);
			if (folder === undefined) throw new Error(`${file} has no parent folder`);
			expect(parsed.values.name).toBe(folder);
			expect(parsed.values.description.length).toBeGreaterThan(0);
			expect(parsed.body).not.toMatch(/https?:\/\//);
		}
	});

	test("ultrathink-protocol leads with when to use it and keeps the method inside the bot", () => {
		const parsed = frontmatter(readFileSync(PROTOCOL, "utf8"), PROTOCOL);
		expect(parsed.values.name).toBe("ultrathink-protocol");
		expect(parsed.values.description.startsWith("When to use it:")).toBe(true);
		for (const phrase of [
			"perform this method yourself",
			"Keep the XML spec and the graph internal",
			"bin/ultrathink",
			"hooks/engine.ts",
			"any CLI planner",
			"outside service",
			"<ORIGINAL>",
			"always runs this full protocol",
			"bare `/ultrathink-quick`",
			"`raw:`",
			"<SCOPE>",
			"<CONSTRAINTS>",
			"<ACCEPTANCE_CRITERIA>",
			"<OUT_OF_SCOPE>",
			"do not invent repository facts",
			"5 to 8",
			"<WORKFLOW>",
			"Verify:",
			"at most 4",
			"ultrathink graph <graphId> · node <nodeId>",
			"Linear is the default",
			"Notion is optional",
			"`Level` = `Task`",
			"Greptile",
		]) {
			expect(parsed.body).toContain(phrase);
		}
	});

	test("control skills describe a conversation preference and do not promise engine state", () => {
		const forbidden = ["bin/ultrathink", "hooks/engine.ts", "hooks/uplift.ts", "UserPromptSubmit", "last-plan.json", "state directory", "state file", "~/"];
		for (const file of skillFiles()) {
			if (file === PROTOCOL) continue;
			const parsed = frontmatter(readFileSync(file, "utf8"), file);
			expect(parsed.body.toLowerCase()).toContain("this conversation");
			for (const phrase of forbidden) expect(parsed.body).not.toContain(phrase);
		}
	});

	test("discovery lists grok-bot as an unverified skill-protocol adapter and leaves gpt-dot pending", () => {
		const discovery = JSON.parse(readFileSync(join(ROOT, "ultrathink.discovery.json"), "utf8")) as {
			externalIntegrations: Record<string, { identity: string; status: string; adapterPresent: boolean; compatibilityVerified: boolean; delivery?: string; entrypoints?: string[] }>;
		};
		const grok = discovery.externalIntegrations["grok-bot"];
		expect(grok).toMatchObject({
			identity: "documented-product",
			status: "skill-adapter",
			adapterPresent: true,
			compatibilityVerified: false,
			delivery: "skill-protocol",
		});
		const skillPaths = skillFiles().map((file) => file.slice(ROOT.length).replaceAll("\\", "/").replace(/^\//, ""));
		expect(grok?.entrypoints).toEqual(expect.arrayContaining([...skillPaths, "hosts/grok-bot/README.md"]));
		expect(discovery.externalIntegrations["gpt-dot"]).toEqual({
			identity: "unverified",
			status: "pending-identity-and-contract",
			adapterPresent: false,
			compatibilityVerified: false,
		});
	});
});
