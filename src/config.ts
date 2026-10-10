// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type PstackStage } from "./cursor/pstack.ts";
import { DEFAULT_GATEWAY_CONFIG, SEAT_PATTERN, type GatewayConfig } from "./gateway/types.ts";
import { DEFAULT_HINDSIGHT_CONFIG, type HindsightConfig } from "./hindsight/types.ts";
import { DEFAULT_RAGFLOW_CONFIG, type RagflowConfig } from "./ragflow/types.ts";
import { DECISION_POINTS, DECISIONS_PROVIDERS, DEFAULT_DECISIONS_CONFIG, type DecisionPoint, type DecisionsConfig, type DecisionsProvider } from "./decisions/types.ts";
import { DEFAULT_GROK_CONFIG, GROK_EFFORTS, GROK_TRANSPORTS, type GrokConfig, type GrokEffort, type GrokTransport } from "./grok/types.ts";
import { DEFAULT_HITL_CONFIG, type HitlConfig } from "./hitl/types.ts";
import { DEFAULT_SHIP_CONFIG, GREPTILE_MAX_SCORE, JUDGE_MODES, type JudgeMode, MERGE_METHODS, type ShipConfig } from "./ship/types.ts";
import { DEFAULT_MUSE_CONFIG, MUSE_EFFORTS, type MuseConfig, type MuseEffort } from "./muse/types.ts";
import { CAPTURE_MODES, DEFAULT_TEACH_CONFIG, type CaptureMode, type TeachConfig } from "./teach/types.ts";
import { MAX_NODES, MIN_NODES, THINK_ENGINES, type ThinkConfig, type ThinkEngine } from "./think/types.ts";
import { type HostId, isHostId } from "./host/types.ts";
import { type LegacyRoute, ROUTE_DEFAULT_MODELS } from "./route-defaults.ts";

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
	model: ROUTE_DEFAULT_MODELS.claude,
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
	/**
	 * Absent or `"direct"` uses `POST /brief` and `POST /events`. `"gateway"` calls the desk gateway
	 * and does not need `url`. A project file cannot set this.
	 */
	backend?: "direct" | "gateway";
}

export const DEFAULT_SUBSTRATE_CONFIG: SubstrateConfig = {
	url: "",
};

export interface StateConfig {
	/** Days a session record is kept before the scheduled prune may remove it; 0 = keep forever. User files only. */
	retentionDays: number;
}

export const DEFAULT_STATE_CONFIG: StateConfig = {
	retentionDays: 0,
};

/** Stages a user mapping may remap: every pstack stage except `orchestrate`, the router that carries all moments. */
type PstackMappingStage = Exclude<PstackStage, "orchestrate">;

/**
 * Cursor pstack bridge (`src/cursor/pstack.ts`): `/gsd-*` slash commands detected in Cursor's beforeSubmitPrompt
 * hook. Opt-in and user-only — every key comes from user files; a project layer is ignored entirely.
 */
export interface PstackConfig {
	/** Whether the bridge injects pstack skill instructions; only a user file can turn this on. */
	enabled: boolean;
	/** Absolute Cursor directory to resolve pstack from; absent uses the hook's own resolution. */
	cursorDir?: string;
	/** Per-stage skill names replacing the default mapping; unknown stages and non-string entries are dropped. */
	mapping?: Partial<Record<PstackMappingStage, string[]>>;
	/** Character cap for the injected context block. */
	contextCapChars?: number;
}

export const DEFAULT_PSTACK_CONFIG: PstackConfig = {
	enabled: false,
	contextCapChars: 2000,
};

/** A per-host planning model override; "" in a field means no override for it. */
export interface HostModelOverride {
	/** Exact credential-bearing provider id the planning target must belong to; "" = no provider constraint. */
	provider: string;
	/** Opaque model or host selector; "" = no model override. */
	model: string;
}

/**
 * Planning model selection (`models` in any config layer). `hosts` targets an existing host; `providerDefaults` maps an
 * exact credential provider id to the selector native Omp planning uses when the live model is unusable. Neither can
 * define endpoints, headers or credentials, and no legacy CLI route consumes `providerDefaults` (its eligible set is empty).
 */
export interface ModelsConfig {
	hosts: Partial<Record<HostId, HostModelOverride>>;
	providerDefaults: Record<string, string>;
}

/** Where an effective legacy route model came from: the route-default map, a nonblank file-layer pin, or a file-layer blank. */
export type LegacyModelProvenance = "route-default" | "file-pin" | "explicit-blank";

export interface UltrathinkConfig {
	uplift: { enabled: boolean; skipTrivial: boolean; maxChars: number; echo: boolean };
	claude: ClaudeConfig;
	grok: GrokConfig;
	hitl: HitlConfig;
	think: ThinkConfig;
	notion: NotionConfig;
	linear: LinearConfig;
	track: TrackConfig;
	muse: MuseConfig;
	ship: ShipConfig;
	substrate: SubstrateConfig;
	/** Jev decision points (OpenRouter Decisions API). Opt-in; no URL key by design (D1). */
	decisions: DecisionsConfig;
	/** Hindsight memory server (Teachable Moments storage). Opt-in; a project file can only turn it off. */
	hindsight: HindsightConfig;
	/** RAGFlow document search (planner grounding). Opt-in; a project file can only turn it off. */
	ragflow: RagflowConfig;
	/** Desk gateway used when an integration's backend is `gateway`. A project file cannot set it. */
	gateway: GatewayConfig;
	/** Teachable Moments capture, recall and promotion. Opt-in; a project file can only lower it. */
	teach: TeachConfig;
	/** On-disk session state. Opt-in retention; a project file can never set it. */
	state: StateConfig;
	/** Cursor pstack bridge (opt-in; user files only — a project layer cannot enable or retarget it). */
	pstack: PstackConfig;
	/** Planning model overrides and exact-provider default selectors; built-in `{ hosts: {}, providerDefaults: {} }`. */
	models: ModelsConfig;
	/**
	 * Provenance of the effective `claude.model`, `grok.model` and `muse.model`, recorded by the merge in memory only and never
	 * read from a config file. `grok` is never "explicit-blank": its non-empty merge ignores blanks.
	 */
	modelProvenance: Readonly<Record<LegacyRoute, LegacyModelProvenance>>;
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
			engine: "auto",
		},
		claude: { ...DEFAULT_CLAUDE_CONFIG },
		grok: { ...DEFAULT_GROK_CONFIG },
		muse: { ...DEFAULT_MUSE_CONFIG },
		hitl: { ...DEFAULT_HITL_CONFIG },
		notion: { ...DEFAULT_NOTION_CONFIG },
		linear: { ...DEFAULT_LINEAR_CONFIG },
		track: { ...DEFAULT_TRACK_CONFIG },
		ship: { ...DEFAULT_SHIP_CONFIG, skills: [...DEFAULT_SHIP_CONFIG.skills] },
		substrate: { ...DEFAULT_SUBSTRATE_CONFIG },
		decisions: { ...DEFAULT_DECISIONS_CONFIG, points: [...DEFAULT_DECISIONS_CONFIG.points] },
		hindsight: { ...DEFAULT_HINDSIGHT_CONFIG },
		ragflow: { ...DEFAULT_RAGFLOW_CONFIG, datasetIds: [...DEFAULT_RAGFLOW_CONFIG.datasetIds] },
		gateway: { ...DEFAULT_GATEWAY_CONFIG },
		teach: { ...DEFAULT_TEACH_CONFIG },
		state: { ...DEFAULT_STATE_CONFIG },
		pstack: { ...DEFAULT_PSTACK_CONFIG },
		models: { hosts: {}, providerDefaults: providerDictionary({}) },
		modelProvenance: { claude: "route-default", grok: "route-default", muse: "route-default" },
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
		engine: THINK_ENGINES.includes(think.engine as ThinkEngine) ? (think.engine as ThinkEngine) : defaults.engine,
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
		model: selectorField(claude.model) ?? defaults.model,
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
		model: selectorField(grok.model) || defaults.model,
		reasoningEffort: GROK_EFFORTS.includes(grok.reasoningEffort as GrokEffort)
			? (grok.reasoningEffort as GrokEffort)
			: defaults.reasoningEffort,
		transport: GROK_TRANSPORTS.includes(grok.transport as GrokTransport) ? (grok.transport as GrokTransport) : defaults.transport,
		bin: nonEmpty(grok.bin, defaults.bin),
		home: typeof grok.home === "string" ? grok.home.trim() : defaults.home,
		callTimeoutMs: nonNegativeMs(grok.callTimeoutMs, defaults.callTimeoutMs),
		fallbackToClaude: typeof grok.fallbackToClaude === "boolean" ? grok.fallbackToClaude : defaults.fallbackToClaude,
		shuntBaseUrl: httpUrl(grok.shuntBaseUrl, defaults.shuntBaseUrl),
		shuntModel: selectorField(grok.shuntModel) || defaults.shuntModel,
		shuntMaxTokens:
			typeof grok.shuntMaxTokens === "number" && Number.isInteger(grok.shuntMaxTokens) && grok.shuntMaxTokens > 0
				? grok.shuntMaxTokens
				: defaults.shuntMaxTokens,
	};
}

/** Like `mergeClaude`: every layer may set the local CLI target; no project tightening (mirrors claude/grok). */
function mergeMuse(muse: Record<string, unknown> | undefined, defaults: MuseConfig): MuseConfig {
	if (!muse) return defaults;
	return {
		bin: nonEmpty(muse.bin, defaults.bin),
		model: selectorField(muse.model) ?? defaults.model,
		reasoningEffort: MUSE_EFFORTS.includes(muse.reasoningEffort as MuseEffort)
			? (muse.reasoningEffort as MuseEffort)
			: defaults.reasoningEffort,
		callTimeoutMs: nonNegativeMs(muse.callTimeoutMs, defaults.callTimeoutMs),
	};
}

/** C0 and C1 control characters: NUL, newline, ESC (ANSI), DEL and the rest. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/** A selector or provider string carrying a control character is never sent anywhere; resolution reports it `selector-invalid`. */
export function hasControlCharacter(value: string): boolean {
	return CONTROL_CHARACTER.test(value);
}

/** Shared selector string normalization: blanks stay absent; nonblank controls stay raw so selection can reject them before trim. */
export function normalizeSelectorField(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return hasControlCharacter(value) ? value : trimmed;
}

/**
 * A model/provider selector after normalization: undefined for a wrong type, "" for an entirely-whitespace blank,
 * otherwise trimmed of surrounding whitespace only. Nonblank strings carrying controls stay as written so resolution
 * can diagnose them before trim hides them; each merge consumer applies its existing blank/reset rule.
 */
function selectorField(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return normalizeSelectorField(value);
}

/** Provider keys never merged into a dictionary, in any layer (prototype pollution, T-15-01). An object lookup would hit the prototype itself. */
const UNSAFE_DICTIONARY_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** A prototype-free copy of a provider dictionary's own entries, so no inherited property can act as a mapping. */
function providerDictionary(entries: Readonly<Record<string, string>>): Record<string, string> {
	const out = Object.create(null) as Record<string, string>;
	for (const [key, value] of Object.entries(entries)) out[key] = value;
	return out;
}

/**
 * Per-entry merge of `models` (D-05): a wrong type keeps the lower value, a blank host field clears it, a blank provider
 * default removes the lower selector (exposing the host-catalog tier), and unknown hosts, prototype keys and inherited fields are ignored.
 */
function mergeModels(models: Record<string, unknown> | undefined, defaults: ModelsConfig): ModelsConfig {
	if (!models) return defaults;
	const hosts: Partial<Record<HostId, HostModelOverride>> = { ...defaults.hosts };
	for (const [host, entry] of Object.entries(asRecord(models.hosts) ?? {})) {
		const fields = asRecord(entry);
		if (!fields || !isHostId(host)) continue;
		const provider = Object.hasOwn(fields, "provider") ? selectorField(fields.provider) : undefined;
		const model = Object.hasOwn(fields, "model") ? selectorField(fields.model) : undefined;
		if (provider === undefined && model === undefined) continue;
		const lower = hosts[host];
		hosts[host] = { provider: provider ?? lower?.provider ?? "", model: model ?? lower?.model ?? "" };
	}
	const providerDefaults = providerDictionary(defaults.providerDefaults);
	for (const [provider, selector] of Object.entries(asRecord(models.providerDefaults) ?? {})) {
		if (UNSAFE_DICTIONARY_KEYS.includes(provider)) continue;
		const value = selectorField(selector);
		if (value === "") delete providerDefaults[provider];
		else if (value !== undefined) providerDefaults[provider] = value;
	}
	return { hosts, providerDefaults };
}

/** What a layer leaves on a legacy route model's provenance; a blank clears Claude and Muse, Grok's non-empty merge ignores it. */
function modelPin(section: Record<string, unknown> | undefined, lower: LegacyModelProvenance, blankClears: boolean): LegacyModelProvenance {
	const model = section?.model;
	if (typeof model !== "string") return lower;
	if (model.trim()) return "file-pin";
	return blankClears ? "explicit-blank" : lower;
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

/** `"gateway"` is kept. `"direct"` clears it. Anything else keeps the earlier layer. Absent means direct. */
function backendField(value: unknown, fallback: "direct" | "gateway" | undefined): "gateway" | undefined {
	if (value === "direct") return undefined;
	if (value === "gateway") return "gateway";
	return fallback === "gateway" ? "gateway" : undefined;
}

function mergeSubstrate(substrate: Record<string, unknown> | undefined, defaults: SubstrateConfig, project: boolean): SubstrateConfig {
	if (!substrate) return defaults;
	const url = httpUrl(substrate.url, defaults.url);
	const backend = project ? defaults.backend : backendField(substrate.backend, defaults.backend);
	return backend === "gateway" ? { url, backend } : { url };
}

function mergeGateway(gateway: Record<string, unknown> | undefined, defaults: GatewayConfig, project: boolean): GatewayConfig {
	if (!gateway || project) return defaults;
	const seat = typeof gateway.seat === "string" && SEAT_PATTERN.test(gateway.seat) ? gateway.seat : defaults.seat;
	return {
		url: urlAsWritten(gateway.url, defaults.url),
		seat,
		timeoutMs: intInRange(gateway.timeoutMs, 1, MAX_SERVICE_TIMEOUT_MS, defaults.timeoutMs),
	};
}

/** A finite number in [0, 1]; anything else falls back. */
function unitInterval(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/** Upper bound for `decisions.timeoutMs`; a larger (or non-finite) value keeps the previous layer's (K4). */
const MAX_DECISIONS_TIMEOUT_MS = 30_000;

/**
 * Per-field merge; only the fourteen known keys are read, so a layer can never add a URL (D1). `enabled` is ignored in
 * every layer: Jev is always on, and only ULTRATHINK_DECISIONS=0 disables it. A project layer (a file a cloned repository
 * controls) may only tighten consent (K5): `zdr` false→true, `points` narrowed to the intersection with the lower layers;
 * the remaining keys merge as usual.
 */
function mergeDecisions(decisions: Record<string, unknown> | undefined, defaults: DecisionsConfig, project: boolean): DecisionsConfig {
	if (!decisions) return defaults;
	let points = Array.isArray(decisions.points)
		? [...new Set(decisions.points.filter((p): p is DecisionPoint => DECISION_POINTS.includes(p as DecisionPoint)))]
		: defaults.points;
	if (project && points !== defaults.points) points = defaults.points.filter((p) => points.includes(p));
	const zdr = typeof decisions.zdr === "boolean" ? decisions.zdr : defaults.zdr;
	return {
		// Jev is always on: the file value is ignored in every layer; only ULTRATHINK_DECISIONS=0 disables.
		enabled: true,
		provider: DECISIONS_PROVIDERS.includes(decisions.provider as DecisionsProvider)
			? (decisions.provider as DecisionsProvider)
			: defaults.provider,
		model: nonEmpty(decisions.model, defaults.model),
		points,
		timeoutMs:
			typeof decisions.timeoutMs === "number" &&
			Number.isFinite(decisions.timeoutMs) &&
			decisions.timeoutMs > 0 &&
			decisions.timeoutMs <= MAX_DECISIONS_TIMEOUT_MS
				? decisions.timeoutMs
				: defaults.timeoutMs,
		zdr: project ? defaults.zdr || zdr : zdr,
		planSkipBelow: unitInterval(decisions.planSkipBelow, defaults.planSkipBelow),
		shipVetoAtOrBelow: unitInterval(decisions.shipVetoAtOrBelow, defaults.shipVetoAtOrBelow),
		shipApproveAt: unitInterval(decisions.shipApproveAt, defaults.shipApproveAt),
		groundedAt: unitInterval(decisions.groundedAt, defaults.groundedAt),
		blockingAt: unitInterval(decisions.blockingAt, defaults.blockingAt),
		teachableBelow: unitInterval(decisions.teachableBelow, defaults.teachableBelow),
		teachableAutoAt: unitInterval(decisions.teachableAutoAt, defaults.teachableAutoAt),
		skillworthyAt: unitInterval(decisions.skillworthyAt, defaults.skillworthyAt),
	};
}

/** An integer in [min, max]; anything else falls back. */
function intInRange(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** A URL is kept as written (trimmed): the resolver validates it and reports a bad one, so a typo is visible, not silent. */
function urlAsWritten(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** Upper bound for the Hindsight and RAGFlow request budgets. */
const MAX_SERVICE_TIMEOUT_MS = 120_000;
const HINDSIGHT_BANK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_DATASET_IDS = 20;

/**
 * A project layer (a file a cloned repository controls) never reaches the service target or turns anything on: it is
 * ignored apart from `enabled`, which can only go true -> false, so a repository cannot point memory traffic at its own host.
 */
function mergeHindsight(hindsight: Record<string, unknown> | undefined, defaults: HindsightConfig, project: boolean): HindsightConfig {
	if (!hindsight) return defaults;
	const enabled = booleanOr(hindsight.enabled, defaults.enabled);
	if (project) return { ...defaults, enabled: defaults.enabled && enabled };
	const backend = backendField(hindsight.backend, defaults.backend);
	const merged: HindsightConfig = {
		enabled,
		url: urlAsWritten(hindsight.url, defaults.url),
		bank: typeof hindsight.bank === "string" && HINDSIGHT_BANK.test(hindsight.bank) ? hindsight.bank : defaults.bank,
		timeoutMs: intInRange(hindsight.timeoutMs, 1, MAX_SERVICE_TIMEOUT_MS, defaults.timeoutMs),
		retainTimeoutMs: intInRange(hindsight.retainTimeoutMs, 1, MAX_SERVICE_TIMEOUT_MS, defaults.retainTimeoutMs),
	};
	if (backend === "gateway") merged.backend = "gateway";
	return merged;
}

/** Same trust rule as `mergeHindsight`; `ground` (sends the prompt to RAGFlow) can only be turned off by a project file. */
function mergeRagflow(ragflow: Record<string, unknown> | undefined, defaults: RagflowConfig, project: boolean): RagflowConfig {
	if (!ragflow) return defaults;
	const enabled = booleanOr(ragflow.enabled, defaults.enabled);
	const ground = booleanOr(ragflow.ground, defaults.ground);
	if (project) return { ...defaults, enabled: defaults.enabled && enabled, ground: defaults.ground && ground };
	let datasetIds = defaults.datasetIds;
	if (Array.isArray(ragflow.datasetIds)) {
		const ids = ragflow.datasetIds.filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim());
		if (ids.length === ragflow.datasetIds.length && ids.length <= MAX_DATASET_IDS) datasetIds = [...new Set(ids)];
	}
	const backend = backendField(ragflow.backend, defaults.backend);
	const merged: RagflowConfig = {
		enabled,
		url: urlAsWritten(ragflow.url, defaults.url),
		datasetIds,
		topK: intInRange(ragflow.topK, 1, 20, defaults.topK),
		similarityThreshold: unitInterval(ragflow.similarityThreshold, defaults.similarityThreshold),
		timeoutMs: intInRange(ragflow.timeoutMs, 1, MAX_SERVICE_TIMEOUT_MS, defaults.timeoutMs),
		ground,
		groundChars: intInRange(ragflow.groundChars, 500, 8_000, defaults.groundChars),
	};
	if (backend === "gateway") merged.backend = "gateway";
	return merged;
}

/**
 * A project layer can only turn `enabled`, `recall` and `autoPromote` off and lower `capture` (auto -> observe -> explicit);
 * every other key is ignored there. `CAPTURE_MODES` is ordered lowest first.
 */
function mergeTeach(teach: Record<string, unknown> | undefined, defaults: TeachConfig, project: boolean): TeachConfig {
	if (!teach) return defaults;
	const enabled = booleanOr(teach.enabled, defaults.enabled);
	const recall = booleanOr(teach.recall, defaults.recall);
	const autoPromote = booleanOr(teach.autoPromote, defaults.autoPromote);
	const requested = CAPTURE_MODES.find((mode) => mode === teach.capture);
	if (project) {
		const capture: CaptureMode =
			requested !== undefined && CAPTURE_MODES.indexOf(requested) < CAPTURE_MODES.indexOf(defaults.capture) ? requested : defaults.capture;
		return {
			...defaults,
			enabled: defaults.enabled && enabled,
			capture,
			recall: defaults.recall && recall,
			autoPromote: defaults.autoPromote && autoPromote,
		};
	}
	return {
		enabled,
		capture: requested ?? defaults.capture,
		recall,
		recallLimit: intInRange(teach.recallLimit, 1, 10, defaults.recallLimit),
		recallChars: intInRange(teach.recallChars, 500, 8_000, defaults.recallChars),
		promoteAfter: intInRange(teach.promoteAfter, 2, 20, defaults.promoteAfter),
		autoPromote,
		observeMinToolCalls: intInRange(teach.observeMinToolCalls, 0, 50, defaults.observeMinToolCalls),
		timeoutMs: intInRange(teach.timeoutMs, 500, 30_000, defaults.timeoutMs),
	};
}

/**
 * A project layer (a file a cloned repository controls) is ignored entirely: a hostile `retentionDays: 1` would delete
 * the user's history. Only user files can opt in to the scheduled prune.
 */
function mergeState(state: Record<string, unknown> | undefined, defaults: StateConfig, project: boolean): StateConfig {
	if (!state || project) return defaults;
	return { retentionDays: intInRange(state.retentionDays, 0, 3650, defaults.retentionDays) };
}

/** An absolute path as written (trimmed); blank, relative or wrong-typed values keep the lower layer's. */
function absolutePathField(value: unknown, fallback: string | undefined): string | undefined {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed && isAbsolute(trimmed) ? trimmed : fallback;
}

/** The four stages a user mapping may remap; `orchestrate` routes over all of them and is not a mapping key. */
const PSTACK_MAPPING_STAGES: readonly PstackMappingStage[] = ["discuss", "plan", "execute", "review"];

/** A fresh mapping holding only the known stages and only their string entries; everything else is dropped. */
function pstackMapping(mapping: unknown): Partial<Record<PstackMappingStage, string[]>> | undefined {
	const record = asRecord(mapping);
	if (!record) return undefined;
	const merged: Partial<Record<PstackMappingStage, string[]>> = {};
	for (const stage of PSTACK_MAPPING_STAGES) {
		const value = record[stage];
		if (!Array.isArray(value)) continue;
		merged[stage] = value.filter((name): name is string => typeof name === "string");
	}
	return Object.keys(merged).length ? merged : undefined;
}

/**
 * The pstack bridge is opt-in and user-only: a project layer (a file a cloned repository controls) is ignored
 * entirely — its `enabled: true` stays the default false, and it can retarget neither cursorDir nor mapping.
 */
function mergePstack(pstack: Record<string, unknown> | undefined, defaults: PstackConfig, project: boolean): PstackConfig {
	if (!pstack || project) return defaults;
	return {
		enabled: booleanOr(pstack.enabled, defaults.enabled),
		cursorDir: absolutePathField(pstack.cursorDir, defaults.cursorDir),
		mapping: pstackMapping(pstack.mapping),
		contextCapChars: positiveInt(pstack.contextCapChars, defaults.contextCapChars ?? 2000),
	};
}

/** Merges one config layer onto `base`; `project` marks a repository-controlled layer (consent may only tighten, K5). */
export function mergeConfig(
	file: Record<string, unknown> | undefined,
	base: UltrathinkConfig,
	options: { project?: boolean } = {},
): UltrathinkConfig {
	if (!file) return base;
	const claude = asRecord(file.claude);
	const grok = asRecord(file.grok);
	const muse = asRecord(file.muse);
	return {
		uplift: mergeUplift(asRecord(file.uplift), base.uplift),
		claude: mergeClaude(claude, base.claude),
		grok: mergeGrok(grok, base.grok),
		muse: mergeMuse(muse, base.muse),
		hitl: mergeHitl(asRecord(file.hitl), base.hitl),
		think: mergeThink(asRecord(file.think), base.think),
		notion: mergeNotion(asRecord(file.notion), base.notion),
		linear: mergeLinear(asRecord(file.linear), base.linear),
		track: mergeTrack(asRecord(file.track), base.track),
		ship: mergeShip(asRecord(file.ship), base.ship),
		substrate: mergeSubstrate(asRecord(file.substrate), base.substrate, options.project === true),
		decisions: mergeDecisions(asRecord(file.decisions), base.decisions, options.project === true),
		hindsight: mergeHindsight(asRecord(file.hindsight), base.hindsight, options.project === true),
		ragflow: mergeRagflow(asRecord(file.ragflow), base.ragflow, options.project === true),
		gateway: mergeGateway(asRecord(file.gateway), base.gateway, options.project === true),
		teach: mergeTeach(asRecord(file.teach), base.teach, options.project === true),
		state: mergeState(asRecord(file.state), base.state, options.project === true),
		pstack: mergePstack(asRecord(file.pstack), base.pstack, options.project === true),
		models: mergeModels(asRecord(file.models), base.models),
		modelProvenance: {
			claude: modelPin(claude, base.modelProvenance.claude, true),
			grok: modelPin(grok, base.modelProvenance.grok, false),
			muse: modelPin(muse, base.modelProvenance.muse, true),
		},
	};
}

/** Host-neutral user config: `${XDG_CONFIG_HOME || ~/.config}/ultrathink/config.json`. */
export function userConfigPath(env: Record<string, string | undefined> = process.env): string {
	return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "ultrathink", "config.json");
}

/** A config file: a plain path merges as a user layer; `{ path, project: true }` is a repository-controlled project layer. */
export type ConfigSource = string | { path: string; project: true };

/** Config files for ultrathink, lowest precedence first — later files win: user, then Claude user, then project. */
export function claudeConfigPaths(cwd: string, env: Record<string, string | undefined> = process.env): ConfigSource[] {
	const home = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
	return [userConfigPath(env), join(home, "ultrathink.json"), { path: join(cwd, ".claude", "ultrathink.json"), project: true }];
}

/** Loads config from `files` in order (later files win); defaults when none override. */
export function loadConfig(files: readonly ConfigSource[]): UltrathinkConfig {
	let config = defaultConfig();
	for (const file of files) {
		const project = typeof file !== "string";
		config = mergeConfig(asRecord(readJson(project ? file.path : file)), config, { project });
	}
	return config;
}
