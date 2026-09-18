import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	apply,
	claudeMdPath,
	ensureMcpServer,
	ensurePluginInstalled,
	mergeClaudeMd,
	readSetupState,
	rollback,
	status,
	type Run,
} from "./setup.ts";

function tempClaudeDir(): { env: Record<string, string>; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-setup-"));
	return { env: { CLAUDE_CONFIG_DIR: dir }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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

describe("mergeClaudeMd", () => {
	test("appends the block to empty or existing content", () => {
		expect(mergeClaudeMd("")).toContain("<!-- ultrathink:start -->");
		const withContent = mergeClaudeMd("# My project rules\n");
		expect(withContent.startsWith("# My project rules")).toBe(true);
		expect(withContent).toContain("<!-- ultrathink:start -->");
	});

	test("replaces an existing block in place instead of duplicating", () => {
		const first = mergeClaudeMd("# Rules\n");
		const second = mergeClaudeMd(first);
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
	test("apply writes the CLAUDE.md block and reports each step; status then confirms it; rollback removes it", () => {
		const { env, cleanup } = tempClaudeDir();
		const run = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
		try {
			const applied = apply("/repo", run, env);
			expect(applied.claudeMd.changed).toBe(true);
			expect(existsSync(claudeMdPath(env))).toBe(true);
			expect(readFileSync(claudeMdPath(env), "utf8")).toContain("<!-- ultrathink:start -->");

			const statusRun = fakeRun(() => ({ stdout: "notion\nlinear\n", stderr: "", code: 0 }));
			const statusText = status(env, statusRun);
			expect(statusText).toContain("Notion MCP: configured");
			expect(statusText).toContain("Linear MCP: configured");
			expect(statusText).toContain(`CLAUDE.md contract: present at ${claudeMdPath(env)}`);

			const rolledBack = rollback(env, run);
			expect(rolledBack.claudeMd.changed).toBe(true);
			expect(readFileSync(claudeMdPath(env), "utf8")).not.toContain("<!-- ultrathink:start -->");
		} finally {
			cleanup();
		}
	});

	test("re-applying does not duplicate the CLAUDE.md block", () => {
		const { env, cleanup } = tempClaudeDir();
		const run = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
		try {
			apply("/repo", run, env);
			apply("/repo", run, env);
			const text = readFileSync(claudeMdPath(env), "utf8");
			expect(text.match(/<!-- ultrathink:start -->/g)).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	test("apply records added:true for a server it actually adds; rollback then removes it", () => {
		const { env, cleanup } = tempClaudeDir();
		// "list" reports neither server configured, so ensureMcpServer adds both.
		const applyRun = fakeRun((cmd) => (cmd[2] === "list" ? { stdout: "", stderr: "", code: 0 } : { stdout: "added", stderr: "", code: 0 }));
		try {
			apply("/repo", applyRun, env);
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
		const { env, cleanup } = tempClaudeDir();
		// "list" reports both servers already configured, so ensureMcpServer skips both.
		const applyRun = fakeRun((cmd) => (cmd[2] === "list" ? { stdout: "notion\nlinear\n", stderr: "", code: 0 } : { stdout: "", stderr: "", code: 0 }));
		try {
			apply("/repo", applyRun, env);
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
		const { env, cleanup } = tempClaudeDir();
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
