// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// HTTP and Kafka REST sink transports (AUDIT-02). Both POST envelopes and classify the outcome
// for the sink queue: 2xx is delivered, 408/425/429/5xx and network errors are retryable, every
// other status and any redirect are not. Retries stop at the queue's maxAttempts (5 in fanout.ts), so a batch
// that keeps failing is eventually dropped. A Kafka 2xx is delivered only when no record in its body reports an
// error. Kafka delivery is at least once: a retryable batch failure resends the whole batch, so records Kafka
// already accepted can arrive again. A Kafka batch is classified by its first failing record. That record's error
// code decides retryable or not, and the whole batch is reported as one failure with that code. A record with an
// error but no numeric error_code is retryable, since its cause is unknown. A non-retryable mixed batch reports
// its full count as dropped, though some of its records were accepted. Error reasons never carry the token or a URL.

import type { SendResult, SinkEnvelope, SinkTransport } from "./types.ts";

export interface HttpTransportOptions {
	readonly url: string;
	readonly token?: string;
	readonly fetch?: typeof fetch;
}

export interface KafkaRestTransportOptions {
	readonly baseUrl: string;
	readonly topic: string;
	readonly token?: string;
	readonly fetch?: typeof fetch;
}

const MIN_TOKEN_LENGTH = 16;
const KAFKA_CONTENT_TYPE = "application/vnd.kafka.json.v2+json";
const KAFKA_ACCEPT = "application/vnd.kafka.v2+json";
const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/** Accepts https, or plain http only to loopback; rejects embedded credentials. The raw value is never echoed. */
function parseEndpoint(raw: string, label: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new TypeError(`${label} is not a valid URL`);
	}
	if (url.username !== "" || url.password !== "") {
		throw new TypeError(`${label} must not contain credentials`);
	}
	if (url.protocol === "https:") return url;
	if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return url;
	throw new TypeError(`${label} must use https, or http to 127.0.0.1 or localhost`);
}

function validateToken(token: string | undefined): void {
	if (token === undefined) return;
	if (token.length < MIN_TOKEN_LENGTH) {
		throw new RangeError(`token must be at least ${MIN_TOKEN_LENGTH} characters`);
	}
	if (!/^[\x21-\x7e]+$/.test(token)) {
		throw new TypeError("token contains characters that are not valid in an HTTP header");
	}
}

function classifyStatus(status: number): SendResult {
	if (status >= 200 && status <= 299) return { ok: true };
	const retryable = status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
	return { ok: false, retryable, reason: `http ${status}` };
}

/** Classifies a transport exception. Reasons carry only the error code or class name, never its message. */
export function networkFailure(err: unknown, signal: AbortSignal): SendResult {
	if (signal.aborted) return { ok: false, retryable: true, reason: "aborted" };
	const code = (err as { code?: unknown } | null)?.code;
	const label = typeof code === "string" && /^[A-Z_]{1,32}$/.test(code) ? code : err instanceof Error ? err.name : "Error";
	return { ok: false, retryable: true, reason: `network error: ${label}` };
}

async function postJson(args: {
	readonly url: URL;
	readonly contentType: string;
	readonly accept?: string;
	readonly token: string | undefined;
	readonly body: string;
	readonly fetchImpl: typeof fetch;
	readonly signal: AbortSignal;
	readonly readBody?: (text: string) => SendResult;
}): Promise<SendResult> {
	if (args.signal.aborted) return { ok: false, retryable: true, reason: "aborted" };
	const headers: Record<string, string> = { "content-type": args.contentType };
	if (args.accept !== undefined) headers.accept = args.accept;
	if (args.token !== undefined) headers.authorization = `Bearer ${args.token}`;
	try {
		const res = await args.fetchImpl(args.url.href, {
			method: "POST",
			headers,
			body: args.body,
			redirect: "error",
			signal: args.signal,
		});
		const status = classifyStatus(res.status);
		if (!status.ok || args.readBody === undefined) {
			void res.body?.cancel().catch(() => undefined);
			return status;
		}
		return args.readBody(await res.text());
	} catch (err) {
		// Bun rejects redirect: "error" with UnexpectedRedirect before any request reaches the other origin.
		if (!args.signal.aborted && (err as { code?: unknown } | null)?.code === "UnexpectedRedirect") {
			return { ok: false, retryable: false, reason: "redirect refused" };
		}
		return networkFailure(err, args.signal);
	}
}

/** Reads a Kafka REST v2 produce response. A 200 can still fail records: each `offsets` entry carries its own error. */
function classifyKafkaProduce(text: string): SendResult {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return { ok: false, retryable: true, reason: "kafka response unreadable" };
	}
	const offsets = (body as { offsets?: unknown } | null)?.offsets;
	if (!Array.isArray(offsets)) return { ok: false, retryable: true, reason: "kafka response unreadable" };
	for (const entry of offsets as unknown[]) {
		const record = (entry ?? {}) as { error_code?: unknown; error?: unknown };
		if ((record.error_code ?? null) === null && (record.error ?? null) === null) continue;
		const code = record.error_code;
		if (typeof code !== "number") return { ok: false, retryable: true, reason: "kafka record error" };
		// Kafka REST error codes start with the HTTP status they map to: 42201 is 422, 50002 is 500.
		const verdict = classifyStatus(Math.floor(code / 100));
		return { ok: false, retryable: verdict.ok === false && verdict.retryable, reason: `kafka record error ${code}` };
	}
	return { ok: true };
}

export function createHttpTransport(opts: HttpTransportOptions): SinkTransport {
	const url = parseEndpoint(opts.url, "url");
	validateToken(opts.token);
	const fetchImpl = opts.fetch ?? fetch;
	return {
		name: "http",
		async send(batch: readonly SinkEnvelope[], signal: AbortSignal): Promise<SendResult> {
			if (batch.length === 0) return { ok: true };
			let body: string;
			try {
				body = `${batch.map((env) => JSON.stringify(env)).join("\n")}\n`;
			} catch {
				return { ok: false, retryable: false, reason: "encode failed" };
			}
			return postJson({
				url,
				contentType: NDJSON_CONTENT_TYPE,
				token: opts.token,
				body,
				fetchImpl,
				signal,
			});
		},
	};
}

export function createKafkaRestTransport(opts: KafkaRestTransportOptions): SinkTransport {
	const base = parseEndpoint(opts.baseUrl, "baseUrl");
	if (opts.topic.length === 0) throw new RangeError("topic must not be empty");
	validateToken(opts.token);
	const fetchImpl = opts.fetch ?? fetch;
	const basePath = base.href.replace(/\/+$/, "");
	const url = new URL(`${basePath}/topics/${encodeURIComponent(opts.topic)}`);
	return {
		name: "kafka-rest",
		async send(batch: readonly SinkEnvelope[], signal: AbortSignal): Promise<SendResult> {
			if (batch.length === 0) return { ok: true };
			let body: string;
			try {
				body = JSON.stringify({ records: batch.map((env) => ({ value: env })) });
			} catch {
				return { ok: false, retryable: false, reason: "encode failed" };
			}
			return postJson({
				url,
				contentType: KAFKA_CONTENT_TYPE,
				accept: KAFKA_ACCEPT,
				token: opts.token,
				body,
				fetchImpl,
				signal,
				readBody: classifyKafkaProduce,
			});
		},
	};
}
