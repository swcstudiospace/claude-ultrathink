// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { UltrathinkConfig } from "../config.ts";
import { createMcpClient } from "../mcp/client.ts";
import type { McpClient } from "../mcp/client.ts";
import { resolveAuthHeader } from "../mcp/oauth.ts";
import { storePath as defaultStorePath } from "../mcp/store.ts";
import type { ProgressSink } from "../host/progress.ts";
import type { ThoughtGraph } from "../think/types.ts";
import { createTracking } from "./create.ts";
import type { TrackingRefs, TrackPlan } from "./types.ts";

export type Tracker = (input: {
	plan: TrackPlan;
	graph?: ThoughtGraph;
	existing?: TrackingRefs;
	signal?: AbortSignal;
	progress?: ProgressSink;
}) => Promise<TrackingRefs | undefined>;

/** Undefined when neither `linear.team` nor `notion.dataSourceUrl` is configured; an unconfigured provider is never contacted. */
export function createGatewayTracker(
	config: UltrathinkConfig,
	deps: { storePath?: string; fetch?: typeof fetch } = {},
): Tracker | undefined {
	const linearTeam = config.linear.team.trim();
	const notionDataSource = config.notion.dataSourceUrl.trim().replace(/^collection:\/\//, "");
	if (!linearTeam && !notionDataSource) return undefined;
	return async ({ plan, graph, existing, signal, progress }) => {
		if (signal?.aborted) return undefined;
		const clientDeps = { storePath: deps.storePath ?? defaultStorePath(), fetch: deps.fetch };
		const clients: McpClient[] = [];
		// Credential resolution can wait on the store lock and a token refresh; bound it by
		// the same budget and the caller's signal so the prompt never waits past the budget.
		const stop = Promise.withResolvers<"stop">();
		const timer = setTimeout(() => stop.resolve("stop"), config.track.budgetMs);
		const onAbort = () => stop.resolve("stop");
		signal?.addEventListener("abort", onAbort, { once: true });
		const startedAt = Date.now();
		try {
			const auth = await Promise.race([
				Promise.all([
					linearTeam ? resolveAuthHeader("linear", clientDeps).catch(() => undefined) : undefined,
					notionDataSource ? resolveAuthHeader("notion", clientDeps).catch(() => undefined) : undefined,
				]),
				stop.promise,
			]);
			if (auth === "stop" || signal?.aborted) return undefined;
			const remainingMs = config.track.budgetMs - (Date.now() - startedAt);
			if (remainingMs <= 0) return undefined;
			const [linearAuth, notionAuth] = auth;
			if (linearAuth === undefined && notionAuth === undefined) return undefined;
			const linear = linearAuth === undefined ? undefined : createMcpClient("linear", clientDeps);
			const notion = notionAuth === undefined ? undefined : createMcpClient("notion", clientDeps);
			if (linear) clients.push(linear);
			if (notion) clients.push(notion);
			if (signal) signal.addEventListener("abort", () => clients.forEach((client) => client.close()), { once: true });
			return await createTracking(plan, graph, existing, {
				linear,
				notion,
				...(linearTeam ? { linearTeam } : {}),
				...(notionDataSource ? { notionDataSource } : {}),
				concurrency: config.track.concurrency,
				budgetMs: remainingMs,
				progress,
			});
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			for (const client of clients) client.close();
		}
	};
}

/**
 * One shell word for a command line printed into the agent's context: plain paths stay as they are, anything else
 * (spaces, quotes, `$`…) is POSIX single-quoted so the line can be run as-is.
 */
export function shellArg(value: string): string {
	return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function trackCommand(repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")): string {
	return `${shellArg(resolve(repoRoot, "bin", "ultrathink-mcp"))} track complete`;
}
