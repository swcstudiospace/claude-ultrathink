// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// In-process span export over OTLP/JSON (https://opentelemetry.io/docs/specs/otlp/).
// Hand-rolled on purpose: the service has zero runtime dependencies (phase 71 D1).
// `record` queues a finished span synchronously; `flush` posts the queue in batches.
// A failed batch is dropped and never retried, so export cannot grow memory or stall shutdown.

export type SpanKind = 1 | 2 | 3; // 1 INTERNAL, 2 SERVER, 3 CLIENT

export interface FinishedSpan {
	traceId: string; // 32 lowercase hex
	spanId: string; // 16 lowercase hex
	parentSpanId?: string; // 16 hex; omitted for a root span
	name: string;
	kind: SpanKind;
	startUnixNano: bigint;
	endUnixNano: bigint;
	attributes: Record<string, string | number | boolean>;
	error: boolean;
}

export interface SpanSink {
	record(span: FinishedSpan): void; // never throws
	flush?(): Promise<void>; // never rejects
	shutdown?(): Promise<void>;
}

export interface SpanExporterOptions {
	endpoint: string; // base URL, already validated; "/v1/traces" is appended
	serviceName: string;
	serviceVersion: string;
	fetch?: (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
	maxQueue?: number; // default 2048
	maxBatch?: number; // default 512
	timeoutMs?: number; // default 5000
	onDrop?: () => void; // one call per span refused by a full queue
	onFailure?: () => void; // one call per failed batch
}

export interface SpanExporter extends SpanSink {
	flush(): Promise<void>;
	shutdown(): Promise<void>;
}

const DEFAULT_MAX_QUEUE = 2048;
const DEFAULT_MAX_BATCH = 512;
const DEFAULT_TIMEOUT_MS = 5000;
const TRACES_PATH = "/v1/traces";
const SCOPE_NAME = "ultrathink";
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

type OtlpAnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

/** Encode one attribute value: integers as decimal strings (OTLP/JSON int64), BigInt keeps large magnitudes out of exponent form. */
function encodeValue(value: string | number | boolean): OtlpAnyValue {
	if (typeof value === "string") return { stringValue: value };
	if (typeof value === "boolean") return { boolValue: value };
	if (Number.isInteger(value)) return { intValue: BigInt(value).toString() };
	return { doubleValue: value };
}

/** Encode finished spans as one OTLP/JSON `ExportTraceServiceRequest`. */
export function encodeOtlpTraces(spans: readonly FinishedSpan[], resource: { serviceName: string; serviceVersion: string }): unknown {
	return {
		resourceSpans: [
			{
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: resource.serviceName } },
						{ key: "service.version", value: { stringValue: resource.serviceVersion } },
					],
				},
				scopeSpans: [
					{
						scope: { name: SCOPE_NAME },
						spans: spans.map((span) => ({
							traceId: span.traceId,
							spanId: span.spanId,
							// A root span has no parentSpanId key at all, rather than an empty or null one.
							...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
							name: span.name,
							kind: span.kind,
							startTimeUnixNano: span.startUnixNano.toString(),
							endTimeUnixNano: span.endUnixNano.toString(),
							attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: encodeValue(value) })),
							status: { code: span.error ? STATUS_ERROR : STATUS_UNSET },
						})),
					},
				],
			},
		],
	};
}

function positiveInteger(name: string, value: number): number {
	// A zero batch size would make the drain loop spin forever, so reject it at construction.
	if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
	return value;
}

/** Run an observer callback; a throwing observer must never break recording or export. */
function notify(callback: (() => void) | undefined): void {
	try {
		callback?.();
	} catch {
		// Deliberately ignored: telemetry hooks are not allowed to affect the request path.
	}
}

export function createSpanExporter(options: SpanExporterOptions): SpanExporter {
	const maxQueue = positiveInteger("maxQueue", options.maxQueue ?? DEFAULT_MAX_QUEUE);
	const maxBatch = positiveInteger("maxBatch", options.maxBatch ?? DEFAULT_MAX_BATCH);
	const timeoutMs = positiveInteger("timeoutMs", options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const url = `${options.endpoint}${TRACES_PATH}`;
	const resource = { serviceName: options.serviceName, serviceVersion: options.serviceVersion };
	const post = options.fetch ?? ((target, init) => fetch(target, init));
	const { onDrop, onFailure } = options;

	const queue: FinishedSpan[] = [];
	let closed = false;
	let inFlight: Promise<void> | undefined;

	async function delivers(batch: FinishedSpan[]): Promise<boolean> {
		try {
			const response = await post(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(encodeOtlpTraces(batch, resource)),
				signal: AbortSignal.timeout(timeoutMs),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	async function drain(): Promise<void> {
		// Spans recorded while a batch is in flight are picked up by the next iteration.
		while (queue.length > 0) {
			const batch = queue.splice(0, maxBatch);
			if (!(await delivers(batch))) notify(onFailure);
		}
	}

	function flush(): Promise<void> {
		// Single-flight: concurrent callers share the one drain that is already running.
		inFlight ??= drain().finally(() => {
			inFlight = undefined;
		});
		return inFlight;
	}

	async function shutdown(): Promise<void> {
		// Closing first means no span can arrive after the final drain has started.
		closed = true;
		await flush();
	}

	return {
		record(span) {
			if (closed) return;
			if (queue.length >= maxQueue) {
				notify(onDrop);
				return;
			}
			queue.push(span);
		},
		flush,
		shutdown,
	};
}
