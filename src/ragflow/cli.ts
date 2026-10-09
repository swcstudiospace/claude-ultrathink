// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `bin/ultrathink ragflow check | datasets | search "<question>"`: operator tools for the RAGFlow integration. They honor
 * the kill switch and `ragflow.enabled`, the URL policy and the key lookup exactly as the planner does, but ignore
 * `ragflow.ground`, so the connection can be proven before grounding is switched on. Output never contains the key.
 */
import { claudeConfigPaths, loadConfig } from "../config.ts";
import type { GatewayConfig } from "../gateway/types.ts";
import { redactSecrets } from "../grok/auth.ts";
import type { CliResult } from "../teach/types.ts";
import { flattenText } from "./ground.ts";
import { ragflowStatusLine, resolveRagflow } from "./settings.ts";
import type { RagflowClient, RagflowConfig } from "./types.ts";

export interface CommandDeps {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	stateDir?: string;
	storePath?: string;
	fetch?: typeof fetch;
	/** Tests inject the `ragflow` config slice; otherwise it is loaded like the other commands do. */
	config?: RagflowConfig;
	/** Desk gateway section. Loaded with `config` when omitted. */
	gateway?: GatewayConfig;
	stdin?: () => Promise<string>;
	now?: () => number;
}

const USAGE =
	'Usage: ultrathink ragflow check [--json] | datasets [--json] | search "<question>" [--dataset <id>]... [--limit N] [--json]';
const SEARCH_EXCERPT_CHARS = 300;
const MAX_LIMIT = 100;

interface Parsed {
	json: boolean;
	positional: string[];
	datasets: string[];
	limit?: number;
}

/** Flags shared by every subcommand; `--dataset` and `--limit` only where `search` allows them. Undefined on any misuse. */
function parseArgs(args: readonly string[], search: boolean): Parsed | undefined {
	const parsed: Parsed = { json: false, positional: [], datasets: [] };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "--json") {
			parsed.json = true;
		} else if (search && arg === "--dataset") {
			const value = args[++i]?.trim();
			if (!value || value.startsWith("--")) return undefined;
			parsed.datasets.push(value);
		} else if (search && arg === "--limit") {
			const value = args[++i] ?? "";
			if (!/^\d+$/.test(value)) return undefined;
			const limit = Number(value);
			if (limit < 1 || limit > MAX_LIMIT) return undefined;
			parsed.limit = limit;
		} else if (arg.startsWith("--")) {
			return undefined;
		} else {
			parsed.positional.push(arg);
		}
	}
	return parsed;
}

/** `kind` "not-ready" is the CLI's own: RAGFlow is off or unconfigured and no request was made. */
function failed(label: string, json: boolean, error: { kind: string; message: string }): CliResult {
	const text = error.kind === "not-ready" ? `RAGFlow ${label}: ${error.message}` : `RAGFlow ${label}: error (${error.kind}) · ${error.message}`;
	return { code: 1, text: json ? JSON.stringify({ ok: false, error }) : text };
}

function cell(value: number | undefined): string {
	return value === undefined ? "-" : String(value);
}

function pad(rows: string[][]): string {
	const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
	return rows.map((row) => row.map((value, column) => value.padEnd(widths[column] ?? 0)).join("  ").trimEnd()).join("\n");
}

async function check(client: RagflowClient, json: boolean, now: () => number): Promise<CliResult> {
	const started = now();
	const result = await client.health();
	const ms = Math.max(0, Math.round(now() - started));
	if (!result.ok) return failed("check", json, result.error);
	const { datasets, scope } = result.value;
	if (scope === "gateway") {
		if (json) return { code: 0, text: JSON.stringify({ ok: true, scope, ms }) };
		return { code: 0, text: `RAGFlow check: ok · gateway probe · ${ms} ms` };
	}
	if (json) return { code: 0, text: JSON.stringify({ ok: true, datasets, ms }) };
	return { code: 0, text: `RAGFlow check: ok · ${datasets} dataset(s) · ${ms} ms` };
}

async function datasets(client: RagflowClient, json: boolean): Promise<CliResult> {
	const result = await client.listDatasets();
	if (!result.ok) return failed("datasets", json, result.error);
	if (json) return { code: 0, text: JSON.stringify({ ok: true, datasets: result.value }) };
	if (result.value.length === 0) return { code: 0, text: "RAGFlow datasets: none visible to this key" };
	const rows = [["id", "name", "documents", "chunks"]];
	for (const dataset of result.value) rows.push([dataset.id, flattenText(dataset.name, 60), cell(dataset.documentCount), cell(dataset.chunkCount)]);
	return { code: 0, text: pad(rows) };
}

async function search(client: RagflowClient, parsed: Parsed, config: RagflowConfig): Promise<CliResult> {
	const question = parsed.positional[0] ?? "";
	let datasetIds = parsed.datasets.length > 0 ? parsed.datasets : config.datasetIds;
	if (datasetIds.length === 0) {
		const listed = await client.listDatasets();
		if (!listed.ok) return failed("search", parsed.json, listed.error);
		datasetIds = listed.value.map((dataset) => dataset.id);
	}
	if (datasetIds.length === 0) return failed("search", parsed.json, { kind: "not-ready", message: "no datasets to search" });
	const result = await client.retrieve({
		question,
		datasetIds,
		topK: parsed.limit ?? config.topK,
		similarityThreshold: config.similarityThreshold,
	});
	if (!result.ok) return failed("search", parsed.json, result.error);
	const chunks = [...result.value].sort((a, b) => (b.similarity ?? -1) - (a.similarity ?? -1));
	if (parsed.json) return { code: 0, text: JSON.stringify({ ok: true, count: chunks.length, chunks }) };
	if (chunks.length === 0) return { code: 0, text: "RAGFlow search: no matches" };
	const lines = chunks.map((chunk) => {
		const similarity = chunk.similarity === undefined ? "n/a " : chunk.similarity.toFixed(2);
		return `${similarity}  ${flattenText(chunk.documentName ?? "", 80) || "document"}: ${flattenText(chunk.content, SEARCH_EXCERPT_CHARS)}`;
	});
	return { code: 0, text: lines.join("\n") };
}

/** `bin/ultrathink ragflow <argv…>`. Never rejects. code 0 ok, 1 failure or not ready, 2 usage. text has no trailing newline. */
export async function runRagflowCommand(argv: string[], deps: CommandDeps): Promise<CliResult> {
	const command = argv[0]?.trim().toLowerCase();
	if (command !== "check" && command !== "datasets" && command !== "search") return { code: 2, text: USAGE };
	const parsed = parseArgs(argv.slice(1), command === "search");
	if (!parsed) return { code: 2, text: USAGE };
	if (command === "search" ? parsed.positional.length !== 1 || (parsed.positional[0] ?? "").trim() === "" : parsed.positional.length > 0) {
		return { code: 2, text: USAGE };
	}
	try {
		const env = deps.env ?? process.env;
		const loaded = deps.config && deps.gateway ? undefined : loadConfig(claudeConfigPaths(deps.cwd, env));
		const config = deps.config ?? loaded?.ragflow;
		if (!config) return { code: 1, text: "RAGFlow: config unavailable" };
		const gateway = deps.gateway ?? loaded?.gateway;
		const { readiness, client } = resolveRagflow(config, env, { storePath: deps.storePath, fetch: deps.fetch, gateway });
		if (readiness.state !== "ready" || !client) {
			const reason = ragflowStatusLine(config, env, deps.storePath, gateway).replace(/^RAGFlow: /, "");
			return failed(command, parsed.json, { kind: "not-ready", message: reason });
		}
		if (command === "check") return await check(client, parsed.json, deps.now ?? Date.now);
		if (command === "datasets") return await datasets(client, parsed.json);
		return await search(client, parsed, config);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { code: 1, text: `RAGFlow ${command}: ${redactSecrets(message)}` };
	}
}
