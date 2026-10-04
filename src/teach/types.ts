// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Shared contract for Teachable Moments: the lesson record, the `teach` config section, the context every operation
 * runs in, the capture / recall / observe / promote shapes and the local store. Type-only (plus constants), so every
 * layer and every host can depend on it. The functions that implement it live in sibling files:
 *
 *   store.ts    openStore(dir): TeachStore
 *   capture.ts  captureMoment: CaptureFn, syncOutbox(ctx): Promise<SyncOutcome>
 *   recall.ts   recallLessons: RecallFn, formatLessonsSection(outcome, maxChars): string, lessonsLookup(outcome): LessonsLookup
 *   skills.ts   recallSkills, formatSkillsSection(outcome, maxChars): string, skillsLookup(outcome): SkillsLookup
 *   observe.ts  observeDigest: ObserveFn
 *   promote.ts  promotionCandidates(ctx), renderSkillDraft(moments, ctx), installSkill(draft, target, ctx)
 *   cli.ts      runTeachCommand(argv, deps): Promise<CliResult>
 *   status.ts   teachStatusLine(config, env, storePath?, stateDir?): string
 *   context.ts  teachContext(options): TeachContext
 *
 * Storage: the local store (<stateDir>/teach/) holds every moment and an outbox of pending Hindsight writes; Hindsight
 * (bank `hindsight.bank`) holds the shared copy. One Hindsight document per moment: document id `tm:<id>`, content
 * `# <name>\n\n<description>\n\n<body>` (at most 3000 characters, so the "chunks" extraction mode stores exactly one
 * unit), tags `ultrathink`, `teachable`, `project:<project>`, `host:<host>`, `kind:<kind>`, `status:<status>` plus the
 * moment's own sanitized tags, string metadata `tm_id, schema ("tm/2"), name, kind, status, origin, project, host,
 * confidence, occurrences, created_at, last_seen_at, source_phase, source_artifacts (JSON), related_ids (JSON)`.
 */
import type { DecisionsConfig } from "../decisions/types.ts";
import type { HindsightClient, HindsightConfig } from "../hindsight/types.ts";

export const MOMENT_KINDS = ["bug", "pitfall", "pattern", "decision", "playbook"] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];

/** candidate: found by `observe`, local only. confirmed: kept (explicit capture, `teach confirm`, or auto mode). promoted: a skill was made. superseded: replaced. */
export const MOMENT_STATUSES = ["candidate", "confirmed", "promoted", "superseded"] as const;
export type MomentStatus = (typeof MOMENT_STATUSES)[number];

export const MOMENT_ORIGINS = ["explicit", "observe", "import"] as const;
export type MomentOrigin = (typeof MOMENT_ORIGINS)[number];

export const MAX_NAME_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 300;
export const MAX_BODY_CHARS = 2_400;

export interface TeachableMoment {
	// Schema v1 (docs/teachable-moment-schema.md), unchanged.
	id: string;
	/** Short, teachable title, e.g. "tsc rejects value imports of types: use import type". */
	name: string;
	description: string;
	body: string;
	/** Phase, graph node or issue the lesson came from. */
	sourcePhase: string;
	sourceArtifacts: string[];
	/** ISO 8601 UTC. */
	createdAt: string;
	tags: string[];
	relatedIds: string[];
	// Schema v2.
	schema: 2;
	kind: MomentKind;
	status: MomentStatus;
	origin: MomentOrigin;
	/** Lowercase basename of the repository's primary checkout, "unknown" outside a repository (same rule as aimee's `project:` tag). */
	project: string;
	/** Host that captured it first. */
	host: string;
	/** 0..1. Explicit captures are 1. */
	confidence: number;
	/** Times this lesson was captured (same `dedupeKey`), at least 1. */
	occurrences: number;
	lastSeenAt: string;
	/** sha256 hex of `project|kind|normalized name`, first 32 characters. */
	dedupeKey: string;
	/** Times this machine injected the lesson into a plan. */
	recalled: number;
	supersedes?: string;
	/** Set once Hindsight confirmed the write. */
	retained?: { at: string; bank: string; documentId: string };
	promoted?: { at: string; skill: string; target: SkillTarget; path?: string };
}

export const CAPTURE_MODES = ["explicit", "observe", "auto"] as const;
/**
 * explicit: only `teach capture` (CLI, agent tool, slash command) creates moments, nothing runs in the background.
 * observe: hosts also hand finished turns to `teach observe`, which stores local *candidates* for a human to confirm.
 * auto: candidates that pass the gate are confirmed and retained without a human step.
 */
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export interface TeachConfig {
	/** Master switch (on by default). A project file can only turn it off. */
	enabled: boolean;
	/** A project file can only lower it (auto -> observe -> explicit). */
	capture: CaptureMode;
	/** Inject recalled lessons and skills into plans. */
	recall: boolean;
	/** Lessons per plan, 1..10. */
	recallLimit: number;
	/** Cap on the characters of the lessons section (Hermes spills pieces over 10 000, the handoff budget is 9 000). */
	recallChars: number;
	/** Occurrences before a confirmed moment is offered as a skill. */
	promoteAfter: number;
	/** Install promoted skills without a human step. User files only; default on. */
	autoPromote: boolean;
	/** `observe` skips turns with fewer tool calls than this. */
	observeMinToolCalls: number;
	/** Budget (ms) for the recall inside the planner. */
	timeoutMs: number;
}

export const DEFAULT_TEACH_CONFIG: TeachConfig = {
	enabled: true,
	capture: "auto",
	recall: true,
	recallLimit: 5,
	recallChars: 3_000,
	promoteAfter: 3,
	autoPromote: true,
	observeMinToolCalls: 4,
	timeoutMs: 2_500,
};

/** `ULTRATHINK_TEACH=0` turns Teachable Moments off for the process, whatever any config says. */
export const TEACH_KILL_ENV = "ULTRATHINK_TEACH";

/** What every operation needs. Seams (`now`, `fetch`, `hindsight`, `complete`, `signal`) exist for tests and hosts. */
export interface TeachContext {
	/** Host the call runs for (a HostId, or another string for tests). */
	host: string;
	/** Working directory of the session; the project name derives from it. */
	cwd: string;
	sessionId?: string;
	/** `decisions` is the Jev (OpenRouter Decisions) section; absent = no Jev point runs (tests, hosts that build a context by hand). */
	config: { teach: TeachConfig; hindsight: HindsightConfig; decisions?: DecisionsConfig };
	env: NodeJS.ProcessEnv;
	/** The host's state directory; the store lives in `<stateDir>/teach`. Never under `.planning`. */
	stateDir: string;
	/** Credential store path (src/mcp/store.ts `storePath`). */
	storePath?: string;
	now?: () => number;
	fetch?: typeof fetch;
	/** Injected Hindsight client (tests); otherwise resolved from `config.hindsight`, the credential store and `env`. */
	hindsight?: HindsightClient;
	/** One LLM completion (system, user) -> text; `observe` uses it to distill lessons. Default: the configured planning engine. */
	complete?: (system: string, user: string, signal?: AbortSignal) => Promise<string>;
	signal?: AbortSignal;
	log?: (line: string) => void;
}

export interface CaptureInput {
	name: string;
	description?: string;
	body: string;
	kind?: MomentKind;
	tags?: string[];
	sourcePhase?: string;
	sourceArtifacts?: string[];
	relatedIds?: string[];
	/** Default 1 for explicit, 0.5 for observe. */
	confidence?: number;
	/** Default "explicit". */
	origin?: MomentOrigin;
	/** Mark another moment (by id) superseded by this one. */
	supersedes?: string;
	/** Default "confirmed" for explicit and import, "candidate" for observe unless the mode is auto. */
	status?: MomentStatus;
}

/** retained: Hindsight confirmed. queued: written locally, in the outbox. local-only: Hindsight is off, not ready, or the moment is a candidate. off: Teachable Moments is off, nothing was stored. */
export type RetainState = "retained" | "queued" | "local-only" | "off";

export interface CaptureOutcome {
	moment: TeachableMoment;
	/** False when the moment merged into an existing one (same `dedupeKey`: occurrences + 1). */
	created: boolean;
	retain: RetainState;
	reason?: string;
}

export interface SyncOutcome {
	/** Outbox entries completed. */
	done: number;
	/** Entries still waiting (failed or not yet due). */
	pending: number;
	/** First failure, one line. */
	reason?: string;
}

export interface RecallRequest {
	/** The user's prompt or any search text. */
	query: string;
	limit?: number;
	/** Overrides `config.teach.recallChars`. */
	chars?: number;
	/** Restrict to one project; default the context's project. `"*"` searches every project. */
	project?: string;
}

export interface RecalledLesson {
	id: string;
	name: string;
	description: string;
	body: string;
	kind: MomentKind;
	project: string;
	host: string;
	occurrences: number;
	createdAt: string;
	source: "hindsight" | "local";
}

export type RecallStatus = "used" | "none" | "off" | "error";

export interface RecallOutcome {
	status: RecallStatus;
	lessons: RecalledLesson[];
	source: "hindsight" | "local" | "none";
	/** Characters of the formatted section, 0 unless `status` is "used". */
	chars: number;
	ms: number;
	/** One line when `status` is "error" or "off". */
	reason?: string;
}

/** The record a session keeps of one lessons lookup (no lesson text), like the Greptile knowledge lookup. */
export interface LessonsLookup {
	outcome: RecallStatus;
	count: number;
	ids: string[];
	chars: number;
	ms: number;
	source: "hindsight" | "local" | "none";
	reason?: string;
}

/** One promoted skill matched to a prompt: a pointer, not the skill body (the lesson text already recalls). */
export interface RecalledSkill {
	name: string;
	description: string;
	/** Absolute SKILL.md path when known (drafts always; installs when the moment recorded it). */
	path?: string;
	target: SkillTarget;
	/** Moments the skill was made from. */
	sourceIds: string[];
	occurrences: number;
}

export interface SkillRecallOutcome {
	status: RecallStatus;
	skills: RecalledSkill[];
	/** Characters of the formatted section, 0 unless `status` is "used". */
	chars: number;
	ms: number;
	/** One line when `status` is "error" or "off". */
	reason?: string;
}

/** The record a session keeps of one skills lookup (names only, no skill text). */
export interface SkillsLookup {
	outcome: RecallStatus;
	count: number;
	names: string[];
	chars: number;
	ms: number;
	reason?: string;
}

export const DIGEST_MAX_TURNS = 60;
export const DIGEST_MAX_CHARS = 24_000;
export const DIGEST_TURN_CHARS = 1_500;

export interface DigestTurn {
	role: "user" | "assistant" | "tool";
	text: string;
	/** Tool name for role "tool" (and for an assistant turn that only called a tool). */
	tool?: string;
	isError?: boolean;
}

/** A finished turn, reduced by a host to what `observe` needs. Hosts redact nothing: `observe` does, before anything is stored or sent. */
export interface TeachDigest {
	host: string;
	sessionId: string;
	cwd: string;
	/** ISO 8601 UTC. */
	at: string;
	turns: DigestTurn[];
	toolCalls: number;
	outcome?: "completed" | "failed" | "interrupted";
}

export interface ObserveOutcome {
	/** Why nothing was done ("off", "too short", "subagent", ...). */
	skipped?: string;
	captured: CaptureOutcome[];
	ms: number;
}

export type SkillTarget = "hermes" | "omp" | "claude" | "drafts";

export interface SkillDraft {
	/** Lowercase `[a-z0-9][a-z0-9-]{0,63}`. */
	name: string;
	/** One sentence, at most 60 characters, ends with a period (Hermes' limit for new skills), trigger first. */
	description: string;
	/** Markdown body without frontmatter. */
	body: string;
	/** The whole SKILL.md (frontmatter + body). */
	content: string;
	/** Moments the skill was made from. */
	sourceIds: string[];
	warnings: string[];
}

/** drafted: written under `<stateDir>/teach/skill-drafts`. created/updated: written into the host's skill directory. refused: nothing written (name taken by an authored skill, symlink, invalid draft). */
export interface InstallOutcome {
	target: SkillTarget;
	path: string;
	action: "drafted" | "created" | "updated" | "refused";
	reason?: string;
}

export type OutboxOp =
	| { op: "retain"; momentId: string }
	| { op: "delete"; documentId: string }
	| { op: "tags"; documentId: string; tags: string[] };

export interface OutboxEntry {
	id: string;
	op: OutboxOp;
	attempts: number;
	/** Epoch ms before which the entry is not retried. */
	nextAt: number;
	enqueuedAt: number;
	lastError?: string;
}

/** Synchronous, file-backed, safe for several processes (one JSON file per moment and per outbox entry, written atomically). */
export interface TeachStore {
	/** `<stateDir>/teach`. */
	readonly dir: string;
	list(): TeachableMoment[];
	get(id: string): TeachableMoment | undefined;
	findByDedupeKey(key: string): TeachableMoment | undefined;
	put(moment: TeachableMoment): void;
	remove(id: string): boolean;
	/** Adds 1 to `recalled` for each id that exists. */
	bumpRecalled(ids: string[]): void;
	enqueue(op: OutboxOp, now: number): OutboxEntry;
	outbox(): OutboxEntry[];
	ack(entryId: string): void;
	/** Records a failed attempt and schedules the next one with exponential backoff (1 min doubling, capped at 6 h). */
	fail(entryId: string, reason: string, now: number): void;
}

export interface CliResult {
	code: number;
	text: string;
}

export type CaptureFn = (input: CaptureInput, ctx: TeachContext) => Promise<CaptureOutcome>;
export type RecallFn = (request: RecallRequest, ctx: TeachContext) => Promise<RecallOutcome>;
export type ObserveFn = (digest: TeachDigest, ctx: TeachContext) => Promise<ObserveOutcome>;
