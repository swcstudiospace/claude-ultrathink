// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Hand-written client for the RAGFlow REST API (0.27.1, Python): dataset listing and retrieval with a Bearer key. RAGFlow
 * answers failures as HTTP 200 with `{code != 0, message}` as often as with an HTTP error, so every response is judged
 * on both. Never rejects except with an AbortError when the caller's signal aborts; errors are classified, one line, and
 * free of the key and the question. The health probe is a one-row dataset listing: the documented healthz route blocks
 * the operator's single API worker for minutes (see ./types.ts).
 */
import { redactSecrets } from "../grok/auth.ts";
import { type HttpOutcome, requestJson } from "../net/http.ts";
import { checkServiceUrl } from "../net/safe-url.ts";
import type {
	RagflowChunk,
	RagflowClient,
	RagflowClientOptions,
	RagflowDataset,
	RagflowError,
	RagflowErrorKind,
	RagflowResult,
	RetrieveQuery,
} from "./types.ts";

const MAX_MESSAGE_CHARS = 200;
const PAGE_SIZE = 100;
const MAX_DATASETS = 1000;
const DEFAULT_TOP_K = 5;
const DEFAULT_SIMILARITY = 0.2;

type Body = Record<string, unknown>;

function isRecord(value: unknown): value is Body {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function failure(kind: RagflowErrorKind, detail: string, extra: { status?: number; code?: number } = {}): RagflowResult<never> {
	const message = `ragflow ${kind}: ${detail}`;
	const error: RagflowError = { kind, message: message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS - 3)}...` : message };
	if (extra.status !== undefined) error.status = extra.status;
	if (extra.code !== undefined) error.code = extra.code;
	return { ok: false, error };
}

function statusKind(status: number): RagflowErrorKind | undefined {
	if (status === 401 || status === 403) return "auth";
	if (status === 404) return "not-found";
	if (status === 400 || status === 422) return "bad-request";
	if (status === 429) return "rate-limit";
	if (status >= 500) return "server";
	return undefined;
}

function codeKind(code: number): RagflowErrorKind {
	if (code === 109 || code === 108) return "auth";
	if (code === 101 || code === 102) return "bad-request";
	return "api-error";
}

export function createRagflowClient(options: RagflowClientOptions): RagflowClient {
	const checked = checkServiceUrl(options.url);
	if (!checked.ok) throw new Error(`ragflow url: ${checked.reason}`);
	const apiKey = options.apiKey.trim();
	if (apiKey === "") throw new Error("ragflow: api key is empty");
	const base = checked.url;

	/** One line of server text with the key (and anything the caller marks secret) removed. */
	const clean = (text: string, secrets: readonly string[]): string => {
		let out = text.replaceAll(apiKey, "[redacted]");
		for (const secret of secrets) if (secret.length > 0) out = out.replaceAll(secret, "[redacted]");
		return redactSecrets(out).replace(/\s+/g, " ").trim();
	};

	/** The `{code:0,...}` body of a successful call, or the classified failure. `secrets` are masked in error detail. */
	async function call(
		path: string,
		body: unknown,
		secrets: readonly string[],
	): Promise<RagflowResult<{ body: Body; ms: number }>> {
		const outcome: HttpOutcome = await requestJson(`${base}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { Authorization: `Bearer ${apiKey}` },
			body,
			timeoutMs: options.timeoutMs,
			signal: options.signal,
			fetch: options.fetch,
		});
		if (outcome.kind === "timeout") return failure("timeout", `no response within ${options.timeoutMs} ms`);
		if (outcome.kind === "network") return failure("network", clean(outcome.message, secrets) || "request failed");
		const { status, json } = outcome;
		const record = isRecord(json) ? json : undefined;
		const code = record && isNumber(record.code) ? record.code : undefined;
		const detail = record && typeof record.message === "string" ? clean(record.message, secrets) : "";
		const extra = { status, ...(code !== undefined ? { code } : {}) };
		if (status < 200 || status >= 300) {
			return failure(statusKind(status) ?? "api-error", detail || `HTTP ${status}`, extra);
		}
		if (!record || code === undefined) return failure("invalid-response", "response is not a {code, data} object", { status });
		if (code !== 0) return failure(codeKind(code), detail || `code ${code}`, extra);
		return { ok: true, value: { body: record, ms: outcome.ms } };
	}

	async function listPage(page: number, pageSize: number): Promise<RagflowResult<{ items: unknown[]; total?: number }>> {
		const result = await call(`/api/v1/datasets?page=${page}&page_size=${pageSize}`, undefined, []);
		if (!result.ok) return result;
		const { data, total } = result.value.body;
		if (!Array.isArray(data)) return failure("invalid-response", "datasets response has no data array");
		return { ok: true, value: { items: data, total: isNumber(total) ? total : undefined } };
	}

	return {
		async health() {
			const page = await listPage(1, 1);
			if (!page.ok) return page;
			return { ok: true, value: { datasets: page.value.total ?? page.value.items.length } };
		},

		async listDatasets() {
			const datasets: RagflowDataset[] = [];
			let seen = 0;
			for (let page = 1; seen < MAX_DATASETS; page++) {
				const result = await listPage(page, PAGE_SIZE);
				if (!result.ok) return result;
				const { items, total } = result.value;
				if (items.length === 0) break;
				seen += items.length;
				for (const item of items) {
					if (!isRecord(item) || typeof item.id !== "string") continue;
					const dataset: RagflowDataset = { id: item.id, name: typeof item.name === "string" ? item.name : item.id };
					if (typeof item.description === "string") dataset.description = item.description;
					if (isNumber(item.chunk_count)) dataset.chunkCount = item.chunk_count;
					if (isNumber(item.document_count)) dataset.documentCount = item.document_count;
					if (typeof item.embedding_model === "string") dataset.embeddingModel = item.embedding_model;
					datasets.push(dataset);
				}
				if (items.length < PAGE_SIZE || (total !== undefined && seen >= total)) break;
			}
			return { ok: true, value: datasets.slice(0, MAX_DATASETS) };
		},

		async retrieve(query: RetrieveQuery) {
			const question = query.question.trim();
			if (question === "") return failure("bad-request", "question is empty");
			if (query.datasetIds.length === 0) return failure("bad-request", "no datasets to search");
			const result = await call(
				"/api/v1/retrieval",
				{
					question: query.question,
					dataset_ids: query.datasetIds,
					page: 1,
					page_size: query.topK ?? DEFAULT_TOP_K,
					similarity_threshold: query.similarityThreshold ?? DEFAULT_SIMILARITY,
					vector_similarity_weight: 0.3,
					top_k: 1024,
				},
				[query.question, question],
			);
			if (!result.ok) return result;
			const data = result.value.body.data;
			if (!isRecord(data) || !Array.isArray(data.chunks)) return failure("invalid-response", "retrieval response has no data.chunks array");
			const chunks: RagflowChunk[] = [];
			for (const item of data.chunks) {
				if (!isRecord(item) || typeof item.id !== "string" || typeof item.content !== "string") continue;
				const chunk: RagflowChunk = { id: item.id, content: item.content };
				if (typeof item.document_id === "string") chunk.documentId = item.document_id;
				if (typeof item.document_keyword === "string") chunk.documentName = item.document_keyword;
				if (typeof item.dataset_id === "string") chunk.datasetId = item.dataset_id;
				if (isNumber(item.similarity)) chunk.similarity = item.similarity;
				chunks.push(chunk);
			}
			return { ok: true, value: chunks };
		},
	};
}
