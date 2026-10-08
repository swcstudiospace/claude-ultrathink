#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Host-neutral JSON plan entry: one JSON object on stdin, one `PlanResponse` JSON line on stdout. Always exits 0.
 * Hermes (hosts/hermes/bridge.py) and Prime Agent (hosts/prime-agent, the `ultrathink` kernel skill) plan through it;
 * Claude Code, Grok Build and Muse use hooks/uplift.ts instead.
 * Only the string fields below cross: no Model, auth, resolver, registry or callable is ever read from the JSON.
 *
 *   { "host": "hermes" | "prime-agent", "session_id": "...", "prompt": "...", "cwd": "...", "model": "...", "provider": "..." }
 */
import { planPrompt, type PlanRequest } from "../src/host/plan.ts";
import { createFdProgressSink } from "../src/host/progress.ts";
import { isHostId } from "../src/host/types.ts";

export function requestFrom(value: unknown): PlanRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	const host = typeof record.host === "string" && isHostId(record.host) ? record.host : undefined;
	// A supplied host that is not a supported HostId (a bot label such as grok-bot, or a non-string) is omitted and
	// flagged instead of being left to host detection, so the planner answers unresolved / unsupported-host with empty
	// context. An absent, null or blank host keeps the existing detection.
	const declared = typeof record.host === "string" ? record.host.trim() !== "" : record.host !== undefined && record.host !== null;
	const text = (key: string): string | undefined => (typeof record[key] === "string" ? (record[key] as string) : undefined);
	const rawModel = text("model");
	const model = rawModel?.trim() ? rawModel.trim() : undefined;
	const rawProvider = text("provider");
	const provider = rawProvider?.trim() ? rawProvider.trim() : undefined;
	return {
		host,
		...(declared && host === undefined ? { invalidHost: true as const } : {}),
		session_id: text("session_id") ?? text("sessionId"),
		prompt: text("prompt") ?? text("userPrompt") ?? text("user_prompt") ?? text("text"),
		cwd: text("cwd") ?? text("workspaceRoot"),
		transcript_path: text("transcript_path") ?? text("transcriptPath"),
		parent_session_id: text("parent_session_id") ?? text("parentSessionId"),
		platform: text("platform"),
		// The sender's session model id is legacy route evidence only: under think.engine auto it picks the Hermes route
		// by family (AD-3). It is never a wire model or a native target, and Omp planning never follows it.
		// Blank (the old senders' unknown marker) means unknown, never a model id.
		model,
		// An opaque legacy provider declaration, never credential-binding proof; blank means none.
		provider,
	};
}

async function main(): Promise<void> {
	let raw = "";
	try {
		raw = await new Response(Bun.stdin.stream()).text();
	} catch {
		raw = "";
	}
	let parsed: unknown = {};
	if (raw.trim()) {
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = {};
		}
	}
	const forced = process.env.ULTRATHINK_HOST;
	const request = requestFrom(parsed);
	// The environment only fills an absent host; it never overrides the unsupported-host diagnostic.
	if (!request.host && !request.invalidHost && forced && isHostId(forced)) request.host = forced;
	const result = await planPrompt(request, process.env, { progress: createFdProgressSink() });
	await emit(result);
}

/**
 * Writes the response line and waits for it to reach the pipe. A `process.stdout.write` followed by `process.exit`
 * (even from the write callback) drops everything past the 128 KiB pipe buffer under Bun, and a full plan response
 * (context plus view) is larger than that: the caller would read a truncated JSON line.
 */
export async function emit(response: unknown): Promise<void> {
	await Bun.write(Bun.stdout, `${JSON.stringify(response)}\n`);
}

if (import.meta.main) {
	main()
		.catch(() => emit({ context: "", skipped: "engine-error" }))
		.catch(() => {
			// fail-open: nothing left to say
		})
		.finally(() => {
			process.exit(0);
		});
}
