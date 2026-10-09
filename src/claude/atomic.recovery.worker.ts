// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Real-process RMW fixture; only the delayed worker pauses at the stale-read and rename boundaries. */
import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import type { SessionRecord } from "./state.ts";

const [stateDir, sessionId, events, actor] = process.argv.slice(2);
if (!stateDir || !sessionId || !events || !actor) process.exit(2);
const eventDir = events;
const lock = join(stateDir, "sessions", `${sessionId}.json.lock`);
const nodeFs = { ...fs };
const sleepWord = new Int32Array(new SharedArrayBuffer(4));
function signal(name: string): void {
	nodeFs.writeFileSync(join(eventDir, name), "", { mode: 0o600 });
}
function wait(name: string): void {
	const deadline = Date.now() + 20_000;
	while (!nodeFs.existsSync(join(eventDir, name))) {
		if (Date.now() >= deadline) throw new Error(`barrier timed out: ${name}`);
		Atomics.wait(sleepWord, 0, 0, 5);
	}
}

let paused = false;
mock.module("node:fs", () => ({
	...nodeFs,
	statSync(path: string): fs.Stats {
		const value = nodeFs.statSync(path);
		if (actor === "delayed" && !paused && path === lock && Date.now() - value.mtimeMs > 60_000) {
			paused = true;
			signal("snapshot");
			wait("snapshot-go");
		}
		return value;
	},
	renameSync(from: string, to: string): void {
		try {
			nodeFs.renameSync(from, to);
		} catch (error) {
			if (to === `${lock}.guard` && ["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
				signal(`${actor}.guarded`);
			}
			throw error;
		}
		if (actor === "delayed" && from === lock) {
			signal("moved");
			wait("rename-go");
		}
	},
}));

// This fixture must load state after installing process-local filesystem barriers; a static import would bind too early.
const { updateSession } = await import("./state.ts");
signal(`${actor}.attempting`);
const result = updateSession(stateDir, sessionId, (record: SessionRecord & { counter?: number }) => {
	let active: number | undefined;
	try {
		active = nodeFs.openSync(join(events, "active"), "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		signal(`${actor}.overlap`);
	}
	try {
		signal(`${actor}.entered`);
		wait("body-go");
		return { ...record, counter: (record.counter ?? 0) + 1 };
	} finally {
		if (active !== undefined) {
			nodeFs.closeSync(active);
			nodeFs.unlinkSync(join(events, "active"));
		}
	}
}, { timeoutMs: 20_000, staleMs: 60_000, pollMs: 5 });
if (!result) throw new Error("session vanished");
