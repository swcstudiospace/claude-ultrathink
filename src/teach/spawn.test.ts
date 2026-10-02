// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnObserveDetached, writeInbox } from "./spawn.ts";
import type { TeachDigest } from "./types.ts";

let root: string;
let stateDir: string;
let repoRoot: string;
let sessionCwd: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "teach-spawn-"));
	stateDir = join(root, "state");
	repoRoot = join(root, "repo");
	sessionCwd = join(root, "session");
	mkdirSync(repoRoot);
	mkdirSync(sessionCwd);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function digest(overrides: Partial<TeachDigest> = {}): TeachDigest {
	return {
		host: "omp",
		sessionId: "s1",
		cwd: sessionCwd,
		at: "2026-10-02T10:00:00.000Z",
		turns: [
			{ role: "user", text: "go" },
			{ role: "assistant", text: "done" },
		],
		toolCalls: 4,
		...overrides,
	};
}

const inbox = (): string => join(stateDir, "teach", "inbox");

describe("writeInbox", () => {
	test("writes a private, atomically-named file under <stateDir>/teach/inbox", () => {
		const path = writeInbox(digest(), stateDir, () => 1_790_000_000_000);
		expect(path.startsWith(`${inbox()}/`)).toBe(true);
		expect(path.slice(inbox().length + 1)).toMatch(/^1790000000000-[0-9a-f]{8}\.json$/);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(inbox()).mode & 0o777).toBe(0o700);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(digest());
		expect(readdirSync(inbox()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("two writes in the same millisecond get different files", () => {
		const a = writeInbox(digest(), stateDir, () => 5);
		const b = writeInbox(digest(), stateDir, () => 5);
		expect(a).not.toBe(b);
		expect(readdirSync(inbox())).toHaveLength(2);
	});
});

describe("spawnObserveDetached", () => {
	test("starts `bin/ultrathink teach observe --file <inbox file>` with host and state dir in the environment", () => {
		const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
		const env = { PATH: "/usr/bin", KEEP: "1", ULTRATHINK_HOST: "stale", ULTRATHINK_STATE_DIR: "/stale" };
		const result = spawnObserveDetached(digest(), {
			repoRoot,
			env,
			stateDir,
			host: "omp",
			spawn: (cmd, args, opts) => {
				calls.push({ cmd, args, ...opts });
			},
		});
		expect(result).toEqual({ spawned: true });
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.cmd).toBe(join(repoRoot, "bin", "ultrathink"));
		expect(call?.args.slice(0, 3)).toEqual(["teach", "observe", "--file"]);
		const file = call?.args[3] ?? "";
		expect(file.startsWith(`${inbox()}/`)).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(digest());
		expect(call?.env).toMatchObject({ PATH: "/usr/bin", KEEP: "1", ULTRATHINK_HOST: "omp", ULTRATHINK_STATE_DIR: stateDir });
		expect(call?.cwd).toBe(sessionCwd);
		expect(env.ULTRATHINK_HOST).toBe("stale");
	});

	test("runs in the repository root when the session directory no longer exists", () => {
		let cwd = "";
		spawnObserveDetached(digest({ cwd: join(root, "gone") }), {
			repoRoot,
			env: {},
			stateDir,
			host: "omp",
			spawn: (_cmd, _args, opts) => {
				cwd = opts.cwd;
			},
		});
		expect(cwd).toBe(repoRoot);
	});

	test("a failing spawn reports the reason, removes the inbox file and does not throw", () => {
		const result = spawnObserveDetached(digest(), {
			repoRoot,
			env: {},
			stateDir,
			host: "omp",
			spawn: () => {
				throw new Error("EACCES: nope");
			},
		});
		expect(result.spawned).toBe(false);
		expect(result.reason).toContain("EACCES");
		expect(readdirSync(inbox())).toEqual([]);
	});

	test("an unwritable state directory reports spawned:false", () => {
		writeFileSync(join(root, "blocker"), "");
		const result = spawnObserveDetached(digest(), { repoRoot, env: {}, stateDir: join(root, "blocker"), host: "omp", spawn: () => {} });
		expect(result.spawned).toBe(false);
		expect(result.reason).toBeTruthy();
	});

	test("prunes inbox files older than 24 hours and leaves fresh and foreign files alone", () => {
		mkdirSync(inbox(), { recursive: true });
		const old = join(inbox(), "1000-aaaaaaaa.json");
		const oldTmp = join(inbox(), "1000-bbbbbbbb.json.tmp");
		const fresh = join(inbox(), `${Date.now() - 60_000}-cccccccc.json`);
		const foreign = join(inbox(), "notes.txt");
		for (const path of [old, oldTmp, fresh, foreign]) writeFileSync(path, "{}");
		spawnObserveDetached(digest(), { repoRoot, env: {}, stateDir, host: "omp", spawn: () => {} });
		expect(existsSync(old)).toBe(false);
		expect(existsSync(oldTmp)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(foreign)).toBe(true);
		expect(readdirSync(inbox())).toHaveLength(3);
	});

	test("the default spawn runs the launcher detached with the file argument and environment", async () => {
		const marker = join(root, "marker.txt");
		mkdirSync(join(repoRoot, "bin"));
		const launcher = join(repoRoot, "bin", "ultrathink");
		writeFileSync(launcher, `#!/bin/sh\nprintf '%s|%s|%s|%s' "$1 $2 $3" "$ULTRATHINK_HOST" "$ULTRATHINK_STATE_DIR" "$(pwd -P)" > "${marker}.tmp" && mv "${marker}.tmp" "${marker}"\n`);
		chmodSync(launcher, 0o755);
		const result = spawnObserveDetached(digest(), { repoRoot, env: { ...process.env }, stateDir, host: "omp" });
		expect(result).toEqual({ spawned: true });
		// The launcher runs detached, so there is no handle to await: poll for its (atomically renamed) marker file.
		for (let i = 0; i < 250 && !existsSync(marker); i++) await Bun.sleep(20);
		const [args, host, state, cwd] = readFileSync(marker, "utf8").split("|");
		expect(args).toBe("teach observe --file");
		expect(host).toBe("omp");
		expect(state).toBe(stateDir);
		expect(cwd).toBe(realpathSync(sessionCwd));
	});
});
