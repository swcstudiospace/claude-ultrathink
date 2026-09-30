// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPaths, defaultConfig, loadConfig, mergeConfig, type UltrathinkConfig, userConfigPath } from "./config.ts";
import type { DecisionsConfig } from "./decisions/types.ts";

function tempConfigFile(content: unknown): { path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-config-"));
	const path = join(dir, "ultrathink.json");
	writeFileSync(path, JSON.stringify(content));
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("defaultConfig", () => {
	test("defaults to the Claude engine, not Grok", () => {
		expect(defaultConfig().think.engine).toBe("claude");
	});

	test("tracks nowhere until the user configures a Linear team or Notion data source", () => {
		const config = defaultConfig();
		expect(config.notion.dataSourceUrl).toBe("");
		expect(config.linear.team).toBe("");
	});

	test("contacts no optional service and ships nothing until configured", () => {
		const config = defaultConfig();
		expect(config.substrate.url).toBe("");
		expect(config.grok.shuntBaseUrl).toBe("");
		expect(config.grok.shuntModel).toBe("");
		expect(config.ship).toMatchObject({ enabled: false, autoMerge: false, deleteBranch: false, greptileOrganization: "" });
	});
});

describe("mergeConfig", () => {
	test("undefined file returns base unchanged", () => {
		const base = defaultConfig();
		expect(mergeConfig(undefined, base)).toBe(base);
	});

	test("uplift partial JSON merges onto defaults", () => {
		const base = defaultConfig();
		const merged = mergeConfig({ uplift: { enabled: false } }, base);
		expect(merged.uplift).toEqual({ ...base.uplift, enabled: false });
	});

	test("uplift wrong-typed fields fall back to defaults", () => {
		const base = defaultConfig();
		const merged = mergeConfig({ uplift: { enabled: "no", maxChars: "big" } }, base);
		expect(merged.uplift).toEqual(base.uplift);
	});

	test("think engine only accepts grok or claude", () => {
		const base = defaultConfig();
		expect(mergeConfig({ think: { engine: "grok" } }, base).think.engine).toBe("grok");
		expect(mergeConfig({ think: { engine: "bogus" } }, base).think.engine).toBe("claude");
	});

	test("think maxNodes is clamped to MAX_NODES, and an invalid maxNodes (below the given minNodes) falls back to the default maxNodes instead of minNodes", () => {
		const base = defaultConfig();
		expect(mergeConfig({ think: { minNodes: 4, maxNodes: 100 } }, base).think.maxNodes).toBe(8);
		const result = mergeConfig({ think: { minNodes: 6, maxNodes: 3 } }, base).think;
		expect(result.minNodes).toBe(6);
		expect(result.maxNodes).toBe(8);
	});

	test("claude concurrency rejects non-positive input (falls back to the default) and callTimeoutMs/budgetMs reject negative numbers", () => {
		const base = defaultConfig();
		const merged = mergeConfig({ claude: { concurrency: 0, callTimeoutMs: -5, budgetMs: -1 } }, base);
		expect(merged.claude.concurrency).toBe(base.claude.concurrency);
		expect(merged.claude.callTimeoutMs).toBe(base.claude.callTimeoutMs);
		expect(merged.claude.budgetMs).toBe(base.claude.budgetMs);
	});

	test("grok reasoningEffort only accepts known efforts, baseUrl trailing slash is stripped", () => {
		const base = defaultConfig();
		const merged = mergeConfig({ grok: { reasoningEffort: "medium", baseUrl: "https://x/v1/" } }, base);
		expect(merged.grok.reasoningEffort).toBe("medium");
		expect(merged.grok.baseUrl).toBe("https://x/v1");
		expect(mergeConfig({ grok: { reasoningEffort: "extreme" } }, base).grok.reasoningEffort).toBe(base.grok.reasoningEffort);
	});

	test("grok defaults are grok-4.7 @ xhigh over the http transport, with no shunt gateway configured", () => {
		const grok = defaultConfig().grok;
		expect(grok.model).toBe("grok-4.7");
		expect(grok.reasoningEffort).toBe("xhigh");
		expect(grok.transport).toBe("http");
		expect(grok.shuntBaseUrl).toBe("");
		expect(grok.shuntModel).toBe("");
		expect(grok.shuntMaxTokens).toBe(8192);
	});

	test("grok transport accepts http, cli and shunt; anything else falls back", () => {
		const base = defaultConfig();
		expect(mergeConfig({ grok: { transport: "shunt" } }, base).grok.transport).toBe("shunt");
		expect(mergeConfig({ grok: { transport: "cli" } }, base).grok.transport).toBe("cli");
		expect(mergeConfig({ grok: { transport: "http" } }, base).grok.transport).toBe("http");
		expect(mergeConfig({ grok: { transport: "proxy" } }, base).grok.transport).toBe("http");
		expect(mergeConfig({ grok: { transport: 3 } }, base).grok.transport).toBe("http");
	});

	test("grok shunt keys are validated: http(s) URL with trailing slash stripped, non-empty model, positive integer max_tokens", () => {
		const base = defaultConfig();
		const merged = mergeConfig(
			{ grok: { transport: "shunt", shuntBaseUrl: "http://10.0.0.5:3001/", shuntModel: "grok-4.7", shuntMaxTokens: 4096 } },
			base,
		);
		expect(merged.grok.shuntBaseUrl).toBe("http://10.0.0.5:3001");
		expect(merged.grok.shuntModel).toBe("grok-4.7");
		expect(merged.grok.shuntMaxTokens).toBe(4096);
		const bad = mergeConfig({ grok: { shuntBaseUrl: "not a url", shuntModel: "  ", shuntMaxTokens: 0 } }, base).grok;
		expect(bad.shuntBaseUrl).toBe(base.grok.shuntBaseUrl);
		expect(bad.shuntModel).toBe(base.grok.shuntModel);
		expect(bad.shuntMaxTokens).toBe(base.grok.shuntMaxTokens);
		expect(mergeConfig({ grok: { shuntBaseUrl: "ftp://x" } }, base).grok.shuntBaseUrl).toBe(base.grok.shuntBaseUrl);
		expect(mergeConfig({ grok: { shuntMaxTokens: 1.5 } }, base).grok.shuntMaxTokens).toBe(base.grok.shuntMaxTokens);
		expect(mergeConfig({ grok: { shuntMaxTokens: "8192" } }, base).grok.shuntMaxTokens).toBe(base.grok.shuntMaxTokens);
	});

	test("hitl maxQuestions is clamped to 1-4", () => {
		const base = defaultConfig();
		expect(mergeConfig({ hitl: { maxQuestions: 0 } }, base).hitl.maxQuestions).toBe(base.hitl.maxQuestions);
		expect(mergeConfig({ hitl: { maxQuestions: 9 } }, base).hitl.maxQuestions).toBe(base.hitl.maxQuestions);
		expect(mergeConfig({ hitl: { maxQuestions: 2 } }, base).hitl.maxQuestions).toBe(2);
	});

	test("hitl knowledgeBase is opt-in and accepts only a boolean", () => {
		const base = defaultConfig();
		expect(base.hitl.knowledgeBase).toBe(false);
		expect(mergeConfig({ hitl: { knowledgeBase: true } }, base).hitl.knowledgeBase).toBe(true);
		expect(mergeConfig({ hitl: { knowledgeBase: false } }, base).hitl.knowledgeBase).toBe(false);
		expect(mergeConfig({ hitl: { knowledgeBase: "true" } }, base).hitl.knowledgeBase).toBe(false);
		expect(mergeConfig({ hitl: { knowledgeBase: 1 } }, base).hitl.knowledgeBase).toBe(false);
		expect(mergeConfig({ hitl: { maxQuestions: 2 } }, base).hitl.knowledgeBase).toBe(false);
	});

	test("notion dataSourceUrl and linear team accept a non-empty override, reject an empty string", () => {
		const base = mergeConfig({ notion: { dataSourceUrl: "collection://mine" }, linear: { team: "Mine" } }, defaultConfig());
		expect(base.notion.dataSourceUrl).toBe("collection://mine");
		expect(mergeConfig({ notion: { dataSourceUrl: "collection://other" } }, base).notion.dataSourceUrl).toBe("collection://other");
		expect(mergeConfig({ notion: { dataSourceUrl: "" } }, base).notion.dataSourceUrl).toBe("collection://mine");
		expect(mergeConfig({ linear: { team: "Other Team" } }, base).linear.team).toBe("Other Team");
		expect(mergeConfig({ linear: { team: "  " } }, base).linear.team).toBe("Mine");
	});
});

describe("track config", () => {
	test("defaults", () => {
		expect(defaultConfig().track).toEqual({ enabled: true, budgetMs: 60_000, concurrency: 6 });
	});

	test("accepts valid overrides and rejects invalid values", () => {
		const base = defaultConfig();
		expect(mergeConfig({ track: { enabled: false, budgetMs: 5000, concurrency: 2.7 } }, base).track).toEqual({
			enabled: false,
			budgetMs: 5000,
			concurrency: 2,
		});
		expect(mergeConfig({ track: { enabled: "no", budgetMs: 0, concurrency: 0 } }, base).track).toEqual(base.track);
		expect(mergeConfig({ track: { budgetMs: -1, concurrency: Number.NaN } }, base).track).toEqual(base.track);
	});
});

describe("config paths", () => {
	test("user config lives under XDG_CONFIG_HOME, else ~/.config", () => {
		expect(userConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/ultrathink/config.json");
		expect(userConfigPath({})).toBe(join(homedir(), ".config", "ultrathink", "config.json"));
	});

	test("user, then Claude home, then project, in that order; only the project file is tagged as a project layer", () => {
		expect(claudeConfigPaths("/repo", { XDG_CONFIG_HOME: "/xdg", CLAUDE_CONFIG_DIR: "/home/.claude" })).toEqual([
			"/xdg/ultrathink/config.json",
			"/home/.claude/ultrathink.json",
			{ path: "/repo/.claude/ultrathink.json", project: true },
		]);
		expect(claudeConfigPaths("/repo", {})[1]).toBe(join(homedir(), ".claude", "ultrathink.json"));
	});

	test("the project file overrides ~/.claude, which overrides the user config", () => {
		const root = mkdtempSync(join(tmpdir(), "ultrathink-paths-"));
		const env = { XDG_CONFIG_HOME: join(root, "xdg"), CLAUDE_CONFIG_DIR: join(root, "claude") };
		const [user, claude, project] = claudeConfigPaths(join(root, "repo"), env).map((s) => (typeof s === "string" ? s : s.path)) as [
			string,
			string,
			string,
		];
		const files: [string, unknown][] = [
			[user, { linear: { team: "User" }, notion: { dataSourceUrl: "collection://user" }, hitl: { maxQuestions: 1 } }],
			[claude, { linear: { team: "Claude" }, notion: { dataSourceUrl: "collection://claude" } }],
			[project, { notion: { dataSourceUrl: "collection://project" } }],
		];
		try {
			for (const [path, content] of files) {
				mkdirSync(join(path, ".."), { recursive: true });
				writeFileSync(path, JSON.stringify(content));
			}
			const config = loadConfig(claudeConfigPaths(join(root, "repo"), env));
			expect(config.hitl.maxQuestions).toBe(1);
			expect(config.linear.team).toBe("Claude");
			expect(config.notion.dataSourceUrl).toBe("collection://project");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("loadConfig", () => {
	test("later files win; missing files are skipped", () => {
		const home = tempConfigFile({ uplift: { enabled: false } });
		const project = tempConfigFile({ uplift: { enabled: true }, hitl: { maxQuestions: 2 } });
		try {
			const config = loadConfig([home.path, project.path, "/does/not/exist.json"]);
			expect(config.uplift.enabled).toBe(true);
			expect(config.hitl.maxQuestions).toBe(2);
		} finally {
			home.cleanup();
			project.cleanup();
		}
	});
});

describe("ship config", () => {
	const base = defaultConfig();
	test("defaults gate gsd- skills with strict review, but ship stays off until enabled", () => {
		expect(base.ship).toMatchObject({
			enabled: false,
			autoMerge: false,
			deleteBranch: false,
			skills: ["gsd-"],
			minScore: 5,
			mergeMethod: "squash",
			maxRounds: 5,
			waitMs: 100_000,
			reviewRetries: 3,
			mergeTimeoutMs: 3_600_000,
		});
	});
	test("opting in restores auto-merge and branch deletion; greptileOrganization is trimmed", () => {
		const ship = mergeConfig({ ship: { enabled: true, autoMerge: true, deleteBranch: true, greptileOrganization: " acme " } }, base).ship;
		expect(ship).toMatchObject({ enabled: true, autoMerge: true, deleteBranch: true, greptileOrganization: "acme" });
		expect(mergeConfig({ ship: { greptileOrganization: 7 } }, base).ship.greptileOrganization).toBe("");
	});
	test("valid overrides apply", () => {
		const ship = mergeConfig(
			{ ship: { autoMerge: false, skills: [], mergeMethod: "rebase", maxRounds: 2, minScore: 4, waitMs: 30_000 } },
			base,
		).ship;
		expect(ship).toMatchObject({ autoMerge: false, skills: [], mergeMethod: "rebase", maxRounds: 2, minScore: 4, waitMs: 30_000 });
	});
	test("invalid values fall back to defaults", () => {
		const ship = mergeConfig(
			{
				ship: {
					enabled: "yes",
					skills: ["gsd-", ""],
					mergeMethod: "force",
					maxRounds: 0,
					minScore: 9,
					pollMs: -1,
					waitMs: 0,
					reviewRetries: -1,
					mergeTimeoutMs: 0,
				},
			},
			base,
		).ship;
		expect(ship).toEqual(base.ship);
	});
	test("reviewRetries accepts 0 and floors fractions; strings and negatives fall back", () => {
		expect(mergeConfig({ ship: { reviewRetries: 0 } }, base).ship.reviewRetries).toBe(0);
		expect(mergeConfig({ ship: { reviewRetries: 2.7 } }, base).ship.reviewRetries).toBe(2);
		expect(mergeConfig({ ship: { reviewRetries: -1 } }, base).ship.reviewRetries).toBe(3);
		expect(mergeConfig({ ship: { reviewRetries: "3" } }, base).ship.reviewRetries).toBe(3);
	});
	test("mergeTimeoutMs must be at least 1 ms", () => {
		expect(mergeConfig({ ship: { mergeTimeoutMs: 600_000 } }, base).ship.mergeTimeoutMs).toBe(600_000);
		expect(mergeConfig({ ship: { mergeTimeoutMs: 0 } }, base).ship.mergeTimeoutMs).toBe(3_600_000);
		expect(mergeConfig({ ship: { mergeTimeoutMs: -5 } }, base).ship.mergeTimeoutMs).toBe(3_600_000);
	});
	test("minScore above Greptile's 5/5 maximum falls back", () => {
		expect(mergeConfig({ ship: { minScore: 6 } }, base).ship.minScore).toBe(5);
	});
	test("judge accepts gate and advisory; anything else falls back to gate", () => {
		expect(base.ship.judge).toBe("gate");
		expect(mergeConfig({ ship: { judge: "advisory" } }, base).ship.judge).toBe("advisory");
		expect(mergeConfig({ ship: { judge: "gate" } }, { ...base, ship: { ...base.ship, judge: "advisory" } }).ship.judge).toBe("gate");
		for (const judge of ["off", "ADVISORY", 1, null]) expect(mergeConfig({ ship: { judge } }, base).ship.judge).toBe("gate");
	});
});

describe("substrate config", () => {
	const base = defaultConfig();
	test("accepts an http(s) URL with trailing slashes stripped", () => {
		expect(mergeConfig({ substrate: { url: "http://127.0.0.1:7410/" } }, base).substrate.url).toBe("http://127.0.0.1:7410");
	});
	test("rejects non-http values and cannot be cleared by an empty string", () => {
		expect(mergeConfig({ substrate: { url: "ftp://x" } }, base).substrate.url).toBe("");
		const set = mergeConfig({ substrate: { url: "https://substrate.example" } }, base);
		expect(mergeConfig({ substrate: { url: "" } }, set).substrate.url).toBe("https://substrate.example");
	});
});

/** Brief §5 defaults, written out so a drifted constant fails here (AC-1.6). */
const DECISIONS_DEFAULTS: DecisionsConfig = {
	enabled: false,
	model: "~typesafe/jev-latest",
	points: ["plan", "ship", "knowledge", "blocking"],
	timeoutMs: 3000,
	zdr: true,
	planSkipBelow: 0.2,
	shipVetoAtOrBelow: 0.2,
	shipApproveAt: 0.7,
	groundedAt: 0.8,
	blockingAt: 0.5,
};

describe("decisions config", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	/**
	 * Runs the real loader over the user layer (XDG config.json), the Claude home layer (a second user layer) and the project
	 * layer (<project>/.claude/ultrathink.json); `undefined` = no file.
	 */
	function loadLayers(user: unknown, claude?: unknown, project?: unknown): UltrathinkConfig {
		const root = mkdtempSync(join(tmpdir(), "ut-decisions-config-"));
		roots.push(root);
		const env = { XDG_CONFIG_HOME: join(root, "xdg"), CLAUDE_CONFIG_DIR: join(root, "claude") };
		const cwd = join(root, "repo");
		const sources = claudeConfigPaths(cwd, env);
		for (const [source, content] of [
			[sources[0], user],
			[sources[1], claude],
			[sources[2], project],
		] as const) {
			if (content === undefined || source === undefined) continue;
			const path = typeof source === "string" ? source : source.path;
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, JSON.stringify(content));
		}
		return loadConfig(sources);
	}

	test("a fresh install has decisions off with the brief §5 defaults (AC-1.6)", () => {
		expect(defaultConfig().decisions).toEqual(DECISIONS_DEFAULTS);
		expect(loadLayers(undefined).decisions).toEqual(DECISIONS_DEFAULTS);
		expect(loadLayers({ uplift: { enabled: false } }, { hitl: { maxQuestions: 2 } }).decisions).toEqual(DECISIONS_DEFAULTS);
	});

	test("each defaultConfig() owns its points list, so mutating one never changes the next default", () => {
		defaultConfig().decisions.points.splice(0);
		expect(defaultConfig().decisions.points).toEqual(["plan", "ship", "knowledge", "blocking"]);
	});

	test("enabled adopts only a boolean; \"yes\" and 1 keep the earlier layer's value (AC-10.5)", () => {
		expect(loadLayers({}, { decisions: { enabled: true } }).decisions.enabled).toBe(true);
		expect(loadLayers({ decisions: { enabled: true } }, { decisions: { enabled: false } }).decisions.enabled).toBe(false);
		for (const enabled of ["yes", 1]) {
			expect(loadLayers({ decisions: { enabled: true } }, { decisions: { enabled } }).decisions.enabled).toBe(true);
			expect(loadLayers({}, { decisions: { enabled } }).decisions.enabled).toBe(false);
		}
	});

	test("model is trimmed; empty, blank and non-string values keep the earlier layer's model (AC-10.6)", () => {
		const user = { decisions: { model: "typesafe/jev-user" } };
		expect(loadLayers(user, { decisions: { model: "typesafe/jev-1.13" } }).decisions.model).toBe("typesafe/jev-1.13");
		expect(loadLayers(user, { decisions: { model: "  typesafe/jev-1.13  " } }).decisions.model).toBe("typesafe/jev-1.13");
		for (const model of ["", "   ", 42]) {
			expect(loadLayers(user, { decisions: { model } }).decisions.model).toBe("typesafe/jev-user");
			expect(loadLayers({}, { decisions: { model } }).decisions.model).toBe("~typesafe/jev-latest");
		}
	});

	test("points keeps known names in input order, drops unknowns and duplicates, allows []; a non-array keeps the earlier layer (AC-10.7)", () => {
		const user = { decisions: { points: ["ship", "knowledge"] } };
		expect(loadLayers(user, { decisions: { points: ["plan", "ship"] } }).decisions.points).toEqual(["plan", "ship"]);
		expect(loadLayers(user, { decisions: { points: ["plan", "bogus"] } }).decisions.points).toEqual(["plan"]);
		expect(loadLayers(user, { decisions: { points: [] } }).decisions.points).toEqual([]);
		expect(loadLayers(user, { decisions: { points: "plan" } }).decisions.points).toEqual(["ship", "knowledge"]);
		expect(loadLayers(user, { decisions: { points: null } }).decisions.points).toEqual(["ship", "knowledge"]);
		expect(
			loadLayers({}, { decisions: { points: ["blocking", "PLAN", "plan", "blocking", 3, null, "plan"] } }).decisions.points,
		).toEqual(["blocking", "plan"]);
		expect(loadLayers({ decisions: { points: [] } }, { decisions: { enabled: true } }).decisions.points).toEqual([]);
	});

	test("timeoutMs adopts a finite number in (0, 30000]; 0, negatives, larger values and strings keep the earlier layer (AC-10.8, K4)", () => {
		const user = { decisions: { timeoutMs: 4000 } };
		expect(loadLayers(user, { decisions: { timeoutMs: 5000 } }).decisions.timeoutMs).toBe(5000);
		expect(loadLayers(user, { decisions: { timeoutMs: 1.5 } }).decisions.timeoutMs).toBe(1.5);
		expect(loadLayers(user, { decisions: { timeoutMs: 30000 } }).decisions.timeoutMs).toBe(30000);
		for (const timeoutMs of [0, -1, 30001, 1e300, "3000", null]) {
			expect(loadLayers(user, { decisions: { timeoutMs } }).decisions.timeoutMs).toBe(4000);
		}
		const base = defaultConfig();
		for (const timeoutMs of [Number.POSITIVE_INFINITY, Number.NaN]) {
			expect(mergeConfig({ decisions: { timeoutMs } }, base).decisions.timeoutMs).toBe(3000);
		}
	});

	test("zdr adopts only a boolean; the string \"false\" keeps the earlier layer (AC-10.9)", () => {
		expect(loadLayers({}, { decisions: { zdr: false } }).decisions.zdr).toBe(false);
		expect(loadLayers({}, { decisions: { zdr: "false" } }).decisions.zdr).toBe(true);
		expect(loadLayers({ decisions: { zdr: false } }, { decisions: { zdr: "true" } }).decisions.zdr).toBe(false);
		expect(loadLayers({ decisions: { zdr: false } }, { decisions: { zdr: 1 } }).decisions.zdr).toBe(false);
	});

	test("every threshold adopts a finite number in [0, 1] and only its own key; out-of-range and strings keep the earlier layer (AC-10.10)", () => {
		const thresholds = ["planSkipBelow", "shipVetoAtOrBelow", "shipApproveAt", "groundedAt", "blockingAt"] as const;
		const previous = 0.45;
		for (const key of thresholds) {
			const user = { decisions: { [key]: previous } };
			for (const value of [0, 1, 0.35]) {
				expect(loadLayers(user, { decisions: { [key]: value } }).decisions).toEqual({ ...DECISIONS_DEFAULTS, [key]: value });
			}
			for (const value of [-0.1, 1.1, "0.3", null]) {
				expect(loadLayers(user, { decisions: { [key]: value } }).decisions).toEqual({ ...DECISIONS_DEFAULTS, [key]: previous });
			}
			expect(mergeConfig({ decisions: { [key]: Number.NaN } }, defaultConfig()).decisions[key]).toBe(
				DECISIONS_DEFAULTS[key],
			);
		}
	});

	test("layers merge per field: a later layer overrides only the keys it sets (AC-10.11)", () => {
		const config = loadLayers(
			{ decisions: { enabled: true, planSkipBelow: 0.3 } },
			{ decisions: { planSkipBelow: 0.1, zdr: false } },
		);
		expect(config.decisions).toEqual({ ...DECISIONS_DEFAULTS, enabled: true, planSkipBelow: 0.1, zdr: false });
	});

	test("a non-object decisions section keeps the earlier layer whole", () => {
		const user = { decisions: { enabled: true, points: ["plan"] } };
		for (const decisions of ["on", true, ["plan"], null]) {
			expect(loadLayers(user, { decisions }).decisions).toEqual({ ...DECISIONS_DEFAULTS, enabled: true, points: ["plan"] });
		}
	});

	test("url and endpoint keys in any layer are ignored: the merged section has exactly the ten keys and no URL (D1, AC-2.12)", () => {
		const config = loadLayers(
			{ decisions: { url: "https://evil.example/user" } },
			{ decisions: { enabled: true, url: "https://evil.example/x", endpoint: "https://evil.example/y" } },
			{ decisions: { url: "https://evil.example/project", endpoint: "https://evil.example/z" } },
		);
		expect(config.decisions).toEqual({ ...DECISIONS_DEFAULTS, enabled: true });
		expect(Object.keys(config.decisions).sort()).toEqual(Object.keys(DECISIONS_DEFAULTS).sort());
		expect(JSON.stringify(config)).not.toContain("evil.example");
	});

	describe("a project file can only tighten consent (K5)", () => {
		test("a project `enabled: true` never opts a user in; a project `enabled: false` turns off a user's `true`", () => {
			expect(loadLayers({}, undefined, { decisions: { enabled: true } }).decisions.enabled).toBe(false);
			expect(loadLayers({ decisions: { enabled: false } }, undefined, { decisions: { enabled: true } }).decisions.enabled).toBe(false);
			expect(loadLayers({ decisions: { enabled: true } }, undefined, { decisions: { enabled: true } }).decisions.enabled).toBe(true);
			expect(loadLayers({ decisions: { enabled: true } }, undefined, { decisions: { enabled: false } }).decisions.enabled).toBe(false);
			expect(loadLayers({}, { decisions: { enabled: true } }, { decisions: { enabled: false } }).decisions.enabled).toBe(false);
		});

		test("a project `zdr: false` never lowers a user's retention guard; a project `zdr: true` raises a user's `false`", () => {
			expect(loadLayers({}, undefined, { decisions: { zdr: false } }).decisions.zdr).toBe(true);
			expect(loadLayers({ decisions: { zdr: true } }, undefined, { decisions: { zdr: false } }).decisions.zdr).toBe(true);
			expect(loadLayers({ decisions: { zdr: false } }, undefined, { decisions: { zdr: true } }).decisions.zdr).toBe(true);
			expect(loadLayers({ decisions: { zdr: false } }, undefined, { decisions: { zdr: false } }).decisions.zdr).toBe(false);
		});

		test("project points are intersected with the user's: they narrow, never widen, and keep the user's order", () => {
			const user = { decisions: { enabled: true, points: ["ship", "plan"] } };
			expect(loadLayers(user, undefined, { decisions: { points: ["plan"] } }).decisions.points).toEqual(["plan"]);
			expect(loadLayers(user, undefined, { decisions: { points: ["plan", "knowledge", "blocking"] } }).decisions.points).toEqual([
				"plan",
			]);
			expect(loadLayers(user, undefined, { decisions: { points: ["knowledge"] } }).decisions.points).toEqual([]);
			expect(loadLayers(user, undefined, { decisions: { points: ["plan", "ship", "bogus"] } }).decisions.points).toEqual([
				"ship",
				"plan",
			]);
			expect(loadLayers(user, undefined, { decisions: { points: "knowledge" } }).decisions.points).toEqual(["ship", "plan"]);
			expect(loadLayers({ decisions: { points: [] } }, undefined, { decisions: { points: ["plan"] } }).decisions.points).toEqual([]);
			expect(loadLayers({}, { decisions: { points: ["blocking"] } }, { decisions: { points: ["blocking", "ship"] } }).decisions.points).toEqual([
				"blocking",
			]);
		});

		test("model, thresholds and timeoutMs from a project file still merge as usual", () => {
			const config = loadLayers(
				{ decisions: { enabled: true, model: "typesafe/jev-user", planSkipBelow: 0.3, timeoutMs: 4000 } },
				undefined,
				{ decisions: { model: "typesafe/jev-1.13", planSkipBelow: 0.1, blockingAt: 0.9, timeoutMs: 8000 } },
			);
			expect(config.decisions).toEqual({
				...DECISIONS_DEFAULTS,
				enabled: true,
				model: "typesafe/jev-1.13",
				planSkipBelow: 0.1,
				blockingAt: 0.9,
				timeoutMs: 8000,
			});
			expect(loadLayers({ decisions: { timeoutMs: 4000 } }, undefined, { decisions: { timeoutMs: 30001 } }).decisions.timeoutMs).toBe(4000);
		});

		test("a plain path list keeps user semantics, so only the tagged project entry is restricted", () => {
			const file = tempConfigFile({ decisions: { enabled: true, zdr: false, points: ["plan", "ship"] } });
			try {
				expect(loadConfig([file.path]).decisions).toMatchObject({ enabled: true, zdr: false, points: ["plan", "ship"] });
				expect(loadConfig([{ path: file.path, project: true }]).decisions).toMatchObject({
					enabled: false,
					zdr: true,
					points: ["plan", "ship"],
				});
			} finally {
				file.cleanup();
			}
		});
	});
});
