// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Planning model selection shared by every host entry (UT-Planning-ModelSelection 1.0.0). `selectEngine` makes one
 * explicit engine decision, then returns one completer with its safe resolution record, or a visible skip carrying that
 * record. Omp planning under `think.engine: auto` is native: the in-process selector the host supplies decides from the
 * live model and never maps session-model families; without one it is `unresolved: native-unavailable`, never Claude.
 * Other hosts, named engines and auxiliary helpers run a legacy CLI route (Claude, Muse, Grok HTTP/CLI/shunt) whose wire
 * model is a file pin, a host wire override, or the route default from `ROUTE_DEFAULT_MODELS`. Claude replaces a selected
 * Grok route only through the two explicit, labeled user switches `grok.fallbackToClaude: true` (login missing or
 * expired) and `grok.enabled: false`; otherwise a missing or expired Grok login skips with `GROK_LOGIN_REQUIRED`. The
 * shunt transport does not need `grok login`.
 */
import { grokAuthStatusFresh, redactSecrets } from "../grok/auth.ts";
import { createGrokCompleter } from "../grok/complete.ts";
import { grokEngineLabel } from "../grok/label.ts";
import type { GrokTransport } from "../grok/types.ts";
import { type ClaudeCompleter, createClaudeCompleter } from "../claude/complete.ts";
import { createMuseCompleter } from "../muse/complete.ts";
import { hasControlCharacter, type HostModelOverride, type UltrathinkConfig } from "../config.ts";
import type { ControlState } from "../claude/state.ts";
import { type LegacyRoute, ROUTE_DEFAULT_MODELS } from "../route-defaults.ts";
import { redactLine, redactText } from "../teach/redact.ts";
import { detectHost } from "./detect.ts";
import type { HostId } from "./types.ts";

/** First engine errors are persisted and shown to the agent: redacted, one line, bounded. */
export const MAX_ENGINE_ERROR_CHARS = 500;

export type ModelResolutionState = "override" | "detected" | "default" | "unresolved";
export type PlanningTransport = "omp-native" | "claude-cli" | "muse-cli" | "grok-http" | "grok-cli" | "grok-shunt";
export type ModelResolutionSource =
	| "host-override"
	| "provider-override"
	| "engine-model"
	| "shunt-model"
	| "ctx.model"
	| "ctx.models.current"
	| "configured-default"
	| "host-catalog"
	| "cli-default"
	| "none"
	| "route-default"
	| "configured-fallback";
export type ModelResolutionReason =
	| "explicit-model"
	| "explicit-provider"
	| "live-model"
	| "active-unavailable"
	| "cli-delegation"
	| "provider-unknown"
	| "mapping-missing"
	| "selector-invalid"
	| "selector-unresolved"
	| "provider-mismatch"
	| "transport-incompatible"
	| "native-unavailable"
	| "concrete-model-required"
	| "provider-disabled"
	| "unsupported-model"
	| "unsupported-host"
	| "route-default-model"
	| "grok-unavailable";

/** The engine request and where it came from, independent of the model resolution state. */
export interface EngineSelectionProvenance {
	/** Effective request (`state.engine ?? config.think.engine`), never a detected family. */
	engine: "auto" | "claude" | "grok" | "muse";
	/** "control" iff `state.engine` is present, explicit `auto` included. */
	source: "control" | "config";
	/** `host === "omp" && engine !== "auto"`: a named engine opted out of native planning. */
	nativeOptOut: boolean;
}

/** The only selection projection that may cross storage, process or UI boundaries: allowlisted and display-safe. */
export interface ModelResolution {
	version: "1.0.0";
	state: ModelResolutionState;
	/** "unknown" is a diagnostic, not a runtime HostId. */
	host: HostId | "unknown";
	transport?: PlanningTransport;
	source: ModelResolutionSource;
	reason: ModelResolutionReason;
	engineSelection: EngineSelectionProvenance;
	/** The default tier behind a native `provider-override` selection. */
	defaultSource?: "configured-default" | "host-catalog";
	/** Native only; never credential-provider evidence. */
	api?: string;
	/** Native only; never credential-provider evidence. */
	providerType?: string;
	provider?: string;
	/** Absent for a CLI default or an unresolved target. */
	modelId?: string;
	/** A selected native Model or a known legacy wire id (pin or route default); not proof of the upstream model. */
	modelKnown: boolean;
	/** Bounded, one line, generated from this record. */
	label: string;
}

export interface SelectedEngine {
	label: string;
	complete: ClaudeCompleter;
	error: () => string | undefined;
	resolution: ModelResolution;
}

export interface EngineSkip {
	/** Stable reason code (the unchanged `GROK_LOGIN_REQUIRED` notice for an unavailable Grok route); no raw provider error. */
	skipped: string;
	resolution: ModelResolution;
	/** Safe human explanation; the original prompt continues. */
	notice?: string;
}

export type EngineSelection = SelectedEngine | EngineSkip;

/** The shared policy's request to the native binding, which materializes whole Models. */
export interface ModelIntent {
	host: HostId;
	/** An absent host entry is two empty strings. */
	override: HostModelOverride;
	providerDefaults: Readonly<Record<string, string>>;
	engineSelection: EngineSelectionProvenance;
}

export type NativeEngineSelector = (intent: ModelIntent, signal?: AbortSignal) => Promise<EngineSelection>;

export interface EngineSelectionContext {
	host?: HostId;
	/** The legacy hook's session model string: route evidence for Hermes auto only, never a native Model or a wire model. */
	sessionModel?: unknown;
	/** Optional legacy provider declaration; never credential-binding proof. */
	provider?: string;
	sessionId?: string;
	signal?: AbortSignal;
	/** In-process native selector; consulted only for Omp planning under `auto`. */
	native?: NativeEngineSelector;
	/** Default "planning". Auxiliary helpers (ship judge, lesson distiller) never inherit a native session target. */
	purpose?: "planning" | "auxiliary";
}

export const GROK_LOGIN_REQUIRED = "Prompt Uplift skipped · Grok 4.7 login required (run `grok login`)";

/**
 * Legacy route per host under `think.engine: auto`. Omp planning resolves natively and never reads this; the Omp entry
 * only routes the auxiliary helpers, which run without a live Omp model.
 */
export const HOST_DEFAULT_ENGINES: Record<HostId, LegacyRoute> = {
	"claude-code": "claude",
	"grok-build": "grok",
	hermes: "claude",
	muse: "muse",
	omp: "claude",
};

export function captureFirstError(label: string, complete: ClaudeCompleter, resolution: ModelResolution): SelectedEngine {
	let first: string | undefined;
	return {
		label,
		complete: async (system, user, signal) => {
			try {
				return await complete(system, user, signal);
			} catch (error) {
				// redactLine keeps short Bearer [REDACTED] as prose; engine stderr is diagnostics, not prose,
				// so mask every remaining Bearer [REDACTED] too before the error is persisted and shown.
				first ??= redactSecrets(redactLine(error instanceof Error ? error.message : String(error), MAX_ENGINE_ERROR_CHARS));
				throw error;
			}
		},
		error: () => first,
		resolution,
	};
}

const MAX_DISPLAY_ID_CHARS = 128;
/** Characters a displayed provider or model id may carry; markup, quotes, spaces and controls make it opaque. */
const DISPLAY_ID = /^[\w.:@+/~-]+$/;
/** URI, endpoint or user-info shapes: `//`, a leading `/`, or `name:secret@`. */
const ENDPOINT_LIKE = /\/\/|^\/|:[^/]*@/;

/** Display projection of an opaque id: unchanged when plainly safe, else the opaque marker. The id used for inference is untouched. */
function displayId(id: string, opaque: "<opaque-provider>" | "<opaque-model>"): string {
	return id.length <= MAX_DISPLAY_ID_CHARS && DISPLAY_ID.test(id) && !ENDPOINT_LIKE.test(id) && redactText(id) === id ? id : opaque;
}

const TRANSPORT_ROUTE: Record<PlanningTransport, string> = {
	"omp-native": "omp-native",
	"claude-cli": "claude",
	"muse-cli": "muse",
	"grok-http": "grok",
	"grok-cli": "grok",
	"grok-shunt": "grok",
};

const GROK_TRANSPORT: Record<GrokTransport, PlanningTransport> = { http: "grok-http", cli: "grok-cli", shunt: "grok-shunt" };

/** Bracket tag of a `default` label per source; a CLI default names itself instead. */
const DEFAULT_TAG: Partial<Record<ModelResolutionSource, string>> = {
	"route-default": "route default",
	"configured-default": "configured default",
	"host-catalog": "host-catalog default",
	"cli-default": "",
};

interface ResolutionFields {
	host: HostId | "unknown";
	transport: PlanningTransport;
	state: ModelResolutionState;
	source: ModelResolutionSource;
	reason: ModelResolutionReason;
	engineSelection: EngineSelectionProvenance;
	defaultSource?: "configured-default" | "host-catalog";
	provider?: string;
	modelId?: string;
	api?: string;
	providerType?: string;
}

/** The allowlisted record (§9): fixed vocabulary, display-safe ids (none on an unresolved target), and a generated label. */
function resolutionRecord(fields: ResolutionFields): ModelResolution {
	const selected = fields.state !== "unresolved";
	const modelId = selected && fields.modelId ? displayId(fields.modelId, "<opaque-model>") : undefined;
	const provider = fields.provider ? displayId(fields.provider, "<opaque-provider>") : undefined;
	const api = selected && fields.api ? displayId(fields.api, "<opaque-provider>") : undefined;
	const providerType = selected && fields.providerType ? displayId(fields.providerType, "<opaque-provider>") : undefined;
	const route = TRANSPORT_ROUTE[fields.transport];
	let label: string;
	if (!selected) label = `${route}:unresolved [${fields.reason}]`;
	else {
		const target =
			modelId === undefined
				? "CLI default (model unobserved)"
				: fields.transport === "grok-shunt"
					? `${modelId}@shunt`
					: fields.transport === "omp-native" && provider
						? `${provider}/${modelId}`
						: modelId;
		const tag =
			fields.source === "configured-fallback"
				? "configured fallback · grok unavailable"
				: fields.state === "default"
					? (DEFAULT_TAG[fields.source] ?? "default")
					: fields.state;
		label = tag ? `${route}:${target} [${tag}]` : `${route}:${target}`;
	}
	return {
		version: "1.0.0",
		state: fields.state,
		host: fields.host,
		transport: fields.transport,
		source: fields.source,
		reason: fields.reason,
		engineSelection: { ...fields.engineSelection },
		...(fields.defaultSource ? { defaultSource: fields.defaultSource } : {}),
		...(api ? { api } : {}),
		...(providerType ? { providerType } : {}),
		...(provider ? { provider } : {}),
		...(modelId ? { modelId } : {}),
		modelKnown: modelId !== undefined,
		label,
	};
}

/** A visible unresolved skip: stable reason code, safe notice and the record; the original prompt continues. */
function unresolvedSkip(resolution: ModelResolution): EngineSkip {
	return { skipped: resolution.reason, resolution, notice: `Prompt Uplift skipped · ${resolution.label}` };
}

/** A legacy route's wire choice before any availability check; `model: ""` omits `--model` (Claude/Muse CLI default). */
interface WireChoice {
	model: string;
	source: "shunt-model" | "host-override" | "engine-model" | "route-default" | "cli-default";
}

/** The effective engine model: a file pin, or any value that is not the route default, overrides; the unpinned map value is a default. */
function engineModel(config: UltrathinkConfig, route: LegacyRoute): WireChoice {
	const model = config[route].model;
	if (!model.trim()) return { model: "", source: "cli-default" };
	const pinned = config.modelProvenance[route] === "file-pin" || model !== ROUTE_DEFAULT_MODELS[route];
	return { model, source: pinned ? "engine-model" : "route-default" };
}

/** State, source, reason and wire id a selected legacy choice records. */
function legacyFields(choice: WireChoice): Pick<ResolutionFields, "state" | "source" | "reason" | "modelId"> {
	if (choice.source === "route-default") return { state: "default", source: "route-default", reason: "route-default-model", modelId: choice.model };
	if (choice.source === "cli-default") return { state: "default", source: "cli-default", reason: "cli-delegation" };
	return { state: "override", source: choice.source, reason: "explicit-model", modelId: choice.model };
}

type SelectionBase = Pick<ResolutionFields, "host" | "engineSelection">;

/**
 * The Claude CLI route for one wire choice. `fallback` marks Claude standing in for an unavailable Grok route by explicit
 * user configuration (`grok.enabled: false` or `grok.fallbackToClaude: true`, AD-2a): the choice is then Claude's own
 * effective model, never the Grok or host wire selector, and the record says configured fallback.
 */
function claudeRoute(config: UltrathinkConfig, cwd: string, base: SelectionBase, choice: WireChoice, suffix: string, fallback: boolean): EngineSelection {
	if (hasControlCharacter(choice.model))
		return unresolvedSkip(resolutionRecord({ ...base, transport: "claude-cli", state: "unresolved", source: choice.source, reason: "selector-invalid" }));
	const fields = legacyFields(choice);
	const resolution = resolutionRecord({
		...base,
		transport: "claude-cli",
		...fields,
		...(fallback ? ({ source: "configured-fallback", reason: "grok-unavailable" } as const) : {}),
	});
	return captureFirstError(
		`claude:${choice.model || "session default"}${suffix}`,
		createClaudeCompleter({
			bin: config.claude.bin,
			model: choice.model || undefined,
			settingSources: config.claude.settingSources,
			thinking: config.claude.thinking,
			cwd,
			timeoutMs: config.claude.callTimeoutMs,
		}),
		resolution,
	);
}

/**
 * Map a session model id to a planning route for Hermes under `auto` (AD-3): Hermes sessions run an array of models, so
 * its route follows the model in use instead of the host default. Matching is case-insensitive over the whole id,
 * provider segment included, so "xai-oauth/<grok id>" and a bare grok id both route to Grok. Unknown families (Kimi
 * included) return undefined and the caller keeps the host default. This chooses a route only: the string is never a
 * wire model, a native target or a credential binding, and Omp never calls it.
 */
export function engineForSessionModel(model: unknown): LegacyRoute | undefined {
	if (typeof model !== "string") return undefined;
	const matchFamily = (text: string): LegacyRoute | undefined => {
		if (text.includes("claude") || text.includes("anthropic")) return "claude";
		if (text.includes("grok") || text.includes("xai")) return "grok";
		if (text.includes("muse") || text.includes("spark")) return "muse";
		return undefined;
	};
	const id = model.toLowerCase();
	const segments = id.split("/").filter((segment) => segment !== "");
	// The model segment wins over the provider: "anthropic/grok-…" is Grok, not Claude.
	return matchFamily(segments[segments.length - 1] ?? "") ?? matchFamily(id);
}

export async function selectEngine(
	config: UltrathinkConfig,
	state: ControlState,
	cwd: string,
	context: EngineSelectionContext = {},
): Promise<EngineSelection> {
	const requested = state.engine ?? config.think.engine;
	const host = context.host ?? detectHost();
	const engineSelection: EngineSelectionProvenance = {
		engine: requested,
		source: state.engine === undefined ? "config" : "control",
		nativeOptOut: host === "omp" && requested !== "auto",
	};
	const base: SelectionBase = { host, engineSelection };
	const ompAuto = host === "omp" && requested === "auto";
	if (ompAuto && (context.purpose ?? "planning") === "planning") {
		// Native: the live model decides. Neither family mapping nor the route-default map is consulted (D-06, D-09).
		if (!context.native)
			return unresolvedSkip(resolutionRecord({ ...base, transport: "omp-native", state: "unresolved", source: "none", reason: "native-unavailable" }));
		const intent: ModelIntent = {
			host,
			override: config.models.hosts.omp ?? { provider: "", model: "" },
			providerDefaults: config.models.providerDefaults,
			engineSelection,
		};
		return context.native(intent, context.signal);
	}
	// Legacy routes. Hermes alone keeps its session-model family -> route choice (AD-3); nothing here is ever `detected`.
	const route: LegacyRoute =
		requested !== "auto"
			? requested
			: host === "hermes"
				? (engineForSessionModel(context.sessionModel) ?? HOST_DEFAULT_ENGINES.hermes)
				: HOST_DEFAULT_ENGINES[host];
	// The Omp override names a native target; an auxiliary helper on the Omp auto route never hands it to a CLI.
	const override = (ompAuto ? undefined : config.models.hosts[host]) ?? { provider: "", model: "" };
	const transport: PlanningTransport = route === "claude" ? "claude-cli" : route === "muse" ? "muse-cli" : GROK_TRANSPORT[config.grok.transport];
	if (override.provider) {
		// No current legacy route binds an exact credential provider (§5.2): the constraint is visible, never ignored.
		const invalid = hasControlCharacter(override.provider) || hasControlCharacter(override.model);
		return unresolvedSkip(
			resolutionRecord({
				...base,
				transport,
				state: "unresolved",
				source: override.model ? "host-override" : "provider-override",
				reason: invalid ? "selector-invalid" : "transport-incompatible",
			}),
		);
	}
	// `grok.enabled: false` is the documented switch that forces Claude even when Grok is selected (AD-2a).
	if (route === "grok" && !config.grok.enabled) return claudeRoute(config, cwd, base, engineModel(config, "claude"), "", true);
	// Wire precedence: a nonblank shunt alias on shunt, then the host wire override, then the engine model.
	const shuntAlias = route === "grok" && config.grok.transport === "shunt" ? config.grok.shuntModel.trim() : "";
	const choice: WireChoice = shuntAlias
		? { model: shuntAlias, source: "shunt-model" }
		: override.model
			? { model: override.model, source: "host-override" }
			: engineModel(config, route);
	if (hasControlCharacter(choice.model))
		return unresolvedSkip(resolutionRecord({ ...base, transport, state: "unresolved", source: choice.source, reason: "selector-invalid" }));
	if (route === "claude") return claudeRoute(config, cwd, base, choice, "", false);
	if (route === "muse") {
		return captureFirstError(
			`muse:${choice.model || "session default"}`,
			createMuseCompleter({
				bin: config.muse.bin,
				model: choice.model || undefined,
				reasoningEffort: config.muse.reasoningEffort,
				cwd,
				timeoutMs: config.muse.callTimeoutMs,
			}),
			resolutionRecord({ ...base, transport, ...legacyFields(choice) }),
		);
	}
	// Grok has no omitted-model contract on any transport: a concrete wire model is required.
	if (!choice.model)
		return unresolvedSkip(resolutionRecord({ ...base, transport, state: "unresolved", source: "none", reason: "concrete-model-required" }));
	if (config.grok.transport === "shunt") {
		if (!config.grok.shuntBaseUrl.trim())
			return unresolvedSkip(resolutionRecord({ ...base, transport, state: "unresolved", source: choice.source, reason: "transport-incompatible" }));
	} else {
		const auth = await grokAuthStatusFresh({ home: config.grok.home || undefined, bin: config.grok.bin });
		if (!auth.loggedIn || auth.expired) {
			if (config.grok.fallbackToClaude) return claudeRoute(config, cwd, base, engineModel(config, "claude"), " (grok fallback)", true);
			// Auto and named Grok alike: the visible skip, with zero Claude and native calls (AD-2, AD-2a).
			return {
				skipped: GROK_LOGIN_REQUIRED,
				notice: GROK_LOGIN_REQUIRED,
				resolution: resolutionRecord({ ...base, transport, state: "unresolved", source: choice.source, reason: "grok-unavailable" }),
			};
		}
	}
	const model = override.model || config.grok.model;
	return captureFirstError(
		grokEngineLabel({ ...config.grok, model }),
		createGrokCompleter({
			baseUrl: config.grok.baseUrl,
			model,
			reasoningEffort: config.grok.reasoningEffort,
			timeoutMs: config.grok.callTimeoutMs,
			home: config.grok.home || undefined,
			transport: config.grok.transport,
			bin: config.grok.bin,
			cwd,
			shuntBaseUrl: config.grok.shuntBaseUrl,
			shuntModel: config.grok.shuntModel,
			shuntMaxTokens: config.grok.shuntMaxTokens,
		}),
		resolutionRecord({ ...base, transport, ...legacyFields(choice) }),
	);
}

/** The identity the shared native policy reads from a host Model; the binding keeps and binds the whole Model (D-01). */
export interface NativeModelIdentity {
	/** Exact credential-bearing provider id. */
	provider: string;
	id: string;
	api?: string;
	providerType?: string;
}

/**
 * What the Omp binding answers for the shared native policy (§3.2). It only observes and resolves; it never chooses, so
 * there is no listing, first-available, family or providerType selection anywhere.
 */
export interface NativeModelQuery<M extends NativeModelIdentity> {
	/** The observed live Model: `ctx.model`, else `ctx.models.current()`, never blended (D-01). */
	live?: { model: M; source: "ctx.model" | "ctx.models.current" };
	/** Whether a Model can serve isolated chat/text planning now; "unavailable" covers missing auth or a disabled model. */
	check(model: M): "usable" | "unavailable" | "unsupported";
	/** `ctx.models.resolve` through authenticated availability; `provider` qualifies a bare id at the host boundary. */
	resolve(selector: string, provider?: string): Promise<M | undefined>;
	/** Own-property `DEFAULT_MODEL_PER_PROVIDER[provider]`; undefined without an entry or without the catalog export. */
	catalogDefault(provider: string): string | undefined;
}

type DefaultTier = "configured-default" | "host-catalog";

/**
 * Provider P's default tier: its nonblank configured selector, else the host catalog id. The result must be a usable
 * Model of exactly P (and, for the catalog, exactly that id); a failed configured selector never falls through to the catalog.
 */
async function nativeDefault<M extends NativeModelIdentity>(
	intent: ModelIntent,
	query: NativeModelQuery<M>,
	provider: string,
): Promise<{ tier: DefaultTier; model: M } | { tier: DefaultTier; reason: ModelResolutionReason }> {
	const configured = Object.hasOwn(intent.providerDefaults, provider) ? intent.providerDefaults[provider] : undefined;
	const tier: DefaultTier = configured?.trim() ? "configured-default" : "host-catalog";
	const selector = tier === "configured-default" ? (configured ?? "") : (query.catalogDefault(provider)?.trim() ?? "");
	if (!selector) return { tier, reason: "mapping-missing" };
	if (hasControlCharacter(selector)) return { tier, reason: "selector-invalid" };
	const model = await query.resolve(selector, provider);
	if (!model) return { tier, reason: "selector-unresolved" };
	if (model.provider !== provider) return { tier, reason: "provider-mismatch" };
	if (tier === "host-catalog" && model.id !== selector) return { tier, reason: "selector-unresolved" };
	const usable = query.check(model);
	if (usable !== "usable") return { tier, reason: usable === "unsupported" ? "unsupported-model" : "selector-unresolved" };
	return { tier, model };
}

/**
 * Native precedence (D-06) for the Omp binding's `NativeEngineSelector`: a nonblank `models.hosts.omp.model` (resolved
 * with the provider constraint when one is set), then the usable live Model, then the same provider's validated default,
 * else a visible unresolved skip. A provider-only constraint keeps a matching usable live Model `detected`; otherwise it
 * selects that provider's default as `override`. A failed explicit or configured selector never falls through. `bind`
 * turns the one chosen whole Model into the completer every stage of the flight uses.
 */
export async function selectNativeEngine<M extends NativeModelIdentity>(
	intent: ModelIntent,
	query: NativeModelQuery<M>,
	bind: (model: M) => ClaudeCompleter,
): Promise<EngineSelection> {
	const base: SelectionBase = { host: intent.host, engineSelection: intent.engineSelection };
	const unresolved = (source: ModelResolutionSource, reason: ModelResolutionReason, provider?: string): EngineSkip =>
		unresolvedSkip(resolutionRecord({ ...base, transport: "omp-native", state: "unresolved", source, reason, provider }));
	const selected = (model: M, fields: Pick<ResolutionFields, "state" | "source" | "reason" | "defaultSource">): SelectedEngine => {
		const resolution = resolutionRecord({
			...base,
			transport: "omp-native",
			...fields,
			provider: model.provider,
			modelId: model.id,
			api: model.api,
			providerType: model.providerType,
		});
		return captureFirstError(resolution.label, bind(model), resolution);
	};
	const { provider: constraint, model: selector } = intent.override;
	if (hasControlCharacter(selector) || hasControlCharacter(constraint)) return unresolved(selector ? "host-override" : "provider-override", "selector-invalid");
	if (selector) {
		const model = await query.resolve(selector, constraint || undefined);
		if (!model) return unresolved("host-override", "selector-unresolved");
		if (constraint && model.provider !== constraint) return unresolved("host-override", "provider-mismatch");
		const usable = query.check(model);
		if (usable !== "usable") return unresolved("host-override", usable === "unsupported" ? "unsupported-model" : "selector-unresolved");
		return selected(model, { state: "override", source: "host-override", reason: "explicit-model" });
	}
	const live = query.live;
	if (live && query.check(live.model) === "usable" && (!constraint || live.model.provider === constraint))
		return selected(live.model, { state: "detected", source: live.source, reason: "live-model" });
	// The provider comes only from the constraint or the observed (even unusable) live Model; nothing else establishes it.
	const provider = constraint || live?.model.provider || "";
	if (!provider) return unresolved("none", "provider-unknown");
	const fallback = await nativeDefault(intent, query, provider);
	if (!("model" in fallback)) return unresolved(constraint ? "provider-override" : fallback.tier, fallback.reason, provider);
	return constraint
		? selected(fallback.model, { state: "override", source: "provider-override", reason: "explicit-provider", defaultSource: fallback.tier })
		: selected(fallback.model, { state: "default", source: fallback.tier, reason: "active-unavailable" });
}

/**
 * The status label of the current engine request; mirrors selection without auth checks. An `observed` record for the
 * same host and engine request (the live session's latest resolution, which only the host process can pass) shows its
 * generated label. Omp planning under `auto` is native, so without one the label says the live model is not observed
 * instead of guessing a CLI route (§9 path 6). On a legacy route a `models.hosts` wire model replaces the engine model,
 * and a provider constraint, which no legacy route can bind (§5.2), shows unresolved as selection reports it. Hermes
 * routes by session-model family under `auto` (AD-3), which a static label cannot show, so it names the default route.
 */
export function engineLabel(config: UltrathinkConfig, state: ControlState, host?: HostId, observed?: ModelResolution): string {
	const requested = state.engine ?? config.think.engine;
	const resolvedHost = host ?? detectHost();
	if (observed?.host === resolvedHost && observed.engineSelection.engine === requested) return observed.label;
	if (requested === "auto" && resolvedHost === "omp") return "omp-native:auto (live model not observed)";
	const engine = requested === "auto" ? HOST_DEFAULT_ENGINES[resolvedHost] : requested;
	const override = config.models.hosts[resolvedHost] ?? { provider: "", model: "" };
	let label: string;
	if (override.provider) {
		const invalid = hasControlCharacter(override.provider) || hasControlCharacter(override.model);
		label = `${engine}:unresolved [${invalid ? "selector-invalid" : "transport-incompatible"}]`;
	} else if (engine === "muse") {
		label = `muse:${override.model || config.muse.model || "session default"}`;
	} else if (engine === "grok" && config.grok.enabled) {
		label = grokEngineLabel({ ...config.grok, model: override.model || config.grok.model });
	} else {
		// A disabled Grok route runs Claude on Claude's own model (configured fallback), never the host's wire selector.
		label = `claude:${(engine === "claude" && override.model) || config.claude.model || "session default"}`;
	}
	if (requested === "auto" && resolvedHost === "hermes") return `${label} (follows session model)`;
	return label;
}
