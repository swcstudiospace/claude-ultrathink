// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCliPlan, mergeMuseSettings, mergeOmpMcp, planClaude, planGrok, planHermes, writeJson } from "./mcp-register.ts";
import type { Entry, Run } from "./mcp-register.ts";

const CMD = "/repo/claude-ultrathink/bin/ultrathink-mcp";
const entries: Entry[] = ["notion", "linear", "greptile"].map((id) => ({ id, command: CMD, args: ["serve", id] }));

describe("mergeOmpMcp", () => {
	test("preserves other servers and replaces a same-named http entry with stdio", () => {
		const current = {
			other: true,
			mcpServers: {
				relume: { type: "http", url: "https://relume.example/mcp" },
				notion: { type: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer x" } },
			},
		};
		const { next, changes } = mergeOmpMcp(current, entries);
		expect(next.other).toBe(true);
		const servers = next.mcpServers as Record<string, unknown>;
		expect(servers.relume).toEqual(current.mcpServers.relume);
		expect(servers.notion).toEqual({ type: "stdio", command: CMD, args: ["serve", "notion"] });
		expect(changes).toEqual([
			{ id: "notion", action: "replaced" },
			{ id: "linear", action: "added" },
			{ id: "greptile", action: "added" },
		]);
	});

	test("second merge is a no-op", () => {
		const once = mergeOmpMcp({ mcpServers: { relume: { url: "u" } } }, entries).next;
		const twice = mergeOmpMcp(once, entries);
		expect(twice.next).toEqual(once);
		expect(twice.changes.every((c) => c.action === "unchanged")).toBe(true);
	});
});

describe("mergeMuseSettings", () => {
	test("preserves unrelated keys and writes optional stdio entries", () => {
		const current = { schema_version: 1, provider: "anthropic", tui: { theme: "dark" } };
		const { next } = mergeMuseSettings(current, entries);
		expect(next.provider).toBe("anthropic");
		expect(next.tui).toEqual({ theme: "dark" });
		expect((next.mcpServers as Record<string, unknown>).linear).toEqual({
			type: "stdio",
			command: CMD,
			args: ["serve", "linear"],
			mode: "optional",
		});
		expect(mergeMuseSettings(next, entries).next).toEqual(next);
	});

	test("folds legacy mcp_servers into mcpServers", () => {
		const { next } = mergeMuseSettings({ mcp_servers: { keep: { type: "stdio", command: "/x" } } }, entries);
		expect(next.mcp_servers).toBeUndefined();
		expect((next.mcpServers as Record<string, unknown>).keep).toEqual({ type: "stdio", command: "/x" });
	});
});

function fakeRun(respond: (cmd: string[]) => string): { run: Run; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		run(cmd) {
			calls.push(cmd);
			return { code: 0, stdout: respond(cmd), stderr: "" };
		},
	};
}

describe("CLI host planners", () => {
	test("claude: already registered issues no add", () => {
		const { run } = fakeRun((cmd) => `${cmd[3]}:\n  Type: stdio\n  Command: ${CMD}\n  Args: serve ${cmd[3]}\n`);
		const plan = planClaude(run, entries);
		expect(plan.commands).toEqual([]);
	});

	test("claude: different entry is removed then re-added", () => {
		const { run } = fakeRun(() => "notion:\n  Type: http\n  URL: https://mcp.notion.com/mcp\n");
		const plan = planClaude(run, entries.slice(0, 1));
		expect(plan.changes).toEqual([{ id: "notion", action: "replaced" }]);
		expect(plan.commands.at(-1)).toEqual(["claude", "mcp", "add", "--scope", "user", "notion", "--", CMD, "serve", "notion"]);
	});

	test("grok: already registered issues no add", () => {
		const listed = JSON.stringify(entries.map((e) => ({ name: e.id, command: e.command, args: e.args, scope: "user" })));
		const { run } = fakeRun(() => listed);
		expect(planGrok(run, entries).commands).toEqual([]);
	});

	test("hermes: truncated list row that matches issues no add", () => {
		const rows = entries.map((e) => `  ${e.id.padEnd(16)} ${`${CMD} serve ${e.id}`.slice(0, 27)}...   all  ✓ enabled`);
		const { run } = fakeRun(() => `  MCP Servers:\n\n${rows.join("\n")}\n`);
		expect(planHermes(run, entries).commands).toEqual([]);
	});

	test("hermes: url entry with same name is replaced", () => {
		const { run } = fakeRun(() => "  linear           https://mcp.linear.app/mcp     all   ✓ enabled\n");
		const plan = planHermes(run, entries.slice(1, 2));
		expect(plan.changes).toEqual([{ id: "linear", action: "replaced" }]);
		expect(plan.commands).toEqual([
			["hermes", "mcp", "remove", "linear"],
			["hermes", "mcp", "add", "linear", "--command", CMD, "--args", "serve", "linear"],
		]);
	});

	test("hermes: disabled row is re-added, enabled row stays unchanged", () => {
		const { run } = fakeRun(
			() =>
				`  notion           ${CMD} serve notion   all          ✗ disabled\n  linear           ${CMD} serve linear   all          ✓ enabled\n`,
		);
		const plan = planHermes(run, entries.slice(0, 2));
		expect(plan.changes).toEqual([
			{ id: "notion", action: "re-enabled", reason: "was disabled" },
			{ id: "linear", action: "unchanged" },
		]);
		expect(plan.commands).toEqual([
			["hermes", "mcp", "remove", "notion"],
			["hermes", "mcp", "add", "notion", "--command", CMD, "--args", "serve", "notion"],
		]);
	});
});

describe("applyCliPlan", () => {
	const linear = entries.slice(1, 2);
	const hermesRow = `  linear           ${CMD} serve linear   all  ✓ enabled\n`;

	function stateful(listAfterAdd: string, listBefore = ""): { run: Run; stdins: Record<string, string | undefined> } {
		const stdins: Record<string, string | undefined> = {};
		let added = false;
		const run: Run = (cmd, options) => {
			if (cmd[2] === "add" || cmd[2] === "remove") {
				stdins[cmd[2]] = options?.stdin;
				if (cmd[2] === "add") added = true;
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: added || listBefore ? 0 : 1, stdout: added ? listAfterAdd : listBefore, stderr: "" };
		};
		return { run, stdins };
	}

	test("hermes add and remove receive stdin y so an unauthenticated server is still saved", () => {
		const { run, stdins } = stateful(hermesRow);
		const changes = applyCliPlan("hermes", run, linear, planHermes(run, linear));
		expect(stdins).toEqual({ remove: "y\n", add: "y\n" });
		expect(changes).toEqual([{ id: "linear", action: "added" }]);
	});

	test("hermes entry missing from the post-add list is FAILED", () => {
		const { run } = stateful("  MCP Servers:\n\n");
		const [change] = applyCliPlan("hermes", run, linear, planHermes(run, linear));
		expect(change?.action).toBe("FAILED");
		expect(change?.reason).toBeTruthy();
	});

	test("hermes entry still disabled after add is saved disabled, not FAILED", () => {
		const { run } = stateful(`  linear           ${CMD} serve linear   all  ✗ disabled\n`);
		expect(applyCliPlan("hermes", run, linear, planHermes(run, linear))).toEqual([
			{ id: "linear", action: "saved disabled", reason: "linear not authenticated yet" },
		]);
	});

	test("claude entry not matching after add is FAILED", () => {
		const { run, stdins } = stateful("linear:\n  Type: http\n  URL: https://mcp.linear.app/mcp\n");
		const [change] = applyCliPlan("claude", run, linear, planClaude(run, linear));
		expect(stdins.add).toBeUndefined();
		expect(change?.action).toBe("FAILED");
	});

	test("grok entry absent from post-add list is FAILED, present is added", () => {
		const missing = stateful("[]", "[]");
		expect(applyCliPlan("grok", missing.run, linear, planGrok(missing.run, linear))[0]?.action).toBe("FAILED");
		const present = stateful(JSON.stringify([{ name: "linear", command: CMD, args: ["serve", "linear"] }]), "[]");
		expect(applyCliPlan("grok", present.run, linear, planGrok(present.run, linear))).toEqual([{ id: "linear", action: "added" }]);
	});
});

describe("writeJson", () => {
	test("keeps an existing 0600 file at 0600 and defaults new files to 0600", () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-register-"));
		try {
			const existing = join(dir, "mcp.json");
			writeFileSync(existing, "{}\n");
			chmodSync(existing, 0o600);
			writeJson(existing, { mcpServers: {} });
			expect(statSync(existing).mode & 0o777).toBe(0o600);
			expect(JSON.parse(readFileSync(existing, "utf8"))).toEqual({ mcpServers: {} });
			const fresh = join(dir, "sub", "settings.json");
			writeJson(fresh, {});
			expect(statSync(fresh).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
