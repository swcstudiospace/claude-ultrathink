import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPaths, defaultConfig, loadConfig, mergeConfig } from "./config.ts";

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

	test("points at the live Agent Task Graph data source and the Spectrum Web Co Linear team", () => {
		const config = defaultConfig();
		expect(config.notion.dataSourceUrl).toBe("collection://be3418f0-d2d8-411b-8677-fa8a95ee63be");
		expect(config.linear.team).toBe("Spectrum Web Co");
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

	test("hitl maxQuestions is clamped to 1-4", () => {
		const base = defaultConfig();
		expect(mergeConfig({ hitl: { maxQuestions: 0 } }, base).hitl.maxQuestions).toBe(base.hitl.maxQuestions);
		expect(mergeConfig({ hitl: { maxQuestions: 9 } }, base).hitl.maxQuestions).toBe(base.hitl.maxQuestions);
		expect(mergeConfig({ hitl: { maxQuestions: 2 } }, base).hitl.maxQuestions).toBe(2);
	});

	test("notion dataSourceUrl and linear team accept a non-empty override, reject an empty string", () => {
		const base = defaultConfig();
		expect(mergeConfig({ notion: { dataSourceUrl: "collection://other" } }, base).notion.dataSourceUrl).toBe("collection://other");
		expect(mergeConfig({ notion: { dataSourceUrl: "" } }, base).notion.dataSourceUrl).toBe(base.notion.dataSourceUrl);
		expect(mergeConfig({ linear: { team: "Other Team" } }, base).linear.team).toBe("Other Team");
	});
});

describe("claudeConfigPaths", () => {
	test("home then project, in that order", () => {
		const paths = claudeConfigPaths("/repo", { CLAUDE_CONFIG_DIR: "/home/.claude" });
		expect(paths).toEqual(["/home/.claude/ultrathink.json", "/repo/.claude/ultrathink.json"]);
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
