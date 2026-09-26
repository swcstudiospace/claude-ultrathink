// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";
import { readControl } from "../claude/state.ts";
import { writeStore } from "../mcp/store.ts";
import {
	parseUltrathinkCommand,
	runControl,
	trackingEnabled,
	trackingOff,
	type UltrathinkCommand,
	ULTRATHINK_VERBS,
} from "./commands.ts";

function config(patch: { track?: boolean; notion?: string; linear?: string } = {}): UltrathinkConfig {
	const base = defaultConfig();
	return {
		...base,
		track: { ...base.track, enabled: patch.track ?? true },
		notion: { dataSourceUrl: patch.notion ?? "" },
		linear: { team: patch.linear ?? "" },
	};
}

describe("parseUltrathinkCommand", () => {
	test.each<[string, UltrathinkCommand]>([
		["/ultrathink-quick fix the typo", { verb: "quick", args: "fix the typo" }],
		["/ultrathink-track off", { verb: "track", args: "off" }],
		["  /ULTRATHINK-Status  ", { verb: "status", args: "" }],
		["/ultrathink-quick   fix\n  the typo  ", { verb: "quick", args: "fix\n  the typo" }],
		["/ultrathink:ultrathink-skip", { verb: "skip", args: "" }],
		[
			"<command-message>ultrathink:ultrathink-quick is running…</command-message>\n<command-name>/ultrathink:ultrathink-quick</command-name>\n<command-args>  fix the typo </command-args>",
			{ verb: "quick", args: "fix the typo" },
		],
		["<command-name>/ultrathink-track</command-name>\n<command-args>on</command-args>", { verb: "track", args: "on" }],
		['<user_query>\n/ultrathink-quick fix the typo\n</user_query>\n<skill_information>\n<skill name="ultrathink-quick" args="fix the typo">\nBody.\n</skill>\n</skill_information>', { verb: "quick", args: "fix the typo" }],
		// Older names stay accepted.
		["/ultrathink:quick fix the typo", { verb: "quick", args: "fix the typo" }],
		["<command-name>/ultrathink:off</command-name>", { verb: "off", args: "" }],
		["/ultrathink quick fix it", { verb: "quick", args: "fix it" }],
		["/ultrathink TRACK\n on ", { verb: "track", args: "on" }],
		["<user_query>\n/ultrathink status\n</user_query>", { verb: "status", args: "" }],
	])("%p", (text, expected) => {
		expect(parseUltrathinkCommand(text)).toEqual(expected);
	});

	test("every verb parses under each of its names", () => {
		for (const verb of ULTRATHINK_VERBS) {
			for (const typed of [`/ultrathink-${verb}`, `/ultrathink:ultrathink-${verb}`, `/ultrathink:${verb}`, `/ultrathink ${verb}`]) {
				expect(parseUltrathinkCommand(typed)).toEqual({ verb, args: "" });
			}
		}
	});

	test.each([
		"fix the typo",
		"",
		"please run /ultrathink:quick later",
		"/ultrathink-bogus x",
		"/ultrathink:ultrathink-bogus",
		"/ultrathink:bogus x",
		"/ultrathink-last",
		"/ultrathink:last",
		"/ultrathink-",
		"/ultrathink:",
		"/ultrathink",
		"/ultrathink bogus x",
		"/ultrathink-ship",
		"/ultrathink:ultrathink-kickoff stateFile=/tmp/s.json",
		"/model sonnet",
		"<local-command-stdout>/ultrathink-status</local-command-stdout>",
		"<user_query>\nfix the typo\n</user_query>",
		"<user_query>\n/quick fix the typo\n</user_query>",
	])("%p is not a command", (text) => {
		expect(parseUltrathinkCommand(text)).toBeUndefined();
	});
});

describe("trackingEnabled", () => {
	test("the control toggle beats config; ULTRATHINK_TRACK=0 beats both", () => {
		expect(trackingEnabled(config({ track: true }), {}, {})).toBe(true);
		expect(trackingEnabled(config({ track: false }), {}, {})).toBe(false);
		expect(trackingEnabled(config({ track: true }), { trackEnabled: false }, {})).toBe(false);
		expect(trackingEnabled(config({ track: false }), { trackEnabled: true }, {})).toBe(true);
		expect(trackingEnabled(config({ track: true }), { trackEnabled: true }, { ULTRATHINK_TRACK: "0" })).toBe(false);
		expect(trackingEnabled(config({ track: true }), {}, { ULTRATHINK_TRACK: "1" })).toBe(true);
	});
});

describe("trackingOff", () => {
	test("rows are unwanted when tracking is turned off or nothing is configured", () => {
		expect(trackingOff(config(), {})).toBe(true);
		expect(trackingOff(config({ notion: "  ", linear: " " }), { trackEnabled: true })).toBe(true);
		expect(trackingOff(config({ notion: "collection://abc" }), {})).toBe(false);
		expect(trackingOff(config({ linear: "Acme" }), {})).toBe(false);
		expect(trackingOff(config({ linear: "Acme" }), { trackEnabled: false })).toBe(true);
	});

	test("config track.enabled=false only stops the planner's own tracker; kickoff still creates rows", () => {
		const hookOff = config({ track: false, linear: "Acme" });
		expect(trackingEnabled(hookOff, {}, {})).toBe(false);
		expect(trackingOff(hookOff, {})).toBe(false);
	});
});

describe("runControl", () => {
	const ENV_KEYS = [
		"XDG_CONFIG_HOME",
		"CLAUDE_CONFIG_DIR",
		"ULTRATHINK_TRACK",
		"ULTRATHINK_SHIP",
		"SUBSTRATE_URL",
		"SUBSTRATE_DISABLED",
		"ULTRATHINK_MCP_STORE",
	] as const;
	const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
	let dir: string;
	let io: { stateDir: string; cwd: string };

	function projectConfig(extra: Record<string, unknown>): void {
		mkdirSync(join(io.cwd, ".claude"), { recursive: true });
		// An empty Grok home keeps the OAuth status line off the real ~/.grok.
		writeFileSync(join(io.cwd, ".claude", "ultrathink.json"), JSON.stringify({ grok: { home: join(dir, "grok") }, ...extra }));
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-commands-"));
		io = { stateDir: join(dir, "state"), cwd: join(dir, "project") };
		for (const key of ENV_KEYS) saved[key] = process.env[key];
		// User-level config on the machine running the tests must not leak in.
		process.env.XDG_CONFIG_HOME = join(dir, "xdg");
		process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
		for (const key of ["ULTRATHINK_TRACK", "ULTRATHINK_SHIP", "SUBSTRATE_URL", "SUBSTRATE_DISABLED"] as const) delete process.env[key];
		// The credential store must never be the real one.
		process.env.ULTRATHINK_MCP_STORE = join(dir, "mcp-credentials.json");
		projectConfig({});
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	test("off, on, skip, track off and track on persist in the state dir", async () => {
		expect(await runControl(["off"], io)).toBe("Prompt Uplift off");
		expect(readControl(io.stateDir)).toEqual({ enabled: false });
		expect(await runControl(["on"], io)).toBe("Prompt Uplift on");
		expect(await runControl(["skip"], io)).toBe("Prompt Uplift will skip the next prompt");
		expect(await runControl(["track", "off"], io)).toStartWith("Tracking: off (Linear/Notion rows)");
		expect(readControl(io.stateDir)).toEqual({ enabled: true, skipOnce: true, trackEnabled: false });
		expect(await runControl(["Track", "ON"], io)).toStartWith("Tracking: on");
		expect(readControl(io.stateDir)).toEqual({ enabled: true, skipOnce: true, trackEnabled: true });
		expect(await runControl(["status"], io)).toStartWith("Prompt Uplift on (skipping next prompt)");
	});

	test("status reports tracking and names what is not configured", async () => {
		const status = await runControl(["status"], io);
		expect(status).toContain("Tracking: on (not configured: set notion.dataSourceUrl / linear.team)");
		expect(status).toContain("Notion: not configured");
		expect(status).toContain("Linear team: not configured");
		expect(status).toContain(`State: ${io.stateDir}`);
		expect(await runControl([], io)).toBe(status);

		projectConfig({ notion: { dataSourceUrl: "collection://abc" }, linear: { team: "Acme" } });
		const configured = await runControl(["status"], io);
		expect(configured).toContain("Tracking: on (Linear/Notion rows)");
		expect(configured).toContain("Notion: collection://abc");
		expect(configured).toContain("Linear team: Acme");

		await runControl(["track", "off"], io);
		expect(await runControl(["track"], io)).toBe("Tracking: off (Linear/Notion rows)\nNotion: collection://abc\nLinear team: Acme");
	});

	test("tracking reads off only when no rows are wanted; config or ULTRATHINK_TRACK=0 leaves them to kickoff", async () => {
		const kickoff = "Tracking: kickoff (planner-side row creation off; /ultrathink-track off stops all rows)";
		projectConfig({ linear: { team: "Acme" }, track: { enabled: false } });
		expect(await runControl(["status"], io)).toContain(kickoff);
		projectConfig({ linear: { team: "Acme" } });
		process.env.ULTRATHINK_TRACK = "0";
		expect(await runControl(["track"], io)).toStartWith(kickoff);
		expect(await runControl(["track", "on"], io)).toStartWith(kickoff);
		expect(await runControl(["track", "off"], io)).toStartWith("Tracking: off (Linear/Notion rows)");
	});

	/** The one status line starting with `prefix`. */
	async function statusLine(prefix: string): Promise<string | undefined> {
		return (await runControl(["status"], io)).split("\n").find((line) => line.startsWith(prefix));
	}

	test("status shows the substrate as off until a URL is set; SUBSTRATE_URL beats config, SUBSTRATE_DISABLED beats both", async () => {
		expect(await statusLine("Substrate:")).toBe("Substrate: off (optional: set substrate.url or SUBSTRATE_URL)");
		projectConfig({ substrate: { url: "https://substrate.example/" } });
		expect(await statusLine("Substrate:")).toBe("Substrate: https://substrate.example (config)");
		process.env.SUBSTRATE_URL = "http://localhost:9000";
		expect(await statusLine("Substrate:")).toBe("Substrate: http://localhost:9000 (SUBSTRATE_URL)");
		process.env.SUBSTRATE_DISABLED = "1";
		expect(await statusLine("Substrate:")).toBe("Substrate: off (SUBSTRATE_DISABLED=1)");
	});

	test("status shows ship as off by default, its merge settings when enabled, and off again under ULTRATHINK_SHIP=0", async () => {
		expect(await statusLine("Ship:")).toBe("Ship: off (opt-in: set ship.enabled)");
		projectConfig({ ship: { enabled: true } });
		expect(await statusLine("Ship:")).toBe("Ship: on · auto-merge off · delete branch off");
		projectConfig({ ship: { enabled: true, autoMerge: true, deleteBranch: true } });
		expect(await statusLine("Ship:")).toBe("Ship: on · auto-merge on · delete branch on");
		process.env.ULTRATHINK_SHIP = "0";
		expect(await statusLine("Ship:")).toBe("Ship: off (ULTRATHINK_SHIP=0)");
	});

	test("status shows the knowledge base as opt-in, idle while HITL is off, missing a credential, then ready with its organization", async () => {
		expect(await statusLine("Knowledge base:")).toBe("Knowledge base: off (opt-in: set hitl.knowledgeBase)");
		projectConfig({ hitl: { knowledgeBase: true } });
		expect(await statusLine("Knowledge base:")).toBe(
			"Knowledge base: on · no Greptile credential (run bin/ultrathink-mcp auth login greptile)",
		);
		writeStore(process.env.ULTRATHINK_MCP_STORE as string, {
			version: 1,
			providers: { greptile: { kind: "api_key", apiKey: "test-key", updatedAt: 1 } },
		});
		expect(await statusLine("Knowledge base:")).toBe("Knowledge base: on · Greptile");
		projectConfig({ hitl: { knowledgeBase: true }, ship: { greptileOrganization: "acme" } });
		expect(await statusLine("Knowledge base:")).toBe("Knowledge base: on · Greptile · organization acme");
		await runControl(["hitl", "off"], io);
		expect(await statusLine("Knowledge base:")).toBe("Knowledge base: on · not read while HITL is off");
		projectConfig({ hitl: { enabled: false, knowledgeBase: true }, ship: { greptileOrganization: "acme" } });
		await runControl(["hitl", "on"], io);
		expect(await statusLine("Knowledge base:")).toBe("Knowledge base: on · Greptile · organization acme");
	});

	test("the shunt status names the missing gateway setting and the model actually sent", async () => {
		const grok = { home: join(dir, "grok"), model: "grok-test", transport: "shunt" };
		projectConfig({ grok });
		const unset = await statusLine("Grok:");
		expect(unset).toContain("shunt gateway not configured (set grok.shuntBaseUrl)");
		expect(unset).toContain("wire model grok-test");
		expect(unset).not.toContain("/v1/messages");

		projectConfig({ grok: { ...grok, shuntBaseUrl: "https://gateway.example", shuntModel: "wire-x" } });
		const set = await statusLine("Grok:");
		expect(set).toContain("https://gateway.example/v1/messages");
		expect(set).toContain("wire model wire-x");
	});

	test("the legacy think, hitl, grok and last scopes keep working", async () => {
		expect(await runControl(["think", "off"], io)).toBe("Graph of Thought off");
		expect(await runControl(["think"], io)).toBe("Graph of Thought off");
		expect(await runControl(["hitl", "off"], io)).toBe("HITL clarifications off");
		expect(await runControl(["grok", "engine", "claude"], io)).toBe("Thinking engine set to claude:sonnet");
		expect(readControl(io.stateDir)).toEqual({ thinkEnabled: false, hitlEnabled: false, engine: "claude" });
		expect(await runControl(["grok"], io)).toStartWith("Engine: claude:sonnet\nGrok: ");
		expect(await runControl(["last"], io)).toBe("No uplift recorded yet");
		expect(await runControl(["think", "last"], io)).toBe("No thought graph recorded yet");
	});

	test("bad arguments answer with usage; failures become a message, never a throw", async () => {
		expect(await runControl(["bogus"], io)).toStartWith("Usage: ultrathink <command>");
		expect(await runControl(["quick", "fix", "it"], io)).toStartWith("Usage: ultrathink <command>");
		expect(await runControl(["track", "maybe"], io)).toBe("Usage: track on|off|status");
		expect(await runControl(["think", "sideways"], io)).toBe("Usage: think on|off|last|status");
		expect(await runControl(["hitl", "maybe"], io)).toBe("Usage: hitl on|off|last|status");
		expect(await runControl(["grok", "engine", "gpt"], io)).toBe("Usage: grok engine grok|claude");
		expect(readControl(io.stateDir)).toEqual({});

		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "");
		expect(await runControl(["off"], { stateDir: join(blocker, "state"), cwd: io.cwd })).toStartWith("ultrathink: ");
	});
});
