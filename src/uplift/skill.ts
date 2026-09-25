// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { isTrivial } from "./detect.ts";

export interface SkillInvocation {
	/** As invoked, without a leading "/" or Omp's "skill:" prefix; Claude plugin skills keep "plugin:skill". */
	name: string;
	/** What the user typed alongside the skill; undefined for a bare invocation. */
	instruction?: string;
	/** What the skill does: frontmatter `description`, else the first `<objective>` block, else the first body paragraph; whitespace-collapsed, <= 600 chars. */
	summary?: string;
	source: "omp" | "hermes" | "hermes-bundle" | "slash";
}

export interface SkillLookup {
	cwd: string;
	/** Defaults to os.homedir(). */
	home?: string;
	/** This plugin's checkout, whose commands/ and skills/ are ultrathink's own. Defaults to the running copy. */
	pluginRoot?: string;
}

/** Ultrathink's own skills; a user typing one of them must never re-plan (duplicate tracker rows). */
export const ULTRATHINK_SKILLS: readonly string[] = ["ultrathink-kickoff", "ultrathink-sync", "ultrathink-plan", "ultrathink-ship"];

const SUMMARY_MAX = 600;
const OMP_PREFIX_RE = /^\[IMPORTANT: User invoked the "([^"]+)" skill; follow its instructions\. Full skill below\.\]/;
const HERMES_PREFIX = '[IMPORTANT: The user has invoked the "';
const HERMES_SINGLE_TAIL = '" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]';
const HERMES_INSTRUCTION = "The user has provided the following instruction alongside the skill invocation: ";
const HERMES_RUNTIME = "\n\n[Runtime note:";
const BUNDLE_INSTRUCTION = "\nUser instruction: ";
const BUNDLE_END = "\n\n[Loaded as part of the ";
const OMP_DIR = "\n[Skill directory: ";
const OMP_USER = "\nUser: ";
const NAME_RE = /^[A-Za-z0-9._:-]+$/;
/** `/ultrathink:<anything>` and `/ultrathink <verb>`: ultrathink's command namespace, answered by the hooks, never planned. */
const ULTRATHINK_COMMAND_RE = /^ultrathink(?::|$)/i;
/** The running copy of this plugin (Claude's `${CLAUDE_PLUGIN_ROOT}`, or the checkout Grok, Muse, Omp and Hermes load). */
const PLUGIN_ROOT = resolve(import.meta.dir, "..", "..");
/** Claude Code stacked slash skills (`/review /simplify fix it`) resolved per prompt, first command included. */
const MAX_STACKED_SKILLS = 5;

function collapse(text: string): string | undefined {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : flat;
}

function nonEmpty(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed ? trimmed : undefined;
}

function splitFrontmatter(text: string): { frontmatter?: string; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!match) return { body: text };
	return { frontmatter: match[1], body: text.slice(match[0].length) };
}

function frontmatterDescription(frontmatter: string): string | undefined {
	const lines = frontmatter.split(/\r?\n/);
	const index = lines.findIndex((line) => /^description:/.test(line));
	if (index < 0) return undefined;
	const value = (lines[index] ?? "").slice("description:".length).trim();
	if (value && !/^[>|][+-]?$/.test(value)) {
		const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
		return collapse(quoted ? (quoted[2] ?? "") : value);
	}
	const block: string[] = [];
	for (const line of lines.slice(index + 1)) {
		if (line.trim() && !/^\s/.test(line)) break;
		block.push(line);
	}
	return collapse(block.join(" "));
}

function bodySummary(body: string): string | undefined {
	const objective = /<objective>([\s\S]*?)<\/objective>/i.exec(body);
	if (objective) {
		const summary = collapse(objective[1] ?? "");
		if (summary) return summary;
	}
	for (const paragraph of body.split(/\r?\n\s*\r?\n/)) {
		const trimmed = paragraph.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		return collapse(trimmed);
	}
	return undefined;
}

/** Recognizes Omp and Hermes skill scaffolding. Pure, no filesystem. */
export function parseSkillScaffold(prompt: string): SkillInvocation | undefined {
	const text = prompt.replace(/^\s+/, "");
	const omp = OMP_PREFIX_RE.exec(text);
	if (omp) {
		const name = omp[1] ?? "";
		const dirAt = text.lastIndexOf(OMP_DIR);
		const body = text.slice(omp[0].length, dirAt < 0 ? undefined : dirAt).replace(/\n---\s*$/, "");
		let instruction: string | undefined;
		if (dirAt >= 0) {
			const userAt = text.indexOf(OMP_USER, dirAt + OMP_DIR.length);
			if (userAt >= 0) instruction = nonEmpty(text.slice(userAt + OMP_USER.length));
		}
		return { name, instruction, summary: bodySummary(body), source: "omp" };
	}
	if (!text.startsWith(HERMES_PREFIX)) return undefined;
	const nameEnd = text.indexOf('"', HERMES_PREFIX.length);
	if (nameEnd < 0) return undefined;
	const name = text.slice(HERMES_PREFIX.length, nameEnd);
	const headerEnd = text.indexOf("\n");
	const header = headerEnd < 0 ? text : text.slice(0, headerEnd);
	if (header.includes(" skill bundle,")) {
		// The user's instruction precedes the first loaded skill; a `User instruction:` line inside a skill body is not the user's.
		const loadedAt = text.indexOf(BUNDLE_END);
		const at = text.indexOf(BUNDLE_INSTRUCTION);
		let instruction: string | undefined;
		let body = text.slice(header.length);
		if (at >= 0 && (loadedAt < 0 || at < loadedAt)) {
			instruction = nonEmpty(text.slice(at + BUNDLE_INSTRUCTION.length, loadedAt < 0 ? undefined : loadedAt));
			body = text.slice(header.length, at);
		}
		return { name, instruction, summary: bodySummary(body), source: "hermes-bundle" };
	}
	if (!text.startsWith(HERMES_SINGLE_TAIL, nameEnd)) return undefined;
	const bodyStart = nameEnd + HERMES_SINGLE_TAIL.length;
	const at = text.lastIndexOf(HERMES_INSTRUCTION);
	let instruction: string | undefined;
	let body = text.slice(bodyStart);
	if (at >= bodyStart) {
		const rest = text.slice(at + HERMES_INSTRUCTION.length);
		const end = rest.indexOf(HERMES_RUNTIME);
		instruction = nonEmpty(end < 0 ? rest : rest.slice(0, end));
		body = text.slice(bodyStart, at);
	}
	return { name, instruction, summary: bodySummary(body), source: "hermes" };
}

function normalizeName(raw: string): string {
	return raw.replace(/^\//, "").replace(/^skill:/, "");
}

/** `/name args` or a Claude `<command-name>/name</command-name> … <command-args>args</command-args>` expansion. Pure. `<local-command…` is not a command invocation. */
export function parseSlashCommand(prompt: string): { name: string; args?: string } | undefined {
	const text = prompt.trim();
	if (text.startsWith("/")) {
		const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
		const name = match ? normalizeName(`/${match[1] ?? ""}`) : "";
		if (!name) return undefined;
		return { name, args: nonEmpty(match?.[2]) };
	}
	if (!/^<command-(?:name|message)\b/i.test(text)) return undefined;
	const command = /<command-name>\s*([\s\S]*?)\s*<\/command-name>/i.exec(text);
	const name = normalizeName(command?.[1] ?? "");
	if (!name) return undefined;
	const args = /<command-args>([\s\S]*?)<\/command-args>/i.exec(text);
	return { name, args: nonEmpty(args?.[1]) };
}

/** The typed text inside the `<user_query>` wrapper Grok puts first in the prompt its hooks receive (skill and context blocks follow). Pure. */
export function grokUserQuery(prompt: string): string | undefined {
	return /^<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(prompt.trimStart())?.[1];
}

function readSkill(path: string): { path: string; summary?: string } | undefined {
	try {
		if (!statSync(path).isFile()) return undefined;
		const { frontmatter, body } = splitFrontmatter(readFileSync(path, "utf8"));
		return { path, summary: (frontmatter ? frontmatterDescription(frontmatter) : undefined) ?? bodySummary(body) };
	} catch {
		return undefined;
	}
}

function globFirst(root: string, pattern: string): string | undefined {
	try {
		const hits = [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true, followSymlinks: true })].sort();
		return hits[0] === undefined ? undefined : join(root, hits[0]);
	} catch {
		return undefined;
	}
}

/** SKILL.md / command .md for a slash command name, or undefined (built-in or unknown command). */
export function resolveSkillFile(name: string, lookup: SkillLookup): { path: string; summary?: string } | undefined {
	const normalized = normalizeName(name);
	if (!NAME_RE.test(normalized) || normalized.includes("..")) return undefined;
	const home = lookup.home ?? homedir();
	const parts = normalized.split(":");
	if (parts.length === 2 && parts[0] && parts[1]) {
		const [plugin, skill] = parts;
		const root = join(home, ".claude", "plugins", "cache");
		for (const pattern of [`*/${plugin}/*/skills/${skill}/SKILL.md`, `*/${plugin}/*/commands/${skill}.md`]) {
			const hit = globFirst(root, pattern);
			const found = hit ? readSkill(hit) : undefined;
			if (found) return found;
		}
		return undefined;
	}
	if (parts.length !== 1) return undefined;
	const pluginRoot = lookup.pluginRoot ?? PLUGIN_ROOT;
	const candidates = [
		// Claude lets users type this plugin's commands and skills unqualified (`/ultrathink-quick`).
		join(pluginRoot, "commands", `${normalized}.md`),
		join(pluginRoot, "skills", normalized, "SKILL.md"),
		join(lookup.cwd, ".claude", "skills", normalized, "SKILL.md"),
		join(lookup.cwd, ".claude", "commands", `${normalized}.md`),
		join(home, ".claude", "skills", normalized, "SKILL.md"),
		join(home, ".claude", "commands", `${normalized}.md`),
		join(home, ".agents", "skills", normalized, "SKILL.md"),
		join(home, ".grok", "skills", normalized, "SKILL.md"),
		join(home, ".omp", "agent", "skills", normalized, "SKILL.md"),
	];
	for (const path of candidates) {
		const found = readSkill(path);
		if (found) return found;
	}
	return undefined;
}

function isUltrathinkSkill(name: string): boolean {
	const bare = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
	return ULTRATHINK_SKILLS.includes(bare);
}

/** A resolved skill or command file that lives under this plugin's root (symlinks resolved) is ultrathink's own. */
function ownFile(path: string, lookup: SkillLookup): "ultrathink-command" | "ultrathink-skill" | undefined {
	try {
		const root = realpathSync(lookup.pluginRoot ?? PLUGIN_ROOT);
		const file = realpathSync(path);
		if (!file.startsWith(`${root}${sep}`)) return undefined;
		return file.startsWith(`${join(root, "commands")}${sep}`) ? "ultrathink-command" : "ultrathink-skill";
	} catch {
		return undefined;
	}
}

function targetFor(skill: SkillInvocation): { text: string; skill: SkillInvocation } {
	const text =
		skill.instruction && !isTrivial(skill.instruction)
			? skill.instruction
			: `Run the "${skill.name}" skill.${skill.summary ? ` ${skill.summary}` : ""}`;
	return { text, skill };
}

/**
 * What ultrathink plans for a prompt: the plain prompt, the instruction inside a skill invocation
 * (or the skill's objective for a bare one), or a skip for ultrathink's own skills and commands and non-skill slash commands.
 */
export function planningTarget(
	prompt: string,
	lookup: SkillLookup,
): { text: string; skill?: SkillInvocation } | { skip: "slash-command" | "ultrathink-skill" | "ultrathink-command" } {
	const scaffold = parseSkillScaffold(prompt);
	if (scaffold) {
		if (scaffold.name.split(/\s+/).some((part) => isUltrathinkSkill(normalizeName(part)))) {
			return { skip: "ultrathink-skill" };
		}
		return targetFor(scaffold);
	}
	const command = parseSlashCommand(prompt);
	// Grok wraps what the user typed in <user_query>; ultrathink's own skills and commands must not plan there either.
	const typed = command ?? parseSlashCommand(grokUserQuery(prompt) ?? "");
	if (!typed) return { text: prompt };
	if (isUltrathinkSkill(typed.name)) return { skip: "ultrathink-skill" };
	if (ULTRATHINK_COMMAND_RE.test(typed.name)) return { skip: "ultrathink-command" };
	const file = resolveSkillFile(typed.name, lookup);
	const own = file && ownFile(file.path, lookup);
	if (own) return { skip: own };
	if (!command) return { text: prompt };
	if (!file) return { skip: "slash-command" };
	let instruction = command.args;
	for (let count = 1; count < MAX_STACKED_SKILLS && instruction?.startsWith("/"); count++) {
		const stacked = parseSlashCommand(instruction);
		if (!stacked) break;
		if (isUltrathinkSkill(stacked.name)) return { skip: "ultrathink-skill" };
		if (ULTRATHINK_COMMAND_RE.test(stacked.name)) return { skip: "ultrathink-command" };
		const stackedFile = resolveSkillFile(stacked.name, lookup);
		if (!stackedFile) break;
		const stackedOwn = ownFile(stackedFile.path, lookup);
		if (stackedOwn) return { skip: stackedOwn };
		instruction = stacked.args;
	}
	return targetFor({ name: command.name, instruction, summary: file.summary, source: "slash" });
}
