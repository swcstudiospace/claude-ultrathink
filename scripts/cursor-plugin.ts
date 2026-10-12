#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
// Install or remove the Cursor planner hook, and optionally wire substrate and swarm.
// Usage: see USAGE below (`bun scripts/cursor-plugin.ts --help`).
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	EVENT,
	HOOK_LOCK_WAIT_MS,
	acquireHookLock,
	hookCommand,
	nodeCandidates,
	readHooksFile,
	resolveNode,
	writeHooksFile,
} from "./cursor-hooks.ts";

/** Staged planner hook. Distinct from the pstack bridge file. */
export const PLAN_HOOK_FILE = "ultrathink-cursor-plan.js";
/** Sibling file naming the ultrathink checkout the staged hook calls. */
export const PLAN_ROOT_FILE = "ultrathink-cursor-plan.root";
/**
 * Marker for this installer only. The pstack installer owns `ultrathink-managed`
 * and would replace any other entry that carries it.
 */
export const PLAN_MARKER = "ultrathink-cursor-managed";

export const USAGE = `Usage: bun scripts/cursor-plugin.ts install|remove [--cursor-dir <dir>] [--target <repo>]

  install             stage hosts/cursor/${PLAN_HOOK_FILE} into <cursorDir>/hooks and register it
                      under hooks.${EVENT} with ${PLAN_MARKER}: true
  remove              delete that entry and the staged hook; leaves pstack and substrate entries
  --cursor-dir <dir>  Cursor settings directory (default: ~/.cursor)
  --target <repo>     workspace that receives Agent Swarm Cursor agents when SWARM_ROOT is set

Optional checkouts, both fail-open (a missing checkout is skipped, a failing command is logged):
  SUBSTRATE_ROOT      run the substrate Cursor hook projector and cursor-mcp projector
  SWARM_ROOT          with --target, run scripts/_install_cursor.py (agents and the rule only)

Does not start swarm_run.py or autonomous_run.py, and does not write tokens.`;

type Json = Record<string, unknown>;
export type HookAction = "added" | "replaced" | "unchanged" | "removed" | "not present";

export interface ExternalStep {
	name: string;
	argv: string[];
	/** Absolute path that must exist before the command runs. */
	script: string;
}

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An entry is this installer's when it carries the planner marker or names the planner hook file. */
export function isPlanOwned(entry: unknown): boolean {
	return (
		isObject(entry) &&
		(entry[PLAN_MARKER] === true || (typeof entry.command === "string" && entry.command.includes(PLAN_HOOK_FILE)))
	);
}

function prepare(current: unknown): { top: Json; hooks: Json; list: unknown[] } | { reason: string } {
	if (current !== undefined && !isObject(current)) return { reason: "hooks.json top-level value is not an object" };
	const top: Json = current === undefined ? {} : { ...current };
	if (top.hooks !== undefined && !isObject(top.hooks)) return { reason: 'hooks.json: "hooks" is not an object' };
	const hooks: Json = top.hooks === undefined ? {} : { ...top.hooks };
	const existing = hooks[EVENT];
	if (existing !== undefined && !Array.isArray(existing)) return { reason: `hooks.json: "hooks.${EVENT}" is not an array` };
	const list: unknown[] = existing === undefined ? [] : [...existing];
	top.hooks = hooks;
	hooks[EVENT] = list;
	return { top, hooks, list };
}

/** Adds or refreshes the planner entry. Pstack, substrate, and other entries keep their slots. */
export function upsertPlanHook(current: unknown, wanted: Json): { next?: Json; action?: HookAction; reason?: string } {
	const shaped = prepare(current);
	if ("reason" in shaped) return { reason: shaped.reason };
	const { top, hooks, list } = shaped;
	const first = list.findIndex(isPlanOwned);
	if (first < 0) {
		list.push(wanted);
		return { next: top, action: "added" };
	}
	const duplicates = list.some((entry, index) => index > first && isPlanOwned(entry));
	if (!duplicates && JSON.stringify(list[first]) === JSON.stringify(wanted)) return { action: "unchanged" };
	hooks[EVENT] = list.flatMap((entry, index) => (index === first ? [wanted] : isPlanOwned(entry) ? [] : [entry]));
	return { next: top, action: "replaced" };
}

/** Deletes planner entries only. */
export function removePlanHook(current: unknown): { next?: Json; action?: HookAction; reason?: string } {
	const shaped = prepare(current);
	if ("reason" in shaped) return { reason: shaped.reason };
	const { top, hooks, list } = shaped;
	if (!list.some(isPlanOwned)) return { action: "not present" };
	hooks[EVENT] = list.filter((entry) => !isPlanOwned(entry));
	return { next: top, action: "removed" };
}

/**
 * Commands for the optional checkouts. Absent env skips that checkout.
 * `--target` is required before the swarm installer is included.
 * No step runs `swarm_run.py` or `autonomous_run.py`.
 */
export function externalSteps(env: Record<string, string | undefined>, target: string | undefined): ExternalStep[] {
	const steps: ExternalStep[] = [];
	const substrate = env.SUBSTRATE_ROOT?.trim();
	if (substrate) {
		steps.push({
			name: "substrate-hooks",
			script: join(substrate, "packages", "projector", "src", "cursor.ts"),
			argv: ["bun", join(substrate, "packages", "projector", "src", "cursor.ts")],
		});
		steps.push({
			name: "substrate-mcp",
			script: join(substrate, "packages", "projector", "src", "cursor-mcp.ts"),
			argv: ["bun", join(substrate, "packages", "projector", "src", "cursor-mcp.ts")],
		});
	}
	const swarm = env.SWARM_ROOT?.trim();
	if (swarm && target) {
		const script = join(swarm, "scripts", "_install_cursor.py");
		steps.push({
			name: "swarm-cursor",
			script,
			argv: ["python3", script, "--target", target],
		});
	}
	return steps;
}

export interface MainDeps {
	env: Record<string, string | undefined>;
	root: string;
	log: (line: string) => void;
	nodeCandidates: string[];
	/** Runs one external argv. Default is spawnSync. Return status, or null when the binary cannot start. */
	run?: (argv: string[]) => number | null;
}

function usage(log: (line: string) => void, reason: string): number {
	log(`error: ${reason}`);
	log(USAGE);
	return 2;
}

function fail(log: (line: string) => void, reason: string): number {
	log(`error: ${reason}`);
	return 1;
}

function ensureDir(dir: string, mode: number): void {
	if (existsSync(dir)) return;
	mkdirSync(dir, { recursive: true, mode });
	chmodSync(dir, mode);
}

function commit(
	file: string,
	merge: (current: unknown) => { next?: Json; action?: HookAction; reason?: string },
	log: (line: string) => void,
): { code: number; action?: HookAction } {
	for (let attempt = 1; attempt <= 3; attempt++) {
		const parsed = readHooksFile(file);
		if ("reason" in parsed) return { code: fail(log, parsed.reason) };
		const merged = merge(parsed.config);
		if (merged.reason) return { code: fail(log, merged.reason) };
		if (merged.next === undefined) return { code: 0, ...(merged.action ? { action: merged.action } : {}) };
		if (writeHooksFile(file, merged.next, parsed.raw)) return { code: 0, ...(merged.action ? { action: merged.action } : {}) };
	}
	return { code: fail(log, "hooks.json changed while it was being updated; re-run the command") };
}

function defaultRun(argv: string[]): number | null {
	const result = spawnSync(argv[0] ?? "", argv.slice(1), { stdio: "inherit" });
	return result.error ? null : result.status;
}

/** Runs optional substrate and swarm installers. A missing script or a non-zero status is logged and skipped. */
export function runExternal(
	steps: readonly ExternalStep[],
	log: (line: string) => void,
	run: (argv: string[]) => number | null,
): void {
	for (const step of steps) {
		if (!existsSync(step.script)) {
			log(`${step.name}: skipped, ${step.script} is not installed`);
			continue;
		}
		const status = run(step.argv);
		if (status === null) log(`${step.name}: skipped, ${step.argv[0]} could not start`);
		else if (status !== 0) log(`${step.name}: exited ${status}; the Cursor planner hook is still installed`);
		else log(`${step.name}: ok`);
	}
}

export function main(argv: string[], deps: Partial<MainDeps> = {}): number {
	const env = deps.env ?? process.env;
	const root = deps.root ?? dirname(dirname(fileURLToPath(import.meta.url)));
	const log = deps.log ?? console.log;
	if (argv.includes("--help") || argv.includes("-h")) {
		log(USAGE);
		return 0;
	}
	let command: string | undefined;
	let cursorArg: string | undefined;
	let target: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--cursor-dir") {
			cursorArg = argv[++i];
			if (cursorArg === undefined) return usage(log, "missing value for --cursor-dir");
		} else if (arg === "--target") {
			target = argv[++i];
			if (target === undefined) return usage(log, "missing value for --target");
		} else if (command === undefined) command = arg;
		else return usage(log, `unexpected argument: ${arg}`);
	}
	if (command !== "install" && command !== "remove") {
		return usage(log, command ? `unknown command: ${command}` : "missing command (install or remove)");
	}
	if (target !== undefined && !isAbsolute(target)) target = resolve(target);
	const cursorDir = resolve(cursorArg ?? join(env.HOME?.trim() || homedir(), ".cursor"));
	const file = join(cursorDir, "hooks.json");
	const staged = join(cursorDir, "hooks", PLAN_HOOK_FILE);
	const rootFile = join(cursorDir, "hooks", PLAN_ROOT_FILE);
	const initial = readHooksFile(file);
	if ("reason" in initial) return fail(log, initial.reason);

	if (command === "remove") {
		if (removePlanHook(initial.config).action === "not present" && !existsSync(staged) && !existsSync(rootFile)) {
			log(`hooks.json: no ${PLAN_MARKER} ${EVENT} entry present`);
			return 0;
		}
		const locked = acquireHookLock(cursorDir, HOOK_LOCK_WAIT_MS);
		if ("reason" in locked) return fail(log, locked.reason);
		try {
			const committed = commit(file, removePlanHook, log);
			if (committed.code !== 0) return committed.code;
			if (existsSync(staged)) {
				rmSync(staged);
				log(`unstaged ${staged}`);
			}
			if (existsSync(rootFile)) rmSync(rootFile);
			log(
				committed.action === "not present"
					? `hooks.json: no ${PLAN_MARKER} ${EVENT} entry present`
					: `hooks.json: ${EVENT} entry removed`,
			);
			return 0;
		} finally {
			locked.release();
		}
	}

	const source = join(root, "hosts", "cursor", PLAN_HOOK_FILE);
	if (!existsSync(source)) return fail(log, `hook source not found: ${source}`);
	const candidates = deps.nodeCandidates ?? nodeCandidates(env);
	const node = resolveNode(candidates);
	if (node === undefined) return fail(log, `no executable node found (tried ${candidates.join(", ")})`);
	const wanted: Json = { type: "command", command: hookCommand(node, staged), [PLAN_MARKER]: true };
	const preview = upsertPlanHook(initial.config, wanted);
	if (preview.reason) return fail(log, preview.reason);

	const locked = acquireHookLock(cursorDir, HOOK_LOCK_WAIT_MS);
	if ("reason" in locked) return fail(log, locked.reason);
	const previousHook = existsSync(staged) ? readFileSync(staged) : undefined;
	const previousRoot = existsSync(rootFile) ? readFileSync(rootFile) : undefined;
	try {
		ensureDir(cursorDir, 0o700);
		ensureDir(dirname(staged), 0o755);
		copyFileSync(source, staged);
		chmodSync(staged, 0o644);
		writeFileSync(rootFile, `${root}\n`, { mode: 0o600 });
		chmodSync(rootFile, 0o600);
		log(`staged ${staged}`);
		const committed = commit(file, (current) => upsertPlanHook(current, wanted), log);
		if (committed.code !== 0) {
			if (previousHook === undefined) rmSync(staged, { force: true });
			else writeFileSync(staged, previousHook);
			if (previousRoot === undefined) rmSync(rootFile, { force: true });
			else writeFileSync(rootFile, previousRoot);
			return committed.code;
		}
		log(
			committed.action === "unchanged"
				? `hooks.json: ${EVENT} entry already current`
				: `hooks.json: ${EVENT} entry ${committed.action}`,
		);
	} finally {
		locked.release();
	}

	const run = deps.run ?? defaultRun;
	runExternal(externalSteps(env, target), log, run);
	return 0;
}

if (import.meta.main) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (error) {
		console.error(`cursor-plugin: ${error instanceof Error ? error.message : String(error)}`);
		console.error(USAGE);
		process.exit(2);
	}
}
