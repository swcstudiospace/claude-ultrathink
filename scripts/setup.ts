#!/usr/bin/env bun
/**
 * scripts/setup.ts — apply/status/rollback for the ultrathink plugin.
 *
 * apply: adds the Notion + Linear MCP servers (user scope), installs the
 * plugin marketplace, and merges the tracking contract into the global
 * ~/.claude/CLAUDE.md between marker comments. Idempotent — re-running
 * updates in place rather than duplicating.
 *
 * Unlike the source repo's claude-setup.ts, this never touches
 * ~/.claude/settings.json — this plugin has no env vars or local proxy to
 * wire up.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const START_MARKER = "<!-- ultrathink:start -->";
const END_MARKER = "<!-- ultrathink:end -->";
const BLOCK_RE = /<!-- ultrathink:start -->[\s\S]*?<!-- ultrathink:end -->/;

const CLAUDE_MD_BLOCK = `${START_MARKER}
## Agent Command Center

All Claude Code work in this project is tracked in Notion and Linear via the
\`ultrathink\` plugin:

- Notion database: the "🧩 Agent Task Graph" data source (\`collection://be3418f0-d2d8-411b-8677-fa8a95ee63be\`), under "Agent Command Center".
- Linear team: Spectrum Web Co.

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

export function mergeClaudeMd(current: string): string {
	if (BLOCK_RE.test(current)) return current.replace(BLOCK_RE, CLAUDE_MD_BLOCK);
	const trimmed = current.trimEnd();
	return trimmed ? `${trimmed}\n\n${CLAUDE_MD_BLOCK}\n` : `${CLAUDE_MD_BLOCK}\n`;
}

export type Run = (cmd: string[]) => { stdout: string; stderr: string; code: number };

function defaultRun(cmd: string[]): { stdout: string; stderr: string; code: number } {
	const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
	return { stdout: proc.stdout?.toString() ?? "", stderr: proc.stderr?.toString() ?? "", code: proc.exitCode ?? 1 };
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

export interface ApplyResult {
	notion: { added: boolean; message: string };
	linear: { added: boolean; message: string };
	plugin: { installed: boolean; message: string };
	claudeMd: { path: string; changed: boolean };
}

export function apply(
	repoRoot: string,
	run: Run = defaultRun,
	env: Record<string, string | undefined> = process.env,
): ApplyResult {
	const notion = ensureMcpServer("notion", "https://mcp.notion.com/mcp", run);
	const linear = ensureMcpServer("linear", "https://mcp.linear.app/mcp", run);
	const plugin = ensurePluginInstalled(repoRoot, run);

	const path = claudeMdPath(env);
	const before = existsSync(path) ? readFileSync(path, "utf8") : "";
	const after = mergeClaudeMd(before);
	if (after !== before) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, after);
	}

	writeSetupState({ notionAdded: notion.added, linearAdded: linear.added }, env);

	return { notion, linear, plugin, claudeMd: { path, changed: after !== before } };
}

export function status(env: Record<string, string | undefined> = process.env, run: Run = defaultRun): string {
	const path = claudeMdPath(env);
	const claudeMdOk = existsSync(path) && BLOCK_RE.test(readFileSync(path, "utf8"));
	const mcpList = run(["claude", "mcp", "list"]);
	const notionOk = mcpList.code === 0 && mcpList.stdout.includes("notion");
	const linearOk = mcpList.code === 0 && mcpList.stdout.includes("linear");
	return [
		`Notion MCP: ${notionOk ? "configured" : "missing — run: claude mcp add --transport http --scope user notion https://mcp.notion.com/mcp"}`,
		`Linear MCP: ${linearOk ? "configured" : "missing — run: claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp"}`,
		`CLAUDE.md contract: ${claudeMdOk ? `present at ${path}` : `missing at ${path} — run: bun scripts/setup.ts apply`}`,
	].join("\n");
}

export function rollback(
	env: Record<string, string | undefined> = process.env,
	run: Run = defaultRun,
): { claudeMd: { changed: boolean }; notion: { removed: boolean }; linear: { removed: boolean } } {
	const path = claudeMdPath(env);
	let claudeMdChanged = false;
	if (existsSync(path)) {
		const before = readFileSync(path, "utf8");
		const stripped = before.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd();
		if (stripped !== before.trimEnd()) {
			writeFileSync(path, stripped ? `${stripped}\n` : "");
			claudeMdChanged = true;
		}
	}
	const state = readSetupState(env);
	const notion = state.notionAdded ? run(["claude", "mcp", "remove", "notion"]) : undefined;
	const linear = state.linearAdded ? run(["claude", "mcp", "remove", "linear"]) : undefined;
	return {
		claudeMd: { changed: claudeMdChanged },
		notion: { removed: notion !== undefined && notion.code === 0 },
		linear: { removed: linear !== undefined && linear.code === 0 },
	};
}

async function main(): Promise<void> {
	const cmd = process.argv[2] ?? "status";
	const repoRoot = new URL("..", import.meta.url).pathname;
	if (cmd === "apply") {
		const result = apply(repoRoot);
		console.log(`Notion MCP: ${result.notion.message}`);
		console.log(`Linear MCP: ${result.linear.message}`);
		console.log(`Plugin: ${result.plugin.message}`);
		console.log(`CLAUDE.md: ${result.claudeMd.changed ? "updated" : "already up to date"} (${result.claudeMd.path})`);
		return;
	}
	if (cmd === "rollback") {
		const result = rollback();
		console.log(`CLAUDE.md: ${result.claudeMd.changed ? "block removed" : "no block found"}`);
		console.log(`Notion MCP: ${result.notion.removed ? "removed" : "not removed (may not have existed)"}`);
		console.log(`Linear MCP: ${result.linear.removed ? "removed" : "not removed (may not have existed)"}`);
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
