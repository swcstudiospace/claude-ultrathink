// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
// Register the central ultrathink MCP gateway (notion, linear, greptile) in every host's user config.
// Usage: bun scripts/mcp-register.ts [--hosts claude,grok,hermes,muse,omp] [--providers notion,linear,greptile] [--dry-run]
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOSTS = ["claude", "grok", "hermes", "muse", "omp"] as const;
export type Host = (typeof HOSTS)[number];
export const PROVIDER_IDS = ["notion", "linear", "greptile"] as const;

export interface Entry {
	id: string;
	command: string;
	args: string[];
}

export type Action = "added" | "replaced" | "re-enabled" | "unchanged" | "saved disabled" | "FAILED";

export interface Change {
	id: string;
	action: Action;
	reason?: string;
}

export interface MergeResult {
	next: Record<string, unknown>;
	changes: Change[];
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type Run = (cmd: string[], options?: { stdin?: string }) => RunResult;

export type CliHost = "claude" | "grok" | "hermes";

export interface Plan {
	commands: string[][];
	changes: Change[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function mergeServers(current: unknown, entries: Entry[], shape: (entry: Entry) => Json, legacyKey?: string): MergeResult {
	const next: Json = isObject(current) ? { ...current } : {};
	let servers: Json = isObject(next.mcpServers) ? { ...next.mcpServers } : {};
	if (legacyKey && isObject(next[legacyKey])) {
		servers = { ...(next[legacyKey] as Json), ...servers };
		delete next[legacyKey];
	}
	const changes: Change[] = [];
	for (const entry of entries) {
		const wanted = shape(entry);
		const existing = servers[entry.id];
		const action: Action = existing === undefined ? "added" : sameJson(existing, wanted) ? "unchanged" : "replaced";
		servers[entry.id] = wanted;
		changes.push({ id: entry.id, action });
	}
	next.mcpServers = servers;
	return { next, changes };
}

export function mergeOmpMcp(current: unknown, entries: Entry[]): MergeResult {
	return mergeServers(current, entries, (e) => ({ type: "stdio", command: e.command, args: e.args }));
}

export function mergeMuseSettings(current: unknown, entries: Entry[]): MergeResult {
	const base = isObject(current) ? current : { schema_version: 1 };
	return mergeServers(
		base,
		entries,
		(e) => ({ type: "stdio", command: e.command, args: e.args, mode: "optional" }),
		"mcp_servers",
	);
}

export function planClaude(run: Run, entries: Entry[]): Plan {
	const plan: Plan = { commands: [], changes: [] };
	for (const entry of entries) {
		const got = run(["claude", "mcp", "get", entry.id]);
		const text = `${got.stdout}\n${got.stderr}`;
		const matches =
			got.code === 0 &&
			(text.includes([entry.command, ...entry.args].join(" ")) ||
				(text.includes(`Command: ${entry.command}`) && text.includes(`Args: ${entry.args.join(" ")}`)));
		if (matches) {
			plan.changes.push({ id: entry.id, action: "unchanged" });
			continue;
		}
		plan.changes.push({ id: entry.id, action: got.code === 0 ? "replaced" : "added" });
		plan.commands.push(["claude", "mcp", "remove", "--scope", "user", entry.id]);
		plan.commands.push(["claude", "mcp", "add", "--scope", "user", entry.id, "--", entry.command, ...entry.args]);
	}
	return plan;
}

export function planGrok(run: Run, entries: Entry[]): Plan {
	const listed = run(["grok", "mcp", "list", "--json"]);
	let servers: Json[] = [];
	try {
		const parsed: unknown = JSON.parse(listed.stdout);
		if (Array.isArray(parsed)) servers = parsed.filter(isObject);
	} catch {
		servers = [];
	}
	const plan: Plan = { commands: [], changes: [] };
	for (const entry of entries) {
		const existing = servers.filter((s) => s.name === entry.id);
		if (existing.some((s) => s.command === entry.command && sameJson(s.args ?? [], entry.args))) {
			plan.changes.push({ id: entry.id, action: "unchanged" });
			continue;
		}
		plan.changes.push({ id: entry.id, action: existing.length ? "replaced" : "added" });
		plan.commands.push(["grok", "mcp", "add", "--scope", "user", entry.id, entry.command, "--", ...entry.args]);
	}
	return plan;
}

export function planHermes(run: Run, entries: Entry[]): Plan {
	const lines = run(["hermes", "mcp", "list"]).stdout.split("\n");
	const plan: Plan = { commands: [], changes: [] };
	for (const entry of entries) {
		const full = [entry.command, ...entry.args].join(" ");
		// `hermes mcp list` rows are `<name>  <transport>  ...`; long transports are truncated with "...".
		const named = lines.map((line) => line.trim()).filter((line) => line.split(/\s+/)[0] === entry.id);
		const shown = named.filter((line) => {
			const transport = line.slice(entry.id.length).trim().split(/\s{2,}/)[0] ?? "";
			return transport.endsWith("...") ? full.startsWith(transport.slice(0, -3)) : transport === full;
		});
		// Status column is `✓ enabled` or `✗ disabled`; Hermes saves failed connection tests disabled.
		const disabled = shown.length > 0 && shown.every((line) => /\bdisabled\s*$/.test(line));
		if (shown.length && !disabled) {
			plan.changes.push({ id: entry.id, action: "unchanged" });
			continue;
		}
		plan.changes.push(
			disabled
				? { id: entry.id, action: "re-enabled", reason: "was disabled" }
				: { id: entry.id, action: named.length ? "replaced" : "added" },
		);
		plan.commands.push(["hermes", "mcp", "remove", entry.id]);
		plan.commands.push(["hermes", "mcp", "add", entry.id, "--command", entry.command, "--args", ...entry.args]);
	}
	return plan;
}

export function backupSuffix(date: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `.bak-ultrathink-mcp-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function backup(file: string, stamp: string, dryRun: boolean): void {
	if (!existsSync(file)) return;
	console.log(`  backup ${file} -> ${file}${stamp}`);
	if (!dryRun) copyFileSync(file, `${file}${stamp}`);
}

function readJson(file: string): unknown {
	if (!existsSync(file)) return undefined;
	return JSON.parse(readFileSync(file, "utf8"));
}

export function writeJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
	chmodSync(tmp, mode);
	renameSync(tmp, file);
}

function report(host: Host, changes: Change[]): void {
	for (const c of changes) console.log(`  ${host}: ${c.id} ${c.action}${c.reason ? `: ${c.reason}` : ""}`);
}

const spawnRun: Run = (cmd, options) => {
	const stdin = options?.stdin === undefined ? "ignore" : Buffer.from(options.stdin);
	const proc = Bun.spawnSync(cmd, { stdin, stdout: "pipe", stderr: "pipe" });
	return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
};

const PLANNERS: Record<CliHost, (run: Run, entries: Entry[]) => Plan> = {
	claude: planClaude,
	grok: planGrok,
	hermes: planHermes,
};

// Runs the plan's commands, then re-plans to confirm every changed entry is now registered.
// `hermes mcp add|remove` prompt (connection test / confirm); feeding "y\n" saves even when auth is pending.
export function applyCliPlan(host: CliHost, run: Run, entries: Entry[], plan: Plan): Change[] {
	const stdin = host === "hermes" ? "y\n" : undefined;
	const errors = new Map<string, string>();
	for (const cmd of plan.commands) {
		console.log(`  $ ${cmd.join(" ")}`);
		const result = run(cmd, stdin === undefined ? undefined : { stdin });
		if (result.code !== 0 && cmd[2] !== "remove") {
			const id = cmd.find((part) => entries.some((e) => e.id === part)) ?? "";
			errors.set(id, `exit ${result.code}: ${result.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
		}
	}
	const changed = entries.filter((e) => plan.changes.some((c) => c.id === e.id && c.action !== "unchanged"));
	const after = changed.length ? PLANNERS[host](run, changed).changes : [];
	return plan.changes.map((c) => {
		if (c.action === "unchanged") return c;
		const next = after.find((a) => a.id === c.id)?.action;
		if (next === "unchanged") return c;
		if (host === "hermes" && next === "re-enabled") {
			return { id: c.id, action: "saved disabled", reason: `${c.id} not authenticated yet` };
		}
		return { id: c.id, action: "FAILED", reason: errors.get(c.id) ?? `not registered after ${host} mcp add` };
	});
}

function list(value: string | undefined, allowed: readonly string[], name: string): string[] {
	if (!value) return [...allowed];
	const items = value.split(",").map((s) => s.trim()).filter(Boolean);
	for (const item of items) if (!allowed.includes(item)) throw new Error(`unknown ${name}: ${item}`);
	return items;
}

function argValue(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

export function main(argv: string[], run: Run = spawnRun, env: Record<string, string | undefined> = process.env): number {
	const dryRun = argv.includes("--dry-run");
	const hosts = list(argValue(argv, "--hosts"), HOSTS, "host") as Host[];
	const providers = list(argValue(argv, "--providers"), PROVIDER_IDS, "provider");
	const root = dirname(dirname(fileURLToPath(import.meta.url)));
	const command = join(root, "bin", "ultrathink-mcp");
	const entries: Entry[] = providers.map((id) => ({ id, command, args: ["serve", id] }));
	const stamp = backupSuffix(new Date());
	const home = env.HOME || homedir();
	const config = env.XDG_CONFIG_HOME || join(home, ".config");
	let failed = false;
	if (dryRun) console.log("dry run: nothing will be written or executed");

	for (const host of hosts) {
		console.log(`${host}:`);
		if (host === "omp" || host === "muse") {
			const file =
				host === "omp"
					? join(env.PI_CODING_AGENT_DIR || join(home, ".omp", "agent"), "mcp.json")
					: join(config, "muse", "settings.json");
			const current = readJson(file);
			const merged = host === "omp" ? mergeOmpMcp(current, entries) : mergeMuseSettings(current, entries);
			report(host, merged.changes);
			if (sameJson(current, merged.next)) continue;
			backup(file, stamp, dryRun);
			console.log(`  write ${file}`);
			if (!dryRun) writeJson(file, merged.next);
			continue;
		}
		if (!Bun.which(host)) {
			console.log(`  ${host}: not on PATH, skipped`);
			continue;
		}
		const plan = PLANNERS[host](run, entries);
		if (!plan.commands.length || dryRun) report(host, plan.changes);
		if (!plan.commands.length) continue;
		const configFile =
			host === "claude"
				? join(env.CLAUDE_CONFIG_DIR || home, ".claude.json")
				: host === "grok"
					? join(home, ".grok", "config.toml")
					: join(env.HERMES_HOME || join(home, ".hermes"), "config.yaml");
		backup(configFile, stamp, dryRun);
		if (dryRun) {
			for (const cmd of plan.commands) console.log(`  $ ${cmd.join(" ")}`);
			continue;
		}
		const changes = applyCliPlan(host, run, entries, plan);
		report(host, changes);
		if (changes.some((c) => c.action === "FAILED")) failed = true;
	}
	return failed ? 1 : 0;
}

if (import.meta.main) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (error) {
		console.error(`mcp-register: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	}
}
