#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Host-neutral plan entry. Hermes, Muse, and Omp send one JSON object on
 * stdin and read one JSON object on stdout. Always exits 0.
 *
 *   { "host": "hermes", "session_id": "...", "prompt": "...", "cwd": "..." }
 */
import { planPrompt, type PlanRequest } from "../src/host/plan.ts";
import { createFdProgressSink } from "../src/host/progress.ts";
import { isHostId } from "../src/host/types.ts";

function requestFrom(value: unknown): PlanRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	const host = typeof record.host === "string" && isHostId(record.host) ? record.host : undefined;
	const text = (key: string): string | undefined => (typeof record[key] === "string" ? (record[key] as string) : undefined);
	return {
		host,
		session_id: text("session_id") ?? text("sessionId"),
		prompt: text("prompt") ?? text("userPrompt") ?? text("user_prompt") ?? text("text"),
		cwd: text("cwd") ?? text("workspaceRoot"),
		transcript_path: text("transcript_path") ?? text("transcriptPath"),
		parent_session_id: text("parent_session_id") ?? text("parentSessionId"),
		platform: text("platform"),
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
	if (!request.host && forced && isHostId(forced)) request.host = forced;
	const result = await planPrompt(request, process.env, { progress: createFdProgressSink() });
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

main()
	.catch(() => {
		process.stdout.write(`${JSON.stringify({ context: "", skipped: "engine-error" })}\n`);
	})
	.finally(() => {
		process.exit(0);
	});
