// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Server-side planner: runs the plugin's own pipeline (`planPrompt`: uplift, Graph of Thought, Chain of Thought,
 * clarify) against an OpenRouter chat model, as a background job with long-polled results.
 *
 * The plan never reads the operator's personal config or control state: the plugin config is built here and handed
 * over captured, the env is built from scratch, and tracking, substrate, Hindsight, RAGFlow, shipping, lessons and
 * (unless `serverDecisions`) Jev stay off. The only outbound traffic is the OpenRouter completer.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeCompleter } from "../../../src/claude/complete.ts";
import { readSession, type SessionRecord } from "../../../src/claude/state.ts";
import { defaultConfig, type UltrathinkConfig as PluginConfig } from "../../../src/config.ts";
import type { ModelResolution, SelectedEngine } from "../../../src/host/engine.ts";
import { GROKBOT_ENGINE_HOST, checkRecord, journalDir, readMeta } from "../../../src/host/grokbot.ts";
import { type PlanResponse, planPrompt } from "../../../src/host/plan.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import { CeilingError, type Ledger } from "../cost/ledger.ts";
import type { Store } from "../store/store.ts";
import { type JournalErrorCode, type JournalResult, type SessionView, cleanText, isSessionId, isolatedConfigEnv } from "./journal.ts";
import { OpenRouterError, type OpenRouterFetch, type OpenRouterUsage, createOpenRouterCompleter } from "./openrouter.ts";
import { DEFAULT_MAX_CHARS, type ChatQuestion, renderChatPlan } from "./render.ts";

export type JobStatus = "running" | "planned" | "failed" | "invalid" | "skipped";

export interface JobUsage {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	costUsd?: number;
}

export interface ResultView {
	sessionId: string;
	status: JobStatus;
	mode: "server" | "client";
	/** Chat-ready plan when planned, otherwise one status line. */
	text: string;
	truncated?: boolean;
	questions?: ChatQuestion[];
	usage?: JobUsage;
	error?: string;
}

export interface StartView {
	sessionId: string;
	status: JobStatus;
	pollAfterSec?: number;
	error?: string;
}

export interface HeadlessPlanner {
	/** `config.serverPlanning`. */
	readonly enabled: boolean;
	start(input: { prompt: unknown; sessionId?: unknown }): Promise<JournalResult<StartView>>;
	result(input: { sessionId: unknown; waitSeconds?: unknown; detail?: unknown }): Promise<JournalResult<ResultView>>;
	/** Null when the session is not a server job (including malformed ids, which the journal reports). */
	status(input: { sessionId: unknown }): JournalResult<SessionView> | null;
	/** Aborts running jobs, waits up to 5 s, then marks what is left failed with error "interrupted". */
	shutdown(): Promise<void>;
}

export interface PlannerCall {
	sessionId: string;
	model: string;
	ms: number;
	outcome: string;
	attempts: number;
	inputTokens: number;
	outputTokens: number;
	costUsd?: number;
}

export interface HeadlessOptions {
	config: UltrathinkConfig;
	store: Store;
	ledger: Ledger;
	fetch?: OpenRouterFetch;
	now?: () => number;
	/** Resolves early when `signal` aborts. Drives the start window, the long poll, the plan timeout and the shutdown wait. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Replaces the OpenRouter completer (tests). Its calls are still reserved and settled in the ledger. */
	completer?: ClaudeCompleter;
	/** Environment the planner's allowlisted pass-through keys are read from; defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Plugin entry point; defaults to `planPrompt`. A test seam, never a behavior switch. */
	plan?: typeof planPrompt;
	/** One event per model call; counts and timings only, never keys, prompts or response text. A throwing hook is ignored. */
	onCall?: (call: PlannerCall) => void;
}

interface JobFile {
	sessionId: string;
	runId: string;
	status: JobStatus;
	createdAt: number;
	updatedAt: number;
	error?: string;
	usage: JobUsage;
	promptSha256: string;
}

type AbortReason = "timeout" | "shutdown" | "budget_exceeded" | "ledger_unavailable";

interface Job extends JobFile {
	controller: AbortController;
	reason?: AbortReason;
	/** First non-abort completer failure, as a code. */
	firstError?: string;
	seq: number;
	settled: boolean;
	done: Promise<void>;
	finish: () => void;
}

interface Outcome {
	status: Exclude<JobStatus, "running">;
	error?: string;
}

const START_WAIT_MS = 15_000;
const SHUTDOWN_WAIT_MS = 5_000;
const DEFAULT_WAIT_SECONDS = 40;
const MAX_WAIT_SECONDS = 45;
const POLL_AFTER_SEC = 5;
const CHARS_PER_TOKEN = 3;
const MAX_ERROR_CHARS = 300;
const PLANNER_OWNER = "ultrathink-server-planner";
const JOB_STATUSES: Record<string, true> = { running: true, planned: true, failed: true, invalid: true, skipped: true };
/** Skips that mean the engine failed rather than that the request was declined. */
const ENGINE_SKIPS: Record<string, true> = { "uplift-failed": true, "engine-error": true };
/** Variables with no secret and no config meaning that a plan may inherit. */
const PASS_THROUGH_ENV = ["PATH", "TZ", "LANG", "LC_ALL", "TMPDIR"] as const;

const fail = (code: JournalErrorCode, errors?: string[]): JournalResult<never> =>
	errors ? { ok: false, code, errors } : { ok: false, code };

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal?.aborted) return Promise.resolve();
	const timer = setTimeout(resolve, ms);
	signal?.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			resolve();
		},
		{ once: true },
	);
	return promise;
};

/** The plugin config a server plan runs with: planning on, everything that reaches outside the model off. */
function pluginConfig(service: UltrathinkConfig): PluginConfig {
	const config = defaultConfig();
	config.uplift = { ...config.uplift, enabled: true, skipTrivial: false, echo: false };
	config.claude = { ...config.claude, concurrency: 3, callTimeoutMs: 0, budgetMs: 0, echo: false };
	config.think = { ...config.think, enabled: true };
	config.hitl = { ...config.hitl, enabled: true, knowledgeBase: false };
	config.track = { ...config.track, enabled: false };
	config.ship = { ...config.ship, enabled: false, autoMerge: false };
	config.hindsight = { ...config.hindsight, enabled: false, url: "" };
	config.ragflow = { ...config.ragflow, enabled: false, ground: false, url: "" };
	config.teach = { ...config.teach, enabled: false, recall: false };
	config.decisions = { ...config.decisions, enabled: service.serverDecisions };
	config.substrate = { ...config.substrate, url: "" };
	config.gateway = { ...config.gateway, url: "" };
	config.notion = { dataSourceUrl: "" };
	config.linear = { team: "" };
	config.state = { ...config.state, retentionDays: 0 };
	config.pstack = { ...config.pstack, enabled: false };
	config.swarm = { ...config.swarm, autoRun: false };
	return config;
}

function isJobFile(value: unknown): value is JobFile {
	if (typeof value !== "object" || value === null) return false;
	const file = value as Record<string, unknown>;
	return (
		typeof file.sessionId === "string" &&
		typeof file.status === "string" &&
		Object.hasOwn(JOB_STATUSES, file.status) &&
		typeof file.createdAt === "number" &&
		typeof file.updatedAt === "number" &&
		typeof file.promptSha256 === "string" &&
		typeof file.usage === "object" &&
		file.usage !== null
	);
}

function statusLine(status: JobStatus, error?: string): string {
	switch (status) {
		case "running":
			return "The plan is still being prepared. Call ultrathink_result again with the same sessionId; no other work is needed meanwhile.";
		case "failed":
			return `Planning failed (${error ?? "engine_error"}). Tell the user, and offer to try again with a new sessionId.`;
		case "invalid":
			return `The planner produced an incomplete plan (${error ?? "invalid_plan"}). Offer to try again with a new sessionId, or rephrase the request.`;
		case "skipped":
			return `Planning was skipped (${error ?? "skipped"}). Rephrase the request as a plain description of the task, without a leading slash or a raw: prefix, and call ultrathink_uplift again with a new sessionId.`;
		default:
			return "";
	}
}

export function createHeadlessPlanner(opts: HeadlessOptions): HeadlessPlanner {
	const { config, store, ledger } = opts;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? defaultSleep;
	const plan = opts.plan ?? planPrompt;
	const stateDir = config.stateDir;
	const jobsDir = join(stateDir, "jobs");
	const cwd = join(stateDir, "cwd");
	const jobs = new Map<string, Job>();
	const enabled = config.serverPlanning;
	let closed = false;

	const jobPath = (sessionId: string): string => join(jobsDir, `${sessionId}.json`);

	function persist(file: JobFile): void {
		mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
		const path = jobPath(file.sessionId);
		const tmp = `${path}.${process.pid}.tmp`;
		const body: JobFile = {
			sessionId: file.sessionId,
			runId: file.runId,
			status: file.status,
			createdAt: file.createdAt,
			updatedAt: file.updatedAt,
			...(file.error === undefined ? {} : { error: file.error }),
			usage: { ...file.usage },
			promptSha256: file.promptSha256,
		};
		writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
	}

	function readJobFile(sessionId: string): JobFile | undefined {
		try {
			const parsed: unknown = JSON.parse(readFileSync(jobPath(sessionId), "utf8"));
			return isJobFile(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	// A job left running by a previous process has no one to finish it.
	function recoverInterrupted(): void {
		let names: string[];
		try {
			names = readdirSync(jobsDir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = readJobFile(name.slice(0, -".json".length));
			if (file?.status !== "running") continue;
			try {
				persist({ ...file, status: "failed", error: "interrupted", updatedAt: now() });
			} catch {
				continue;
			}
			try {
				store.updateRun(file.runId, { status: "failed", reason: "interrupted" });
			} catch {
				// the run row is bookkeeping only
			}
		}
	}

	function plannerEnv(): Record<string, string | undefined> {
		const base = opts.env ?? process.env;
		const env: Record<string, string | undefined> = {};
		for (const key of PASS_THROUGH_ENV) if (base[key] !== undefined) env[key] = base[key];
		Object.assign(env, isolatedConfigEnv(stateDir), {
			ULTRATHINK_HOST: GROKBOT_ENGINE_HOST,
			ULTRATHINK_STATE_DIR: stateDir,
			ULTRATHINK_SHIP: "0",
			ULTRATHINK_HINDSIGHT: "0",
			ULTRATHINK_RAGFLOW: "0",
			ULTRATHINK_TEACH: "0",
			ULTRATHINK_GATEWAY: "0",
			SUBSTRATE_DISABLED: "1",
		});
		if (config.serverDecisions) {
			// Jev reads its key from the env; this is the one place the key is handed to the plugin.
			if (config.openRouterApiKey !== undefined) env.OPENROUTER_API_KEY = config.openRouterApiKey;
		} else {
			env.ULTRATHINK_DECISIONS = "0";
		}
		// ULTRATHINK_CHILD and ULTRATHINK_UPLIFT are not on the allowlist, so they cannot reach the plan.
		return env;
	}

	function resolutionFor(model: string): ModelResolution {
		return {
			version: "1.0.0",
			state: "override",
			host: GROKBOT_ENGINE_HOST,
			source: "host-override",
			reason: "explicit-model",
			engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
			modelKnown: true,
			modelId: model,
			label: `openrouter:${model}`,
		};
	}

	/** One model call, reserved before and settled after in the ledger; a ceiling ends the whole job. */
	function meteredCompleter(job: Job, model: string): ClaudeCompleter {
		return async (system, user, signal) => {
			if (signal?.aborted || job.controller.signal.aborted) throw new DOMException("plan aborted", "AbortError");
			const estimated = Math.ceil((system.length + user.length) / CHARS_PER_TOKEN) + config.modelMaxOutputTokens;
			let reservationId: number;
			try {
				reservationId = ledger.reserve({ runId: job.runId, phase: `model-${++job.seq}`, attempt: 1, estimatedTokens: estimated }).reservationId;
			} catch (error) {
				job.reason ??= error instanceof CeilingError ? "budget_exceeded" : "ledger_unavailable";
				job.controller.abort();
				throw error;
			}
			const reported: { usage?: OpenRouterUsage; call?: { ms: number; outcome: string; attempts: number } } = {};
			const startedAt = now();
			const emit = (outcome: string, usage?: OpenRouterUsage): void => {
				if (!opts.onCall) return;
				const call = reported.call;
				try {
					opts.onCall({
						sessionId: job.sessionId,
						model,
						ms: call?.ms ?? Math.max(0, now() - startedAt),
						outcome: call?.outcome ?? outcome,
						attempts: call?.attempts ?? 1,
						inputTokens: usage?.promptTokens ?? 0,
						outputTokens: usage?.completionTokens ?? 0,
						...(usage?.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
					});
				} catch {
					// telemetry must never affect the job
				}
			};
			try {
				const complete =
					opts.completer ??
					createOpenRouterCompleter({
						apiKey: config.openRouterApiKey ?? "",
						baseUrl: config.openRouterBaseUrl,
						model,
						maxOutputTokens: config.modelMaxOutputTokens,
						timeoutMs: config.modelTimeoutMs,
						referer: config.publicOrigin,
						...(config.modelReasoningEffort === undefined ? {} : { reasoningEffort: config.modelReasoningEffort }),
						sleep,
						...(opts.fetch ? { fetch: opts.fetch } : {}),
						onUsage: (usage) => {
							reported.usage = usage;
						},
						onCall: (info) => {
							reported.call = { ms: info.ms, outcome: info.outcome, attempts: info.attempts };
						},
					});
				const text = await complete(system, user, signal);
				job.usage.calls += 1;
				const { usage } = reported;
				emit("ok", usage);
				if (usage) {
					job.usage.inputTokens += usage.promptTokens;
					job.usage.outputTokens += usage.completionTokens;
					if (usage.costUsd !== undefined) job.usage.costUsd = (job.usage.costUsd ?? 0) + usage.costUsd;
				}
				const actual = usage ? usage.promptTokens + usage.completionTokens : Math.ceil((system.length + user.length + text.length) / CHARS_PER_TOKEN);
				try {
					ledger.settle(reservationId, Math.max(0, Math.round(actual)));
				} catch {
					// the reservation keeps counting, which only errs on the safe side
				}
				return text;
			} catch (error) {
				const failure = error instanceof OpenRouterError ? error.code : error instanceof Error && error.name === "AbortError" ? "aborted" : "engine_error";
				emit(failure);
				try {
					ledger.abandon(reservationId);
				} catch {
					// as above
				}
				const aborted = error instanceof OpenRouterError ? error.code === "aborted" : error instanceof Error && error.name === "AbortError";
				if (!aborted) job.firstError ??= error instanceof OpenRouterError ? error.code : "engine_error";
				throw error;
			}
		};
	}

	function abortOutcome(job: Job): Outcome {
		switch (job.reason) {
			case "timeout":
				return { status: "failed", error: "timeout" };
			case "shutdown":
				return { status: "failed", error: "interrupted" };
			case "budget_exceeded":
				return { status: "failed", error: "budget_exceeded" };
			case "ledger_unavailable":
				return { status: "failed", error: "ledger_unavailable" };
			default:
				return { status: "failed", error: "aborted" };
		}
	}

	function judge(job: Job, response: PlanResponse): Outcome {
		if (job.reason !== undefined || response.skipped === "aborted") return abortOutcome(job);
		if (response.skipped !== undefined && !Object.hasOwn(ENGINE_SKIPS, response.skipped)) return { status: "skipped", error: response.skipped };
		if (response.skipped !== undefined || response.statePath === undefined) return { status: "failed", error: job.firstError ?? response.skipped ?? "engine_error" };
		const record = readSession(stateDir, job.sessionId);
		if (!record) return { status: "failed", error: job.firstError ?? "engine_error" };
		const check = checkRecord(record, { thinkOff: false });
		if (check.ok) return { status: "planned" };
		// The engine's own failure explains a degraded record better than the degradation does.
		if (job.firstError !== undefined) return { status: "failed", error: job.firstError };
		const detail = check.errors.join("; ");
		return { status: "invalid", error: detail.length > MAX_ERROR_CHARS ? `${detail.slice(0, MAX_ERROR_CHARS)}...` : detail };
	}

	function finalize(job: Job, outcome: Outcome): void {
		if (job.settled) return;
		job.settled = true;
		job.status = outcome.status;
		if (outcome.error === undefined) delete job.error;
		else job.error = outcome.error;
		job.updatedAt = now();
		let written = true;
		try {
			persist(job);
		} catch {
			written = false;
		}
		try {
			store.updateRun(job.runId, outcome.status === "planned" ? { status: "complete", reason: null } : { status: "failed", reason: outcome.error ?? outcome.status });
		} catch {
			// bookkeeping only
		}
		if (written) jobs.delete(job.sessionId);
		job.finish();
	}

	async function execute(job: Job, prompt: string, model: string): Promise<void> {
		const timer = new AbortController();
		sleep(config.planTimeoutMs, timer.signal)
			.then(() => {
				if (timer.signal.aborted || job.settled) return;
				job.reason ??= "timeout";
				job.controller.abort();
			})
			.catch(() => {});
		let outcome: Outcome;
		try {
			const response = await plan({ host: GROKBOT_ENGINE_HOST, session_id: job.sessionId, prompt, cwd }, plannerEnv(), {
				stateDir,
				signal: job.controller.signal,
				config: pluginConfig(config),
				control: { enabled: true },
				createTracker: () => undefined,
				selectEngine: async (): Promise<SelectedEngine> => ({
					label: `openrouter:${model}`,
					complete: meteredCompleter(job, model),
					error: () => job.firstError,
					resolution: resolutionFor(model),
				}),
			});
			outcome = judge(job, response);
		} catch {
			outcome = job.reason === undefined ? { status: "failed", error: job.firstError ?? "engine_error" } : abortOutcome(job);
		} finally {
			timer.abort();
		}
		finalize(job, outcome);
	}

	async function waitFor(job: Job, ms: number): Promise<void> {
		if (job.settled || ms <= 0) return;
		const wait = new AbortController();
		try {
			await Promise.race([job.done, sleep(ms, wait.signal)]);
		} finally {
			wait.abort();
		}
	}

	function startView(file: JobFile): StartView {
		return {
			sessionId: file.sessionId,
			status: file.status,
			...(file.status === "running" ? { pollAfterSec: POLL_AFTER_SEC } : {}),
			...(file.error === undefined ? {} : { error: file.error }),
		};
	}

	function renderView(sessionId: string, mode: "server" | "client", detail: "brief" | "full", record: SessionRecord, usage?: JobUsage): ResultView {
		const rendered = renderChatPlan(record, { detail, maxChars: DEFAULT_MAX_CHARS[detail] });
		return {
			sessionId,
			status: "planned",
			mode,
			text: rendered.text,
			...(rendered.truncated ? { truncated: true } : {}),
			...(rendered.questions.length > 0 ? { questions: rendered.questions } : {}),
			...(usage ? { usage: { ...usage } } : {}),
		};
	}

	function serverView(file: JobFile, detail: "brief" | "full"): JournalResult<ResultView> {
		if (file.status === "planned") {
			const record = readSession(stateDir, file.sessionId);
			if (!record) return fail("engine_error");
			return { ok: true, data: renderView(file.sessionId, "server", detail, record, file.usage) };
		}
		return {
			ok: true,
			data: {
				sessionId: file.sessionId,
				status: file.status,
				mode: "server",
				text: statusLine(file.status, file.error),
				usage: { ...file.usage },
				...(file.error === undefined ? {} : { error: file.error }),
			},
		};
	}

	// A finished session from the client-driven loop: the chat model did the thinking, the record is the same.
	function clientView(sessionId: string, detail: "brief" | "full"): JournalResult<ResultView> {
		const meta = readMeta(journalDir(stateDir, sessionId));
		if (!meta) return fail("not_found");
		const status: JobStatus = meta.status === "planned" || meta.status === "invalid" || meta.status === "skipped" ? meta.status : "running";
		if (status === "planned") {
			const record = readSession(stateDir, sessionId);
			if (!record) return fail("engine_error");
			return { ok: true, data: renderView(sessionId, "client", detail, record) };
		}
		const text =
			status === "running"
				? "This session is driven by the chat model and is not finished: keep answering its pending requests with ultrathink_pending, ultrathink_show and ultrathink_answer."
				: statusLine(status, status === "skipped" ? "skipped" : undefined);
		return { ok: true, data: { sessionId, status, mode: "client", text } };
	}

	recoverInterrupted();

	return {
		enabled,

		async start(input) {
			const sessionId = input.sessionId === undefined ? randomUUID() : input.sessionId;
			if (!isSessionId(sessionId)) return fail("invalid_session_id");
			if (typeof input.prompt !== "string") return fail("invalid_input");
			const prompt = cleanText(input.prompt);
			if (prompt.length === 0 || prompt.length > config.maxInputChars) return fail("invalid_input");
			if (!enabled) return fail("disabled");
			if (closed) return fail("not_ready");
			const model = config.planningModel;
			if (opts.completer === undefined && (config.openRouterApiKey === undefined || model === undefined)) return fail("not_ready");

			const promptSha256 = createHash("sha256").update(prompt).digest("hex");
			const existing = jobs.get(sessionId) ?? readJobFile(sessionId);
			if (existing) {
				if (existing.promptSha256 !== promptSha256) return fail("session_conflict");
				const live = jobs.get(sessionId);
				if (live) await waitFor(live, START_WAIT_MS);
				return { ok: true, data: startView(live ?? existing) };
			}
			// The id already belongs to the client-driven loop.
			if (readMeta(journalDir(stateDir, sessionId))) return fail("session_conflict");
			let running = 0;
			for (const job of jobs.values()) if (!job.settled) running += 1;
			if (running >= config.maxConcurrentPlans) return fail("busy");

			let job: Job;
			try {
				mkdirSync(cwd, { recursive: true });
				const at = now();
				// A claimable status would let a queue worker adopt the row; paused-for-blocker is never claimed.
				const run = store.db
					.transaction(() => {
						const created = store.createRun({ ownerId: PLANNER_OWNER, request: `server plan ${sessionId}`, route: "server-planning" });
						store.updateRun(created.id, { status: "paused-for-blocker", reason: "server_planning", currentPhase: "plan" });
						return created;
					})
					.immediate();
				const { promise, resolve } = Promise.withResolvers<void>();
				job = {
					sessionId,
					runId: run.id,
					status: "running",
					createdAt: at,
					updatedAt: at,
					usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
					promptSha256,
					controller: new AbortController(),
					seq: 0,
					settled: false,
					done: promise,
					finish: resolve,
				};
				persist(job);
			} catch {
				return fail("engine_error");
			}
			jobs.set(sessionId, job);
			void execute(job, prompt, model ?? "custom");
			await waitFor(job, START_WAIT_MS);
			return { ok: true, data: startView(job) };
		},

		async result(input) {
			const { sessionId } = input;
			if (!isSessionId(sessionId)) return fail("invalid_session_id");
			let waitSeconds = DEFAULT_WAIT_SECONDS;
			if (input.waitSeconds !== undefined) {
				if (typeof input.waitSeconds !== "number" || Number.isNaN(input.waitSeconds)) return fail("invalid_input");
				waitSeconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.floor(input.waitSeconds)));
			}
			if (input.detail !== undefined && input.detail !== "brief" && input.detail !== "full") return fail("invalid_input");
			const detail: "brief" | "full" = input.detail === "full" ? "full" : "brief";
			try {
				const live = jobs.get(sessionId);
				if (live) await waitFor(live, waitSeconds * 1000);
				const file = live ?? readJobFile(sessionId);
				return file ? serverView(file, detail) : clientView(sessionId, detail);
			} catch {
				return fail("engine_error");
			}
		},

		status(input) {
			const sessionId = input.sessionId;
			if (!isSessionId(sessionId)) return null;
			const file = jobs.get(sessionId) ?? readJobFile(sessionId);
			if (!file) return null;
			return { ok: true, data: { sessionId, status: file.status, pendingCount: 0, pending: [] } };
		},

		async shutdown() {
			closed = true;
			const running = [...jobs.values()].filter((job) => !job.settled);
			if (running.length === 0) return;
			for (const job of running) {
				job.reason ??= "shutdown";
				job.controller.abort();
			}
			const wait = new AbortController();
			try {
				await Promise.race([Promise.all(running.map((job) => job.done)), sleep(SHUTDOWN_WAIT_MS, wait.signal)]);
			} finally {
				wait.abort();
			}
			for (const job of running) finalize(job, { status: "failed", error: "interrupted" });
		},
	};
}
