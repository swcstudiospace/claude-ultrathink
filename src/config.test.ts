// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPaths, defaultConfig, loadConfig, mergeConfig, userConfigPath } from "./config.ts";

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

	test("user, then Claude home, then project, in that order", () => {
		expect(claudeConfigPaths("/repo", { XDG_CONFIG_HOME: "/xdg", CLAUDE_CONFIG_DIR: "/home/.claude" })).toEqual([
			"/xdg/ultrathink/config.json",
			"/home/.claude/ultrathink.json",
			"/repo/.claude/ultrathink.json",
		]);
		expect(claudeConfigPaths("/repo", {})[1]).toBe(join(homedir(), ".claude", "ultrathink.json"));
	});

	test("the project file overrides ~/.claude, which overrides the user config", () => {
		const root = mkdtempSync(join(tmpdir(), "ultrathink-paths-"));
		const env = { XDG_CONFIG_HOME: join(root, "xdg"), CLAUDE_CONFIG_DIR: join(root, "claude") };
		const [user, claude, project] = claudeConfigPaths(join(root, "repo"), env) as [string, string, string];
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
