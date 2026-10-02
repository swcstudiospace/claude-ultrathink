// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Hands a `TeachDigest` to a detached `teach observe` process. A host's Stop or agent_end handler has seconds, and the
 * distiller needs up to 90, so the host writes the digest to a private inbox file and starts the CLI without waiting
 * for it. The CLI deletes the file once read; files left behind by a crash are pruned after 24 hours.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TeachDigest } from "./types.ts";

export const INBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INBOX_FILE = /^(\d+)-[0-9a-f]{8}\.json(?:\.tmp)?$/;

export interface SpawnObserveOptions {
	repoRoot: string;
	env: NodeJS.ProcessEnv;
	stateDir: string;
	host: string;
	/** Test seam; defaults to a detached, unref'd `node:child_process` spawn with ignored stdio. */
	spawn?: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => void;
}

function inboxDir(stateDir: string): string {
	return join(stateDir, "teach", "inbox");
}

function startDetached(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }): void {
	const child = nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: "ignore" });
	// A missing launcher is reported asynchronously as an 'error' event; without a listener it would crash the host.
	child.on("error", () => {});
	child.unref();
}

/** Removes inbox files older than 24 hours. Foreign file names are left alone; failures are ignored. */
function pruneInbox(dir: string, now: number): void {
	try {
		for (const name of readdirSync(dir)) {
			const match = INBOX_FILE.exec(name);
			if (match && now - Number(match[1]) > INBOX_MAX_AGE_MS) rmSync(join(dir, name), { force: true });
		}
	} catch {
		// best effort: no inbox yet, or unreadable
	}
}

export function writeInbox(digest: TeachDigest, stateDir: string, now: () => number = Date.now): string {
	const dir = inboxDir(stateDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// a directory we do not own keeps its mode
	}
	const path = join(dir, `${now()}-${randomBytes(4).toString("hex")}.json`);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(digest), { mode: 0o600 });
	renameSync(tmp, path);
	return path;
}

export function spawnObserveDetached(digest: TeachDigest, options: SpawnObserveOptions): { spawned: boolean; reason?: string } {
	let path: string | undefined;
	try {
		pruneInbox(inboxDir(options.stateDir), Date.now());
		path = writeInbox(digest, options.stateDir);
		const cwd = existsSync(digest.cwd) ? digest.cwd : options.repoRoot;
		(options.spawn ?? startDetached)(join(options.repoRoot, "bin", "ultrathink"), ["teach", "observe", "--file", path], {
			env: { ...options.env, ULTRATHINK_HOST: options.host, ULTRATHINK_STATE_DIR: options.stateDir },
			cwd,
		});
		return { spawned: true };
	} catch (error) {
		if (path) {
			try {
				rmSync(path, { force: true });
			} catch {
				// the 24 hour prune collects it
			}
		}
		return { spawned: false, reason: error instanceof Error ? error.message.slice(0, 200) : "spawn failed" };
	}
}
