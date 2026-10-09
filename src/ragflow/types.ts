// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Shared types for the RAGFlow integration (infiniflow/ragflow REST API, deployed 0.27.1): the `ragflow` config
 * section, the client contract and the planner-grounding outcome. Imports nothing, so every layer can depend on it.
 *
 * Wire facts the implementation relies on: `Authorization: Bearer <api key>`; `GET /api/v1/datasets?page&page_size`
 * lists datasets as `{code:0,data:[...],total}`; `POST /api/v1/retrieval {question, dataset_ids, page, page_size,
 * similarity_threshold, vector_similarity_weight, top_k}` returns `{code:0,data:{chunks:[...],total}}`. A failure is
 * HTTP 200/4xx with `{code != 0, message}` (109 = authentication, 108 = permission, 101/102 = bad argument). NEVER call
 * `/v1/system/healthz` or `/api/v1/system/healthz`: on the operator's deployment it blocks the single API worker for
 * minutes while it retries an unreachable object store. The health probe is `GET /api/v1/datasets?page=1&page_size=1`.
 */

export interface RagflowConfig {
	/** Opt-in. A project file can only turn it off. */
	enabled: boolean;
	/** Base URL of the RAGFlow web/API origin ("" until set). User files only; the `RAGFLOW_URL` env var fills in when empty. */
	url: string;
	/** Datasets to search. Empty means every dataset the key can see (listed once per process). User files only. */
	datasetIds: string[];
	/** Chunks returned per search (the request's `page_size`). */
	topK: number;
	/** RAGFlow `similarity_threshold`, 0..1. */
	similarityThreshold: number;
	/** Budget (ms) for one request. */
	timeoutMs: number;
	/** Add retrieved document excerpts to the planner's context. */
	ground: boolean;
	/** Cap on the characters of excerpts added to the planner's context. */
	groundChars: number;
	/**
	 * Absent or `"direct"` uses the RAGFlow API and its key. `"gateway"` calls the desk gateway
	 * and does not read a RAGFlow key. A project file cannot set this.
	 */
	backend?: "direct" | "gateway";
}

export const DEFAULT_RAGFLOW_CONFIG: RagflowConfig = {
	enabled: false,
	url: "",
	datasetIds: [],
	topK: 5,
	similarityThreshold: 0.2,
	timeoutMs: 8_000,
	ground: false,
	groundChars: 3_000,
};

export const RAGFLOW_KEY_ENV = "RAGFLOW_API_KEY";
export const RAGFLOW_URL_ENV = "RAGFLOW_URL";
/** `ULTRATHINK_RAGFLOW=0` turns the integration off for the process, whatever any config says. */
export const RAGFLOW_KILL_ENV = "ULTRATHINK_RAGFLOW";

export type RagflowErrorKind =
	| "auth" // HTTP 401/403 or body code 109/108
	| "not-found"
	| "bad-request" // HTTP 400/422 or body code 101/102
	| "rate-limit"
	| "server" // 5xx
	| "api-error" // HTTP 2xx with body code != 0 that is none of the above
	| "timeout"
	| "network"
	| "invalid-response";

export interface RagflowError {
	kind: RagflowErrorKind;
	/** One line, at most 200 characters, never the key or the question. */
	message: string;
	status?: number;
	/** RAGFlow's body `code`, when the response carried one. */
	code?: number;
}

export type RagflowResult<T> = { ok: true; value: T } | { ok: false; error: RagflowError };

export interface RagflowDataset {
	id: string;
	name: string;
	description?: string;
	chunkCount?: number;
	documentCount?: number;
	embeddingModel?: string;
}

export interface RagflowChunk {
	id: string;
	content: string;
	documentId?: string;
	/** RAGFlow's `document_keyword` (the file name). */
	documentName?: string;
	datasetId?: string;
	similarity?: number;
}

export interface RetrieveQuery {
	question: string;
	datasetIds: string[];
	topK?: number;
	similarityThreshold?: number;
}

export interface RagflowClientOptions {
	url: string;
	apiKey: string;
	timeoutMs: number;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

/** Never rejects except with an AbortError when the caller's signal aborts. */
export interface RagflowClient {
	/** `GET /api/v1/datasets?page=1&page_size=1`; `value.datasets` is the server's total. */
	health(): Promise<RagflowResult<{ datasets: number }>>;
	/** Pages of 100 until an empty page or `total`, at most 1000 datasets. */
	listDatasets(): Promise<RagflowResult<RagflowDataset[]>>;
	retrieve(query: RetrieveQuery): Promise<RagflowResult<RagflowChunk[]>>;
}

export type RagflowKeySource = "store" | typeof RAGFLOW_KEY_ENV;

export type RagflowReadiness =
	| { state: "ready"; url: string; keySource: RagflowKeySource }
	| { state: "ready"; backend: "gateway"; url: string; seat: string; tokenSource: "store" | "DESK_GATEWAY_TOKEN" }
	| { state: "off"; reason: "disabled" | "killed" }
	| { state: "unready"; reason: "no-url" | "bad-url" | "no-key" | "no-token"; detail?: string };

export interface RagflowResolution {
	readiness: RagflowReadiness;
	/** Present only when `readiness.state === "ready"`. */
	client?: RagflowClient;
}

export type GroundStatus = "used" | "none" | "off" | "error";

/** What one planner-grounding lookup did; recorded on the session like the Greptile knowledge lookup. */
export interface GroundOutcome {
	status: GroundStatus;
	chunks: RagflowChunk[];
	/** Characters of the formatted section, 0 unless `status` is "used". */
	chars: number;
	ms: number;
	/** Datasets searched. */
	datasets: number;
	/** One line when `status` is "error" or "off". */
	reason?: string;
}

/** The record a session keeps of one grounding lookup (no document text). */
export interface DocsLookup {
	status: GroundStatus;
	/** Excerpts included in the plan context. */
	count: number;
	chars: number;
	ms: number;
	datasets: number;
	reason?: string;
}
