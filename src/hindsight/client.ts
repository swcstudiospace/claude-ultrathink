// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Hand-written client for the Hindsight 0.9.1 HTTP API (retain, recall, documents, banks). One request per call with a
 * hard time budget (src/net/http.ts), no retries (callers queue and replay), the bearer key only on `/v1/**`, and every
 * failure returned as a classified, redacted one-line error that never carries the key or request content. Banks are
 * kept in `chunks` extraction mode: the server runs without an LLM, and a retain in any other mode would call one.
 * Never rejects except with an AbortError when the caller's signal aborts.
 */
import { redactSecrets } from "../grok/auth.ts";
import { requestJson } from "../net/http.ts";
import { checkServiceUrl } from "../net/safe-url.ts";
import type {
	BankState,
	DocumentInfo,
	HindsightClient,
	HindsightClientOptions,
	HindsightError,
	HindsightErrorKind,
	HindsightHealth,
	HindsightResult,
	RecallHit,
	RecallQuery,
	RetainItem,
	RetainOutcome,
} from "./types.ts";

const MAX_MESSAGE_CHARS = 200;
const DEFAULT_RECALL_TYPES = ["world", "experience", "observation"];
const DEFAULT_RECALL_BUDGET = "low";
const DEFAULT_RECALL_MAX_TOKENS = 1500;
const WANTED_MODE = "chunks";

/** Replaces `apiKey` and known secret shapes with "[redacted]", collapses whitespace to one line, caps at 200 characters. */
export function redactMessage(text: string, apiKey?: string): string {
	const key = apiKey?.trim();
	const out = redactSecrets(key ? text.replaceAll(key, "[redacted]") : text)
		.replace(/\s+/g, " ")
		.trim();
	return out.length > MAX_MESSAGE_CHARS ? `${out.slice(0, MAX_MESSAGE_CHARS - 3)}...` : out;
}

function statusKind(status: number): HindsightErrorKind {
	if (status === 401 || status === 403) return "auth";
	if (status === 404) return "not-found";
	if (status === 429) return "rate-limit";
	if (status >= 500) return "server";
	if (status >= 400) return "bad-request";
	return "invalid-response";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** FastAPI validation errors put the offending input in an array-valued `detail`; only a plain string is safe to show. */
function httpDetail(status: number, json: unknown): string {
	if (isRecord(json)) {
		for (const field of [json.detail, json.message]) {
			if (typeof field === "string" && field.trim() !== "") return `HTTP ${status}: ${field}`;
		}
	}
	return `HTTP ${status}`;
}

type Reply = { ok: true; status: number; json: unknown } | { ok: false; error: HindsightError };

interface CallOptions {
	body?: unknown;
	timeoutMs: number;
	/** False for `/health` and `/version`, which take no key. */
	auth?: boolean;
	/** A 404 is returned as a reply instead of an error. */
	allow404?: boolean;
}

function parseVersion(json: unknown): { apiVersion: string; features: Record<string, boolean> } | undefined {
	if (!isRecord(json)) return undefined;
	const features: Record<string, boolean> = {};
	if (isRecord(json.features)) {
		for (const [name, value] of Object.entries(json.features)) if (typeof value === "boolean") features[name] = value;
	}
	return { apiVersion: typeof json.api_version === "string" ? json.api_version : "", features };
}

function toHit(raw: unknown): RecallHit | undefined {
	if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.text !== "string") return undefined;
	const metadata: Record<string, string> = {};
	if (isRecord(raw.metadata)) {
		for (const [name, value] of Object.entries(raw.metadata)) if (typeof value === "string") metadata[name] = value;
	}
	const hit: RecallHit = { id: raw.id, text: raw.text, tags: strings(raw.tags), metadata };
	if (typeof raw.document_id === "string") hit.documentId = raw.document_id;
	if (typeof raw.type === "string") hit.type = raw.type;
	if (typeof raw.context === "string") hit.context = raw.context;
	if (typeof raw.mentioned_at === "string") hit.mentionedAt = raw.mentioned_at;
	return hit;
}

function toDocument(json: unknown): DocumentInfo | undefined {
	if (!isRecord(json) || typeof json.id !== "string") return undefined;
	const info: DocumentInfo = { id: json.id, tags: strings(json.tags) };
	if (typeof json.created_at === "string") info.createdAt = json.created_at;
	if (typeof json.updated_at === "string") info.updatedAt = json.updated_at;
	if (typeof json.memory_unit_count === "number") info.memoryUnitCount = json.memory_unit_count;
	return info;
}

/** Throws a plain Error on a programming error (unsafe URL, empty bank or key); src/hindsight/settings.ts guards first. */
export function createHindsightClient(options: HindsightClientOptions): HindsightClient {
	const checked = checkServiceUrl(options.url);
	if (!checked.ok) throw new Error(`hindsight: invalid url (${checked.reason})`);
	if (options.bank.trim() === "") throw new Error("hindsight: bank must not be empty");
	if (options.apiKey.trim() === "") throw new Error("hindsight: apiKey must not be empty");
	const { bank, apiKey } = options;
	const base = checked.url;
	const bankUrl = `${base}/v1/default/banks/${encodeURIComponent(bank)}`;
	const documentUrl = (id: string) => `${bankUrl}/documents/${encodeURIComponent(id)}`;

	const fail = (kind: HindsightErrorKind, detail: string, status?: number): { ok: false; error: HindsightError } => {
		const error: HindsightError = { kind, message: redactMessage(`hindsight ${kind}: ${detail}`, apiKey) };
		if (status !== undefined) error.status = status;
		return { ok: false, error };
	};

	async function call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, opts: CallOptions): Promise<Reply> {
		const outcome = await requestJson(url, {
			method,
			headers: opts.auth === false ? undefined : { Authorization: `Bearer ${apiKey}` },
			body: opts.body,
			timeoutMs: opts.timeoutMs,
			signal: options.signal,
			fetch: options.fetch,
		});
		if (outcome.kind === "timeout") return fail("timeout", `no response within ${opts.timeoutMs} ms`);
		if (outcome.kind === "network") return fail("network", outcome.message);
		const { status, json } = outcome;
		if ((status >= 200 && status < 300) || (status === 404 && opts.allow404)) return { ok: true, status, json };
		return fail(statusKind(status), httpDetail(status, json), status);
	}

	async function health(): Promise<HindsightResult<HindsightHealth>> {
		const healthReply = await call("GET", `${base}/health`, { timeoutMs: options.timeoutMs, auth: false });
		const versionReply = await call("GET", `${base}/version`, { timeoutMs: options.timeoutMs, auth: false });
		const version = versionReply.ok ? parseVersion(versionReply.json) : undefined;
		const failure =
			healthReply.ok && !isRecord(healthReply.json) ? fail("invalid-response", "/health returned an unusable body") : healthReply;
		if (!failure.ok) {
			// A failing /health must not hide what /version said.
			if (!version) return failure;
			return { ok: true, value: { ok: false, apiVersion: version.apiVersion, databaseConnected: false, features: version.features } };
		}
		const body = failure.json as Record<string, unknown>;
		const databaseConnected = body.database === "connected";
		return {
			ok: true,
			value: {
				ok: failure.status === 200 && body.status === "healthy" && databaseConnected,
				apiVersion: version?.apiVersion ?? "",
				databaseConnected,
				features: version?.features ?? {},
			},
		};
	}

	let ensured: Promise<HindsightResult<BankState>> | undefined;

	async function ensureOnce(): Promise<HindsightResult<BankState>> {
		const config = await call("GET", `${bankUrl}/config`, { timeoutMs: options.timeoutMs, allow404: true });
		if (!config.ok) return config;
		let created = false;
		let mode = "";
		if (config.status === 404) {
			const put = await call("PUT", bankUrl, { body: {}, timeoutMs: options.timeoutMs });
			if (!put.ok) return put;
			created = true;
		} else {
			const resolved = isRecord(config.json) && isRecord(config.json.config) ? config.json.config : undefined;
			if (!resolved) return fail("invalid-response", "bank config response has no config object");
			if (typeof resolved.retain_extraction_mode === "string") mode = resolved.retain_extraction_mode;
		}
		if (mode !== WANTED_MODE) {
			const patch = await call("PATCH", `${bankUrl}/config`, {
				body: { updates: { retain_extraction_mode: WANTED_MODE } },
				timeoutMs: options.timeoutMs,
			});
			if (!patch.ok) return patch;
		}
		return { ok: true, value: { bankId: bank, created, extractionMode: WANTED_MODE } };
	}

	function ensureBank(): Promise<HindsightResult<BankState>> {
		if (!ensured) {
			const attempt = ensureOnce();
			ensured = attempt;
			// Only a success stays cached; a failure or an abort must be retried by the next call.
			attempt.then(
				(result) => {
					if (!result.ok && ensured === attempt) ensured = undefined;
				},
				() => {
					if (ensured === attempt) ensured = undefined;
				},
			);
		}
		return ensured;
	}

	async function retain(item: RetainItem): Promise<HindsightResult<RetainOutcome>> {
		// A retain into a missing bank would auto-create it in the server's default (LLM) extraction mode.
		const bankState = await ensureBank();
		if (!bankState.ok) return bankState;
		const reply = await call("POST", `${bankUrl}/memories`, {
			body: {
				items: [
					{
						content: item.content,
						context: item.context,
						tags: item.tags,
						metadata: item.metadata,
						document_id: item.documentId,
						timestamp: item.timestamp,
						update_mode: "replace",
					},
				],
				async: false,
			},
			timeoutMs: options.retainTimeoutMs,
		});
		if (!reply.ok) return reply;
		const json = reply.json;
		if (!isRecord(json) || json.success !== true || typeof json.items_count !== "number") {
			return fail("invalid-response", "retain response lacks success and items_count");
		}
		return {
			ok: true,
			value: { bankId: typeof json.bank_id === "string" ? json.bank_id : bank, documentId: item.documentId, itemsCount: json.items_count },
		};
	}

	async function recall(query: RecallQuery): Promise<HindsightResult<RecallHit[]>> {
		const reply = await call("POST", `${bankUrl}/memories/recall`, {
			body: {
				query: query.query,
				types: query.types ?? DEFAULT_RECALL_TYPES,
				budget: query.budget ?? DEFAULT_RECALL_BUDGET,
				max_tokens: query.maxTokens ?? DEFAULT_RECALL_MAX_TOKENS,
				tags: query.tags,
				tags_match: query.tagsMatch,
				tag_groups: query.tagGroups,
			},
			timeoutMs: options.timeoutMs,
		});
		if (!reply.ok) return reply;
		if (!isRecord(reply.json) || !Array.isArray(reply.json.results)) return fail("invalid-response", "recall response has no results array");
		const hits: RecallHit[] = [];
		for (const raw of reply.json.results) {
			const hit = toHit(raw);
			if (hit) hits.push(hit);
		}
		return { ok: true, value: hits };
	}

	async function getDocument(documentId: string): Promise<HindsightResult<DocumentInfo | null>> {
		const reply = await call("GET", documentUrl(documentId), { timeoutMs: options.timeoutMs, allow404: true });
		if (!reply.ok) return reply;
		if (reply.status === 404) return { ok: true, value: null };
		const info = toDocument(reply.json);
		return info ? { ok: true, value: info } : fail("invalid-response", "document response has no id");
	}

	async function deleteDocument(documentId: string): Promise<HindsightResult<boolean>> {
		const reply = await call("DELETE", documentUrl(documentId), { timeoutMs: options.timeoutMs, allow404: true });
		return reply.ok ? { ok: true, value: reply.status !== 404 } : reply;
	}

	async function setDocumentTags(documentId: string, tags: string[]): Promise<HindsightResult<true>> {
		const reply = await call("PATCH", documentUrl(documentId), { body: { tags }, timeoutMs: options.timeoutMs });
		return reply.ok ? { ok: true, value: true } : reply;
	}

	async function deleteBank(): Promise<HindsightResult<true>> {
		const reply = await call("DELETE", bankUrl, { timeoutMs: options.timeoutMs, allow404: true });
		if (!reply.ok) return reply;
		ensured = undefined;
		return { ok: true, value: true };
	}

	return { bank, health, ensureBank, retain, recall, getDocument, deleteDocument, setDocumentTags, deleteBank };
}
