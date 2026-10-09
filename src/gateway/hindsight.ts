// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * HindsightClient backed by desk_memory_recall and desk_memory_retain.
 * Other document and bank methods are not desk tools: they fail closed with a
 * one-line reason and send nothing.
 */
import type {
	BankState,
	DocumentInfo,
	HindsightClient,
	HindsightError,
	HindsightHealth,
	HindsightResult,
	RecallHit,
	RecallQuery,
	RetainItem,
	RetainOutcome,
} from "../hindsight/types.ts";
import { createGatewayClient, type GatewayClientOptions } from "./client.ts";
import { GRAPH_ID_PATTERN, type GatewayFailure } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(failure: GatewayFailure): HindsightResult<never> {
	const kind = failure.reason.includes("timeout") ? "timeout" : failure.state === "unready" ? "not-found" : "server";
	const error: HindsightError = { kind, message: failure.reason };
	return { ok: false, error };
}

function unavailable(what: string): HindsightResult<never> {
	return { ok: false, error: { kind: "not-found", message: `unready: ${what} is not a gateway tool` } };
}

function hitsFrom(payload: Record<string, unknown>): RecallHit[] | GatewayFailure {
	const rows = Array.isArray(payload.results) ? payload.results : [];
	const hits: RecallHit[] = [];
	let nested: string | undefined;
	for (const row of rows) {
		if (!isRecord(row)) continue;
		if (typeof row.error === "string" && nested === undefined) {
			nested = `degraded: ${row.error}: ${typeof row.reason === "string" ? row.reason : row.error}`;
		}
		const body = isRecord(row.body) ? row.body : row;
		const list = Array.isArray(body.results) ? body.results : Array.isArray(body.content) ? body.content : [];
		const items = list.length > 0 ? list : typeof body.text === "string" ? [body] : [];
		for (const item of items) {
			if (!isRecord(item)) continue;
			const text = typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "";
			if (!text) continue;
			const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : [];
			const hit: RecallHit = {
				id: typeof item.id === "string" ? item.id : String(hits.length),
				text,
				tags,
				metadata: {},
			};
			if (typeof item.document_id === "string") hit.documentId = item.document_id;
			hits.push(hit);
		}
	}
	if (hits.length === 0 && nested) return { state: "degraded", reason: nested.slice(0, 200) };
	return hits;
}

function sourceFor(item: RetainItem): string | undefined {
	const raw = item.metadata?.source ?? item.metadata?.url;
	if (typeof raw === "string" && /^https:\/\/\S+$/.test(raw) && raw.length <= 500) return raw;
	const receipt = item.metadata?.receipt_path;
	if (typeof receipt === "string" && /^\.receipts\/bot-0[0-6]-[a-z-]+\/[A-Za-z0-9._-]+\.json$/.test(receipt)) return undefined;
	const id = encodeURIComponent(item.documentId).slice(0, 200);
	return `https://example.com/ultrathink/documents/${id}`;
}

export function createGatewayHindsightClient(options: GatewayClientOptions & { seat: string }): HindsightClient {
	const gateway = createGatewayClient(options);

	return {
		bank: options.seat,
		async health(): Promise<HindsightResult<HindsightHealth>> {
			const result = await gateway.call("desk_memory_recall", { query: "ping", limit: 1, include_shared: false });
			if (!result.ok) return asError(result);
			return { ok: true, value: { ok: true, apiVersion: "gateway", databaseConnected: true, features: {} } };
		},
		async ensureBank(): Promise<HindsightResult<BankState>> {
			return { ok: true, value: { bankId: options.seat, created: false, extractionMode: "chunks" } };
		},
		async retain(item: RetainItem): Promise<HindsightResult<RetainOutcome>> {
			if (item.content.trim().length < 8) {
				return { ok: false, error: { kind: "bad-request", message: "degraded: retain content is shorter than 8 characters" } };
			}
			const args: Record<string, unknown> = { content: item.content.slice(0, 8000) };
			const receipt = item.metadata?.receipt_path;
			if (typeof receipt === "string" && /^\.receipts\/bot-0[0-6]-[a-z-]+\/[A-Za-z0-9._-]+\.json$/.test(receipt)) args.receipt_path = receipt;
			else {
				const source = sourceFor(item);
				if (!source) return { ok: false, error: { kind: "bad-request", message: "degraded: retain needs receipt_path or source" } };
				args.source = source;
			}
			const tags = item.tags.map((tag) => tag.slice(0, 40)).filter((tag) => tag !== "").slice(0, 10);
			if (tags.length > 0) args.tags = tags;
			const graphId = item.metadata?.graph_id;
			if (typeof graphId === "string" && GRAPH_ID_PATTERN.test(graphId)) args.graph_id = graphId;
			const result = await gateway.call("desk_memory_retain", args);
			if (!result.ok) return asError(result);
			if (result.value.ok !== true) {
				return { ok: false, error: { kind: "server", message: "degraded: retain was not accepted" } };
			}
			const bankId = typeof result.value.bank === "string" ? result.value.bank : options.seat;
			return { ok: true, value: { bankId, documentId: item.documentId, itemsCount: 1 } };
		},
		async recall(query: RecallQuery): Promise<HindsightResult<RecallHit[]>> {
			const text = query.query.trim();
			if (text.length < 2) return { ok: false, error: { kind: "bad-request", message: "degraded: recall query is shorter than 2 characters" } };
			const args: Record<string, unknown> = { query: text.slice(0, 500), include_shared: true };
			if (query.maxTokens !== undefined) args.limit = Math.min(20, Math.max(1, Math.round(query.maxTokens / 400)));
			const result = await gateway.call("desk_memory_recall", args);
			if (!result.ok) return asError(result);
			const hits = hitsFrom(result.value);
			if (!Array.isArray(hits)) return asError(hits);
			return { ok: true, value: hits };
		},
		getDocument(_documentId: string): Promise<HindsightResult<DocumentInfo | null>> {
			return Promise.resolve(unavailable("getDocument"));
		},
		deleteDocument(_documentId: string): Promise<HindsightResult<boolean>> {
			return Promise.resolve(unavailable("deleteDocument"));
		},
		setDocumentTags(_documentId: string, _tags: string[]): Promise<HindsightResult<true>> {
			return Promise.resolve(unavailable("setDocumentTags"));
		},
		deleteBank(): Promise<HindsightResult<true>> {
			return Promise.resolve(unavailable("deleteBank"));
		},
	};
}
