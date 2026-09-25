#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * scripts/setup.ts — apply/status/rollback for the ultrathink plugin.
 *
 * apply: when the `claude` CLI is installed, adds the Notion + Linear MCP
 * servers (user scope), installs the plugin marketplace, and merges the
 * tracking contract into the global ~/.claude/CLAUDE.md between marker
 * comments. Without `claude` those steps are skipped. It always installs the
 * Grok rule and global hooks under $GROK_HOME (default ~/.grok). Idempotent —
 * re-running updates in place rather than duplicating.
 *
 * Unlike the source repo's claude-setup.ts, this never touches
 * ~/.claude/settings.json — this plugin has no env vars or local proxy to
 * wire up.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const START_MARKER = "<!-- ultrathink:start -->";
const END_MARKER = "<!-- ultrathink:end -->";
const BLOCK_RE = /<!-- ultrathink:start -->[\s\S]*?<!-- ultrathink:end -->/;

const CLAUDE_MD_BLOCK = `${START_MARKER}
## Ultrathink task tracking

All Claude Code work in this project is tracked in Notion and Linear via the
\`ultrathink\` plugin:

- Notion: the configured Notion database (\`notion.dataSourceUrl\`).
- Linear: the configured Linear team (\`linear.team\`).

Both come from the ultrathink config (\`~/.config/ultrathink/config.json\`,
\`~/.claude/ultrathink.json\`, \`<project>/.claude/ultrathink.json\`; later files
win). A tracker that is not configured is skipped.

Workflow (handled automatically by the plugin's hooks and skills — you do not
need to do this by hand):
1. Every uplifted prompt creates one Notion \`Task\` row (\`ultrathink-kickoff\` skill).
2. Every Graph-of-Thought node creates one Notion \`Issue\` row plus a matching Linear issue.
3. Every node's Chain-of-Thought fill creates one Notion \`Sub-Issue\` row plus a matching Linear sub-issue.
4. Issues nest under their Task, Sub-Issues under their Issue, via \`Parent Item\`.
5. Each Issue/Sub-Issue carries its Linear URL; each Task carries PR URL/number/repo/branch once opened (\`ultrathink-sync\` skill).
6. Rows are found by \`Graph ID\` and updated in place — never duplicated.

If you are asked to do Notion/Linear tracking work outside of a prompt the
\`ultrathink\` hook already tagged, invoke the \`ultrathink-kickoff\` or
\`ultrathink-sync\` skill directly rather than improvising the field mapping.
${END_MARKER}`;

export function claudeMdPath(env: Record<string, string | undefined> = process.env): string {
	const home = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
	return join(home, "CLAUDE.md");
}

/** Records which MCP servers `apply` actually added, so `rollback` only undoes what it did. */
export interface SetupState {
	notionAdded: boolean;
	linearAdded: boolean;
}

export function setupStatePath(env: Record<string, string | undefined> = process.env): string {
	return join(dirname(claudeMdPath(env)), "ultrathink-setup-state.json");
}

/** Fail-open: a missing/unreadable state file means `apply` never ran (or predates this feature) — treat as "added nothing" so rollback removes nothing rather than guessing. */
export function readSetupState(env: Record<string, string | undefined> = process.env): SetupState {
	try {
		const raw = JSON.parse(readFileSync(setupStatePath(env), "utf8")) as Partial<SetupState>;
		return { notionAdded: raw.notionAdded === true, linearAdded: raw.linearAdded === true };
	} catch {
		return { notionAdded: false, linearAdded: false };
	}
}

export function writeSetupState(state: SetupState, env: Record<string, string | undefined> = process.env): void {
	const path = setupStatePath(env);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(state));
}

/** Replaces the marker block in `current` with `block`, keeping the text around it byte-for-byte; appends `block` after a blank line when there is none. */
export function mergeBlock(current: string, block: string): string {
	// A replacer function inserts `block` literally; as a replacement string, `$&` or `$'` in it would expand.
	if (BLOCK_RE.test(current)) return current.replace(BLOCK_RE, () => block);
	const trimmed = current.trimEnd();
	return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

export type Run = (cmd: string[]) => { stdout: string; stderr: string; code: number };

function defaultRun(cmd: string[]): { stdout: string; stderr: string; code: number } {
	try {
		const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
		return { stdout: proc.stdout?.toString() ?? "", stderr: proc.stderr?.toString() ?? "", code: proc.exitCode ?? 1 };
	} catch {
		// Bun.spawnSync throws when the binary is missing; report it the way a shell does.
		return { stdout: "", stderr: `${cmd[0]}: not found`, code: 127 };
	}
}

/** False when the `claude` binary is not installed (exit 127), so Grok-only machines still install. */
export function claudeAvailable(run: Run = defaultRun): boolean {
	return run(["claude", "--version"]).code !== 127;
}

export function grokHome(env: Record<string, string | undefined> = process.env): string {
	return env.GROK_HOME?.trim() || join(homedir(), ".grok");
}

export function ensureMcpServer(name: string, url: string, run: Run = defaultRun): { added: boolean; message: string } {
	const list = run(["claude", "mcp", "list"]);
	if (list.code === 0 && list.stdout.includes(name)) {
		return { added: false, message: `${name}: already configured` };
	}
	const add = run(["claude", "mcp", "add", "--transport", "http", "--scope", "user", name, url]);
	if (add.code !== 0) return { added: false, message: `${name}: failed — ${add.stderr.trim() || add.stdout.trim()}` };
	return { added: true, message: `${name}: added` };
}

export function ensurePluginInstalled(repoRoot: string, run: Run = defaultRun): { installed: boolean; message: string } {
	run(["claude", "plugin", "marketplace", "add", repoRoot]);
	const install = run(["claude", "plugin", "install", "ultrathink@ultrathink"]);
	if (install.code !== 0 && !/already installed/i.test(install.stderr)) {
		return { installed: false, message: `plugin install failed — ${install.stderr.trim() || install.stdout.trim()}` };
	}
	return { installed: true, message: "ultrathink@ultrathink installed" };
}

export interface ClaudeApplyResult {
	notion: { added: boolean; message: string };
	linear: { added: boolean; message: string };
	plugin: { installed: boolean; message: string };
	claudeMd: { path: string; changed: boolean };
}

export interface ApplyResult {
	/** Undefined when the `claude` CLI is not installed: every Claude Code step was skipped. */
	claude?: ClaudeApplyResult;
	grok: { rule: { path: string; changed: boolean }; hooks: { path: string; changed: boolean } };
}

/** Merges the packaged rule's marker block into the rule file; text a user added around the block stays. */
export function installGrokRule(repoRoot: string, rulesDir: string): { path: string; changed: boolean } {
	const source = join(repoRoot, "hosts", "grok", "ultrathink.md");
	const path = join(rulesDir, "ultrathink.md");
	const block = BLOCK_RE.exec(existsSync(source) ? readFileSync(source, "utf8") : "")?.[0];
	if (!block) return { path, changed: false };
	const before = existsSync(path) ? readFileSync(path, "utf8") : "";
	const next = mergeBlock(before, block);
	if (next === before) return { path, changed: false };
	mkdirSync(rulesDir, { recursive: true });
	writeFileSync(path, next);
	return { path, changed: true };
}

interface HookHandler {
	type: string;
	command: string;
	timeout?: number;
	[key: string]: unknown;
}

interface HookGroup {
	matcher?: string;
	hooks: HookHandler[];
}

/**
 * Grok 1.0.40 discovers the plugin's hooks/hooks.json but never dispatches plugin
 * hooks; only `~/.grok/hooks/*.json` runs. This mirrors hooks.json with absolute
 * paths. GROK_PLUGIN_DATA is unset there, so paths.ts falls back to
 * ~/.grok/plugin-data/ultrathink — the path the installed rule points at.
 */
export function grokHooksConfig(repoRoot: string): { hooks: Record<string, unknown[]> } {
	const root = resolve(repoRoot);
	const source = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as {
		hooks: Record<string, HookGroup[]>;
	};
	const hooks: Record<string, unknown[]> = {};
	for (const [event, groups] of Object.entries(source.hooks)) {
		hooks[event] = groups.map((group) => ({
			...group,
			hooks: group.hooks.map((handler) => ({
				...handler,
				command: handler.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", root),
				// Grok's 30s UserPromptSubmit default would kill planning mid-flight.
				...(event === "UserPromptSubmit" ? { timeout: 600 } : {}),
				env: { ULTRATHINK_HOST: "grok-build" },
			})),
		}));
	}
	return { hooks };
}

export function installGrokHooks(repoRoot: string, hooksDir: string): { path: string; changed: boolean } {
	const path = join(hooksDir, "ultrathink.json");
	const next = `${JSON.stringify(grokHooksConfig(repoRoot), null, 2)}\n`;
	const before = existsSync(path) ? readFileSync(path, "utf8") : "";
	if (next === before) return { path, changed: false };
	mkdirSync(hooksDir, { recursive: true });
	writeFileSync(path, next);
	return { path, changed: true };
}

export function apply(
	repoRoot: string,
	run: Run = defaultRun,
	env: Record<string, string | undefined> = process.env,
): ApplyResult {
	const grokDir = grokHome(env);
	const grok = {
		rule: installGrokRule(repoRoot, join(grokDir, "rules")),
		hooks: installGrokHooks(repoRoot, join(grokDir, "hooks")),
	};
	if (!claudeAvailable(run)) return { grok };

	const notion = ensureMcpServer("notion", "https://mcp.notion.com/mcp", run);
	const linear = ensureMcpServer("linear", "https://mcp.linear.app/mcp", run);
	const plugin = ensurePluginInstalled(repoRoot, run);

	const path = claudeMdPath(env);
	const before = existsSync(path) ? readFileSync(path, "utf8") : "";
	const after = mergeBlock(before, CLAUDE_MD_BLOCK);
	if (after !== before) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, after);
	}

	writeSetupState({ notionAdded: notion.added, linearAdded: linear.added }, env);

	return { claude: { notion, linear, plugin, claudeMd: { path, changed: after !== before } }, grok };
}

export function status(env: Record<string, string | undefined> = process.env, run: Run = defaultRun): string {
	const grokDir = grokHome(env);
	const rulePath = join(grokDir, "rules", "ultrathink.md");
	const hooksPath = join(grokDir, "hooks", "ultrathink.json");
	const ruleOk = existsSync(rulePath) && BLOCK_RE.test(readFileSync(rulePath, "utf8"));
	const grok = [
		`Grok rule: ${ruleOk ? "installed" : "missing — run: bun scripts/setup.ts apply"} (${rulePath})`,
		`Grok hooks: ${existsSync(hooksPath) ? "installed" : "missing — run: bun scripts/setup.ts apply"} (${hooksPath})`,
	];
	const mcpList = run(["claude", "mcp", "list"]);
	if (mcpList.code === 127) return ["Claude Code: claude CLI not found", ...grok].join("\n");
	const path = claudeMdPath(env);
	const claudeMdOk = existsSync(path) && BLOCK_RE.test(readFileSync(path, "utf8"));
	const notionOk = mcpList.code === 0 && mcpList.stdout.includes("notion");
	const linearOk = mcpList.code === 0 && mcpList.stdout.includes("linear");
	return [
		`Notion MCP: ${notionOk ? "configured" : "missing — run: claude mcp add --transport http --scope user notion https://mcp.notion.com/mcp"}`,
		`Linear MCP: ${linearOk ? "configured" : "missing — run: claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp"}`,
		`CLAUDE.md contract: ${claudeMdOk ? `present at ${path}` : `missing at ${path} — run: bun scripts/setup.ts apply`}`,
		...grok,
	].join("\n");
}

/** Removes the marker block and keeps the rest of the file; `deleteEmpty` removes a file left empty. True when a block was found. */
function removeBlock(path: string, deleteEmpty: boolean): boolean {
	if (!existsSync(path)) return false;
	const before = readFileSync(path, "utf8");
	if (!BLOCK_RE.test(before)) return false;
	const stripped = before.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd();
	if (!stripped && deleteEmpty) rmSync(path, { force: true });
	else writeFileSync(path, stripped ? `${stripped}\n` : "");
	return true;
}

export interface RollbackResult {
	claudeMd: { changed: boolean };
	notion: { removed: boolean };
	linear: { removed: boolean };
	grok: { rule: { path: string; removed: boolean }; hooks: { path: string; removed: boolean } };
}

export function rollback(env: Record<string, string | undefined> = process.env, run: Run = defaultRun): RollbackResult {
	const claudeMdChanged = removeBlock(claudeMdPath(env), false);
	const state = readSetupState(env);
	const notion = state.notionAdded ? run(["claude", "mcp", "remove", "notion"]) : undefined;
	const linear = state.linearAdded ? run(["claude", "mcp", "remove", "linear"]) : undefined;
	const grokDir = grokHome(env);
	const rulePath = join(grokDir, "rules", "ultrathink.md");
	const hooksPath = join(grokDir, "hooks", "ultrathink.json");
	const hadHooks = existsSync(hooksPath);
	rmSync(hooksPath, { force: true });
	return {
		claudeMd: { changed: claudeMdChanged },
		notion: { removed: notion !== undefined && notion.code === 0 },
		linear: { removed: linear !== undefined && linear.code === 0 },
		// The rule is ours only through its marker block; text a user added around it stays.
		grok: { rule: { path: rulePath, removed: removeBlock(rulePath, true) }, hooks: { path: hooksPath, removed: hadHooks } },
	};
}

async function main(): Promise<void> {
	const cmd = process.argv[2] ?? "status";
	const repoRoot = new URL("..", import.meta.url).pathname;
	if (cmd === "apply") {
		const { claude, grok } = apply(repoRoot);
		if (claude) {
			console.log(`Notion MCP: ${claude.notion.message}`);
			console.log(`Linear MCP: ${claude.linear.message}`);
			console.log(`Plugin: ${claude.plugin.message}`);
			console.log(`CLAUDE.md: ${claude.claudeMd.changed ? "updated" : "already up to date"} (${claude.claudeMd.path})`);
		} else {
			console.log(
				"Claude Code: claude CLI not found — skipped the Notion/Linear MCP servers, plugin install and CLAUDE.md block; install Claude Code and re-run apply to add them.",
			);
		}
		console.log(`Grok rule: ${grok.rule.changed ? "installed" : "already up to date"} (${grok.rule.path})`);
		console.log(`Grok hooks: ${grok.hooks.changed ? "installed" : "already up to date"} (${grok.hooks.path})`);
		console.log(`Hermes: symlink ${join(repoRoot, "hosts/hermes")} to ~/.hermes/plugins/ultrathink, then disable prompt-uplift so both do not plan the same turn.`);
		console.log(`Muse: muse plugins install ${repoRoot} --scope user && muse plugins approve ultrathink`);
		console.log(`Omp: omp plugin link ${repoRoot}`);
		return;
	}
	if (cmd === "rollback") {
		const result = rollback();
		console.log(`CLAUDE.md: ${result.claudeMd.changed ? "block removed" : "no block found"}`);
		console.log(`Notion MCP: ${result.notion.removed ? "removed" : "not removed (may not have existed)"}`);
		console.log(`Linear MCP: ${result.linear.removed ? "removed" : "not removed (may not have existed)"}`);
		console.log(`Grok rule: ${result.grok.rule.removed ? "removed" : "not installed"} (${result.grok.rule.path})`);
		console.log(`Grok hooks: ${result.grok.hooks.removed ? "removed" : "not installed"} (${result.grok.hooks.path})`);
		return;
	}
	console.log(status());
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
