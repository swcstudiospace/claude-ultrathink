#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
// Install or remove the Cursor planner hook, and optionally wire substrate and swarm.
// Usage: see USAGE below (`bun scripts/cursor-plugin.ts --help`).
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectStage, gsdCommandNames } from "../src/cursor/pstack.ts";
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

/** HTML marker in command files this installer writes. A file without it is left alone. */
export const GSD_MARKER = "ultrathink-cursor-gsd";
/** Plugin-relative directory of the thin GSD command files. Not `commands/` or `skills/`. */
export const GSD_COMMAND_DIR = "hosts/cursor/gsd-commands";

const GSD_STAGE_LINE: Record<string, string> = {
	discuss: "Discuss the phase before proposing a design.",
	plan: "Plan the phase before the plan is finalized.",
	execute: "Carry out the phase.",
	review: "Verify and review the completed change.",
	orchestrate: "Run the GSD autonomous loop across discuss, plan, execute, and review.",
};

/**
 * Thin Cursor command for one GSD name the pstack stage table already knows.
 * The body keeps `/<name>` on its own line so the pstack hook still sees an invocation
 * when Cursor inserts the file, and the marker is how `remove` tells our copy from a GSD plugin's.
 */
export function renderGsdCommand(name: string): string {
	const stage = detectStage(`/${name}`).stage ?? "execute";
	const line = GSD_STAGE_LINE[stage] ?? "Continue the GSD workflow for this command.";
	return [
		"---",
		`name: ${name}`,
		`description: ${name} (${stage}). Ultrathink plans /${name}, then the agent continues the GSD workflow.`,
		"---",
		"",
		`<!-- ${GSD_MARKER} -->`,
		"",
		`/${name}`,
		"",
		`${line} The text typed after the command name is the phase or task. Follow the installed GSD instructions for this command when they are present. Ultrathink plans this request before the workflow continues.`,
		"",
	].join("\n");
}

export const USAGE = `Usage: bun scripts/cursor-plugin.ts install|remove [--cursor-dir <dir>] [--target <repo>]

  install             stage hosts/cursor/${PLAN_HOOK_FILE} into <cursorDir>/hooks and register it
                      under hooks.${EVENT} with ${PLAN_MARKER}: true. Also copies the known
                      GSD command names into <cursorDir>/commands (marker ${GSD_MARKER}).
  remove              delete that entry, the staged hook, and command files that carry the marker.
                      Leaves pstack, substrate, and any command file this installer did not write.
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
	/** How long a hook update waits for the lock. Default HOOK_LOCK_WAIT_MS; tests pass 0. */
	lockWaitMs?: number;
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

/** True for any directory entry, a dangling symlink included. `existsSync` follows links, so it reports those as absent. */
function entryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function isRealFile(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function commandsDirIsWritable(dir: string, log: (line: string) => void): boolean {
	if (!existsSync(dir)) return true;
	try {
		if (lstatSync(dir).isSymbolicLink()) {
			log(`commands: skipped, ${dir} is a symlink`);
			return false;
		}
	} catch (error) {
		log(`commands: skipped, ${dir} could not be read (${error instanceof Error ? error.message : String(error)})`);
		return false;
	}
	return true;
}

/**
 * Copies one thin command per known GSD name into `<cursorDir>/commands`.
 * A regular file that does not carry {@link GSD_MARKER} is left in place (an installed GSD plugin).
 * A symlink is left in place. A write error is logged and does not undo the planner hook.
 */
export function installGsdCommands(cursorDir: string, log: (line: string) => void): number {
	const dir = join(cursorDir, "commands");
	if (!commandsDirIsWritable(dir, log)) return 0;
	let written = 0;
	try {
		ensureDir(dir, 0o755);
	} catch (error) {
		log(`commands: skipped, ${dir} could not be created (${error instanceof Error ? error.message : String(error)})`);
		return 0;
	}
	for (const name of gsdCommandNames()) {
		const dest = join(dir, `${name}.md`);
		const body = renderGsdCommand(name);
		try {
			if (entryExists(dest)) {
				if (!isRealFile(dest)) {
					log(`commands: left ${name}.md in place (not a regular file)`);
					continue;
				}
				const current = readFileSync(dest, "utf8");
				if (!current.includes(GSD_MARKER)) {
					log(`commands: left ${name}.md in place (not ultrathink's)`);
					continue;
				}
				if (current === body) {
					log(`commands: ${name}.md already current`);
					continue;
				}
			}
			writeFileSync(dest, body, { mode: 0o644 });
			chmodSync(dest, 0o644);
			written += 1;
			log(`commands: ${name}.md written`);
		} catch (error) {
			log(`commands: ${name}.md skipped (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	return written;
}

/** Deletes command files this installer wrote. Anything without the marker stays. */
export function removeGsdCommands(cursorDir: string, log: (line: string) => void): number {
	const dir = join(cursorDir, "commands");
	if (!existsSync(dir)) return 0;
	if (!commandsDirIsWritable(dir, log)) return 0;
	let removed = 0;
	for (const name of gsdCommandNames()) {
		const dest = join(dir, `${name}.md`);
		try {
			if (!existsSync(dest) || !isRealFile(dest)) continue;
			if (!readFileSync(dest, "utf8").includes(GSD_MARKER)) continue;
			rmSync(dest);
			removed += 1;
			log(`commands: removed ${name}.md`);
		} catch (error) {
			log(`commands: ${name}.md not removed (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	return removed;
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

	const lockWaitMs = deps.lockWaitMs ?? HOOK_LOCK_WAIT_MS;
	if (command === "remove") {
		if (!existsSync(cursorDir)) {
			log(`hooks.json: no ${PLAN_MARKER} ${EVENT} entry present`);
			return 0;
		}
		// Command files and the hook entry change under one lock, so an install in progress cannot write files back.
		const locked = acquireHookLock(cursorDir, lockWaitMs);
		if ("reason" in locked) return fail(log, locked.reason);
		try {
			const removedCommands = removeGsdCommands(cursorDir, log);
			const committed = commit(file, removePlanHook, log);
			if (committed.code !== 0) return committed.code;
			if (committed.action === "not present" && !existsSync(staged) && !existsSync(rootFile)) {
				log(
					removedCommands === 0
						? `hooks.json: no ${PLAN_MARKER} ${EVENT} entry present`
						: `hooks.json: no ${PLAN_MARKER} ${EVENT} entry present; removed ${removedCommands} GSD command file(s)`,
				);
				return 0;
			}
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

	const locked = acquireHookLock(cursorDir, lockWaitMs);
	if ("reason" in locked) return fail(log, locked.reason);
	const previousHook = existsSync(staged) ? readFileSync(staged) : undefined;
	const previousRoot = existsSync(rootFile) ? readFileSync(rootFile) : undefined;
	// Puts the staged hook and its root file back as they were. Runs after any failed or thrown step.
	const restore = (): void => {
		try {
			if (previousHook === undefined) rmSync(staged, { force: true });
			else writeFileSync(staged, previousHook);
			if (previousRoot === undefined) rmSync(rootFile, { force: true });
			else writeFileSync(rootFile, previousRoot);
		} catch (error) {
			log(`could not restore the previous planner files (${error instanceof Error ? error.message : String(error)})`);
		}
	};
	try {
		let committed: { code: number; action?: HookAction };
		try {
			ensureDir(cursorDir, 0o700);
			ensureDir(dirname(staged), 0o755);
			copyFileSync(source, staged);
			chmodSync(staged, 0o644);
			writeFileSync(rootFile, `${root}\n`, { mode: 0o600 });
			chmodSync(rootFile, 0o600);
			log(`staged ${staged}`);
			committed = commit(file, (current) => upsertPlanHook(current, wanted), log);
		} catch (error) {
			restore();
			return fail(log, `could not install the planner hook: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (committed.code !== 0) {
			restore();
			return committed.code;
		}
		log(
			committed.action === "unchanged"
				? `hooks.json: ${EVENT} entry already current`
				: `hooks.json: ${EVENT} entry ${committed.action}`,
		);
		// Command files change under the same lock as the hook, so a remove cannot run between the two.
		installGsdCommands(cursorDir, log);
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
