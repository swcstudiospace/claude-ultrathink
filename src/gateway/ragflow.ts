// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * RagflowClient backed by desk_docs_search. Dataset listing is not a desk tool:
 * `listDatasets` returns one placeholder so grounding can call `retrieve`, which
 * searches the seat's datasets and does not send dataset ids.
 */
import type { RagflowChunk, RagflowClient, RagflowDataset, RagflowError, RagflowResult, RetrieveQuery } from "../ragflow/types.ts";
import { createGatewayClient, type GatewayClientOptions } from "./client.ts";
import type { GatewayFailure } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(failure: GatewayFailure): RagflowResult<never> {
	const kind = failure.reason.includes("timeout") ? "timeout" : failure.state === "unready" ? "not-found" : "server";
	const error: RagflowError = { kind, message: failure.reason };
	return { ok: false, error };
}

function chunksFrom(payload: Record<string, unknown>): RagflowChunk[] {
	const rows = Array.isArray(payload.results) ? payload.results : [];
	const chunks: RagflowChunk[] = [];
	for (const row of rows) {
		if (!isRecord(row) || typeof row.content !== "string" || row.content === "") continue;
		const chunk: RagflowChunk = { id: typeof row.id === "string" ? row.id : `chunk-${chunks.length}`, content: row.content };
		if (typeof row.document === "string") chunk.documentName = row.document;
		else if (typeof row.document_keyword === "string") chunk.documentName = row.document_keyword;
		if (typeof row.dataset_id === "string") chunk.datasetId = row.dataset_id;
		if (typeof row.score === "number") chunk.similarity = row.score;
		else if (typeof row.similarity === "number") chunk.similarity = row.similarity;
		chunks.push(chunk);
	}
	return chunks;
}

export function createGatewayRagflowClient(options: GatewayClientOptions): RagflowClient {
	const gateway = createGatewayClient(options);

	return {
		async health() {
			const result = await gateway.call("desk_docs_search", { query: "ping", limit: 1 });
			if (!result.ok) return asError(result);
			return { ok: true, value: { datasets: chunksFrom(result.value).length } };
		},
		listDatasets(): Promise<RagflowResult<RagflowDataset[]>> {
			return Promise.resolve({ ok: true, value: [{ id: "gateway", name: "desk" }] });
		},
		async retrieve(query: RetrieveQuery) {
			const text = query.question.trim();
			if (text.length < 2) return { ok: false, error: { kind: "bad-request", message: "degraded: search query is shorter than 2 characters" } };
			const limit = Math.min(20, Math.max(1, query.topK ?? 8));
			const args: Record<string, unknown> = { query: text.slice(0, 500), limit };
			const result = await gateway.call("desk_docs_search", args);
			if (!result.ok) return asError(result);
			return { ok: true, value: chunksFrom(result.value) };
		},
	};
}
