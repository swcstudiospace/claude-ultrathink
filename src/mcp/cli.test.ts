// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../claude/state.ts";

const CLI = join(import.meta.dir, "cli.ts");

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ut-mcp-cli-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Runs the real CLI with its config files, credential store and cwd all inside `root`. */
function run(...args: string[]): { code: number | null; stdout: string; stderr: string } {
	const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
		cwd: root,
		env: {
			...process.env,
			HOME: join(root, "home"),
			XDG_CONFIG_HOME: join(root, "xdg"),
			CLAUDE_CONFIG_DIR: join(root, "claude"),
			ULTRATHINK_MCP_STORE: join(root, "credentials.json"),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("notion init", () => {
	test("without --parent is a usage error", () => {
		const { code, stderr } = run("notion", "init", "--write-config");
		expect(code).toBe(2);
		expect(stderr).toContain("notion init needs --parent <notion page url or id>");
		expect(stderr).toContain("ultrathink-mcp notion init --parent");
	});

	test("a --parent without a page id is a usage error", () => {
		const { code, stderr } = run("notion", "init", "--parent", "https://www.notion.so/acme");
		expect(code).toBe(2);
		expect(stderr).toContain("--parent is not a Notion page url or id");
	});

	test("without a Notion login fails with the login command and writes no config", () => {
		const { code, stderr } = run("notion", "init", "--parent", "0123456789abcdef0123456789abcdef", "--write-config");
		expect(code).toBe(1);
		expect(stderr).toContain("notion is not logged in: run: ultrathink-mcp auth login notion");
		expect(existsSync(join(root, "xdg", "ultrathink", "config.json"))).toBe(false);
	});
});

describe("track complete", () => {
	const record: SessionRecord = {
		sessionId: "s1",
		at: 1,
		result: { xml: "<BUILD_PROMPT/>", original: "ship it", root: "/repo", source: "llm" },
		plan: {
			graphId: "ut-test",
			task: {
				graphId: "ut-test",
				item: "Ship it",
				description: "ship it",
				upliftedPrompt: "<BUILD_PROMPT/>",
				agent: "claude-code",
				status: "Planning",
				linearState: "Todo",
			},
			issues: [],
			subIssues: [],
			linearIssues: [],
			linearSubIssues: [],
			hitl: { blocking: [], nonBlocking: [] },
		},
	};

	/** A session file in <root>/state/sessions, with control.json beside sessions/ and an optional user config. */
	function session(control: Record<string, unknown> | undefined, config: Record<string, unknown> | undefined): string {
		const stateDir = join(root, "state");
		mkdirSync(join(stateDir, "sessions"), { recursive: true });
		if (control) writeFileSync(join(stateDir, "control.json"), JSON.stringify(control));
		if (config) {
			mkdirSync(join(root, "xdg", "ultrathink"), { recursive: true });
			writeFileSync(join(root, "xdg", "ultrathink", "config.json"), JSON.stringify(config));
		}
		const path = join(stateDir, "sessions", "s1.json");
		writeFileSync(path, JSON.stringify(record));
		return path;
	}

	test("tracking off (/ultrathink-track off) exits 0 without touching the session, even when configured", () => {
		const path = session({ trackEnabled: false }, { linear: { team: "Acme" } });
		const { code, stdout, stderr } = run("track", "complete", "--state", path);
		expect(code).toBe(0);
		expect(stderr).toContain("ultrathink-mcp: tracking is off (/ultrathink-track on to enable)");
		expect(stdout).toBe("");
		expect(readFileSync(path, "utf8")).toBe(JSON.stringify(record));
		expect(existsSync(path.replace(/\.json$/, ".xml"))).toBe(false);
	});

	test("no linear.team or notion.dataSourceUrl exits 0 and names the config file and notion init", () => {
		const path = session(undefined, undefined);
		const { code, stderr } = run("track", "complete", "--state", path);
		expect(code).toBe(0);
		expect(stderr).toContain(
			`ultrathink-mcp: tracking not configured: set linear.team and/or notion.dataSourceUrl in ${join(root, "xdg", "ultrathink", "config.json")}`,
		);
		expect(stderr).toContain("ultrathink-mcp notion init --parent <page>");
		expect(readFileSync(path, "utf8")).toBe(JSON.stringify(record));
	});

	test("tracking on with a configured team goes on to the tracker", () => {
		const path = session({ trackEnabled: true }, { linear: { team: "Acme" } });
		const { code, stderr } = run("track", "complete", "--state", path);
		expect(code).toBe(1);
		expect(stderr).toContain("no tracker credentials");
	});
});

describe("session mark", () => {
	const record: SessionRecord = {
		sessionId: "s1",
		at: 1,
		host: "hermes",
		result: { xml: "<BUILD_PROMPT/>", original: "ship it", root: "/repo", source: "llm" },
		skill: { name: "gsd-quick", source: "slash" },
	};

	function session(value: unknown): string {
		mkdirSync(join(root, "state", "sessions"), { recursive: true });
		const path = join(root, "state", "sessions", "s1.json");
		writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
		return path;
	}

	test("kicked-off sets kickedOff, keeps every other field, and prints nothing", () => {
		const path = session(record);
		const { code, stdout, stderr } = run("session", "mark", "--state", path, "kicked-off");
		expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...record, kickedOff: true });
	});

	test("synced sets synced without clearing an earlier kickedOff, whatever the argument order", () => {
		const path = session({ ...record, kickedOff: true });
		const { code } = run("session", "mark", "synced", "--state", path);
		expect(code).toBe(0);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...record, kickedOff: true, synced: true });
	});

	test("an unknown, missing or doubled mark is a usage error and leaves the file alone", () => {
		const path = session(record);
		for (const marks of [["kickedOff"], [], ["kicked-off", "synced"]]) {
			const { code, stderr } = run("session", "mark", "--state", path, ...marks);
			expect(code).toBe(2);
			expect(stderr).toContain("session mark needs one of kicked-off, synced");
			expect(stderr).toContain("ultrathink-mcp session mark --state");
		}
		expect(readFileSync(path, "utf8")).toBe(JSON.stringify(record));
	});

	test("a missing or unreadable session file exits 1 with one line and writes nothing", () => {
		const missing = join(root, "state", "sessions", "gone.json");
		const gone = run("session", "mark", "--state", missing, "kicked-off");
		expect(gone.code).toBe(1);
		expect(gone.stderr).toBe(`ultrathink-mcp: cannot read session record: ${missing}\n`);
		expect(existsSync(missing)).toBe(false);
		for (const garbage of ["{not json", "null", JSON.stringify({ sessionId: "s1" })]) {
			const path = session(garbage);
			const { code, stderr } = run("session", "mark", "--state", path, "kicked-off");
			expect(code).toBe(1);
			expect(stderr).toBe(`ultrathink-mcp: cannot read session record: ${path}\n`);
			expect(readFileSync(path, "utf8")).toBe(garbage);
		}
	});
});
