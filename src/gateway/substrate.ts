// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Substrate brief and events through desk_brief and desk_event_emit.
 * A failure returns the same empty brief / false the direct client uses, so planning continues.
 */
import { createGatewayClient } from "./client.ts";
import type { ResolvedGateway } from "./settings.ts";
import { GRAPH_ID_PATTERN } from "./types.ts";

export interface GatewayBriefInput {
	graphId?: string;
	signal?: AbortSignal;
}

export interface GatewayEmitInput {
	kind: string;
	summary: string;
	graphId?: string;
	payload?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KIND_PATTERN = /^[a-z][a-z0-9_.]{2,60}$/;

function briefText(payload: Record<string, unknown>): string {
	const substrate = isRecord(payload.substrate) ? payload.substrate : undefined;
	if (substrate && typeof substrate.brief === "string" && substrate.brief.trim()) return substrate.brief.trim();
	if (typeof payload.brief === "string") return payload.brief.trim();
	return "";
}

export async function gatewayBrief(gateway: ResolvedGateway, input: GatewayBriefInput, fetchImpl?: typeof fetch): Promise<string> {
	if (input.signal?.aborted) return "";
	const client = createGatewayClient({ ...gateway, fetch: fetchImpl, signal: input.signal });
	const args: Record<string, unknown> = {};
	if (input.graphId && GRAPH_ID_PATTERN.test(input.graphId)) args.graph_id = input.graphId;
	const result = await client.call("desk_brief", args);
	if (!result.ok) return "";
	return briefText(result.value);
}

export async function gatewayEmit(
	gateway: ResolvedGateway,
	input: GatewayEmitInput,
	fetchImpl?: typeof fetch,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) return false;
	if (!KIND_PATTERN.test(input.kind)) return false;
	const client = createGatewayClient({ ...gateway, fetch: fetchImpl, signal });
	const args: Record<string, unknown> = { kind: input.kind };
	if (input.graphId && GRAPH_ID_PATTERN.test(input.graphId)) args.graph_id = input.graphId;
	const payload: Record<string, unknown> = { ...(input.payload ?? {}) };
	if (input.summary && payload.summary === undefined) payload.summary = input.summary;
	if (Object.keys(payload).length > 0) args.payload = payload;
	const result = await client.call("desk_event_emit", args);
	return result.ok && result.value.ok === true;
}
