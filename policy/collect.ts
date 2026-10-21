// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Collects the policy input document that policy/*.rego evaluates (the shared input contract in
// .planning/phases/75-policy-as-code-governance/PLAN.md). Static mode reads the repository; --live also fetches
// a running server and records the response headers as they arrived. It writes JSON to stdout and never writes
// anything else.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { SECURITY_HEADERS } from "../services/ultrathink/routes/router.ts";

const LIVE_TIMEOUT_MS = 10_000;
const DEFAULT_ROOT = resolve(import.meta.dir, "..");
const USAGE = "usage: bun policy/collect.ts [--root <dir>] [--live <url>]";

/** `permissions` as written: the shorthand string, a scope map, or null when the key is absent. */
export type Permissions = string | Record<string, string> | null;

export interface WorkflowJob {
	permissions: Permissions;
	/** Every `uses` reference of the job: the job-level reusable-workflow ref first, then each step's, in file order. */
	uses: string[];
}

export interface Workflow {
	file: string;
	/** Parsed event names. Comments never appear here. */
	on: string[];
	permissions: Permissions;
	jobs: Record<string, WorkflowJob>;
}

/** Section name, then setting name, then every value assigned to it in file order. */
export type UnitSections = Record<string, Record<string, string[]>>;

export interface UnitFile {
	file: string;
	sections: UnitSections;
}

export interface PolicyInput {
	source: "static" | "live";
	/** The `SECURITY_HEADERS` export of services/ultrathink/routes/router.ts, in its own case. */
	expected: Record<string, string>;
	/** Static mode: `expected`, lowercased. Live mode: the response headers, lowercased, with absent names absent. */
	headers: Record<string, string>;
	workflows: Workflow[];
	units: UnitFile[];
}

export interface CollectOptions {
	root?: string;
	live?: string;
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, where: string): string {
	if (typeof value !== "string") throw new Error(`${where}: expected a string`);
	return value;
}

function normalizePermissions(value: unknown, where: string): Permissions {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	if (isObject(value)) {
		const scopes: Record<string, string> = {};
		for (const [scope, level] of Object.entries(value)) scopes[scope] = expectString(level, `${where}.${scope}`);
		return scopes;
	}
	throw new Error(`${where}: permissions must be a string or a map`);
}

function normalizeEvents(value: unknown, where: string): string[] {
	if (value === undefined || value === null) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.map((event, index) => expectString(event, `${where}[${index}]`));
	if (isObject(value)) return Object.keys(value);
	throw new Error(`${where}: on must be an event name, a list or a map`);
}

export function parseWorkflow(text: string, file: string): Workflow {
	let doc: unknown;
	try {
		doc = parseYaml(text);
	} catch (error) {
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isObject(doc)) throw new Error(`${file}: workflow must be a mapping`);
	const jobsRaw = doc.jobs ?? {};
	if (!isObject(jobsRaw)) throw new Error(`${file}: jobs must be a mapping`);

	const jobs: Record<string, WorkflowJob> = {};
	for (const [id, job] of Object.entries(jobsRaw)) {
		const where = `${file} job ${id}`;
		if (!isObject(job)) throw new Error(`${where}: job must be a mapping`);
		const uses: string[] = [];
		if (job.uses !== undefined) uses.push(expectString(job.uses, `${where}.uses`));
		if (job.steps !== undefined) {
			if (!Array.isArray(job.steps)) throw new Error(`${where}: steps must be a list`);
			for (const step of job.steps) {
				if (isObject(step) && step.uses !== undefined) uses.push(expectString(step.uses, `${where} step uses`));
			}
		}
		jobs[id] = { permissions: normalizePermissions(job.permissions, `${where}.permissions`), uses };
	}

	return {
		file,
		on: normalizeEvents(doc.on, `${file}.on`),
		permissions: normalizePermissions(doc.permissions, `${file}.permissions`),
		jobs,
	};
}

/** Logical lines: comments and blank lines dropped, a trailing backslash joins the next line (systemd rule). */
function logicalLines(text: string): { line: number; text: string }[] {
	const out: { line: number; text: string }[] = [];
	let buffer: string | undefined;
	let start = 0;
	const physical = text.split("\n");
	for (let index = 0; index < physical.length; index++) {
		const trimmed = (physical[index] ?? "").trim();
		if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
		if (buffer === undefined) {
			buffer = "";
			start = index + 1;
		}
		if (trimmed.endsWith("\\")) {
			buffer += `${trimmed.slice(0, -1)} `;
			continue;
		}
		out.push({ line: start, text: `${buffer}${trimmed}`.trim() });
		buffer = undefined;
	}
	if (buffer !== undefined) out.push({ line: start, text: buffer.trim() });
	return out;
}

const SECTION_HEADER = /^\[([^\]]+)\]$/;

/**
 * A systemd unit INI file. Repeated settings are all kept, in file order. A value is split on whitespace, as systemd
 * splits list-valued settings, so `RestrictAddressFamilies=AF_INET AF_INET6` yields two entries. An empty value
 * (`CapabilityBoundingSet=`) yields `[""]`. Malformed lines fail the parse rather than being skipped.
 */
export function parseUnitFile(text: string, file: string): UnitSections {
	const sections: UnitSections = {};
	let current: Record<string, string[]> | undefined;
	for (const { line, text: content } of logicalLines(text)) {
		const header = SECTION_HEADER.exec(content);
		if (header) {
			current = sections[header[1] ?? ""] ??= {};
			continue;
		}
		const eq = content.indexOf("=");
		if (eq <= 0) throw new Error(`${file}:${line}: expected [Section] or Key=Value`);
		if (current === undefined) throw new Error(`${file}:${line}: setting appears before any [Section]`);
		const key = content.slice(0, eq).trim();
		const value = content.slice(eq + 1).trim();
		const entries = value === "" ? [""] : value.split(/\s+/);
		(current[key] ??= []).push(...entries);
	}
	return sections;
}

function lowercaseKeys(source: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) out[name.toLowerCase()] = value;
	return out;
}

/** GET the URL and return its response headers, lowercased. Absent headers stay absent. */
export async function fetchLiveHeaders(url: string): Promise<Record<string, string>> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`--live is not a valid URL: ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`--live must be an http or https URL: ${url}`);
	}
	const response = await fetch(parsed, { method: "GET", signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
	await response.body?.cancel();
	const headers: Record<string, string> = {};
	response.headers.forEach((value, name) => {
		headers[name.toLowerCase()] = value;
	});
	return headers;
}

export async function collect(options: CollectOptions = {}): Promise<PolicyInput> {
	const root = resolve(options.root ?? DEFAULT_ROOT);
	if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`--root is not a directory: ${root}`);
	}

	const workflowNames = readdirSync(join(root, ".github/workflows"))
		.filter((name) => /\.yml$/.test(name))
		.sort();
	const workflows = workflowNames.map((name) => {
		const file = `.github/workflows/${name}`;
		return parseWorkflow(readFileSync(join(root, file), "utf8"), file);
	});

	const unitNames = readdirSync(join(root, "deploy"))
		.filter((name) => /^ultrathink-.+\.(service|timer)$/.test(name))
		.sort();
	const units = unitNames.map((name) => {
		const file = `deploy/${name}`;
		return { file, sections: parseUnitFile(readFileSync(join(root, file), "utf8"), file) };
	});

	const expected: Record<string, string> = { ...SECURITY_HEADERS };
	if (options.live === undefined) {
		return { source: "static", expected, headers: lowercaseKeys(expected), workflows, units };
	}
	return {
		source: "live",
		expected,
		headers: await fetchLiveHeaders(options.live),
		workflows,
		units,
	};
}

export async function main(argv: readonly string[]): Promise<number> {
	let values: { root?: string; live?: string; help?: boolean };
	try {
		({ values } = parseArgs({
			args: [...argv],
			options: {
				root: { type: "string" },
				live: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
			strict: true,
			allowPositionals: false,
		}));
	} catch (error) {
		process.stderr.write(`collect: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
		return 2;
	}
	if (values.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	try {
		const input = await collect({ root: values.root, live: values.live });
		process.stdout.write(`${JSON.stringify(input, null, 2)}\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`collect: ${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
