// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyCliPlan,
	hermesConfigFile,
	main,
	mergeMuseSettings,
	mergeOmpMcp,
	planClaude,
	planGrok,
	planHermes,
	writeJson,
} from "./mcp-register.ts";
import type { CliHost, Entry, Run } from "./mcp-register.ts";

const CMD = "/repo/claude-ultrathink/bin/ultrathink-mcp";
const entries: Entry[] = ["notion", "linear", "greptile"].map((id) => ({ id, command: CMD, args: ["serve", id] }));

const OTHER_CLONE = "/home/someone/old-clone/bin/ultrathink-mcp";
const foreignNotion = { type: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer x" } };

describe("mergeOmpMcp", () => {
	test("keeps a foreign same-named entry by default and says how to overwrite it", () => {
		const current = {
			other: true,
			mcpServers: { relume: { type: "http", url: "https://relume.example/mcp" }, notion: foreignNotion },
		};
		const { next, changes } = mergeOmpMcp(current, entries);
		expect(next.other).toBe(true);
		const servers = next.mcpServers as Record<string, unknown>;
		expect(servers.relume).toEqual(current.mcpServers.relume);
		expect(servers.notion).toEqual(foreignNotion);
		expect(changes[0]?.action).toBe("kept");
		expect(changes[0]?.reason).toContain("--replace");
		expect(changes.slice(1)).toEqual([
			{ id: "linear", action: "added" },
			{ id: "greptile", action: "added" },
		]);
	});

	test("--replace overwrites a foreign same-named entry with stdio", () => {
		const { next, changes } = mergeOmpMcp({ mcpServers: { notion: foreignNotion } }, entries.slice(0, 1), "replace");
		expect((next.mcpServers as Record<string, unknown>).notion).toEqual({ type: "stdio", command: CMD, args: ["serve", "notion"] });
		expect(changes).toEqual([{ id: "notion", action: "replaced" }]);
	});

	test("an entry from another ultrathink clone is replaced without --replace", () => {
		const current = { mcpServers: { linear: { type: "stdio", command: OTHER_CLONE, args: ["serve", "linear"] } } };
		const { next, changes } = mergeOmpMcp(current, entries.slice(1, 2));
		expect((next.mcpServers as Record<string, unknown>).linear).toEqual({ type: "stdio", command: CMD, args: ["serve", "linear"] });
		expect(changes).toEqual([{ id: "linear", action: "replaced" }]);
	});

	test("second merge is a no-op", () => {
		const once = mergeOmpMcp({ mcpServers: { relume: { url: "u" } } }, entries).next;
		const twice = mergeOmpMcp(once, entries);
		expect(twice.next).toEqual(once);
		expect(twice.changes.every((c) => c.action === "unchanged")).toBe(true);
	});

	test("remove deletes only ultrathink entries", () => {
		const current = {
			mcpServers: {
				notion: foreignNotion,
				linear: { type: "stdio", command: OTHER_CLONE, args: ["serve", "linear"] },
				relume: { url: "u" },
			},
		};
		const { next, changes } = mergeOmpMcp(current, entries, "remove");
		expect(next.mcpServers).toEqual({ notion: foreignNotion, relume: { url: "u" } });
		expect(changes.map((c) => c.action)).toEqual(["kept", "removed", "not registered"]);
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

	test("remove deletes ultrathink entries from mcpServers and legacy mcp_servers only", () => {
		const current = {
			schema_version: 1,
			mcpServers: { notion: foreignNotion, linear: { type: "stdio", command: CMD, args: ["serve", "linear"] } },
			mcp_servers: { greptile: { type: "stdio", command: OTHER_CLONE, args: ["serve", "greptile"] } },
		};
		const { next, changes } = mergeMuseSettings(current, entries, "remove");
		expect(next).toEqual({ schema_version: 1, mcpServers: { notion: foreignNotion }, mcp_servers: {} });
		expect(changes.map((c) => c.action)).toEqual(["kept", "removed", "removed"]);
	});

	test("an entry Muse rewrote without the default type and in another key order is unchanged", () => {
		const current = { schema_version: 1, mcpServers: { notion: { mode: "optional", command: CMD, args: ["serve", "notion"] } } };
		const { next, changes } = mergeMuseSettings(current, entries.slice(0, 1));
		expect(changes).toEqual([{ id: "notion", action: "unchanged" }]);
		expect(next).toEqual(current);
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

	const claudeHttp = "notion:\n  Scope: User config\n  Type: http\n  URL: https://mcp.notion.com/mcp\n";

	test("claude: foreign entry is kept by default with a hint naming --replace", () => {
		const { run } = fakeRun(() => claudeHttp);
		const plan = planClaude(run, entries.slice(0, 1));
		expect(plan.commands).toEqual([]);
		expect(plan.changes[0]?.action).toBe("kept");
		expect(plan.changes[0]?.reason).toContain("--replace");
	});

	test("claude: --replace removes then re-adds a foreign entry", () => {
		const { run } = fakeRun(() => claudeHttp);
		const plan = planClaude(run, entries.slice(0, 1), { mode: "replace" });
		expect(plan.changes).toEqual([{ id: "notion", action: "replaced" }]);
		expect(plan.commands.at(-1)).toEqual(["claude", "mcp", "add", "--scope", "user", "notion", "--", CMD, "serve", "notion"]);
	});

	test("claude: entry from another ultrathink clone is replaced by default", () => {
		const { run } = fakeRun(() => `notion:\n  Type: stdio\n  Command: ${OTHER_CLONE}\n  Args: serve notion\n`);
		expect(planClaude(run, entries.slice(0, 1)).changes).toEqual([{ id: "notion", action: "replaced" }]);
	});

	test("claude: remove deletes only ultrathink entries", () => {
		const { run } = fakeRun((cmd) =>
			cmd[3] === "notion" ? claudeHttp : `${cmd[3]}:\n  Type: stdio\n  Command: ${OTHER_CLONE}\n  Args: serve ${cmd[3]}\n`,
		);
		const plan = planClaude(run, entries.slice(0, 2), { mode: "remove" });
		expect(plan.changes.map((c) => c.action)).toEqual(["kept", "removed"]);
		expect(plan.commands).toEqual([["claude", "mcp", "remove", "--scope", "user", "linear"]]);
	});

	test("grok: foreign entry kept, ours from another clone replaced, --replace overwrites both", () => {
		const listed = JSON.stringify([
			{ name: "notion", url: "https://mcp.notion.com/mcp", scope: "user" },
			{ name: "linear", command: OTHER_CLONE, args: ["serve", "linear"], scope: "user" },
		]);
		const { run } = fakeRun(() => listed);
		expect(planGrok(run, entries.slice(0, 2)).changes.map((c) => c.action)).toEqual(["kept", "replaced"]);
		expect(planGrok(run, entries.slice(0, 2), { mode: "replace" }).changes.map((c) => c.action)).toEqual([
			"replaced",
			"replaced",
		]);
	});

	test("claude: a local-scope entry neither blocks nor gets touched; the user scope decides", () => {
		const { run } = fakeRun(
			(cmd) =>
				`${cmd[3]}:\n  Scope: Local config (private to you in this project)\n  Type: http\n  URL: https://mcp.example/${cmd[3]}\n`,
		);
		const userConfig = JSON.stringify({
			mcpServers: { linear: { type: "stdio", command: OTHER_CLONE, args: ["serve", "linear"] }, greptile: { command: "npx" } },
			projects: { "/p": { mcpServers: { notion: { type: "http", url: "https://mcp.example/notion" } } } },
		});
		const plan = planClaude(run, entries, { claudeConfig: () => userConfig });
		expect(plan.changes.map((c) => c.action)).toEqual(["added", "replaced", "kept"]);
		expect(plan.changes[0]?.reason).toContain("local config entry");
		expect(plan.commands.filter((c) => c[2] === "add").map((c) => c[5])).toEqual(["notion", "linear"]);
		const removing = planClaude(run, entries, { mode: "remove", claudeConfig: () => userConfig });
		expect(removing.changes.map((c) => c.action)).toEqual(["not registered", "removed", "kept"]);
		expect(removing.commands).toEqual([["claude", "mcp", "remove", "--scope", "user", "linear"]]);
	});

	test("grok: only user-scope entries decide; project entries neither block nor get removed", () => {
		const listed = JSON.stringify([
			{ name: "notion", url: "https://mcp.notion.com/mcp", scope: "project" },
			{ name: "linear", command: CMD, args: ["serve", "linear"], scope: "project" },
			{ name: "linear", command: "/opt/other/linear", scope: "user" },
			{ name: "greptile", command: OTHER_CLONE, args: ["serve", "greptile"], scope: "project" },
		]);
		const { run } = fakeRun(() => listed);
		const plan = planGrok(run, entries);
		expect(plan.changes.map((c) => c.action)).toEqual(["added", "kept", "added"]);
		expect(plan.changes[0]?.reason).toBe("project-scope entry with this name is left alone");
		const removing = planGrok(run, entries, { mode: "remove" });
		expect(removing.changes.map((c) => c.action)).toEqual(["not registered", "kept", "not registered"]);
		expect(removing.commands).toEqual([]);
	});

	test("grok: unreadable list is treated as foreign", () => {
		const { run } = fakeRun(() => "error: leader unavailable");
		const plan = planGrok(run, entries.slice(0, 1));
		expect(plan.commands).toEqual([]);
		expect(plan.changes[0]?.action).toBe("kept");
	});

	test("grok: remove deletes only ultrathink entries", () => {
		const listed = JSON.stringify([
			{ name: "notion", url: "https://mcp.notion.com/mcp", scope: "user" },
			{ name: "linear", command: CMD, args: ["serve", "linear"], scope: "user" },
		]);
		const { run } = fakeRun(() => listed);
		const plan = planGrok(run, entries, { mode: "remove" });
		expect(plan.changes.map((c) => c.action)).toEqual(["kept", "removed", "not registered"]);
		expect(plan.commands).toEqual([["grok", "mcp", "remove", "--scope", "user", "linear"]]);
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

	test("hermes: url entry with same name is kept by default and replaced with --replace", () => {
		const { run } = fakeRun(() => "  linear           https://mcp.linear.app/mcp     all   ✓ enabled\n");
		expect(planHermes(run, entries.slice(1, 2)).changes[0]?.action).toBe("kept");
		const plan = planHermes(run, entries.slice(1, 2), { mode: "replace" });
		expect(plan.changes).toEqual([{ id: "linear", action: "replaced" }]);
		expect(plan.commands).toEqual([
			["hermes", "mcp", "remove", "linear"],
			["hermes", "mcp", "add", "linear", "--command", CMD, "--args", "serve", "linear"],
		]);
	});

	test("hermes: truncated rows take ownership from config.yaml", () => {
		const rows = "  notion           /opt/some/other-server...   all  ✓ enabled\n  linear           /home/someone/old-clo...   all  ✓ enabled\n";
		const config = [
			"model: x",
			"mcp_servers:",
			"  notion:",
			"    command: /opt/some/other-server",
			"    env:",
			"      command: /home/someone/old-clone/bin/ultrathink-mcp",
			"  linear:",
			"    args:",
			"    - serve",
			"    - linear",
			`    command: '${OTHER_CLONE}'`,
			"plugins:",
			"  greptile:",
			`    command: ${CMD}`,
		].join("\n");
		const { run } = fakeRun(() => rows);
		const plan = planHermes(run, entries, { hermesConfig: () => config });
		expect(plan.changes.map((c) => c.action)).toEqual(["kept", "replaced", "added"]);
		expect(planHermes(run, entries, { mode: "remove", hermesConfig: () => config }).commands).toEqual([
			["hermes", "mcp", "remove", "linear"],
		]);
	});

	test("hermes: a list row that contradicts config.yaml makes the entry foreign", () => {
		const { run } = fakeRun(() => "  notion           /opt/other/n...   all  ✓ enabled\n");
		const config = `mcp_servers:\n  notion:\n    command: ${OTHER_CLONE}\n`;
		const plan = planHermes(run, entries.slice(0, 1), { hermesConfig: () => config });
		expect(plan.changes[0]?.action).toBe("kept");
		expect(plan.commands).toEqual([]);
		expect(planHermes(run, entries.slice(0, 1), { mode: "remove", hermesConfig: () => config }).commands).toEqual([]);
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

	test("remove is confirmed by a follow-up list; a remove that leaves the entry is FAILED", () => {
		let servers = [{ name: "linear", command: CMD, args: ["serve", "linear"] }];
		const run: Run = (cmd) => {
			if (cmd[2] === "remove") {
				servers = [];
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: JSON.stringify(servers), stderr: "" };
		};
		const options = { mode: "remove" as const, log: () => {} };
		expect(applyCliPlan("grok", run, linear, planGrok(run, linear, options), options)).toEqual([{ id: "linear", action: "removed" }]);
		const stuck: Run = (cmd) =>
			cmd[2] === "remove"
				? { code: 1, stdout: "", stderr: "permission denied" }
				: { code: 0, stdout: JSON.stringify([{ name: "linear", command: CMD }]), stderr: "" };
		const [change] = applyCliPlan("grok", stuck, linear, planGrok(stuck, linear, options), options);
		expect(change).toEqual({ id: "linear", action: "FAILED", reason: "exit 1: permission denied" });
	});
});

const STAMP = ".bak-ultrathink-mcp-20260102-030405";

interface Sandbox {
	home: string;
	lines: string[];
	env: Record<string, string | undefined>;
	deps: (root?: string) => Parameters<typeof main>[1];
}

function sandbox(fn: (box: Sandbox) => void, run?: Run): void {
	const dir = mkdtempSync(join(tmpdir(), "mcp-register-main-"));
	const home = join(dir, "home");
	const bin = join(dir, "bin");
	mkdirSync(home);
	mkdirSync(bin);
	for (const host of ["claude", "grok", "hermes"]) writeFileSync(join(bin, host), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const lines: string[] = [];
	const env: Record<string, string | undefined> = { HOME: home, PATH: bin };
	const deps = (root = "/stable/clone") => ({
		env,
		root,
		log: (line: string) => lines.push(line),
		now: () => new Date(2026, 0, 2, 3, 4, 5),
		run: run ?? (() => ({ code: 1, stdout: "", stderr: "unexpected host call" })),
	});
	try {
		fn({ home, lines, env, deps });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const OURS_HERE = "/stable/clone/bin/ultrathink-mcp";

function readServers(file: string): Record<string, unknown> {
	return JSON.parse(readFileSync(file, "utf8")).mcpServers;
}

// A fake claude/grok/hermes trio backed by one name → command map per host; Hermes' config.yaml is kept in sync.
function fakeHosts(servers: Record<CliHost, Record<string, string>>, hermesConfig: string): { run: Run; calls: string[][] } {
	const calls: string[][] = [];
	const syncHermes = () => {
		const body = Object.entries(servers.hermes).map(
			([id, command]) => `  ${id}:\n    command: ${command}\n    args:\n    - serve\n    - ${id}`,
		);
		writeFileSync(hermesConfig, `mcp_servers:\n${body.join("\n")}\n`);
	};
	syncHermes();
	const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
	const run: Run = (cmd) => {
		calls.push(cmd);
		const host = cmd[0] as CliHost;
		const id = cmd.at(-1) ?? "";
		if (cmd[2] === "remove") {
			delete servers[host][id];
			if (host === "hermes") syncHermes();
			return ok();
		}
		if (cmd[2] === "add" && host === "grok") {
			servers[host][cmd[5] ?? ""] = cmd[6] ?? "";
			return ok();
		}
		if (host === "claude") {
			const command = servers.claude[id];
			return command
				? ok(`${id}:\n  Type: stdio\n  Command: ${command}\n  Args: serve ${id}\n`)
				: { code: 1, stdout: "", stderr: "No MCP server" };
		}
		if (host === "grok") {
			const listed = Object.entries(servers.grok).map(([name, command]) => ({ name, command, args: ["serve", name], scope: "user" }));
			return ok(JSON.stringify(listed));
		}
		const rows = Object.entries(servers.hermes).map(
			([name, command]) => `  ${name.padEnd(16)} ${command.slice(0, 12)}...   all  ✓ enabled`,
		);
		return ok(rows.join("\n"));
	};
	return { run, calls };
}

describe("main", () => {
	test("keeps a foreign entry with a line naming --replace, replaces ours, and is idempotent", () => {
		sandbox(({ home, lines, deps }) => {
			const file = join(home, ".omp", "agent", "mcp.json");
			writeJson(file, {
				mcpServers: { notion: foreignNotion, linear: { type: "stdio", command: OTHER_CLONE, args: ["serve", "linear"] } },
			});
			expect(main(["--hosts", "omp"], deps())).toBe(0);
			expect(lines.find((l) => l.includes("notion kept"))).toContain("--replace");
			expect(readServers(file)).toEqual({
				notion: foreignNotion,
				linear: { type: "stdio", command: OURS_HERE, args: ["serve", "linear"] },
				greptile: { type: "stdio", command: OURS_HERE, args: ["serve", "greptile"] },
			});
			expect(existsSync(`${file}${STAMP}`)).toBe(true);
			lines.length = 0;
			rmSync(`${file}${STAMP}`);
			expect(main(["--hosts", "omp"], deps())).toBe(0);
			expect(lines.filter((l) => l.includes(" unchanged"))).toHaveLength(2);
			expect(existsSync(`${file}${STAMP}`)).toBe(false);
		});
	});

	test("--replace overwrites a foreign entry", () => {
		sandbox(({ home, deps }) => {
			const file = join(home, ".config", "muse", "settings.json");
			writeJson(file, { schema_version: 1, mcpServers: { notion: foreignNotion } });
			expect(main(["--hosts", "muse", "--providers", "notion", "--replace"], deps())).toBe(0);
			expect(readServers(file).notion).toEqual({ type: "stdio", command: OURS_HERE, args: ["serve", "notion"], mode: "optional" });
		});
	});

	test("--remove on JSON hosts deletes only ours, keeps 0600 and backs up; --dry-run writes nothing", () => {
		sandbox(({ home, deps }) => {
			const omp = join(home, ".omp", "agent", "mcp.json");
			const muse = join(home, ".config", "muse", "settings.json");
			const ours = (id: string) => ({ type: "stdio", command: OTHER_CLONE, args: ["serve", id] });
			writeJson(omp, { mcpServers: { notion: foreignNotion, linear: ours("linear"), relume: { url: "u" } } });
			writeJson(muse, { schema_version: 1, mcpServers: { greptile: ours("greptile") } });
			const before = readFileSync(omp, "utf8");
			expect(main(["--hosts", "omp,muse", "--remove", "--dry-run"], deps())).toBe(0);
			expect(readFileSync(omp, "utf8")).toBe(before);
			expect(readdirSync(join(home, ".omp", "agent"))).toEqual(["mcp.json"]);
			expect(main(["--hosts", "omp,muse", "--remove"], deps())).toBe(0);
			expect(readServers(omp)).toEqual({ notion: foreignNotion, relume: { url: "u" } });
			expect(readServers(muse)).toEqual({});
			expect(readFileSync(`${omp}${STAMP}`, "utf8")).toBe(before);
			expect(existsSync(`${muse}${STAMP}`)).toBe(true);
			expect(statSync(omp).mode & 0o777).toBe(0o600);
		});
	});

	test("--remove on CLI hosts removes only ours through each host's mcp remove", () => {
		const servers: Record<CliHost, Record<string, string>> = {
			claude: { notion: "npx", linear: OURS_HERE },
			grok: { notion: OTHER_CLONE, greptile: "/usr/local/bin/greptile-mcp" },
			hermes: { linear: OTHER_CLONE, greptile: "/opt/greptile/server" },
		};
		const dir = mkdtempSync(join(tmpdir(), "mcp-register-hermes-"));
		const fake = fakeHosts(servers, join(dir, "config.yaml"));
		try {
			sandbox(({ home, env, lines, deps }) => {
				env.HERMES_HOME = dir;
				writeFileSync(join(home, ".claude.json"), "{}\n");
				expect(main(["--hosts", "claude,grok,hermes", "--remove", "--dry-run"], deps())).toBe(0);
				expect(fake.calls.filter((c) => c[2] === "remove")).toEqual([]);
				expect(existsSync(join(home, `.claude.json${STAMP}`))).toBe(false);
				lines.length = 0;
				expect(main(["--hosts", "claude,grok,hermes", "--remove"], deps())).toBe(0);
				expect(fake.calls.filter((c) => c[2] === "remove")).toEqual([
					["claude", "mcp", "remove", "--scope", "user", "linear"],
					["grok", "mcp", "remove", "--scope", "user", "notion"],
					["hermes", "mcp", "remove", "linear"],
				]);
				expect(servers).toEqual({
					claude: { notion: "npx" },
					grok: { greptile: "/usr/local/bin/greptile-mcp" },
					hermes: { greptile: "/opt/greptile/server" },
				});
				expect(existsSync(join(home, `.claude.json${STAMP}`))).toBe(true);
				expect(existsSync(join(dir, `config.yaml${STAMP}`))).toBe(true);
				expect(lines.filter((l) => l.endsWith(" removed"))).toHaveLength(3);
			}, fake.run);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("GROK_HOME decides where grok's config.toml is backed up", () => {
		const servers: Record<CliHost, Record<string, string>> = { claude: {}, grok: {}, hermes: {} };
		const dir = mkdtempSync(join(tmpdir(), "mcp-register-grok-"));
		const fake = fakeHosts(servers, join(dir, "config.yaml"));
		try {
			sandbox(({ home, env, deps }) => {
				const grokHome = join(home, "custom-grok");
				mkdirSync(grokHome);
				writeFileSync(join(grokHome, "config.toml"), "");
				env.GROK_HOME = grokHome;
				expect(main(["--hosts", "grok", "--providers", "linear"], deps())).toBe(0);
				expect(servers.grok).toEqual({ linear: OURS_HERE });
				expect(existsSync(join(grokHome, `config.toml${STAMP}`))).toBe(true);
				expect(existsSync(join(home, ".grok"))).toBe(false);
			}, fake.run);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("blank CLAUDE_CONFIG_DIR and GROK_HOME count as unset and padded values are trimmed", () => {
		const servers: Record<CliHost, Record<string, string>> = { claude: {}, grok: {}, hermes: {} };
		const dir = mkdtempSync(join(tmpdir(), "mcp-register-trim-"));
		const fake = fakeHosts(servers, join(dir, "config.yaml"));
		try {
			sandbox(({ home, env, lines, deps }) => {
				const claudeFile = join(home, ".claude.json");
				const grokFile = join(home, ".grok", "config.toml");
				mkdirSync(join(home, ".grok"));
				writeFileSync(claudeFile, "{}\n");
				writeFileSync(grokFile, "");
				const backups = () => lines.filter((l) => l.trimStart().startsWith("backup "));
				env.CLAUDE_CONFIG_DIR = "   ";
				env.GROK_HOME = " ";
				expect(main(["--hosts", "claude,grok", "--providers", "linear", "--dry-run"], deps())).toBe(0);
				expect(backups()).toEqual([
					`  backup ${claudeFile} -> ${claudeFile}${STAMP}`,
					`  backup ${grokFile} -> ${grokFile}${STAMP}`,
				]);
				lines.length = 0;
				env.CLAUDE_CONFIG_DIR = ` ${home}\n`;
				env.GROK_HOME = `  ${join(home, ".grok")} `;
				expect(main(["--hosts", "claude,grok", "--providers", "linear", "--dry-run"], deps())).toBe(0);
				expect(backups()).toHaveLength(2);
			}, fake.run);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("warns to rerun from a stable clone only when run from a plugin cache", () => {
		sandbox(({ lines, deps }) => {
			main(["--hosts", "omp", "--dry-run"], deps("/home/u/.claude/plugins/cache/ultrathink/ultrathink/1.1.0"));
			expect(lines.find((l) => l.startsWith("warning:"))).toContain("stable directory");
			lines.length = 0;
			main(["--hosts", "omp", "--dry-run"], deps());
			expect(lines.some((l) => l.startsWith("warning:"))).toBe(false);
		});
	});

	test("hermes: the active profile's config.yaml decides ownership and is the one backed up", () => {
		const rows = ["  notion           /opt/other/n...   all  ✓ enabled"];
		const calls: string[][] = [];
		const run: Run = (cmd) => {
			calls.push(cmd);
			if (cmd[2] === "add") rows.push(`  ${(cmd[3] ?? "").padEnd(16)} ${cmd[5]} serve ${cmd[3]}   all  ✓ enabled`);
			return { code: 0, stdout: cmd[2] === "list" ? rows.join("\n") : "", stderr: "" };
		};
		sandbox(({ home, lines, deps }) => {
			const root = join(home, ".hermes");
			const profile = join(root, "profiles", "work");
			mkdirSync(profile, { recursive: true });
			writeFileSync(join(root, "config.yaml"), `mcp_servers:\n  notion:\n    command: ${OTHER_CLONE}\n`);
			writeFileSync(join(profile, "config.yaml"), "mcp_servers:\n  notion:\n    command: /opt/other/notion-server\n");
			writeFileSync(join(root, "active_profile"), "work\n");
			expect(main(["--hosts", "hermes", "--providers", "notion,linear"], deps())).toBe(0);
			expect(lines.find((l) => l.includes("notion kept"))).toContain("--replace");
			expect(calls.filter((c) => c[2] !== "list")).toEqual([
				["hermes", "mcp", "remove", "linear"],
				["hermes", "mcp", "add", "linear", "--command", OURS_HERE, "--args", "serve", "linear"],
			]);
			expect(existsSync(join(profile, `config.yaml${STAMP}`))).toBe(true);
			expect(existsSync(join(root, `config.yaml${STAMP}`))).toBe(false);
		}, run);
	});

	test("--replace and --remove together are refused", () => {
		sandbox(({ deps }) => {
			expect(() => main(["--replace", "--remove"], deps())).toThrow("cannot be combined");
		});
	});
});

describe("hermesConfigFile", () => {
	test("follows HERMES_HOME profiles, active_profile and refuses an unresolvable profile", () => {
		const home = mkdtempSync(join(tmpdir(), "mcp-register-hermes-home-"));
		try {
			const root = join(home, ".hermes");
			mkdirSync(join(root, "profiles", "work"), { recursive: true });
			expect(hermesConfigFile({}, home)).toBe(join(root, "config.yaml"));
			writeFileSync(join(root, "active_profile"), "Work\n");
			expect(hermesConfigFile({}, home)).toBe(join(root, "profiles", "work", "config.yaml"));
			expect(hermesConfigFile({ HERMES_HOME: root }, home)).toBe(join(root, "profiles", "work", "config.yaml"));
			expect(hermesConfigFile({ HERMES_HOME: "/srv/h/profiles/ops" }, home)).toBe("/srv/h/profiles/ops/config.yaml");
			writeFileSync(join(root, "active_profile"), "default\n");
			expect(hermesConfigFile({}, home)).toBe(join(root, "config.yaml"));
			writeFileSync(join(root, "active_profile"), "gone\n");
			expect(hermesConfigFile({}, home)).toBeUndefined();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
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
