// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	claudeConfigPaths,
	DEFAULT_CLAUDE_CONFIG,
	defaultConfig,
	hasControlCharacter,
	loadConfig,
	mergeConfig,
	type UltrathinkConfig,
	userConfigPath,
} from "./config.ts";
import type { DecisionsConfig } from "./decisions/types.ts";
import { DEFAULT_GROK_CONFIG } from "./grok/types.ts";
import { DEFAULT_MUSE_CONFIG, MUSE_MODEL_DEFAULT } from "./muse/types.ts";
import { ROUTE_DEFAULT_MODELS } from "./route-defaults.ts";

function tempConfigFile(content: unknown): { path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-config-"));
	const path = join(dir, "ultrathink.json");
	writeFileSync(path, JSON.stringify(content));
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("defaultConfig", () => {
	test("defaults to auto engine selection (host decides; claude-code still resolves to Muse)", () => {
		expect(defaultConfig().think.engine).toBe("auto");
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

	test("think engine only accepts auto, claude, grok or muse", () => {
		const base = defaultConfig();
		expect(mergeConfig({ think: { engine: "grok" } }, base).think.engine).toBe("grok");
		expect(mergeConfig({ think: { engine: "muse" } }, base).think.engine).toBe("muse");
		expect(mergeConfig({ think: { engine: "bogus" } }, base).think.engine).toBe("auto");
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

	test("muse defaults are the Muse route default (muse-spark-1.3-contributor) @ high with no timer", () => {
		const muse = defaultConfig().muse;
		expect(muse.bin).toBe("muse");
		expect(muse.model).toBe(ROUTE_DEFAULT_MODELS.muse);
		expect(muse.model).toBe("muse-spark-1.3-contributor");
		expect(muse.reasoningEffort).toBe("high");
		expect(muse.callTimeoutMs).toBe(0);
	});

	test("muse model accepts empty (inherit the CLI default); bin and effort fall back on bad input", () => {
		const base = defaultConfig();
		expect(mergeConfig({ muse: { model: "" } }, base).muse.model).toBe("");
		expect(mergeConfig({ muse: { model: " other " } }, base).muse.model).toBe("other");
		expect(mergeConfig({ muse: { bin: "  " } }, base).muse.bin).toBe("muse");
		expect(mergeConfig({ muse: { reasoningEffort: "ultra" } }, base).muse.reasoningEffort).toBe("ultra");
		expect(mergeConfig({ muse: { reasoningEffort: "extreme" } }, base).muse.reasoningEffort).toBe("high");
		expect(mergeConfig({ muse: { callTimeoutMs: -5 } }, base).muse.callTimeoutMs).toBe(0);
	});

	test("grok defaults are the Grok route default (grok-4.7) @ xhigh over the http transport, with no shunt gateway configured", () => {
		const grok = defaultConfig().grok;
		expect(grok.model).toBe(ROUTE_DEFAULT_MODELS.grok);
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
	enabled: true,
	provider: "auto",
	model: "~typesafe/jev-latest",
	points: ["plan", "ship", "knowledge", "blocking", "teachable", "skillworthy"],
	timeoutMs: 3000,
	zdr: true,
	planSkipBelow: 0.2,
	shipVetoAtOrBelow: 0.2,
	shipApproveAt: 0.7,
	groundedAt: 0.8,
	blockingAt: 0.5,
	teachableBelow: 0.3,
	teachableAutoAt: 0.8,
	skillworthyAt: 0.5,
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

	test("a fresh install has decisions on with the brief §5 defaults (AC-1.6)", () => {
		expect(defaultConfig().decisions).toEqual(DECISIONS_DEFAULTS);
		expect(loadLayers(undefined).decisions).toEqual(DECISIONS_DEFAULTS);
		expect(loadLayers({ uplift: { enabled: false } }, { hitl: { maxQuestions: 2 } }).decisions).toEqual(DECISIONS_DEFAULTS);
	});

	test("each defaultConfig() owns its points list, so mutating one never changes the next default", () => {
		defaultConfig().decisions.points.splice(0);
		expect(defaultConfig().decisions.points).toEqual(["plan", "ship", "knowledge", "blocking", "teachable", "skillworthy"]);
	});

	test("enabled is always on: true, false, non-booleans and missing values all merge to true in every layer (JEV-01)", () => {
		for (const enabled of [true, false, "yes", 1]) {
			expect(loadLayers({ decisions: { enabled } }).decisions.enabled).toBe(true);
			expect(loadLayers({}, { decisions: { enabled } }).decisions.enabled).toBe(true);
			expect(loadLayers({}, undefined, { decisions: { enabled } }).decisions.enabled).toBe(true);
		}
		expect(loadLayers({}).decisions.enabled).toBe(true);
		expect(loadLayers({ decisions: { enabled: false } }, { decisions: { enabled: false } }, { decisions: { enabled: false } }).decisions.enabled).toBe(
			true,
		);
	});

	test("provider accepts auto, openrouter and vercel per layer; anything else keeps the earlier layer (JEV-02)", () => {
		expect(loadLayers({}).decisions.provider).toBe("auto");
		expect(loadLayers({ decisions: { provider: "vercel" } }).decisions.provider).toBe("vercel");
		expect(loadLayers({ decisions: { provider: "vercel" } }, { decisions: { provider: "openrouter" } }).decisions.provider).toBe("openrouter");
		expect(loadLayers({ decisions: { provider: "openrouter" } }, { decisions: { provider: "auto" } }).decisions.provider).toBe("auto");
		expect(loadLayers({}, undefined, { decisions: { provider: "vercel" } }).decisions.provider).toBe("vercel");
		for (const provider of ["VERCEL", "gateway", "", 1, null]) {
			expect(loadLayers({ decisions: { provider: "vercel" } }, { decisions: { provider } }).decisions.provider).toBe("vercel");
			expect(loadLayers({}, { decisions: { provider } }).decisions.provider).toBe("auto");
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
		const thresholds = [
			"planSkipBelow",
			"shipVetoAtOrBelow",
			"shipApproveAt",
			"groundedAt",
			"blockingAt",
			"teachableBelow",
			"teachableAutoAt",
			"skillworthyAt",
		] as const;
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

	test("url and endpoint keys in any layer are ignored: the merged section has exactly the fourteen keys and no URL (D1, AC-2.12)", () => {
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
		test("a project `enabled` value never changes always-on: true and false in any combination stay true (JEV-01)", () => {
			expect(loadLayers({}, undefined, { decisions: { enabled: true } }).decisions.enabled).toBe(true);
			expect(loadLayers({ decisions: { enabled: false } }, undefined, { decisions: { enabled: true } }).decisions.enabled).toBe(true);
			expect(loadLayers({ decisions: { enabled: true } }, undefined, { decisions: { enabled: true } }).decisions.enabled).toBe(true);
			expect(loadLayers({ decisions: { enabled: true } }, undefined, { decisions: { enabled: false } }).decisions.enabled).toBe(true);
			expect(loadLayers({}, { decisions: { enabled: true } }, { decisions: { enabled: false } }).decisions.enabled).toBe(true);
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

		test("a project file cannot add teachable or skillworthy, but can drop them and move their thresholds", () => {
			const user = { decisions: { enabled: true, points: ["plan", "teachable"], teachableBelow: 0.2 } };
			expect(loadLayers(user, undefined, { decisions: { points: ["plan", "teachable", "skillworthy"] } }).decisions.points).toEqual([
				"plan",
				"teachable",
			]);
			expect(loadLayers(user, undefined, { decisions: { points: ["plan"] } }).decisions.points).toEqual(["plan"]);
			expect(loadLayers({ decisions: { enabled: true, points: ["plan"] } }, undefined, { decisions: { points: ["skillworthy"] } }).decisions.points).toEqual(
				[],
			);
			const tightened = loadLayers(user, undefined, { decisions: { teachableBelow: 0.5, teachableAutoAt: 0.9, skillworthyAt: 0.7 } }).decisions;
			expect(tightened).toMatchObject({ teachableBelow: 0.5, teachableAutoAt: 0.9, skillworthyAt: 0.7 });
			expect(loadLayers(user, undefined, { decisions: { teachableBelow: 2, skillworthyAt: "0.9" } }).decisions).toMatchObject({
				teachableBelow: 0.2,
				skillworthyAt: 0.5,
			});
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
					enabled: true,
					zdr: true,
					points: ["plan", "ship"],
				});
			} finally {
				file.cleanup();
			}
		});
	});
});

/** Runs the real loader over user config.json, the Claude home file and the project file (`undefined` = no file). */
function loadLayerFiles(roots: string[], user: unknown, claude?: unknown, project?: unknown): UltrathinkConfig {
	const root = mkdtempSync(join(tmpdir(), "ut-teach-config-"));
	roots.push(root);
	const env = { XDG_CONFIG_HOME: join(root, "xdg"), CLAUDE_CONFIG_DIR: join(root, "claude") };
	const sources = claudeConfigPaths(join(root, "repo"), env);
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

describe("hindsight config", () => {
	const base = defaultConfig();
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	test("defaults are off with no URL, and each defaultConfig() is independent", () => {
		expect(base.hindsight).toEqual({ enabled: false, url: "", bank: "ultrathink", timeoutMs: 5_000, retainTimeoutMs: 15_000 });
		expect(loadLayerFiles(roots, undefined).hindsight).toEqual(base.hindsight);
		const mutated = defaultConfig();
		mutated.hindsight.enabled = true;
		expect(defaultConfig().hindsight.enabled).toBe(false);
	});

	test("enabled adopts only a boolean", () => {
		expect(mergeConfig({ hindsight: { enabled: true } }, base).hindsight.enabled).toBe(true);
		for (const enabled of ["yes", 1, null]) {
			expect(mergeConfig({ hindsight: { enabled } }, mergeConfig({ hindsight: { enabled: true } }, base)).hindsight.enabled).toBe(true);
		}
	});

	test("url is trimmed and kept as written, so the resolver can report a bad one", () => {
		expect(mergeConfig({ hindsight: { url: "  http://10.0.0.5:8888/  " } }, base).hindsight.url).toBe("http://10.0.0.5:8888/");
		expect(mergeConfig({ hindsight: { url: "not a url" } }, base).hindsight.url).toBe("not a url");
		const set = mergeConfig({ hindsight: { url: "http://hs.lan" } }, base);
		for (const url of ["", "   ", 5, null]) expect(mergeConfig({ hindsight: { url } }, set).hindsight.url).toBe("http://hs.lan");
	});

	test("bank must be a safe identifier of at most 64 characters", () => {
		expect(mergeConfig({ hindsight: { bank: "team.a-1_b" } }, base).hindsight.bank).toBe("team.a-1_b");
		expect(mergeConfig({ hindsight: { bank: "a".repeat(64) } }, base).hindsight.bank).toBe("a".repeat(64));
		for (const bank of ["a".repeat(65), "-lead", "has space", "a/b", "", 3]) {
			expect(mergeConfig({ hindsight: { bank } }, base).hindsight.bank).toBe("ultrathink");
		}
	});

	test("timeouts are positive integers of at most 120000", () => {
		expect(mergeConfig({ hindsight: { timeoutMs: 1, retainTimeoutMs: 120_000 } }, base).hindsight).toMatchObject({
			timeoutMs: 1,
			retainTimeoutMs: 120_000,
		});
		for (const value of [0, -5, 1.5, 120_001, "9", Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(mergeConfig({ hindsight: { timeoutMs: value, retainTimeoutMs: value } }, base).hindsight).toMatchObject({
				timeoutMs: 5_000,
				retainTimeoutMs: 15_000,
			});
		}
	});

	test("unknown keys are ignored and a non-object section changes nothing", () => {
		expect(mergeConfig({ hindsight: { apiKey: "secret", extra: 1 } }, base).hindsight).toEqual(base.hindsight);
		expect(mergeConfig({ hindsight: "on" }, base).hindsight).toEqual(base.hindsight);
	});

	test("user and Claude layers stack, the later one winning per key", () => {
		const config = loadLayerFiles(roots, { hindsight: { enabled: true, url: "http://a.lan", bank: "one" } }, { hindsight: { bank: "two" } });
		expect(config.hindsight).toMatchObject({ enabled: true, url: "http://a.lan", bank: "two" });
	});

	test("a project file cannot turn it on or change the url, bank or timeouts", () => {
		const config = loadLayerFiles(roots, undefined, undefined, {
			hindsight: { enabled: true, url: "https://evil.example", bank: "evil", timeoutMs: 10, retainTimeoutMs: 10 },
		});
		expect(config.hindsight).toEqual(base.hindsight);
		expect(JSON.stringify(config)).not.toContain("evil");
	});

	test("a project file can turn it off but keeps the user's url and bank", () => {
		const user = { hindsight: { enabled: true, url: "http://hs.lan", bank: "mine" } };
		expect(loadLayerFiles(roots, user, undefined, { hindsight: { enabled: false, url: "https://evil.example" } }).hindsight).toEqual({
			...base.hindsight,
			enabled: false,
			url: "http://hs.lan",
			bank: "mine",
		});
		expect(loadLayerFiles(roots, user, undefined, { hindsight: { enabled: true, bank: "evil" } }).hindsight).toMatchObject({
			enabled: true,
			bank: "mine",
		});
	});

	test("a project file cannot supply a key or retarget a user URL and bank", () => {
		const user = { hindsight: { enabled: true, url: "https://hs.example.test", bank: "mine" } };
		const config = loadLayerFiles(roots, user, undefined, {
			hindsight: { enabled: true, url: "https://evil.example", bank: "evil", apiKey: "evil-key", api_key: "evil-key" },
		});
		expect(config.hindsight).toMatchObject({ enabled: true, url: "https://hs.example.test", bank: "mine" });
		expect(config.hindsight).not.toHaveProperty("apiKey");
		expect(config.hindsight).not.toHaveProperty("api_key");
		expect(JSON.stringify(config)).not.toContain("evil");
	});
});

describe("ragflow config", () => {
	const base = defaultConfig();
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	test("defaults are off with no URL, and each defaultConfig() owns its dataset list", () => {
		expect(base.ragflow).toEqual({
			enabled: false,
			url: "",
			datasetIds: [],
			topK: 5,
			similarityThreshold: 0.2,
			timeoutMs: 8_000,
			ground: false,
			groundChars: 3_000,
		});
		defaultConfig().ragflow.datasetIds.push("x");
		expect(defaultConfig().ragflow.datasetIds).toEqual([]);
	});

	test("enabled and ground adopt only booleans", () => {
		const on = mergeConfig({ ragflow: { enabled: true, ground: true } }, base);
		expect(on.ragflow).toMatchObject({ enabled: true, ground: true });
		for (const value of ["yes", 1, null]) {
			expect(mergeConfig({ ragflow: { enabled: value, ground: value } }, on).ragflow).toMatchObject({ enabled: true, ground: true });
		}
	});

	test("url is trimmed and kept as written; blank or non-string keeps the earlier value", () => {
		const set = mergeConfig({ ragflow: { url: " https://rag.lan/ " } }, base);
		expect(set.ragflow.url).toBe("https://rag.lan/");
		for (const url of ["", "  ", 7]) expect(mergeConfig({ ragflow: { url } }, set).ragflow.url).toBe("https://rag.lan/");
		expect(mergeConfig({ ragflow: { url: "ftp//bad" } }, base).ragflow.url).toBe("ftp//bad");
	});

	test("datasetIds are trimmed and deduplicated, at most 20, strings only", () => {
		expect(mergeConfig({ ragflow: { datasetIds: [" a ", "b", "a"] } }, base).ragflow.datasetIds).toEqual(["a", "b"]);
		const twenty = Array.from({ length: 20 }, (_, i) => `d${i}`);
		expect(mergeConfig({ ragflow: { datasetIds: twenty } }, base).ragflow.datasetIds).toEqual(twenty);
		const set = mergeConfig({ ragflow: { datasetIds: ["keep"] } }, base);
		for (const datasetIds of [[...twenty, "d20"], ["ok", ""], ["ok", "  "], ["ok", 3], "a", null]) {
			expect(mergeConfig({ ragflow: { datasetIds } }, set).ragflow.datasetIds).toEqual(["keep"]);
		}
		expect(mergeConfig({ ragflow: { datasetIds: [] } }, set).ragflow.datasetIds).toEqual([]);
	});

	test("topK, similarityThreshold, timeoutMs and groundChars enforce their ranges", () => {
		expect(
			mergeConfig({ ragflow: { topK: 20, similarityThreshold: 1, timeoutMs: 120_000, groundChars: 8_000 } }, base).ragflow,
		).toMatchObject({ topK: 20, similarityThreshold: 1, timeoutMs: 120_000, groundChars: 8_000 });
		expect(
			mergeConfig({ ragflow: { topK: 1, similarityThreshold: 0, timeoutMs: 1, groundChars: 500 } }, base).ragflow,
		).toMatchObject({ topK: 1, similarityThreshold: 0, timeoutMs: 1, groundChars: 500 });
		for (const bad of [{ topK: 0 }, { topK: 21 }, { topK: 2.5 }, { topK: "3" }]) expect(mergeConfig({ ragflow: bad }, base).ragflow.topK).toBe(5);
		for (const similarityThreshold of [-0.1, 1.1, "0.5", Number.NaN]) {
			expect(mergeConfig({ ragflow: { similarityThreshold } }, base).ragflow.similarityThreshold).toBe(0.2);
		}
		for (const timeoutMs of [0, -1, 120_001, 1.5, "5"]) expect(mergeConfig({ ragflow: { timeoutMs } }, base).ragflow.timeoutMs).toBe(8_000);
		for (const groundChars of [499, 8_001, 1000.5, "900"]) expect(mergeConfig({ ragflow: { groundChars } }, base).ragflow.groundChars).toBe(3_000);
	});

	test("user and Claude layers stack, the later one winning per key", () => {
		const config = loadLayerFiles(roots, { ragflow: { enabled: true, topK: 3, url: "http://a.lan" } }, { ragflow: { topK: 7 } });
		expect(config.ragflow).toMatchObject({ enabled: true, topK: 7, url: "http://a.lan" });
	});

	test("a project file cannot turn anything on or set the url, datasets or tuning", () => {
		const config = loadLayerFiles(roots, undefined, undefined, {
			ragflow: { enabled: true, ground: true, url: "https://evil.example", datasetIds: ["evil"], topK: 1, timeoutMs: 10, groundChars: 900 },
		});
		expect(config.ragflow).toEqual(base.ragflow);
		expect(JSON.stringify(config)).not.toContain("evil");
	});

	test("a project file can turn enabled and ground off but nothing else changes", () => {
		const user = { ragflow: { enabled: true, ground: true, url: "http://rag.lan", datasetIds: ["mine"], topK: 9 } };
		expect(loadLayerFiles(roots, user, undefined, { ragflow: { ground: false, url: "https://evil.example", topK: 1 } }).ragflow).toMatchObject({
			enabled: true,
			ground: false,
			url: "http://rag.lan",
			datasetIds: ["mine"],
			topK: 9,
		});
		expect(loadLayerFiles(roots, user, undefined, { ragflow: { enabled: false } }).ragflow).toMatchObject({ enabled: false, ground: true });
		expect(loadLayerFiles(roots, { ragflow: { enabled: true } }, undefined, { ragflow: { ground: true } }).ragflow.ground).toBe(false);
	});

	test("a project file cannot supply a key or replace the user URL and datasets", () => {
		const user = { ragflow: { enabled: true, ground: true, url: "https://rag.example.test", datasetIds: ["mine"] } };
		const config = loadLayerFiles(roots, user, undefined, {
			ragflow: { enabled: true, ground: true, url: "https://evil.example", datasetIds: ["evil"], apiKey: "evil-key" },
		});
		expect(config.ragflow).toMatchObject({ enabled: true, ground: true, url: "https://rag.example.test", datasetIds: ["mine"] });
		expect(config.ragflow).not.toHaveProperty("apiKey");
		expect(JSON.stringify(config)).not.toContain("evil");
	});
});

describe("teach config", () => {
	const base = defaultConfig();
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	test("defaults are on, auto capture with auto-promote, and each defaultConfig() is independent", () => {
		expect(base.teach).toEqual({
			enabled: true,
			capture: "auto",
			recall: true,
			recallLimit: 5,
			recallChars: 3_000,
			promoteAfter: 3,
			autoPromote: true,
			observeMinToolCalls: 4,
			timeoutMs: 2_500,
		});
		defaultConfig().teach.enabled = false;
		expect(defaultConfig().teach.enabled).toBe(true);
	});

	test("booleans adopt only booleans", () => {
		const on = mergeConfig({ teach: { enabled: true, recall: false, autoPromote: true } }, base);
		expect(on.teach).toMatchObject({ enabled: true, recall: false, autoPromote: true });
		for (const value of ["yes", 1, null]) {
			expect(mergeConfig({ teach: { enabled: value, recall: value, autoPromote: value } }, on).teach).toMatchObject({
				enabled: true,
				recall: false,
				autoPromote: true,
			});
		}
	});

	test("capture accepts only the three modes", () => {
		for (const capture of ["explicit", "observe", "auto"] as const) expect(mergeConfig({ teach: { capture } }, base).teach.capture).toBe(capture);
		const observe = mergeConfig({ teach: { capture: "observe" } }, base);
		for (const capture of ["Auto", "always", "", 2, null]) expect(mergeConfig({ teach: { capture } }, observe).teach.capture).toBe("observe");
	});

	test("numeric keys enforce their ranges and integers", () => {
		expect(
			mergeConfig(
				{ teach: { recallLimit: 10, recallChars: 8_000, promoteAfter: 20, observeMinToolCalls: 50, timeoutMs: 30_000 } },
				base,
			).teach,
		).toMatchObject({ recallLimit: 10, recallChars: 8_000, promoteAfter: 20, observeMinToolCalls: 50, timeoutMs: 30_000 });
		expect(
			mergeConfig({ teach: { recallLimit: 1, recallChars: 500, promoteAfter: 2, observeMinToolCalls: 0, timeoutMs: 500 } }, base).teach,
		).toMatchObject({ recallLimit: 1, recallChars: 500, promoteAfter: 2, observeMinToolCalls: 0, timeoutMs: 500 });
		for (const recallLimit of [0, 11, 2.5, "3"]) expect(mergeConfig({ teach: { recallLimit } }, base).teach.recallLimit).toBe(5);
		for (const recallChars of [499, 8_001, 600.5]) expect(mergeConfig({ teach: { recallChars } }, base).teach.recallChars).toBe(3_000);
		for (const promoteAfter of [1, 21, 3.5, Number.NaN]) expect(mergeConfig({ teach: { promoteAfter } }, base).teach.promoteAfter).toBe(3);
		for (const observeMinToolCalls of [-1, 51, 1.5, "2"]) {
			expect(mergeConfig({ teach: { observeMinToolCalls } }, base).teach.observeMinToolCalls).toBe(4);
		}
		for (const timeoutMs of [499, 30_001, 900.5, Number.POSITIVE_INFINITY]) expect(mergeConfig({ teach: { timeoutMs } }, base).teach.timeoutMs).toBe(2_500);
	});

	test("unknown keys are ignored and a non-object section changes nothing", () => {
		expect(mergeConfig({ teach: { mode: "auto", url: "https://x.example" } }, base).teach).toEqual(base.teach);
		expect(mergeConfig({ teach: true }, base).teach).toEqual(base.teach);
	});

	test("user and Claude layers stack, the later one winning per key", () => {
		const config = loadLayerFiles(roots, { teach: { enabled: true, capture: "auto", recallLimit: 3 } }, { teach: { capture: "observe" } });
		expect(config.teach).toMatchObject({ enabled: true, capture: "observe", recallLimit: 3 });
	});

	test("a project file cannot turn anything on, raise the mode or tune a number", () => {
		const config = loadLayerFiles(roots, undefined, undefined, {
			teach: { enabled: true, capture: "auto", recall: true, autoPromote: true, recallLimit: 1, promoteAfter: 2, timeoutMs: 600 },
		});
		expect(config.teach).toEqual(base.teach);
	});

	test("a project file cannot raise capture above the user's level", () => {
		const user = { teach: { enabled: true, capture: "observe" } };
		expect(loadLayerFiles(roots, user, undefined, { teach: { capture: "auto" } }).teach.capture).toBe("observe");
		expect(loadLayerFiles(roots, user, undefined, { teach: { capture: "observe" } }).teach.capture).toBe("observe");
	});

	test("a project file can lower capture auto -> observe -> explicit", () => {
		const auto = { teach: { enabled: true, capture: "auto" } };
		expect(loadLayerFiles(roots, auto, undefined, { teach: { capture: "observe" } }).teach.capture).toBe("observe");
		expect(loadLayerFiles(roots, auto, undefined, { teach: { capture: "explicit" } }).teach.capture).toBe("explicit");
		expect(loadLayerFiles(roots, auto, undefined, { teach: { capture: "bogus" } }).teach.capture).toBe("auto");
	});

	test("a project file can turn enabled, recall and autoPromote off, never on", () => {
		const user = { teach: { enabled: true, recall: true, autoPromote: true, recallLimit: 8 } };
		expect(
			loadLayerFiles(roots, user, undefined, { teach: { enabled: false, recall: false, autoPromote: false, recallLimit: 1 } }).teach,
		).toMatchObject({ enabled: false, recall: false, autoPromote: false, recallLimit: 8 });
		const off = { teach: { enabled: true, recall: false, autoPromote: false } };
		expect(loadLayerFiles(roots, off, undefined, { teach: { recall: true, autoPromote: true } }).teach).toMatchObject({
			recall: false,
			autoPromote: false,
		});
	});

	test("a user file combined with a project file that turns things off keeps the rest", () => {
		const config = loadLayerFiles(
			roots,
			{ hindsight: { enabled: true, url: "http://hs.lan" }, teach: { enabled: true, capture: "auto", recall: true } },
			undefined,
			{ hindsight: { enabled: false }, teach: { capture: "explicit", recall: false } },
		);
		expect(config.hindsight).toMatchObject({ enabled: false, url: "http://hs.lan" });
		expect(config.teach).toMatchObject({ enabled: true, capture: "explicit", recall: false });
	});
});

describe("route defaults (AD-1)", () => {
	test("ROUTE_DEFAULT_MODELS holds exactly three nonblank frozen entries, referenced by the three config defaults", () => {
		expect(Object.isFrozen(ROUTE_DEFAULT_MODELS)).toBe(true);
		expect(ROUTE_DEFAULT_MODELS).toEqual({ claude: "sonnet", grok: "grok-4.7", muse: "muse-spark-1.3-contributor" });
		for (const model of Object.values(ROUTE_DEFAULT_MODELS)) expect(model.trim()).toBe(model);
		expect(DEFAULT_CLAUDE_CONFIG.model).toBe(ROUTE_DEFAULT_MODELS.claude);
		expect(DEFAULT_GROK_CONFIG.model).toBe(ROUTE_DEFAULT_MODELS.grok);
		expect(MUSE_MODEL_DEFAULT).toBe(ROUTE_DEFAULT_MODELS.muse);
		expect(DEFAULT_MUSE_CONFIG.model).toBe(MUSE_MODEL_DEFAULT);
		const config = defaultConfig();
		expect([config.claude.model, config.grok.model, config.muse.model]).toEqual(["sonnet", "grok-4.7", "muse-spark-1.3-contributor"]);
		expect(config.modelProvenance).toEqual({ claude: "route-default", grok: "route-default", muse: "route-default" });
	});

	test("the map cannot be changed at runtime", () => {
		expect(() => {
			(ROUTE_DEFAULT_MODELS as Record<string, string>).claude = "other";
		}).toThrow();
		expect(ROUTE_DEFAULT_MODELS.claude).toBe("sonnet");
	});

	test("no planning-model selection source outside src/route-defaults.ts spells a route-default model (AC-15-016)", () => {
		const selection = ["config.ts", "host/engine.ts", "grok/types.ts", "grok/label.ts", "grok/complete.ts", "muse/types.ts", "muse/complete.ts", "claude/complete.ts"];
		for (const rel of selection) {
			const source = readFileSync(join(import.meta.dir, rel), "utf8");
			const spelled = Object.values(ROUTE_DEFAULT_MODELS).filter((model) => source.includes(model));
			expect({ rel, spelled }).toEqual({ rel, spelled: [] });
		}
	});
});

describe("models config (D-05 merge truth table)", () => {
	const base = defaultConfig();

	test("the built-in value is empty hosts and a prototype-free empty providerDefaults", () => {
		expect(base.models.hosts).toEqual({});
		expect(Object.keys(base.models.providerDefaults)).toEqual([]);
		expect(Object.getPrototypeOf(base.models.providerDefaults)).toBeNull();
	});

	test("nonblank strings trim surrounding whitespace only, keep case, slashes and punctuation, and the later layer wins", () => {
		const user = mergeConfig(
			{ models: { hosts: { omp: { provider: " openai-codex ", model: " OpenRouter/Anthropic/Claude-X:beta " } }, providerDefaults: { xai: " Grok-Fast " } } },
			base,
		);
		expect(user.models.hosts.omp).toEqual({ provider: "openai-codex", model: "OpenRouter/Anthropic/Claude-X:beta" });
		expect(user.models.providerDefaults.xai).toBe("Grok-Fast");
		const later = mergeConfig({ models: { hosts: { omp: { model: "smol" } }, providerDefaults: { xai: "grok-fast-2" } } }, user);
		expect(later.models.hosts.omp).toEqual({ provider: "openai-codex", model: "smol" });
		expect(later.models.providerDefaults.xai).toBe("grok-fast-2");
		expect(user.models.providerDefaults.xai).toBe("Grok-Fast");
	});

	test("absent, null, non-object, array and nonstring values preserve the lower value; empty sections merge nothing", () => {
		const lower = mergeConfig({ models: { hosts: { omp: { provider: "xai", model: "grok-x" } }, providerDefaults: { xai: "fast" } } }, base);
		const cases: unknown[] = [
			undefined,
			null,
			"x",
			42,
			[],
			{ hosts: null, providerDefaults: [] },
			{ hosts: { omp: null } },
			{ hosts: { omp: { provider: 7, model: false } } },
			{ providerDefaults: { xai: 1 } },
			{ hosts: {}, providerDefaults: {} },
		];
		for (const models of cases) {
			const merged = mergeConfig({ models }, lower);
			expect(merged.models.hosts).toEqual(lower.models.hosts);
			expect({ ...merged.models.providerDefaults }).toEqual({ xai: "fast" });
		}
	});

	test("a blank host model or provider clears that lower value without revealing it", () => {
		const lower = mergeConfig({ models: { hosts: { omp: { provider: "xai", model: "grok-x" }, hermes: { model: "h" } } } }, base);
		const cleared = mergeConfig({ models: { hosts: { omp: { model: "  " } } } }, lower);
		expect(cleared.models.hosts.omp).toEqual({ provider: "xai", model: "" });
		expect(cleared.models.hosts.hermes).toEqual({ provider: "", model: "h" });
		expect(mergeConfig({ models: { hosts: { omp: { provider: "\t" } } } }, cleared).models.hosts.omp).toEqual({ provider: "", model: "" });
		expect(JSON.stringify(mergeConfig({ models: { hosts: { omp: { provider: "", model: "" } } } }, lower).models)).not.toContain("grok-x");
	});

	test("a blank provider default removes the lower selector, exposing the host-catalog tier", () => {
		const lower = mergeConfig({ models: { providerDefaults: { xai: "fast", openai: "gpt-x" } } }, base);
		const merged = mergeConfig({ models: { providerDefaults: { xai: " " } } }, lower);
		expect(Object.hasOwn(merged.models.providerDefaults, "xai")).toBe(false);
		expect(merged.models.providerDefaults.openai).toBe("gpt-x");
		expect(lower.models.providerDefaults.xai).toBe("fast");
	});

	test("unknown host keys are ignored and register no host", () => {
		const merged = mergeConfig({ models: { hosts: { "grok-bot": { model: "x" }, "gpt-dot": { provider: "openai" }, omp: { model: "m" } } } }, base);
		expect(Object.keys(merged.models.hosts)).toEqual(["omp"]);
	});

	test("__proto__, constructor and prototype keys are never merged and no mapping is inherited (T-15-01)", () => {
		const file = JSON.parse(
			'{"models":{"providerDefaults":{"__proto__":{"polluted":"yes"},"constructor":"evil","prototype":"evil","xai":"fast"},"hosts":{"__proto__":{"model":"evil"}}}}',
		) as Record<string, unknown>;
		const merged = mergeConfig(file, base);
		const defaults = merged.models.providerDefaults;
		expect(Object.keys(defaults)).toEqual(["xai"]);
		expect(Object.getPrototypeOf(defaults)).toBeNull();
		for (const key of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) expect(Object.hasOwn(defaults, key)).toBe(false);
		expect(defaults.constructor).toBeUndefined();
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.keys(merged.models.hosts)).toEqual([]);
		expect(Object.getPrototypeOf(merged.models.hosts)).toBe(Object.prototype);
		expect(JSON.stringify(merged.models)).not.toContain("evil");
	});

	test("a selector carrying a control character is kept as written for resolution to diagnose; all-whitespace is still a blank", () => {
		const merged = mergeConfig({ models: { hosts: { omp: { model: "\u0000smol", provider: "xai\n" } }, providerDefaults: { xai: " fast\u001b " } } }, base);
		expect(merged.models.hosts.omp).toEqual({ provider: "xai\n", model: "\u0000smol" });
		expect(merged.models.providerDefaults.xai).toBe(" fast\u001b ");
		expect(hasControlCharacter(merged.models.hosts.omp?.model ?? "")).toBe(true);
		expect(hasControlCharacter("openrouter/anthropic/claude-x:beta")).toBe(false);
		expect(mergeConfig({ models: { hosts: { omp: { model: "\n\t " } } } }, merged).models.hosts.omp?.model).toBe("");
	});

	test("every layer, the project file included, may set model selectors", () => {
		const roots: string[] = [];
		try {
			const config = loadLayerFiles(
				roots,
				{ models: { hosts: { omp: { provider: "xai" } }, providerDefaults: { xai: "user-fast" } } },
				{ models: { providerDefaults: { openai: "claude-home" } } },
				{ models: { hosts: { omp: { model: "project-model" } }, providerDefaults: { xai: "project-fast" } } },
			);
			expect(config.models.hosts.omp).toEqual({ provider: "xai", model: "project-model" });
			expect({ ...config.models.providerDefaults }).toEqual({ xai: "project-fast", openai: "claude-home" });
		} finally {
			for (const root of roots) rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("legacy model provenance (AD-1)", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	test("unset at every layer is the route default; a nonblank file value is a pin, even one equal to the route default", () => {
		expect(loadLayerFiles(roots, { uplift: { enabled: true } }).modelProvenance).toEqual({
			claude: "route-default",
			grok: "route-default",
			muse: "route-default",
		});
		const pinned = loadLayerFiles(roots, { claude: { model: "sonnet" } }, { grok: { model: " grok-4.7 " } }, { muse: { model: "muse-spark-1.3-contributor" } });
		expect(pinned.modelProvenance).toEqual({ claude: "file-pin", grok: "file-pin", muse: "file-pin" });
		expect([pinned.claude.model, pinned.grok.model, pinned.muse.model]).toEqual(["sonnet", "grok-4.7", "muse-spark-1.3-contributor"]);
	});

	test("an explicit blank claude.model or muse.model clears a lower pin to CLI omission; Grok's non-empty merge ignores blanks", () => {
		const config = loadLayerFiles(
			roots,
			{ claude: { model: "opus" }, grok: { model: "grok-x", shuntModel: "alias" }, muse: { model: "m" } },
			{ claude: { model: " " }, grok: { model: "", shuntModel: "  " }, muse: { model: "" } },
		);
		expect([config.claude.model, config.grok.model, config.grok.shuntModel, config.muse.model]).toEqual(["", "grok-x", "alias", ""]);
		expect(config.modelProvenance).toEqual({ claude: "explicit-blank", grok: "file-pin", muse: "explicit-blank" });
		const repinned = loadLayerFiles(roots, { claude: { model: "" } }, undefined, { claude: { model: "haiku" } });
		expect(repinned.claude.model).toBe("haiku");
		expect(repinned.modelProvenance.claude).toBe("file-pin");
	});

	test("wrong types keep the lower value and its provenance", () => {
		const config = loadLayerFiles(roots, { claude: { model: "opus" } }, { claude: { model: 7 }, muse: "bogus", grok: { model: null } });
		expect(config.claude.model).toBe("opus");
		expect(config.grok.model).toBe(ROUTE_DEFAULT_MODELS.grok);
		expect(config.modelProvenance).toEqual({ claude: "file-pin", grok: "route-default", muse: "route-default" });
	});

	test("grok.fallbackToClaude keeps its default false and boolean-only merge", () => {
		expect(defaultConfig().grok.fallbackToClaude).toBe(false);
		expect(loadLayerFiles(roots, { grok: { fallbackToClaude: true } }).grok.fallbackToClaude).toBe(true);
		expect(loadLayerFiles(roots, { grok: { fallbackToClaude: true } }, { grok: { fallbackToClaude: "no" } }).grok.fallbackToClaude).toBe(true);
	});
});
