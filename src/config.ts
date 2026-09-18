import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GROK_CONFIG, GROK_EFFORTS, type GrokConfig, type GrokEffort } from "./grok/types.ts";
import { DEFAULT_HITL_CONFIG, type HitlConfig } from "./hitl/types.ts";
import { MAX_NODES, MIN_NODES, type ThinkConfig } from "./think/types.ts";

export interface ClaudeConfig {
	/** `claude` binary used for headless completions. */
	bin: string;
	/** Model alias/name for the uplift and thinking calls; empty inherits the user default. */
	model: string;
	/** Allow extended thinking in child calls (slower). */
	thinking: boolean;
	/** `--setting-sources` for child calls; empty loads none (fastest, no nested hooks). */
	settingSources: string;
	/** Per-call timeout for one headless completion. 0 = no timer. */
	callTimeoutMs: number;
	/** Whole-hook budget in ms. 0 = run until the host hook timeout. */
	budgetMs: number;
	/** Parallel Chain-of-Thought fills per dependency level. */
	concurrency: number;
	/** Print a one-line summary to the user after each uplift. */
	echo: boolean;
}

/**
 * Claude Code UserPromptSubmit timeout in seconds (`hooks/hooks.json`).
 * The host discards hook stdout if we exceed this. 0 is not unlimited there —
 * Claude Code would fall back to the 30s UserPromptSubmit default.
 */
export const CLAUDE_USER_PROMPT_HOOK_TIMEOUT_SEC = 86_400;

export const DEFAULT_CLAUDE_CONFIG: ClaudeConfig = {
	bin: "claude",
	model: "sonnet",
	thinking: false,
	settingSources: "",
	callTimeoutMs: 0,
	budgetMs: 0,
	concurrency: 3,
	echo: true,
};

export interface NotionConfig {
	/** Data source URL for the "Agent Task Graph" database (`collection://<id>`). */
	dataSourceUrl: string;
}

export const DEFAULT_NOTION_CONFIG: NotionConfig = {
	dataSourceUrl: "collection://be3418f0-d2d8-411b-8677-fa8a95ee63be",
};

export interface LinearConfig {
	/** Linear team name that Issues/Sub-Issues are created under. */
	team: string;
}

export const DEFAULT_LINEAR_CONFIG: LinearConfig = {
	team: "Spectrum Web Co",
};

export interface UltrathinkConfig {
	uplift: { enabled: boolean; skipTrivial: boolean; maxChars: number; echo: boolean };
	claude: ClaudeConfig;
	grok: GrokConfig;
	hitl: HitlConfig;
	think: ThinkConfig;
	notion: NotionConfig;
	linear: LinearConfig;
}

export function defaultConfig(): UltrathinkConfig {
	return {
		uplift: {
			enabled: true,
			skipTrivial: true,
			maxChars: 20000,
			echo: true,
		},
		think: {
			enabled: true,
			minNodes: MIN_NODES,
			maxNodes: MAX_NODES,
			engine: "claude",
		},
		claude: { ...DEFAULT_CLAUDE_CONFIG },
		grok: { ...DEFAULT_GROK_CONFIG },
		hitl: { ...DEFAULT_HITL_CONFIG },
		notion: { ...DEFAULT_NOTION_CONFIG },
		linear: { ...DEFAULT_LINEAR_CONFIG },
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function readJson(path: string): unknown {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function mergeUplift(
	uplift: Record<string, unknown> | undefined,
	defaults: UltrathinkConfig["uplift"],
): UltrathinkConfig["uplift"] {
	if (!uplift) return defaults;
	return {
		enabled: typeof uplift.enabled === "boolean" ? uplift.enabled : defaults.enabled,
		skipTrivial: typeof uplift.skipTrivial === "boolean" ? uplift.skipTrivial : defaults.skipTrivial,
		maxChars:
			typeof uplift.maxChars === "number" && Number.isFinite(uplift.maxChars) && uplift.maxChars >= 0
				? uplift.maxChars
				: defaults.maxChars,
		echo: typeof uplift.echo === "boolean" ? uplift.echo : defaults.echo,
	};
}

function mergeThink(think: Record<string, unknown> | undefined, defaults: ThinkConfig): ThinkConfig {
	if (!think) return defaults;
	const minNodes =
		typeof think.minNodes === "number" && Number.isInteger(think.minNodes) && think.minNodes >= 1
			? think.minNodes
			: defaults.minNodes;
	const maxNodes =
		typeof think.maxNodes === "number" && Number.isInteger(think.maxNodes) && think.maxNodes >= minNodes
			? Math.min(think.maxNodes, MAX_NODES)
			: defaults.maxNodes;
	return {
		enabled: typeof think.enabled === "boolean" ? think.enabled : defaults.enabled,
		minNodes: Math.min(minNodes, maxNodes),
		maxNodes,
		engine: think.engine === "grok" || think.engine === "claude" ? think.engine : defaults.engine,
	};
}

function nonNegativeMs(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function mergeClaude(claude: Record<string, unknown> | undefined, defaults: ClaudeConfig): ClaudeConfig {
	if (!claude) return defaults;
	const positive = (value: unknown, fallback: number): number =>
		typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
	return {
		bin: typeof claude.bin === "string" && claude.bin.trim() ? claude.bin.trim() : defaults.bin,
		model: typeof claude.model === "string" ? claude.model.trim() : defaults.model,
		thinking: typeof claude.thinking === "boolean" ? claude.thinking : defaults.thinking,
		settingSources: typeof claude.settingSources === "string" ? claude.settingSources.trim() : defaults.settingSources,
		callTimeoutMs: nonNegativeMs(claude.callTimeoutMs, defaults.callTimeoutMs),
		budgetMs: nonNegativeMs(claude.budgetMs, defaults.budgetMs),
		concurrency: Math.max(1, Math.floor(positive(claude.concurrency, defaults.concurrency))),
		echo: typeof claude.echo === "boolean" ? claude.echo : defaults.echo,
	};
}

function nonEmpty(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function mergeGrok(grok: Record<string, unknown> | undefined, defaults: GrokConfig): GrokConfig {
	if (!grok) return defaults;
	return {
		enabled: typeof grok.enabled === "boolean" ? grok.enabled : defaults.enabled,
		baseUrl: nonEmpty(grok.baseUrl, defaults.baseUrl).replace(/\/+$/, "") || defaults.baseUrl,
		model: nonEmpty(grok.model, defaults.model),
		reasoningEffort: GROK_EFFORTS.includes(grok.reasoningEffort as GrokEffort)
			? (grok.reasoningEffort as GrokEffort)
			: defaults.reasoningEffort,
		transport: grok.transport === "http" || grok.transport === "cli" ? grok.transport : defaults.transport,
		bin: nonEmpty(grok.bin, defaults.bin),
		home: typeof grok.home === "string" ? grok.home.trim() : defaults.home,
		callTimeoutMs: nonNegativeMs(grok.callTimeoutMs, defaults.callTimeoutMs),
		fallbackToClaude: typeof grok.fallbackToClaude === "boolean" ? grok.fallbackToClaude : defaults.fallbackToClaude,
	};
}

function mergeHitl(hitl: Record<string, unknown> | undefined, defaults: HitlConfig): HitlConfig {
	if (!hitl) return defaults;
	return {
		enabled: typeof hitl.enabled === "boolean" ? hitl.enabled : defaults.enabled,
		maxQuestions:
			typeof hitl.maxQuestions === "number" &&
			Number.isInteger(hitl.maxQuestions) &&
			hitl.maxQuestions >= 1 &&
			hitl.maxQuestions <= 4
				? hitl.maxQuestions
				: defaults.maxQuestions,
	};
}

function mergeNotion(notion: Record<string, unknown> | undefined, defaults: NotionConfig): NotionConfig {
	if (!notion) return defaults;
	return { dataSourceUrl: nonEmpty(notion.dataSourceUrl, defaults.dataSourceUrl) };
}

function mergeLinear(linear: Record<string, unknown> | undefined, defaults: LinearConfig): LinearConfig {
	if (!linear) return defaults;
	return { team: nonEmpty(linear.team, defaults.team) };
}

export function mergeConfig(file: Record<string, unknown> | undefined, base: UltrathinkConfig): UltrathinkConfig {
	if (!file) return base;
	return {
		uplift: mergeUplift(asRecord(file.uplift), base.uplift),
		claude: mergeClaude(asRecord(file.claude), base.claude),
		grok: mergeGrok(asRecord(file.grok), base.grok),
		hitl: mergeHitl(asRecord(file.hitl), base.hitl),
		think: mergeThink(asRecord(file.think), base.think),
		notion: mergeNotion(asRecord(file.notion), base.notion),
		linear: mergeLinear(asRecord(file.linear), base.linear),
	};
}

/** Config files for ultrathink, lowest precedence first — later files win. */
export function claudeConfigPaths(cwd: string, env: Record<string, string | undefined> = process.env): string[] {
	const home = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
	return [join(home, "ultrathink.json"), join(cwd, ".claude", "ultrathink.json")];
}

/** Loads config from `files` in order (later files win); defaults when none override. */
export function loadConfig(files: string[]): UltrathinkConfig {
	let config = defaultConfig();
	for (const file of files) {
		config = mergeConfig(asRecord(readJson(file)), config);
	}
	return config;
}
