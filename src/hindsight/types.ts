// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Shared types for the Hindsight integration (vectorize-io/hindsight HTTP API, tested against 0.9.1): the `hindsight`
 * config section, the client contract and its result and error shapes. Imports nothing, so every layer can depend on it.
 *
 * Wire facts the implementation relies on (all under `/v1/default/banks/{bank}`): `POST /memories` retains `items[]`,
 * `POST /memories/recall` searches, `GET|PATCH|DELETE /documents/{id}` manage one document, `PUT /banks/{bank}` creates
 * a bank and `PATCH /config {"updates": {...}}` sets `retain_extraction_mode`. `GET /health` and `GET /version` need no
 * key; everything else needs `Authorization: Bearer <key>` when the server runs the API-key tenant extension.
 */

export interface HindsightConfig {
	/** Opt-in. A project file can only turn it off. */
	enabled: boolean;
	/** Base URL of the Hindsight API ("" until set). User files only; the `HINDSIGHT_API_URL` env var fills in when empty. */
	url: string;
	/** Bank that holds ultrathink's records. User files only. */
	bank: string;
	/** Budget (ms) for health, bank, document and recall requests. */
	timeoutMs: number;
	/** Budget (ms) for one retain. */
	retainTimeoutMs: number;
}

export const DEFAULT_HINDSIGHT_CONFIG: HindsightConfig = {
	enabled: false,
	url: "",
	bank: "ultrathink",
	timeoutMs: 5_000,
	retainTimeoutMs: 15_000,
};

/** Environment variables that supply the key when none is stored, in order. */
export const HINDSIGHT_KEY_ENVS = ["HINDSIGHT_API_KEY", "HINDSIGHT_API_TOKEN"] as const;
export const HINDSIGHT_URL_ENV = "HINDSIGHT_API_URL";
/** `ULTRATHINK_HINDSIGHT=0` turns the integration off for the process, whatever any config says. */
export const HINDSIGHT_KILL_ENV = "ULTRATHINK_HINDSIGHT";

export type HindsightErrorKind =
	| "auth" // 401 / 403
	| "not-found" // 404 on something that must exist (a bank, a route)
	| "bad-request" // 400 / 409 / 422
	| "rate-limit" // 429
	| "server" // 5xx
	| "timeout"
	| "network"
	| "invalid-response"; // 2xx with a body the contract does not allow

export interface HindsightError {
	kind: HindsightErrorKind;
	/** One line, at most 200 characters, never the key or request content. */
	message: string;
	status?: number;
}

export type HindsightResult<T> = { ok: true; value: T } | { ok: false; error: HindsightError };

export interface RetainItem {
	/** Hindsight document id; retaining the same id again replaces the document (idempotent upsert). */
	documentId: string;
	content: string;
	context?: string;
	tags: string[];
	/** String values only (Hindsight drops nulls). */
	metadata?: Record<string, string>;
	/** ISO 8601; defaults to now on the server. */
	timestamp?: string;
}

export interface RetainOutcome {
	bankId: string;
	documentId: string;
	itemsCount: number;
}

export type TagsMatch = "any" | "all" | "any_strict" | "all_strict" | "exact";

export interface RecallQuery {
	/** At most ~500 tokens; callers truncate. */
	query: string;
	tags?: string[];
	tagsMatch?: TagsMatch;
	/** Compound tag filter, passed through as Hindsight `tag_groups` (groups are AND-ed). */
	tagGroups?: unknown[];
	/** Fact types to search; defaults to ["world", "experience", "observation"]. */
	types?: string[];
	maxTokens?: number;
	budget?: "low" | "mid" | "high";
}

export interface RecallHit {
	id: string;
	text: string;
	documentId?: string;
	tags: string[];
	/** Metadata as stored (string values). */
	metadata: Record<string, string>;
	type?: string;
	context?: string;
	mentionedAt?: string;
}

export interface DocumentInfo {
	id: string;
	tags: string[];
	createdAt?: string;
	updatedAt?: string;
	memoryUnitCount?: number;
}

export interface HindsightHealth {
	/** `GET /health` answered `healthy` with the database connected. */
	ok: boolean;
	apiVersion: string;
	databaseConnected: boolean;
	/** `GET /version` features map, e.g. { observations: false, worker: false }. */
	features: Record<string, boolean>;
}

export interface BankState {
	bankId: string;
	/** True when this call created the bank. */
	created: boolean;
	/** The bank's resolved `retain_extraction_mode`; ultrathink needs "chunks" (stores text as-is, no server-side LLM). */
	extractionMode: string;
}

export interface HindsightClientOptions {
	url: string;
	apiKey: string;
	bank: string;
	timeoutMs: number;
	retainTimeoutMs: number;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

/** Never rejects except with an AbortError when the caller's signal aborts. */
export interface HindsightClient {
	readonly bank: string;
	health(): Promise<HindsightResult<HindsightHealth>>;
	/** Idempotent: creates the bank if missing and sets `retain_extraction_mode` to "chunks" when it is not; cached per client. */
	ensureBank(): Promise<HindsightResult<BankState>>;
	retain(item: RetainItem): Promise<HindsightResult<RetainOutcome>>;
	recall(query: RecallQuery): Promise<HindsightResult<RecallHit[]>>;
	/** `value: null` when the document does not exist. */
	getDocument(documentId: string): Promise<HindsightResult<DocumentInfo | null>>;
	/** `value: false` when it was already gone (404 is not an error). */
	deleteDocument(documentId: string): Promise<HindsightResult<boolean>>;
	setDocumentTags(documentId: string, tags: string[]): Promise<HindsightResult<true>>;
	/** Destructive. Only the smoke check's throwaway `ultrathink-smoke-*` banks are ever deleted by ultrathink. */
	deleteBank(): Promise<HindsightResult<true>>;
}

export type HindsightKeySource = "store" | (typeof HINDSIGHT_KEY_ENVS)[number];

export type HindsightReadiness =
	| { state: "ready"; url: string; bank: string; keySource: HindsightKeySource }
	| { state: "off"; reason: "disabled" | "killed" }
	| { state: "unready"; reason: "no-url" | "bad-url" | "no-key"; detail?: string };

export interface HindsightResolution {
	readiness: HindsightReadiness;
	/** Present only when `readiness.state === "ready"`. */
	client?: HindsightClient;
}
