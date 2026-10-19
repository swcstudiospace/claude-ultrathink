// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * The command catalog of the hosted connector. The universe of command names is read from the real plugin files
 * (commands/*.md, skills/<name>/SKILL.md, hosts/grok-bot/skills/<name>/SKILL.md) plus the connector-native names.
 * COMMAND_OVERLAY is the only place that says what each command is on the connector; it is keyed by name and never
 * repeats a name, description or argument hint that a file already owns. The loader refuses to build a catalog when
 * the universe and the overlay disagree, so a new plugin command cannot reach the connector without a decision.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** native: the connector implements it; alias: same as another command; passthrough: the model answers directly; unsupported: needs a plugin host. */
export type CommandState = "native" | "alias" | "passthrough" | "unsupported";

export interface CommandArgument {
	name: string;
	description: string;
	required: boolean;
}

export interface OverlayEntry {
	state: CommandState;
	/** The command an alias stands for. Required exactly when state is alias. */
	aliasOf?: string;
	/** One line of connector behavior. Required for every state except unsupported. */
	summary?: string;
	/** Ultrathink tools the command uses, in call order. */
	tools: readonly string[];
	/** Prompt arguments. Present (possibly empty) exactly when the command is listed as a prompt, so for every state except unsupported. */
	arguments?: readonly CommandArgument[];
	/** Why a plugin-host command has no connector behavior. Required when unsupported. */
	reason?: string;
	/** What to do instead. Required when unsupported. */
	instead?: string;
	/** Description for a command that no file defines. Ignored when a file defines the name. */
	description?: string;
}

/** The longest text argument any prompt or tool accepts, in characters. */
export const MAX_ARGUMENT_CHARS = 20_000;

const REQUEST_ARGUMENT: CommandArgument = { name: "request", description: "What to plan.", required: true };
const PLUGIN_HOST = "use it in a plugin host";
const HOSTS_WITH_PLUGIN = "run it in Claude Code, Omp, Grok Build, Hermes or Muse with the plugin";
const NO_AUTOMATIC_PLANNING =
	"planning runs only when /ultrathink is typed in chat, there is no automatic planning to switch";
const NO_AUTOMATIC_PLANNING_INSTEAD = "do not type /ultrathink, or use /ultrathink-quick <message>";
const TEACH_STATE = "Teachable Moments state lives on the host";
const OPERATOR_CONTROL = "it is an operator control for a plugin host's own planner";

/** Native names that exist on the connector even when no plugin file defines them. */
export const CONNECTOR_NATIVE_NAMES: readonly string[] = ["ultrathink", "ultrathink-think", "ultrathink-last"];

export const COMMAND_OVERLAY: Readonly<Record<string, OverlayEntry>> = {
	ultrathink: {
		state: "native",
		summary:
			"plans the request: ultrathink_uplift (server planning) or ultrathink_plan (client-driven), then ultrathink_result",
		tools: ["ultrathink_uplift", "ultrathink_plan", "ultrathink_result"],
		arguments: [REQUEST_ARGUMENT],
		description: "Plan a request before work starts",
	},
	"ultrathink-plan": {
		state: "alias",
		aliasOf: "ultrathink",
		summary: "same as /ultrathink",
		tools: ["ultrathink_uplift", "ultrathink_plan", "ultrathink_result"],
		arguments: [REQUEST_ARGUMENT],
	},
	"ultrathink-think": {
		state: "native",
		summary: "shows a plan's graph (diagram, tree, one node's steps) with ultrathink_graph",
		tools: ["ultrathink_graph"],
		arguments: [
			{
				name: "sessionId",
				description: "Session id of the plan to show. Omit for the newest planned session.",
				required: false,
			},
			{ name: "node", description: "Id of one node to show with its steps and conclusion.", required: false },
		],
		description: "Show the Graph of Thought of a plan",
	},
	"ultrathink-last": {
		state: "native",
		summary: "shows the newest planned session's plan with its diagram",
		tools: ["ultrathink_sessions", "ultrathink_result", "ultrathink_graph"],
		arguments: [],
		description: "Show the newest plan",
	},
	"ultrathink-status": {
		state: "native",
		summary: "shows the planning mode, ceilings and recent sessions with ultrathink_sessions",
		tools: ["ultrathink_sessions"],
		arguments: [],
	},
	"ultrathink-quick": {
		state: "passthrough",
		summary: "the model answers the message directly and calls no ultrathink tool",
		tools: [],
		arguments: [{ name: "message", description: "The message to answer directly.", required: true }],
	},
	"ultrathink-skip": {
		state: "unsupported",
		tools: [],
		reason: NO_AUTOMATIC_PLANNING,
		instead: NO_AUTOMATIC_PLANNING_INSTEAD,
	},
	"ultrathink-off": {
		state: "unsupported",
		tools: [],
		reason: NO_AUTOMATIC_PLANNING,
		instead: NO_AUTOMATIC_PLANNING_INSTEAD,
	},
	"ultrathink-on": {
		state: "unsupported",
		tools: [],
		reason: NO_AUTOMATIC_PLANNING,
		instead: NO_AUTOMATIC_PLANNING_INSTEAD,
	},
	"ultrathink-track": {
		state: "unsupported",
		tools: [],
		reason: "the hosted connector has no Linear or Notion tracking",
		instead: PLUGIN_HOST,
	},
	"ultrathink-kickoff": {
		state: "unsupported",
		tools: [],
		reason: "it needs git, a shell and the user's tracker or pull-request credentials",
		instead: HOSTS_WITH_PLUGIN,
	},
	"ultrathink-sync": {
		state: "unsupported",
		tools: [],
		reason: "it needs git, a shell and the user's tracker or pull-request credentials",
		instead: HOSTS_WITH_PLUGIN,
	},
	"ultrathink-ship": {
		state: "unsupported",
		tools: [],
		reason: "it needs git, a shell and the user's tracker or pull-request credentials",
		instead: HOSTS_WITH_PLUGIN,
	},
	"ultrathink-teach": { state: "unsupported", tools: [], reason: TEACH_STATE, instead: PLUGIN_HOST },
	"ultrathink-teach-admin": { state: "unsupported", tools: [], reason: TEACH_STATE, instead: PLUGIN_HOST },
	"ultrathink-learn": { state: "unsupported", tools: [], reason: TEACH_STATE, instead: PLUGIN_HOST },
	"ultrathink-lessons": { state: "unsupported", tools: [], reason: TEACH_STATE, instead: PLUGIN_HOST },
	"ultrathink-decisions": { state: "unsupported", tools: [], reason: OPERATOR_CONTROL, instead: PLUGIN_HOST },
	"ultrathink-hindsight": { state: "unsupported", tools: [], reason: OPERATOR_CONTROL, instead: PLUGIN_HOST },
	"ultrathink-engine": { state: "unsupported", tools: [], reason: OPERATOR_CONTROL, instead: PLUGIN_HOST },
	"ultrathink-protocol": { state: "unsupported", tools: [], reason: OPERATOR_CONTROL, instead: PLUGIN_HOST },
	"ultrathink-hitl": {
		state: "unsupported",
		tools: [],
		reason: "clarifying questions are part of every plan result",
		instead: "read the plan's questions",
	},
};

/** The overlay entry of a name, own properties only: a name such as "constructor" is not a command. */
export function overlayEntry(overlay: Readonly<Record<string, OverlayEntry>>, name: string): OverlayEntry | undefined {
	return Object.hasOwn(overlay, name) ? overlay[name] : undefined;
}

/** Where a command name was found, relative to the repository root. */
export interface CommandSource {
	kind: "command" | "skill" | "host-skill";
	path: string;
}

export interface CatalogCommand {
	/** Canonical prompt-safe name; also the overlay key. */
	name: string;
	/** Tool-safe form of the name: dashes replaced by underscores. */
	toolName: string;
	description: string;
	argumentHint?: string;
	sources: readonly CommandSource[];
	state: CommandState;
	aliasOf?: string;
	summary?: string;
	tools: readonly string[];
	arguments: readonly CommandArgument[];
	reason?: string;
	instead?: string;
}

export interface CommandCatalog {
	commands: readonly CatalogCommand[];
	find(name: string): CatalogCommand | undefined;
}

/** Repository root, derived from this file's place under services/ultrathink/mcp/. The release archive mirrors it. */
export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const NAMESPACE = "ultrathink:";

/**
 * The prompt identifier of a command name: lowercase, without a leading slash or `ultrathink:` plugin namespace,
 * every character outside [a-z0-9_-] replaced by `-`, repeats collapsed, `-` and `_` trimmed at both ends.
 * Throws when nothing is left.
 */
export function toPromptName(name: string): string {
	let text = name.trim().toLowerCase();
	if (text.startsWith("/")) text = text.slice(1);
	if (text.startsWith(NAMESPACE)) text = text.slice(NAMESPACE.length);
	const cleaned = text
		.replace(/[^a-z0-9_-]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/_{2,}/g, "_")
		.replace(/^[-_]+|[-_]+$/g, "");
	if (cleaned === "") throw new Error(`invalid command name: ${JSON.stringify(name)}`);
	return cleaned;
}

/** The tool-safe form of a command name: its prompt identifier with every `-` replaced by `_`. */
export function toToolName(name: string): string {
	return toPromptName(name).replaceAll("-", "_");
}

export type CommandResolution =
	| {
			kind: "command";
			name: string;
			entry: OverlayEntry;
			/** The command whose behavior applies: aliasOf for an alias, else name. */
			target: string;
	  }
	| { kind: "help" }
	| { kind: "unknown"; suggestions: string[] };

const MAX_COMMAND_INPUT_CHARS = 100;
const SHORT_PREFIX = "ultrathink-";

function shortForm(name: string): string {
	return name.startsWith(SHORT_PREFIX) ? name.slice(SHORT_PREFIX.length) : name;
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			row.push(Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
		}
		previous = row;
	}
	return previous[b.length] ?? 0;
}

/** The closest overlay names to `key`: substring matches first, then names within edit distance 3, else the supported commands. */
function suggest(key: string, overlay: Readonly<Record<string, OverlayEntry>>): string[] {
	const names = Object.keys(overlay);
	const short = shortForm(key);
	const supported = names.filter((name) => overlayEntry(overlay, name)?.state !== "unsupported");
	if (short === "") return supported;
	const contained = short.length >= 2 ? names.filter((name) => shortForm(name).includes(short)) : [];
	if (contained.length > 0) return contained.slice(0, 5);
	const near = names
		.map((name) => ({ name, distance: editDistance(short, shortForm(name)) }))
		.filter((candidate) => candidate.distance <= 3)
		.sort((a, b) => a.distance - b.distance);
	if (near.length > 0) return near.slice(0, 5).map((candidate) => candidate.name);
	return supported;
}

/**
 * Resolves what a user or model typed to a command: `ultrathink-think`, `think`, `/ultrathink-think`,
 * `ultrathink:ultrathink-think`, any case; `help` asks for the command list. Anything else is unknown, with the closest names.
 * Works on the overlay alone, so it never touches the filesystem.
 */
export function resolveCommand(input: unknown, overlay: Readonly<Record<string, OverlayEntry>> = COMMAND_OVERLAY): CommandResolution {
	if (typeof input !== "string" || input.length > MAX_COMMAND_INPUT_CHARS) {
		return { kind: "unknown", suggestions: suggest("", overlay) };
	}
	let key: string;
	try {
		key = toPromptName(input);
	} catch {
		return { kind: "unknown", suggestions: suggest("", overlay) };
	}
	for (const name of [key, `${SHORT_PREFIX}${key}`]) {
		const entry = overlayEntry(overlay, name);
		if (entry !== undefined) return { kind: "command", name, entry, target: entry.aliasOf ?? name };
	}
	if (key === "help") return { kind: "help" };
	return { kind: "unknown", suggestions: suggest(key, overlay) };
}

/** Lists every command with its connector state, from the overlay alone. */
export function helpText(overlay: Readonly<Record<string, OverlayEntry>> = COMMAND_OVERLAY): string {
	const lines = ["ultrathink commands on this connector:"];
	for (const [name, entry] of Object.entries(overlay)) {
		if (entry.state === "unsupported") {
			lines.push(`/${name} - unsupported here: ${entry.reason ?? ""}; instead: ${entry.instead ?? ""}`);
		} else {
			lines.push(`/${name} - ${entry.state}: ${entry.summary ?? ""}`);
		}
	}
	return lines.join("\n");
}

/** Frontmatter fields of a markdown file as strings: `key: value`, quoted values, folded `>`/`>-` and literal `|` blocks, indented continuations. */
export function parseFrontmatter(text: string): Record<string, string> {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const fields: Record<string, string> = {};
	if (lines[0]?.trim() !== "---") return fields;
	let index = 1;
	while (index < lines.length && lines[index]?.trim() !== "---") {
		const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[index] ?? "");
		index++;
		if (match === null) continue;
		const key = match[1] ?? "";
		const head = (match[2] ?? "").trim();
		const continuation: string[] = [];
		while (index < lines.length && lines[index]?.trim() !== "---") {
			const line = lines[index] ?? "";
			if (line !== "" && !line.startsWith(" ") && !line.startsWith("\t")) break;
			continuation.push(line.trim());
			index++;
		}
		while (continuation.at(-1) === "") continuation.pop();
		if (/^[>|][+-]?$/.test(head)) {
			fields[key] = continuation.join(head.startsWith(">") ? " " : "\n").replace(/ {2,}/g, " ").trim();
		} else {
			fields[key] = unquote([head, ...continuation].filter((part) => part !== "").join(" "));
		}
	}
	return fields;
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (typeof parsed === "string") return parsed;
		} catch {
			// Not valid JSON: keep the text between the quotes.
		}
		return value.slice(1, -1);
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
	return value;
}

interface Found {
	name: string;
	description: string;
	argumentHint: string | undefined;
	source: CommandSource;
}

function listDirectory(path: string): string[] {
	try {
		return readdirSync(path).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function readFound(root: string, relative: string, kind: CommandSource["kind"]): Found | undefined {
	let text: string;
	try {
		text = readFileSync(join(root, relative), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const fields = parseFrontmatter(text);
	const name = fields.name;
	if (name === undefined || name === "") throw new Error(`command file has no frontmatter name: ${relative}`);
	return {
		name,
		description: fields.description ?? "",
		argumentHint: fields["argument-hint"] === undefined || fields["argument-hint"] === "" ? undefined : fields["argument-hint"],
		source: { kind, path: relative },
	};
}

function scanSources(root: string): Found[] {
	const found: Found[] = [];
	for (const file of listDirectory(join(root, "commands"))) {
		if (!file.endsWith(".md")) continue;
		const entry = readFound(root, `commands/${file}`, "command");
		if (entry !== undefined) found.push(entry);
	}
	for (const [directory, kind] of [
		["skills", "skill"],
		["hosts/grok-bot/skills", "host-skill"],
	] as const) {
		for (const folder of listDirectory(join(root, directory))) {
			const entry = readFound(root, `${directory}/${folder}/SKILL.md`, kind);
			if (entry !== undefined) found.push(entry);
		}
	}
	return found;
}

function validateEntry(name: string, entry: OverlayEntry, overlay: Readonly<Record<string, OverlayEntry>>): string[] {
	const problems: string[] = [];
	if (entry.state === "unsupported") {
		if (!entry.reason) problems.push(`${name}: unsupported without a reason`);
		if (!entry.instead) problems.push(`${name}: unsupported without an alternative`);
		if (entry.arguments !== undefined) problems.push(`${name}: unsupported with prompt arguments`);
		return problems;
	}
	if (!entry.summary) problems.push(`${name}: ${entry.state} without a summary`);
	if (entry.arguments === undefined) problems.push(`${name}: ${entry.state} without a prompt argument list`);
	if (entry.state === "alias") {
		const target = entry.aliasOf === undefined ? undefined : overlayEntry(overlay, entry.aliasOf);
		if (target === undefined || target.state === "alias" || target.state === "unsupported") {
			problems.push(`${name}: alias target ${entry.aliasOf ?? "(none)"} is not a native or passthrough command`);
		}
	} else if (entry.aliasOf !== undefined) {
		problems.push(`${name}: aliasOf on a ${entry.state} command`);
	}
	return problems;
}

/**
 * Builds the catalog from the real files under `root`. Throws, naming every offender, when a defined command has no
 * overlay entry, an overlay key has no source, two names share a prompt or tool identifier, or an entry is malformed.
 */
export function loadCommandCatalog(
	root: string = REPOSITORY_ROOT,
	overlay: Readonly<Record<string, OverlayEntry>> = COMMAND_OVERLAY,
): CommandCatalog {
	const byName = new Map<string, Found[]>();
	const rawNames = new Map<string, string>();
	const problems: string[] = [];
	for (const entry of scanSources(root)) {
		let key: string;
		try {
			key = toPromptName(entry.name);
		} catch {
			problems.push(`${entry.source.path}: unusable name ${JSON.stringify(entry.name)}`);
			continue;
		}
		const first = rawNames.get(key);
		if (first !== undefined && first !== entry.name) {
			problems.push(`names ${JSON.stringify(first)} and ${JSON.stringify(entry.name)} map to the prompt name ${key}`);
		}
		rawNames.set(key, first ?? entry.name);
		byName.set(key, [...(byName.get(key) ?? []), entry]);
	}
	const universe = new Set<string>([...byName.keys(), ...CONNECTOR_NATIVE_NAMES]);
	const missing = [...universe].filter((name) => overlayEntry(overlay, name) === undefined);
	if (missing.length > 0) problems.push(`commands without an overlay entry: ${missing.join(", ")}`);
	const orphaned = Object.keys(overlay).filter((name) => !universe.has(name));
	if (orphaned.length > 0) problems.push(`overlay entries without a source: ${orphaned.join(", ")}`);

	const toolNames = new Map<string, string>();
	for (const name of Object.keys(overlay)) {
		let promptName: string;
		try {
			promptName = toPromptName(name);
		} catch {
			problems.push(`overlay key ${JSON.stringify(name)} is not a valid command name`);
			continue;
		}
		if (promptName !== name) problems.push(`overlay key ${JSON.stringify(name)} is not canonical (${promptName})`);
		const tool = toToolName(name);
		const other = toolNames.get(tool);
		if (other !== undefined) problems.push(`names ${other} and ${name} map to the tool name ${tool}`);
		toolNames.set(tool, name);
		const entry = overlay[name];
		if (entry !== undefined) problems.push(...validateEntry(name, entry, overlay));
	}
	if (problems.length > 0) throw new Error(`command catalog drift: ${problems.join("; ")}`);

	const commands: CatalogCommand[] = [];
	for (const [name, entry] of Object.entries(overlay)) {
		const sources = byName.get(name) ?? [];
		const description = sources.find((source) => source.description !== "")?.description ?? entry.description ?? "";
		const argumentHint = sources.find((source) => source.argumentHint !== undefined)?.argumentHint;
		const command: CatalogCommand = {
			name,
			toolName: toToolName(name),
			description,
			sources: sources.map((source) => source.source),
			state: entry.state,
			tools: entry.tools,
			arguments: entry.arguments ?? [],
		};
		if (argumentHint !== undefined) command.argumentHint = argumentHint;
		if (entry.aliasOf !== undefined) command.aliasOf = entry.aliasOf;
		if (entry.summary !== undefined) command.summary = entry.summary;
		if (entry.reason !== undefined) command.reason = entry.reason;
		if (entry.instead !== undefined) command.instead = entry.instead;
		commands.push(command);
	}
	const index = new Map(commands.map((command) => [command.name, command]));
	return { commands, find: (name) => index.get(name) };
}
