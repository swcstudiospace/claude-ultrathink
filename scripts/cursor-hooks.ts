// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
// Install or remove ultrathink's Cursor pstack bridge hook (hosts/cursor/ultrathink-cursor-pstack.js).
// Usage: see USAGE below (`bun scripts/cursor-hooks.ts --help`).
import {
	accessSync,
	chmodSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The staged hook file name inside <cursorDir>/hooks. */
export const HOOK_FILE = "ultrathink-cursor-pstack.js";
/** The hooks.json event ultrathink registers the staged hook under. */
export const EVENT = "beforeSubmitPrompt";
/** Marker that makes a hooks.json entry ultrathink's; gsd-managed, substrate-managed and markerless entries never match. */
export const OUR_MARKER = "ultrathink-managed";

export const USAGE = `Usage: bun scripts/cursor-hooks.ts install|remove [--cursor-dir <dir>]

  install             stage hosts/cursor/${HOOK_FILE} into <cursorDir>/hooks and register it in
                      <cursorDir>/hooks.json under hooks.${EVENT} with ${OUR_MARKER}: true
  remove              delete ultrathink's entry from hooks.${EVENT} and unstage the hook file
  --cursor-dir <dir>  Cursor settings directory (default: ~/.cursor)

Entries without the ${OUR_MARKER} marker whose command does not name ${HOOK_FILE}
(gsd-managed, substrate-managed, foreign) are never modified, reordered or removed.`;

type Json = Record<string, unknown>;
export type HookAction = "added" | "replaced" | "unchanged" | "removed" | "not present";
export interface HookChange {
	/** The new hooks.json value to write; absent when nothing should be written. */
	next?: Json;
	action?: HookAction;
	reason?: string;
}

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Node binaries in GSD's launcher-loop order: `/usr/bin/node`, whatever `PATH` resolves, then
 * `/usr/local/bin/node`. Duplicates collapse so a PATH hit on `/usr/bin/node` is tried once.
 */
export function nodeCandidates(env: Record<string, string | undefined>): string[] {
	const fromPath = Bun.which("node", { PATH: env.PATH ?? "" });
	const ordered = ["/usr/bin/node", ...(fromPath ? [fromPath] : []), "/usr/local/bin/node"];
	return [...new Set(ordered)];
}

/** The first executable candidate, mirroring GSD's launcher node loop. */
export function resolveNode(candidates: readonly string[]): string | undefined {
	return candidates.find(executable);
}

/** POSIX single quotes, so a shell keeps spaces and metacharacters inside one argument. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The hooks.json command Cursor runs: both paths quoted, both absolute when the installer stored them. */
export function hookCommand(node: string, script: string): string {
	return `${shellQuote(node)} ${shellQuote(script)}`;
}

/** An entry is ultrathink's when it carries the marker or its command names the staged hook file. */
export function isOwned(entry: unknown): boolean {
	return (
		isObject(entry) &&
		(entry[OUR_MARKER] === true || (typeof entry.command === "string" && entry.command.includes(HOOK_FILE)))
	);
}

/** A fresh hooks.json value with hooks.EVENT as an array, or a reason the file cannot be shaped safely. */
function prepare(current: unknown): { top: Json; hooks: Json; list: unknown[] } | { reason: string } {
	if (current !== undefined && !isObject(current)) return { reason: "hooks.json top-level value is not an object" };
	const top: Json = current === undefined ? {} : { ...current };
	if (top.hooks !== undefined && !isObject(top.hooks)) return { reason: 'hooks.json: "hooks" is not an object' };
	const hooks: Json = top.hooks === undefined ? {} : { ...top.hooks };
	const existing = hooks[EVENT];
	if (existing !== undefined && !Array.isArray(existing)) {
		return { reason: `hooks.json: "hooks.${EVENT}" is not an array` };
	}
	const list: unknown[] = existing === undefined ? [] : [...existing];
	top.hooks = hooks;
	hooks[EVENT] = list;
	return { top, hooks, list };
}

/** Adds or refreshes ultrathink's entry: owned entries are replaced in place (duplicates collapse), otherwise it appends. */
export function upsertHook(current: unknown, wanted: Json): HookChange {
	const shaped = prepare(current);
	if ("reason" in shaped) return { reason: shaped.reason };
	const { top, hooks, list } = shaped;
	const first = list.findIndex(isOwned);
	if (first < 0) {
		list.push(wanted);
		return { next: top, action: "added" };
	}
	const duplicates = list.some((entry, index) => index > first && isOwned(entry));
	if (!duplicates && JSON.stringify(list[first]) === JSON.stringify(wanted)) return { action: "unchanged" };
	// Foreign entries keep their slots; owned ones collapse into `wanted` at the first owned slot.
	hooks[EVENT] = list.flatMap((entry, index) => (index === first ? [wanted] : isOwned(entry) ? [] : [entry]));
	return { next: top, action: "replaced" };
}

/** Deletes every owned entry, leaving foreign entries and their positions untouched. */
export function removeHook(current: unknown): HookChange {
	const shaped = prepare(current);
	if ("reason" in shaped) return { reason: shaped.reason };
	const { top, hooks, list } = shaped;
	if (!list.some(isOwned)) return { action: "not present" };
	hooks[EVENT] = list.filter((entry) => !isOwned(entry));
	return { next: top, action: "removed" };
}

/** Reads hooks.json; a missing file is an empty config, an unparseable one is a hard error. `raw` is the bytes a later write must still find. */
export function readHooksFile(file: string): { config?: unknown; raw?: string } | { reason: string } {
	if (!existsSync(file)) return { config: undefined };
	try {
		const raw = readFileSync(file, "utf8");
		return { config: JSON.parse(raw), raw };
	} catch (error) {
		return { reason: `hooks.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Atomic hooks.json write: temp file in the same directory (0600), then rename over the target.
 * Refuses when the file's bytes are no longer `expectedRaw` (a missing file matches `undefined`), so a
 * concurrent edit is not replaced with the snapshot from before that edit. Returns false when it refuses.
 */
export function writeHooksFile(file: string, value: unknown, expectedRaw?: string): boolean {
	const current = (): string | undefined => (existsSync(file) ? readFileSync(file, "utf8") : undefined);
	let seen: string | undefined;
	try {
		seen = current();
	} catch {
		return false;
	}
	if (seen !== expectedRaw) return false;
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		// Check again immediately before the rename. The window is small, and a mismatch retries or refuses.
		if (current() !== expectedRaw) {
			rmSync(tmp, { force: true });
			return false;
		}
		renameSync(tmp, file);
		return true;
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

const HOOK_WRITE_ATTEMPTS = 3;

/** Re-reads hooks.json and merges until the write still matches what was read, or the attempts run out. */
function commitHooks(
	file: string,
	merge: (current: unknown) => HookChange,
	log: (line: string) => void,
	beforeCommit: (() => void) | undefined,
): { code: number; action?: HookAction } {
	for (let attempt = 1; attempt <= HOOK_WRITE_ATTEMPTS; attempt++) {
		const parsed = readHooksFile(file);
		if ("reason" in parsed) return { code: fail(log, parsed.reason) };
		const merged = merge(parsed.config);
		if (merged.reason) return { code: fail(log, merged.reason) };
		if (merged.next === undefined) return { code: 0, ...(merged.action ? { action: merged.action } : {}) };
		beforeCommit?.();
		if (writeHooksFile(file, merged.next, parsed.raw)) return { code: 0, ...(merged.action ? { action: merged.action } : {}) };
	}
	return { code: fail(log, "hooks.json changed while it was being updated; re-run the command") };
}

/** Creates dir (and parents) with `mode` only when missing; existing directories keep their mode. */
function ensureDir(dir: string, mode: number): boolean {
	if (existsSync(dir)) return false;
	mkdirSync(dir, { recursive: true, mode });
	chmodSync(dir, mode);
	return true;
}

export interface MainDeps {
	env: Record<string, string | undefined>;
	/** Repository root whose hosts/cursor hook gets staged. */
	root: string;
	log: (line: string) => void;
	/** Node candidates in launcher-loop order; defaults to nodeCandidates(env). */
	nodeCandidates: string[];
	/** Test seam: runs after a merge is computed and before the compare-and-swap write. */
	beforeCommit?: () => void;
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
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--cursor-dir") {
			cursorArg = argv[++i];
			if (cursorArg === undefined) return usage(log, "missing value for --cursor-dir");
		} else if (command === undefined) command = argv[i];
		else return usage(log, `unexpected argument: ${argv[i]}`);
	}
	if (command !== "install" && command !== "remove") {
		return usage(log, command ? `unknown command: ${command}` : "missing command (install or remove)");
	}
	// Relative --cursor-dir values are resolved now. Cursor does not launch the hook from the installer's cwd.
	const cursorDir = resolve(cursorArg ?? join(env.HOME?.trim() || homedir(), ".cursor"));
	const file = join(cursorDir, "hooks.json");
	const staged = join(cursorDir, "hooks", HOOK_FILE);
	// An unparseable hooks.json must change nothing, including the staged hook file.
	const initial = readHooksFile(file);
	if ("reason" in initial) return fail(log, initial.reason);

	if (command === "install") {
		const source = join(root, "hosts", "cursor", HOOK_FILE);
		if (!existsSync(source)) return fail(log, `hook source not found: ${source}`);
		const candidates = deps.nodeCandidates ?? nodeCandidates(env);
		const node = resolveNode(candidates);
		if (node === undefined) return fail(log, `no executable node found (tried ${candidates.join(", ")})`);
		const wanted: Json = { type: "command", command: hookCommand(node, staged), [OUR_MARKER]: true };
		ensureDir(cursorDir, 0o700);
		ensureDir(dirname(staged), 0o755);
		copyFileSync(source, staged);
		chmodSync(staged, 0o644);
		log(`staged ${staged}`);
		const committed = commitHooks(file, (current) => upsertHook(current, wanted), log, deps.beforeCommit);
		if (committed.code !== 0) return committed.code;
		log(
			committed.action === "unchanged"
				? `hooks.json: ${EVENT} entry already current`
				: `hooks.json: ${EVENT} entry ${committed.action}`,
		);
		return 0;
	}

	const committed = commitHooks(file, (current) => removeHook(current), log, deps.beforeCommit);
	if (committed.code !== 0) return committed.code;
	if (existsSync(staged)) {
		rmSync(staged);
		log(`unstaged ${staged}`);
	}
	log(
		committed.action === "not present"
			? `hooks.json: no ${OUR_MARKER} ${EVENT} entry present`
			: `hooks.json: ${EVENT} entry removed`,
	);
	return 0;
}

if (import.meta.main) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (error) {
		console.error(`cursor-hooks: ${error instanceof Error ? error.message : String(error)}`);
		console.error(USAGE);
		process.exit(2);
	}
}
