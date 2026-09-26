// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GROK_CONFIG, GROK_EFFORTS, GROK_TRANSPORTS, type GrokConfig, type GrokEffort, type GrokTransport } from "./grok/types.ts";
import { DEFAULT_HITL_CONFIG, type HitlConfig } from "./hitl/types.ts";
import { DEFAULT_SHIP_CONFIG, GREPTILE_MAX_SCORE, JUDGE_MODES, type JudgeMode, MERGE_METHODS, type ShipConfig } from "./ship/types.ts";
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
	/** Parallel node-detail fills per dependency level. */
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
	/** Data source URL for the "Agent Task Graph" database (`collection://<id>`); "" = Notion tracking not configured. */
	dataSourceUrl: string;
}

export const DEFAULT_NOTION_CONFIG: NotionConfig = {
	dataSourceUrl: "",
};

export interface LinearConfig {
	/** Linear team name that Issues/Sub-Issues are created under; "" = Linear tracking not configured. */
	team: string;
}

export const DEFAULT_LINEAR_CONFIG: LinearConfig = {
	team: "",
};

export interface TrackConfig {
	/** Create Linear/Notion rows from the hook before the agent sees the prompt. */
	enabled: boolean;
	/** Whole tracker-creation budget in ms. */
	budgetMs: number;
	/** Parallel tracker calls. */
	concurrency: number;
}

export const DEFAULT_TRACK_CONFIG: TrackConfig = {
	enabled: true,
	budgetMs: 60_000,
	concurrency: 6,
};

export interface SubstrateConfig {
	/** Agent Substrate service base URL (`POST <url>/brief`); "" = never contacted. `SUBSTRATE_URL` overrides it. */
	url: string;
}

export const DEFAULT_SUBSTRATE_CONFIG: SubstrateConfig = {
	url: "",
};

export interface UltrathinkConfig {
	uplift: { enabled: boolean; skipTrivial: boolean; maxChars: number; echo: boolean };
	claude: ClaudeConfig;
	grok: GrokConfig;
	hitl: HitlConfig;
	think: ThinkConfig;
	notion: NotionConfig;
	linear: LinearConfig;
	track: TrackConfig;
	ship: ShipConfig;
	substrate: SubstrateConfig;
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
		track: { ...DEFAULT_TRACK_CONFIG },
		ship: { ...DEFAULT_SHIP_CONFIG, skills: [...DEFAULT_SHIP_CONFIG.skills] },
		substrate: { ...DEFAULT_SUBSTRATE_CONFIG },
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
		transport: GROK_TRANSPORTS.includes(grok.transport as GrokTransport) ? (grok.transport as GrokTransport) : defaults.transport,
		bin: nonEmpty(grok.bin, defaults.bin),
		home: typeof grok.home === "string" ? grok.home.trim() : defaults.home,
		callTimeoutMs: nonNegativeMs(grok.callTimeoutMs, defaults.callTimeoutMs),
		fallbackToClaude: typeof grok.fallbackToClaude === "boolean" ? grok.fallbackToClaude : defaults.fallbackToClaude,
		shuntBaseUrl: httpUrl(grok.shuntBaseUrl, defaults.shuntBaseUrl),
		shuntModel: nonEmpty(grok.shuntModel, defaults.shuntModel),
		shuntMaxTokens:
			typeof grok.shuntMaxTokens === "number" && Number.isInteger(grok.shuntMaxTokens) && grok.shuntMaxTokens > 0
				? grok.shuntMaxTokens
				: defaults.shuntMaxTokens,
	};
}

/** A non-empty http(s) URL with trailing slashes stripped; anything else falls back. */
function httpUrl(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim().replace(/\/+$/, "");
	if (!trimmed) return fallback;
	try {
		const url = new URL(trimmed);
		return url.protocol === "http:" || url.protocol === "https:" ? trimmed : fallback;
	} catch {
		return fallback;
	}
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
		knowledgeBase: typeof hitl.knowledgeBase === "boolean" ? hitl.knowledgeBase : defaults.knowledgeBase,
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

function mergeTrack(track: Record<string, unknown> | undefined, defaults: TrackConfig): TrackConfig {
	if (!track) return defaults;
	return {
		enabled: typeof track.enabled === "boolean" ? track.enabled : defaults.enabled,
		budgetMs:
			typeof track.budgetMs === "number" && Number.isFinite(track.budgetMs) && track.budgetMs > 0
				? track.budgetMs
				: defaults.budgetMs,
		concurrency:
			typeof track.concurrency === "number" && Number.isFinite(track.concurrency) && track.concurrency >= 1
				? Math.floor(track.concurrency)
				: defaults.concurrency,
	};
}

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function mergeShip(ship: Record<string, unknown> | undefined, defaults: ShipConfig): ShipConfig {
	if (!ship) return defaults;
	const skills =
		Array.isArray(ship.skills) && ship.skills.every((s) => typeof s === "string" && s.trim())
			? (ship.skills as string[]).map((s) => s.trim())
			: defaults.skills;
	return {
		enabled: typeof ship.enabled === "boolean" ? ship.enabled : defaults.enabled,
		autoMerge: typeof ship.autoMerge === "boolean" ? ship.autoMerge : defaults.autoMerge,
		skills,
		minScore:
			typeof ship.minScore === "number" &&
			Number.isFinite(ship.minScore) &&
			ship.minScore >= 1 &&
			ship.minScore <= GREPTILE_MAX_SCORE
				? ship.minScore
				: defaults.minScore,
		requireNoComments:
			typeof ship.requireNoComments === "boolean" ? ship.requireNoComments : defaults.requireNoComments,
		maxRounds: positiveInt(ship.maxRounds, defaults.maxRounds),
		mergeMethod: MERGE_METHODS.includes(ship.mergeMethod as ShipConfig["mergeMethod"])
			? (ship.mergeMethod as ShipConfig["mergeMethod"])
			: defaults.mergeMethod,
		deleteBranch: typeof ship.deleteBranch === "boolean" ? ship.deleteBranch : defaults.deleteBranch,
		greptileOrganization:
			typeof ship.greptileOrganization === "string" ? ship.greptileOrganization.trim() : defaults.greptileOrganization,
		reviewTimeoutMs: positiveInt(ship.reviewTimeoutMs, defaults.reviewTimeoutMs),
		pollMs: positiveInt(ship.pollMs, defaults.pollMs),
		waitMs: positiveInt(ship.waitMs, defaults.waitMs),
		reviewRetries:
			typeof ship.reviewRetries === "number" && Number.isFinite(ship.reviewRetries) && ship.reviewRetries >= 0
				? Math.floor(ship.reviewRetries)
				: defaults.reviewRetries,
		mergeTimeoutMs: positiveInt(ship.mergeTimeoutMs, defaults.mergeTimeoutMs),
		judge: JUDGE_MODES.includes(ship.judge as JudgeMode) ? (ship.judge as JudgeMode) : defaults.judge,
	};
}

function mergeSubstrate(substrate: Record<string, unknown> | undefined, defaults: SubstrateConfig): SubstrateConfig {
	if (!substrate) return defaults;
	return { url: httpUrl(substrate.url, defaults.url) };
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
		track: mergeTrack(asRecord(file.track), base.track),
		ship: mergeShip(asRecord(file.ship), base.ship),
		substrate: mergeSubstrate(asRecord(file.substrate), base.substrate),
	};
}

/** Host-neutral user config: `${XDG_CONFIG_HOME || ~/.config}/ultrathink/config.json`. */
export function userConfigPath(env: Record<string, string | undefined> = process.env): string {
	return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "ultrathink", "config.json");
}

/** Config files for ultrathink, lowest precedence first — later files win: user, then Claude user, then project. */
export function claudeConfigPaths(cwd: string, env: Record<string, string | undefined> = process.env): string[] {
	const home = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
	return [userConfigPath(env), join(home, "ultrathink.json"), join(cwd, ".claude", "ultrathink.json")];
}

/** Loads config from `files` in order (later files win); defaults when none override. */
export function loadConfig(files: string[]): UltrathinkConfig {
	let config = defaultConfig();
	for (const file of files) {
		config = mergeConfig(asRecord(readJson(file)), config);
	}
	return config;
}
