// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The Decisions runtime every decision point shares: the OpenRouter key lookup, the one is-point-active predicate,
 * and a fail-open run() that returns a typed outcome plus a content-free DecisionRecord.
 */
import { readStore, storePath as defaultStorePath } from "../mcp/store.ts";
import { type DecideOutcome, decide, redact, resolveDecisionsUrl } from "./client.ts";
import { type DecisionStates, QUESTION_KEYS, QUESTIONS } from "./questions.ts";
import {
	type DecisionAction,
	type DecisionPoint,
	type DecisionRecord,
	type DecisionsConfig,
	DecisionsError,
	type DecisionsRequest,
	formatP,
} from "./types.ts";

type Env = Record<string, string | undefined>;

export type KeySource = "store" | "OPENROUTER_API_KEY";

/** Stored openrouter api_key (trimmed, non-empty) wins; else trimmed non-empty env.OPENROUTER_API_KEY; else undefined. Never throws. */
export function resolveOpenRouterKey(storePath: string, env: Env): { key: string; source: KeySource } | undefined {
	try {
		const providers = readStore(storePath).providers as Record<string, unknown>;
		const credential = providers.openrouter as { kind?: unknown; apiKey?: unknown } | undefined;
		const stored = credential?.kind === "api_key" && typeof credential.apiKey === "string" ? credential.apiKey.trim() : "";
		if (stored) return { key: stored, source: "store" };
	} catch {
		// unreadable store: fall back to the environment
	}
	const fromEnv = env.OPENROUTER_API_KEY?.trim();
	return fromEnv ? { key: fromEnv, source: "OPENROUTER_API_KEY" } : undefined;
}

export interface DecisionsDeps {
	env?: Env; // default process.env
	storePath?: string; // default storePath(env)
	fetch?: typeof fetch; // default: globalThis.fetch at call time
	now?: () => number; // default Date.now
	sleep?: (ms: number) => Promise<void>; // default Bun.sleep
	random?: () => number; // default Math.random
	/** One line per decision, without the "[ultrathink] " prefix. Default: when env.ULTRATHINK_DEBUG === "1",
	 *  process.stderr.write(`[ultrathink] ${line}\n`); otherwise no output. */
	debug?: (line: string) => void;
}

export interface DecisionsInput extends DecisionsDeps {
	config: DecisionsConfig;
	/** Host session id; omitted from requests when empty or "unknown"; sliced to 256 chars. */
	sessionId?: string;
}

export interface RunDecisionOptions {
	signal?: AbortSignal;
	/** Stored in the record. */
	threshold: number;
	/** Action recorded for an ok outcome (errors record "fail-open"). */
	action: (p: number) => DecisionAction;
}

export type DecisionOutcome =
	| { status: "inactive" } // no request, no record, no debug line
	| { status: "ok"; p: number; record: DecisionRecord }
	| { status: "error"; error: DecisionsError; record: DecisionRecord }; // record.action === "fail-open"

export interface Decisions {
	readonly config: DecisionsConfig;
	/** The one is-point-active predicate: env.ULTRATHINK_DECISIONS !== "0" ∧ config.enabled ∧ config.points.includes(point)
	 *  ∧ key present. Checks the kill switch, enabled and points first; resolves the key at most once per runtime (lazily). */
	active(point: DecisionPoint): boolean;
	/** One decision. Never rejects except with an AbortError (caller abort). */
	run<P extends DecisionPoint>(point: P, state: DecisionStates[P], opts: RunDecisionOptions): Promise<DecisionOutcome>;
}

/** The body run() and the CLI send. */
export function buildDecisionsRequest<P extends DecisionPoint>(
	point: P,
	state: DecisionStates[P],
	input: { model: string; zdr: boolean; sessionId?: string; spanName?: string },
): DecisionsRequest {
	const sessionId = input.sessionId?.trim();
	return {
		model: input.model,
		state,
		questions: { [QUESTION_KEYS[point]]: QUESTIONS[point] },
		// zdr false → no provider key at all (A12)
		...(input.zdr ? { provider: { zdr: true, data_collection: "deny" as const } } : {}),
		...(sessionId && sessionId !== "unknown" ? { session_id: sessionId.slice(0, 256) } : {}),
		trace: { trace_name: "ultrathink", span_name: input.spanName ?? point },
	};
}

/** Debug line text (no prefix): never the message, state, error message or key. */
export function formatDebugLine(record: DecisionRecord): string {
	const tail = `${Math.round(record.latencyMs)}ms · attempts ${record.attempts}`;
	if (record.outcome === "error") return `decisions ${record.point} · error (${record.error}) · ${tail}`;
	const cost = record.cost !== undefined ? ` · cost ${record.cost}` : "";
	return `decisions ${record.point} · p ${formatP(record.p ?? 0)} · ${record.model} · ${tail}${cost}`;
}

/** `ULTRATHINK_DECISIONS=0` turns every decision point off for this shell, whatever the config says. */
export function decisionsKilled(env: Env): boolean {
	return env.ULTRATHINK_DECISIONS === "0";
}

/** Never throws; reads nothing until active()/run() is called. */
export function createDecisions(input: DecisionsInput): Decisions {
	const { config } = input;
	const env = input.env ?? process.env;
	const now = input.now ?? Date.now;
	const debug =
		input.debug ??
		((line: string) => {
			if (env.ULTRATHINK_DEBUG === "1") process.stderr.write(`[ultrathink] ${line}\n`);
		});
	let resolved = false;
	let apiKey: string | undefined;
	const key = (): string | undefined => {
		if (!resolved) {
			resolved = true;
			apiKey = resolveOpenRouterKey(input.storePath ?? defaultStorePath(env), env)?.key;
		}
		return apiKey;
	};
	const active = (point: DecisionPoint): boolean =>
		!decisionsKilled(env) && config.enabled && config.points.includes(point) && key() !== undefined;

	return {
		config,
		active,
		async run(point, state, opts) {
			const apiKeyNow = active(point) ? key() : undefined;
			if (!apiKeyNow) return { status: "inactive" };
			const questionKey = QUESTION_KEYS[point];
			const start = now();
			let outcome: DecideOutcome;
			try {
				outcome = await decide(
					buildDecisionsRequest(point, state, { model: config.model, zdr: config.zdr, sessionId: input.sessionId }),
					{
						apiKey: apiKeyNow,
						timeoutMs: config.timeoutMs,
						url: resolveDecisionsUrl(env).url,
						fetch: input.fetch,
						signal: opts.signal,
						now,
						sleep: input.sleep,
						random: input.random,
					},
				);
			} catch (error) {
				// Only the caller's abort propagates; anything else decide() should never throw still fails open.
				if (opts.signal?.aborted) throw error;
				const message = error instanceof Error ? error.message : String(error);
				outcome = {
					ok: false,
					error: new DecisionsError(
						"network",
						redact(`decisions network: ${redact(message || "unexpected error", apiKeyNow)}`, apiKeyNow),
					),
					attempts: 0,
					latencyMs: Math.max(0, now() - start),
				};
			}
			const base = { point, threshold: opts.threshold, latencyMs: outcome.latencyMs, attempts: outcome.attempts };
			let result: Exclude<DecisionOutcome, { status: "inactive" }>;
			if (outcome.ok) {
				const { response } = outcome;
				const answer = response.answers[questionKey];
				// parseDecisionsResponse guarantees a noul answer for the asked key.
				const p = answer?.type === "noul" ? answer.noul : Number.NaN;
				const record: DecisionRecord = {
					...base,
					outcome: "ok",
					model: response.model,
					...(response.id !== undefined ? { id: response.id } : {}),
					p,
					probabilities: { [questionKey]: p },
					action: opts.action(p),
					...(response.usage.cost !== undefined ? { cost: response.usage.cost } : {}),
					at: now(),
				};
				result = { status: "ok", p, record };
			} else {
				const record: DecisionRecord = {
					...base,
					outcome: "error",
					model: config.model,
					probabilities: {},
					action: "fail-open",
					error: outcome.error.kind,
					at: now(),
				};
				result = { status: "error", error: outcome.error, record };
			}
			try {
				debug(formatDebugLine(result.record));
			} catch {
				// a failing debug sink never changes the decision
			}
			return result;
		},
	};
}
