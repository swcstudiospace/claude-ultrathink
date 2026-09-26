// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	apply,
	applyReport,
	claudeMdPath,
	ensureMcpServer,
	ensurePluginInstalled,
	grokHooksConfig,
	hermesHint,
	installGrokHooks,
	installGrokRule,
	mergeBlock,
	readSetupState,
	repoRootFromModule,
	rollback,
	rollbackReport,
	setupStatePath,
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

/** `claude mcp get` finds nothing (exit 1), `claude mcp list` prints `list`, every other claude call succeeds. */
function mcpRun(list: string): Run & { calls: string[][] } {
	return fakeRun((cmd) => {
		if (cmd[1] === "mcp" && cmd[2] === "get") return { stdout: "", stderr: `No MCP server named "${cmd[3]}".`, code: 1 };
		if (cmd[1] === "mcp" && cmd[2] === "list") return { stdout: list, stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	});
}

const LOOKALIKES = [
	"Checking MCP server health…",
	"",
	"notion-foo: https://example.com/mcp (HTTP) - ✔ Connected",
	"claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected",
	"docs: https://mcp.notion.com/mcp (HTTP) - ✔ Connected",
	"my-linear: npx linear-mcp - ✔ Connected",
].join("\n");

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
	test("skips when `claude mcp get` finds the server by name", () => {
		const run = fakeRun(() => ({ stdout: "notion:\n  Type: http", stderr: "", code: 0 }));
		const result = ensureMcpServer("notion", "https://mcp.notion.com/mcp", run);
		expect(result.added).toBe(false);
		expect(run.calls).toEqual([["claude", "mcp", "get", "notion"]]);
	});

	test("falls back to an exact first-field match in `claude mcp list` when `claude mcp get` fails", () => {
		const run = mcpRun("notion: https://mcp.notion.com/mcp (HTTP) - ✔ Connected\n");
		expect(ensureMcpServer("notion", "https://mcp.notion.com/mcp", run).added).toBe(false);
		expect(run.calls.some((cmd) => cmd[2] === "add")).toBe(false);
	});

	test("a lookalike name or a URL that mentions the server does not count as configured", () => {
		const run = mcpRun(LOOKALIKES);
		expect(ensureMcpServer("notion", "https://mcp.notion.com/mcp", run).added).toBe(true);
		expect(ensureMcpServer("linear", "https://mcp.linear.app/mcp", run).added).toBe(true);
		expect(run.calls).toContainEqual(["claude", "mcp", "add", "--transport", "http", "--scope", "user", "notion", "https://mcp.notion.com/mcp"]);
	});

	test("adds when missing", () => {
		const run = mcpRun("");
		const result = ensureMcpServer("linear", "https://mcp.linear.app/mcp", run);
		expect(result.added).toBe(true);
		expect(run.calls.at(-1)).toEqual(["claude", "mcp", "add", "--transport", "http", "--scope", "user", "linear", "https://mcp.linear.app/mcp"]);
	});

	test("reports failure without throwing", () => {
		const run = fakeRun((cmd) => (cmd[2] === "add" ? { stdout: "", stderr: "network down", code: 1 } : { stdout: "", stderr: "", code: 1 }));
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
			expect(rolledBack.state).toEqual({ path: setupStatePath(env), status: "removed" });
			expect(readFileSync(claudeMdPath(env), "utf8")).not.toContain("<!-- ultrathink:start -->");
			expect(existsSync(rulePath)).toBe(false);
			expect(existsSync(hooksPath)).toBe(false);
			expect(existsSync(setupStatePath(env))).toBe(false);
			expect(status(env, statusRun)).toContain(`Grok rule: missing — run: bun scripts/setup.ts apply (${rulePath})`);

			// The plugin itself is only named for the user to remove; rollback never runs the uninstall.
			const report = rollbackReport(rolledBack).join("\n");
			expect(report).toContain("claude plugin uninstall ultrathink@ultrathink");
			expect(report).toContain("claude plugin marketplace remove ultrathink");
			expect(run.calls.some((cmd) => cmd[1] === "plugin" && (cmd[2] === "uninstall" || cmd[3] === "remove"))).toBe(false);
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

	test("the CLAUDE.md block defers to the configured Notion database and Linear team and tells the agent how to check", () => {
		const { env, repo, cleanup } = tempSetup();
		try {
			apply(repo, fakeRun(() => ({ stdout: "", stderr: "", code: 0 })), env);
			const text = readFileSync(claudeMdPath(env), "utf8");
			expect(text).toContain("notion.dataSourceUrl");
			expect(text).toContain("linear.team");
			expect(text).toContain("bin/ultrathink status");
			expect(text).toContain("When tracking is configured");
			// Unconditional claims would be false on a machine without tracking configured.
			expect(text).not.toMatch(/All Claude Code work in this project is tracked/i);
			expect(text).not.toContain("collection://");
			expect(text).not.toContain("Spectrum Web Co");
		} finally {
			cleanup();
		}
	});

	test("status decides MCP presence by exact server name", () => {
		const { env, cleanup } = tempSetup();
		try {
			const text = status(env, mcpRun(`${LOOKALIKES}\nlinear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected\n`));
			expect(text).toContain("Notion MCP: missing — run: claude mcp add");
			expect(text).toContain("Linear MCP: configured");
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
		// Neither server is configured, so ensureMcpServer adds both.
		const applyRun = mcpRun("");
		try {
			apply(repo, applyRun, env);
			const state = readSetupState(env);
			expect(state.notionAdded).toBe(true);
			expect(state.linearAdded).toBe(true);

			const rollbackRun = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
			const result = rollback(env, rollbackRun);
			expect(result.notion.removed).toBe(true);
			expect(result.linear.removed).toBe(true);
			expect(rollbackRun.calls).toContainEqual(["claude", "mcp", "remove", "--scope", "user", "notion"]);
			expect(rollbackRun.calls).toContainEqual(["claude", "mcp", "remove", "--scope", "user", "linear"]);
		} finally {
			cleanup();
		}
	});

	test("re-running apply keeps servers an earlier apply added recorded, so rollback still removes them", () => {
		const { env, repo, cleanup } = tempSetup();
		try {
			apply(repo, mcpRun(""), env);
			// The second run finds both servers present (added by the first run) and adds nothing.
			const rerun = mcpRun("notion: https://mcp.notion.com/mcp (HTTP) - ✔ Connected\nlinear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected\n");
			const again = apply(repo, rerun, env);
			expect(again.claude?.notion.added).toBe(false);
			expect(again.claude?.linear.added).toBe(false);
			expect(readSetupState(env)).toEqual({ notionAdded: true, linearAdded: true });

			const rollbackRun = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
			const result = rollback(env, rollbackRun);
			expect(result.notion.removed).toBe(true);
			expect(result.linear.removed).toBe(true);
			expect(rollbackRun.calls).toContainEqual(["claude", "mcp", "remove", "--scope", "user", "notion"]);
			expect(rollbackRun.calls).toContainEqual(["claude", "mcp", "remove", "--scope", "user", "linear"]);
		} finally {
			cleanup();
		}
	});

	test("apply records added:false for a server that was already configured; rollback does not remove it", () => {
		const { env, repo, cleanup } = tempSetup();
		// `claude mcp list` shows both servers already configured, so ensureMcpServer skips both.
		const applyRun = mcpRun("notion: https://mcp.notion.com/mcp (HTTP) - ✔ Connected\nlinear: https://mcp.linear.app/mcp (HTTP) - ✔ Connected\n");
		try {
			apply(repo, applyRun, env);
			const state = readSetupState(env);
			expect(state.notionAdded).toBe(false);
			expect(state.linearAdded).toBe(false);

			const rollbackRun = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
			const result = rollback(env, rollbackRun);
			expect(result.notion.removed).toBe(false);
			expect(result.linear.removed).toBe(false);
			expect(rollbackRun.calls.some((cmd) => cmd[2] === "remove")).toBe(false);
			expect(rollbackReport(result).join("\n")).toContain("Notion MCP: left in place (setup did not add it)");
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

	test("rollback deletes the setup state, so a later rollback cannot remove servers the user added since", () => {
		const { env, repo, cleanup } = tempSetup();
		try {
			apply(repo, mcpRun(""), env);
			expect(existsSync(setupStatePath(env))).toBe(true);
			expect(rollback(env, fakeRun(() => ({ stdout: "", stderr: "", code: 0 }))).state.status).toBe("removed");
			expect(existsSync(setupStatePath(env))).toBe(false);

			const again = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
			expect(rollback(env, again).state.status).toBe("absent");
			expect(again.calls).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("a failed removal is reported with its error and stays recorded, so the next rollback retries only that server", () => {
		const { env, repo, cleanup } = tempSetup();
		try {
			apply(repo, mcpRun(""), env);
			const failing = fakeRun((cmd) =>
				cmd[2] === "remove" && cmd.at(-1) === "notion" ? { stdout: "", stderr: "claude: not found", code: 127 } : { stdout: "", stderr: "", code: 0 },
			);
			const first = rollback(env, failing);
			expect(first.notion).toEqual({ removed: false, error: "exit 127: claude: not found" });
			expect(first.linear.removed).toBe(true);
			expect(first.state.status).toBe("kept");
			expect(readSetupState(env)).toEqual({ notionAdded: true, linearAdded: false });
			const report = rollbackReport(first).join("\n");
			expect(report).toContain("Notion MCP: removal failed (exit 127: claude: not found)");
			expect(report).toContain("claude mcp remove --scope user notion");

			const retry = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
			const second = rollback(env, retry);
			expect(retry.calls).toEqual([["claude", "mcp", "remove", "--scope", "user", "notion"]]);
			expect(second.notion.removed).toBe(true);
			expect(second.state.status).toBe("removed");
			expect(existsSync(setupStatePath(env))).toBe(false);
		} finally {
			cleanup();
		}
	});
});

describe("any checkout path", () => {
	test("the repo root is decoded from the module URL, so spaces and non-ASCII are kept verbatim", () => {
		const root = join(tmpdir(), "my clones", "ultrathink-é");
		expect(repoRootFromModule(pathToFileURL(join(root, "scripts", "setup.ts")).href)).toBe(root);
	});

	test("apply from a clone whose path has a space writes that path verbatim and prints pasteable commands", () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink setup "));
		try {
			const repo = join(dir, "my clone");
			writeRepo(repo);
			const env = { CLAUDE_CONFIG_DIR: join(dir, "claude"), GROK_HOME: join(dir, "grok"), HERMES_HOME: join(dir, "hermes home") };
			const result = apply(repo, fakeRun(() => ({ stdout: "", stderr: "", code: 0 })), env);
			const hooks = readFileSync(result.grok.hooks.path, "utf8");
			expect(hooks).toContain(`${repo}/hooks/uplift.ts`);
			expect(hooks).not.toContain("%20");
			const report = applyReport(repo, result, env).join("\n");
			expect(report).toContain(`omp plugin link '${repo}'`);
			expect(report).toContain(`muse plugins install '${repo}' --scope user`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("hermesHint", () => {
	test("links into HERMES_HOME when set, else ~/.hermes, and states the global hook cap", () => {
		const hint = hermesHint("/src/ultrathink", { HERMES_HOME: "/opt/hermes home" });
		expect(hint).toContain(
			`mkdir -p '/opt/hermes home/plugins' && ln -sfn '/src/ultrathink/hosts/hermes' '/opt/hermes home/plugins/ultrathink' && hermes plugins enable ultrathink`,
		);
		expect(hint).toContain("hermes config set plugins.hook_callback_timeout 600");
		expect(hint).toContain("at least 105 s");
		expect(hint).toContain("global Hermes setting");
		expect(hint).toContain("disable any other prompt-planning plugin");
		expect(hint).not.toContain("prompt-uplift");
		expect(hermesHint("/src/ultrathink", {})).toContain(`${join(".hermes", "plugins", "ultrathink")}'`);
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
			// A root given with a trailing slash must not produce `//` paths.
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
