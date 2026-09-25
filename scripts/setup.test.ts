// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	apply,
	claudeMdPath,
	ensureMcpServer,
	ensurePluginInstalled,
	grokHooksConfig,
	installGrokHooks,
	installGrokRule,
	mergeBlock,
	readSetupState,
	rollback,
	status,
	type Run,
} from "./setup.ts";

const RULE = "<!-- ultrathink:start -->\nRead the ultrathink plan.\n<!-- ultrathink:end -->\n";

/** Minimal plugin checkout: the hooks.json and Grok rule that `apply` installs. */
function writeRepo(root: string): void {
	mkdirSync(join(root, "hooks"), { recursive: true });
	mkdirSync(join(root, "hosts", "grok"), { recursive: true });
	const handler = (script: string, timeout: number) => ({
		type: "command",
		command: `"\${CLAUDE_PLUGIN_ROOT}/bin/run-bun" "\${CLAUDE_PLUGIN_ROOT}/hooks/${script}"`,
		timeout,
	});
	writeFileSync(
		join(root, "hooks", "hooks.json"),
		JSON.stringify({
			hooks: {
				UserPromptSubmit: [{ hooks: [handler("uplift.ts", 86400)] }],
				PostToolUse: [{ matcher: "Bash", hooks: [handler("pr-sync.ts", 30)] }],
				Stop: [{ hooks: [handler("stop.ts", 60)] }],
			},
		}),
	);
	writeFileSync(join(root, "hosts", "grok", "ultrathink.md"), RULE);
}

/** Temp Claude config dir, Grok home and plugin checkout; nothing touches the real home. */
function tempSetup(): { env: Record<string, string>; repo: string; rulePath: string; hooksPath: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-setup-"));
	const repo = join(dir, "repo");
	writeRepo(repo);
	const grok = join(dir, "grok");
	return {
		env: { CLAUDE_CONFIG_DIR: join(dir, "claude"), GROK_HOME: grok },
		repo,
		rulePath: join(grok, "rules", "ultrathink.md"),
		hooksPath: join(grok, "hooks", "ultrathink.json"),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

const noClaude = (cmd: string[]) =>
	cmd[0] === "claude" ? { stdout: "", stderr: "claude: not found", code: 127 } : { stdout: "", stderr: "", code: 0 };

function fakeRun(script: (cmd: string[]) => { stdout: string; stderr: string; code: number }): Run & { calls: string[][] } {
	const calls: string[][] = [];
	const run: Run = (cmd) => {
		calls.push(cmd);
		return script(cmd);
	};
	return Object.assign(run, { calls });
}

describe("claudeMdPath", () => {
	test("uses CLAUDE_CONFIG_DIR when set, else ~/.claude", () => {
		expect(claudeMdPath({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe(join("/cfg", "CLAUDE.md"));
		expect(claudeMdPath({}).endsWith(join(".claude", "CLAUDE.md"))).toBe(true);
	});
});

describe("mergeBlock", () => {
	const BLOCK = RULE.trimEnd();

	test("appends the block after a blank line to existing content, or writes it alone into empty content", () => {
		expect(mergeBlock("", BLOCK)).toBe(RULE);
		expect(mergeBlock("# My project rules\n", BLOCK)).toBe(`# My project rules\n\n${RULE}`);
	});

	test("replaces an existing block in place instead of duplicating", () => {
		const first = mergeBlock("# Rules\n", BLOCK);
		const second = mergeBlock(first, BLOCK);
		expect(second.match(/<!-- ultrathink:start -->/g)).toHaveLength(1);
		expect(second).toBe(first);
	});
});

describe("ensureMcpServer", () => {
	test("skips when already configured", () => {
		const run = fakeRun((cmd) => (cmd[2] === "list" ? { stdout: "notion\nlinear\n", stderr: "", code: 0 } : { stdout: "", stderr: "", code: 0 }));
		const result = ensureMcpServer("notion", "https://mcp.notion.com/mcp", run);
		expect(result.added).toBe(false);
		expect(run.calls).toEqual([["claude", "mcp", "list"]]);
	});

	test("adds when missing", () => {
		const run = fakeRun((cmd) => (cmd[2] === "list" ? { stdout: "", stderr: "", code: 0 } : { stdout: "added", stderr: "", code: 0 }));
		const result = ensureMcpServer("linear", "https://mcp.linear.app/mcp", run);
		expect(result.added).toBe(true);
		expect(run.calls[1]).toEqual(["claude", "mcp", "add", "--transport", "http", "--scope", "user", "linear", "https://mcp.linear.app/mcp"]);
	});

	test("reports failure without throwing", () => {
		const run = fakeRun((cmd) => (cmd[2] === "list" ? { stdout: "", stderr: "", code: 0 } : { stdout: "", stderr: "network down", code: 1 }));
		const result = ensureMcpServer("notion", "https://mcp.notion.com/mcp", run);
		expect(result.added).toBe(false);
		expect(result.message).toContain("network down");
	});
});

describe("ensurePluginInstalled", () => {
	test("adds the marketplace then installs, tolerating already-installed", () => {
		const run = fakeRun((cmd) =>
			cmd[2] === "install" ? { stdout: "", stderr: "already installed", code: 1 } : { stdout: "", stderr: "", code: 0 },
		);
		const result = ensurePluginInstalled("/repo", run);
		expect(result.installed).toBe(true);
		expect(run.calls[0]).toEqual(["claude", "plugin", "marketplace", "add", "/repo"]);
	});
});

describe("apply / status / rollback", () => {
	test("apply writes the CLAUDE.md block and Grok files and reports each step; status then confirms it; rollback removes them", () => {
		const { env, repo, rulePath, hooksPath, cleanup } = tempSetup();
		const run = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
		try {
			const applied = apply(repo, run, env);
			expect(applied.claude?.claudeMd.changed).toBe(true);
			expect(applied.grok).toEqual({ rule: { path: rulePath, changed: true }, hooks: { path: hooksPath, changed: true } });
			expect(readFileSync(claudeMdPath(env), "utf8")).toContain("<!-- ultrathink:start -->");
			expect(readFileSync(rulePath, "utf8")).toBe(RULE);

			const statusRun = fakeRun(() => ({ stdout: "notion\nlinear\n", stderr: "", code: 0 }));
			const statusText = status(env, statusRun);
			expect(statusText).toContain("Notion MCP: configured");
			expect(statusText).toContain("Linear MCP: configured");
			expect(statusText).toContain(`CLAUDE.md contract: present at ${claudeMdPath(env)}`);
			expect(statusText).toContain(`Grok rule: installed (${rulePath})`);
			expect(statusText).toContain(`Grok hooks: installed (${hooksPath})`);

			const rolledBack = rollback(env, run);
			expect(rolledBack.claudeMd.changed).toBe(true);
			expect(rolledBack.grok).toEqual({ rule: { path: rulePath, removed: true }, hooks: { path: hooksPath, removed: true } });
			expect(readFileSync(claudeMdPath(env), "utf8")).not.toContain("<!-- ultrathink:start -->");
			expect(existsSync(rulePath)).toBe(false);
			expect(existsSync(hooksPath)).toBe(false);
			expect(status(env, statusRun)).toContain(`Grok rule: missing — run: bun scripts/setup.ts apply (${rulePath})`);
		} finally {
			cleanup();
		}
	});

	test("re-applying does not duplicate the CLAUDE.md block", () => {
		const { env, repo, cleanup } = tempSetup();
		const run = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
		try {
			apply(repo, run, env);
			const again = apply(repo, run, env);
			expect(again.grok.rule.changed).toBe(false);
			expect(again.grok.hooks.changed).toBe(false);
			const text = readFileSync(claudeMdPath(env), "utf8");
			expect(text.match(/<!-- ultrathink:start -->/g)).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	test("the CLAUDE.md block defers to the configured Notion database and Linear team instead of naming a workspace", () => {
		const { env, repo, cleanup } = tempSetup();
		try {
			apply(repo, fakeRun(() => ({ stdout: "", stderr: "", code: 0 })), env);
			const text = readFileSync(claudeMdPath(env), "utf8");
			expect(text).toContain("notion.dataSourceUrl");
			expect(text).toContain("linear.team");
			expect(text).not.toContain("collection://");
			expect(text).not.toContain("Spectrum Web Co");
		} finally {
			cleanup();
		}
	});

	test("without the claude CLI, apply skips every Claude step but still installs Grok; status says so", () => {
		const { env, repo, rulePath, hooksPath, cleanup } = tempSetup();
		const run = fakeRun(noClaude);
		try {
			const applied = apply(repo, run, env);
			expect(applied.claude).toBeUndefined();
			expect(applied.grok.rule.changed).toBe(true);
			expect(applied.grok.hooks.changed).toBe(true);
			expect(existsSync(rulePath)).toBe(true);
			expect(existsSync(hooksPath)).toBe(true);
			expect(existsSync(claudeMdPath(env))).toBe(false);
			expect(run.calls).toEqual([["claude", "--version"]]);

			expect(status(env, fakeRun(noClaude)).split("\n")).toEqual([
				"Claude Code: claude CLI not found",
				`Grok rule: installed (${rulePath})`,
				`Grok hooks: installed (${hooksPath})`,
			]);
		} finally {
			cleanup();
		}
	});

	test("rollback keeps user text around the Grok rule block and leaves a rule without the marker alone", () => {
		const { env, rulePath, cleanup } = tempSetup();
		const run = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
		try {
			mkdirSync(join(rulePath, ".."), { recursive: true });
			writeFileSync(rulePath, `# My Grok rules\n\n${RULE}`);
			expect(rollback(env, run).grok.rule.removed).toBe(true);
			expect(readFileSync(rulePath, "utf8")).toBe("# My Grok rules\n");

			expect(rollback(env, run).grok.rule.removed).toBe(false);
			expect(readFileSync(rulePath, "utf8")).toBe("# My Grok rules\n");
		} finally {
			cleanup();
		}
	});

	test("apply then rollback restores a user's Grok rule file to its original text", () => {
		const { env, repo, rulePath, cleanup } = tempSetup();
		const run = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
		try {
			const original = "# My Grok rules\n\nAlways answer in English.\n";
			mkdirSync(dirname(rulePath), { recursive: true });
			writeFileSync(rulePath, original);
			expect(apply(repo, run, env).grok.rule.changed).toBe(true);
			expect(rollback(env, run).grok.rule.removed).toBe(true);
			expect(readFileSync(rulePath, "utf8")).toBe(original);
		} finally {
			cleanup();
		}
	});

	test("apply records added:true for a server it actually adds; rollback then removes it", () => {
		const { env, repo, cleanup } = tempSetup();
		// "list" reports neither server configured, so ensureMcpServer adds both.
		const applyRun = fakeRun((cmd) => (cmd[2] === "list" ? { stdout: "", stderr: "", code: 0 } : { stdout: "added", stderr: "", code: 0 }));
		try {
			apply(repo, applyRun, env);
			const state = readSetupState(env);
			expect(state.notionAdded).toBe(true);
			expect(state.linearAdded).toBe(true);

			const rollbackRun = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
			const result = rollback(env, rollbackRun);
			expect(result.notion.removed).toBe(true);
			expect(result.linear.removed).toBe(true);
			expect(rollbackRun.calls).toContainEqual(["claude", "mcp", "remove", "notion"]);
			expect(rollbackRun.calls).toContainEqual(["claude", "mcp", "remove", "linear"]);
		} finally {
			cleanup();
		}
	});

	test("apply records added:false for a server that was already configured; rollback does not remove it", () => {
		const { env, repo, cleanup } = tempSetup();
		// "list" reports both servers already configured, so ensureMcpServer skips both.
		const applyRun = fakeRun((cmd) => (cmd[2] === "list" ? { stdout: "notion\nlinear\n", stderr: "", code: 0 } : { stdout: "", stderr: "", code: 0 }));
		try {
			apply(repo, applyRun, env);
			const state = readSetupState(env);
			expect(state.notionAdded).toBe(false);
			expect(state.linearAdded).toBe(false);

			const rollbackRun = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
			const result = rollback(env, rollbackRun);
			expect(result.notion.removed).toBe(false);
			expect(result.linear.removed).toBe(false);
			expect(rollbackRun.calls).not.toContainEqual(["claude", "mcp", "remove", "notion"]);
			expect(rollbackRun.calls).not.toContainEqual(["claude", "mcp", "remove", "linear"]);
		} finally {
			cleanup();
		}
	});

	test("rollback with no prior apply (missing state file) removes nothing", () => {
		const { env, cleanup } = tempSetup();
		try {
			const state = readSetupState(env);
			expect(state.notionAdded).toBe(false);
			expect(state.linearAdded).toBe(false);

			const rollbackRun = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
			const result = rollback(env, rollbackRun);
			expect(result.notion.removed).toBe(false);
			expect(result.linear.removed).toBe(false);
			expect(rollbackRun.calls).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe("grok global hooks", () => {
	function tempRepo(): { root: string; cleanup: () => void } {
		const root = mkdtempSync(join(tmpdir(), "ultrathink-repo-"));
		writeRepo(root);
		return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
	}

	test("grokHooksConfig resolves the plugin root, forces the grok host, and raises only the prompt timeout", () => {
		const { root, cleanup } = tempRepo();
		try {
			// A trailing slash (main() passes a URL pathname) must not produce `//` paths.
			const config = grokHooksConfig(`${root}/`) as {
				hooks: Record<string, { matcher?: string; hooks: { command: string; timeout: number; env: Record<string, string> }[] }[]>;
			};
			expect(Object.keys(config.hooks)).toEqual(["UserPromptSubmit", "PostToolUse", "Stop"]);
			const [prompt] = config.hooks.UserPromptSubmit[0].hooks;
			expect(prompt.command).toBe(`"${root}/bin/run-bun" "${root}/hooks/uplift.ts"`);
			expect(prompt.timeout).toBe(600);
			expect(config.hooks.PostToolUse[0].matcher).toBe("Bash");
			expect(config.hooks.PostToolUse[0].hooks[0].timeout).toBe(30);
			expect(config.hooks.Stop[0].matcher).toBeUndefined();
			expect(config.hooks.Stop[0].hooks[0].timeout).toBe(60);
			for (const groups of Object.values(config.hooks)) {
				for (const handler of groups.flatMap((group) => group.hooks)) {
					expect(handler.command).not.toContain("CLAUDE_PLUGIN_ROOT");
					expect(handler.env).toEqual({ ULTRATHINK_HOST: "grok-build" });
				}
			}
		} finally {
			cleanup();
		}
	});

	test("installGrokHooks writes once, then reports unchanged", () => {
		const { root, cleanup } = tempRepo();
		try {
			const hooksDir = join(root, "grok-home", "hooks");
			const first = installGrokHooks(root, hooksDir);
			expect(first).toEqual({ path: join(hooksDir, "ultrathink.json"), changed: true });
			expect(JSON.parse(readFileSync(first.path, "utf8"))).toEqual(grokHooksConfig(root));
			expect(readFileSync(first.path, "utf8").endsWith("}\n")).toBe(true);
			expect(installGrokHooks(root, hooksDir).changed).toBe(false);
		} finally {
			cleanup();
		}
	});
});

describe("installGrokRule", () => {
	test("an update replaces only the marker block, keeps the user's text around it byte-for-byte, and reports changed only when the bytes change", () => {
		const { repo, rulePath, cleanup } = tempSetup();
		try {
			// As a String.replace replacement string, `$&` and `$'` would expand instead of landing verbatim.
			const packaged = "<!-- ultrathink:start -->\nRead $GROK_PLUGIN_DATA/ultrathink/last-plan.json; keep $& and $' as written.\n<!-- ultrathink:end -->\n";
			writeFileSync(join(repo, "hosts", "grok", "ultrathink.md"), packaged);
			const above = "# My Grok rules\n\n\nPrefer small diffs.  \n\n";
			const below = "\n\n\n## Notes\nNo trailing newline";
			mkdirSync(dirname(rulePath), { recursive: true });
			writeFileSync(rulePath, `${above}<!-- ultrathink:start -->\nAn older rule.\n<!-- ultrathink:end -->${below}`);
			const updated = `${above}${packaged.trimEnd()}${below}`;

			expect(installGrokRule(repo, dirname(rulePath))).toEqual({ path: rulePath, changed: true });
			expect(readFileSync(rulePath, "utf8")).toBe(updated);
			expect(installGrokRule(repo, dirname(rulePath))).toEqual({ path: rulePath, changed: false });
			expect(readFileSync(rulePath, "utf8")).toBe(updated);
		} finally {
			cleanup();
		}
	});

	test("appends the block after a blank line to a rule file without one, keeping its text", () => {
		const { repo, rulePath, cleanup } = tempSetup();
		try {
			mkdirSync(dirname(rulePath), { recursive: true });
			writeFileSync(rulePath, "# My Grok rules\nAlways answer in English.\n");
			expect(installGrokRule(repo, dirname(rulePath))).toEqual({ path: rulePath, changed: true });
			expect(readFileSync(rulePath, "utf8")).toBe(`# My Grok rules\nAlways answer in English.\n\n${RULE}`);
			expect(installGrokRule(repo, dirname(rulePath)).changed).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("creates a missing rule file and its directory with the packaged rule", () => {
		const { repo, rulePath, cleanup } = tempSetup();
		try {
			expect(existsSync(dirname(rulePath))).toBe(false);
			expect(installGrokRule(repo, dirname(rulePath))).toEqual({ path: rulePath, changed: true });
			expect(readFileSync(rulePath, "utf8")).toBe(RULE);
		} finally {
			cleanup();
		}
	});
});
