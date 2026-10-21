// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditPath, createAuditLog, verifyAuditFile } from "./audit.ts";
import { createAuditVerifier, verifyObserved } from "./audit-verify.ts";
import { type ScanReply, type WatchAlert, createAuditWatch } from "./audit-watch.ts";

const START = 1_700_000_000_000;
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-audit-verify-"));
	dirs.push(dir);
	return dir;
}

/** Each record advances the clock one second. */
function clock(): () => number {
	let t = START;
	return () => {
		t += 1000;
		return t;
	};
}

describe("observed scans", () => {
	test("bytes appended after the observed size are not part of the verdict", () => {
		const path = auditPath(tempDir());
		const log = createAuditLog({ path, now: clock() });
		log.record("login_ok", { n: 1 });
		log.record("login_ok", { n: 2 });
		const observed = statSync(path);
		const head = log.head();
		log.record("login_ok", { n: 3 });
		log.record("login_ok", { n: 4 });

		expect(verifyObserved({ path, activeBytes: observed.size, activeIno: observed.ino })).toEqual({ ok: true, records: 2, lastHash: head.hash });
		expect(verifyAuditFile(path).ok).toBe(true);
	});

	test("an active file that was replaced after the observation is raced, not judged", () => {
		const path = auditPath(tempDir());
		const log = createAuditLog({ path, now: clock() });
		log.record("login_ok", { n: 1 });
		const observed = statSync(path);

		expect(verifyObserved({ path, activeBytes: observed.size, activeIno: observed.ino + 1 })).toBe("raced");
	});

	test("the worker verifier judges a tampered chain as broken, and answers raced once closed", async () => {
		const path = auditPath(tempDir());
		const log = createAuditLog({ path, now: clock() });
		log.record("login_ok", { n: 1 });
		log.record("login_ok", { n: 2 });
		const observed = statSync(path);
		const request = { path, activeBytes: observed.size, activeIno: observed.ino };
		const verifier = createAuditVerifier();

		expect(await verifier.verify(request)).toMatchObject({ ok: true, records: 2 });

		const lines = readFileSync(path, "utf8").split("\n");
		lines[0] = (lines[0] as string).replace('"n":1', '"n":7');
		writeFileSync(path, lines.join("\n"));
		expect(await verifier.verify(request)).toMatchObject({ ok: false, brokenAt: 1 });

		verifier.close();
		expect(await verifier.verify(request)).toBe("raced");
	});
});

describe("a worker that does not answer", () => {
	test("fails the scan at the deadline, and the next tick scans again on a fresh worker", async () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const log = createAuditLog({ path, now: clock() });
		log.record("login_ok", { n: 1 });
		log.record("login_ok", { n: 2 });
		const head = log.head();
		// The worker ignores requests while this flag exists. Every worker is a new thread, so the flag is what persists between them.
		const hold = join(dir, "hold");
		writeFileSync(hold, "");
		const script = join(dir, "verify.worker.ts");
		writeFileSync(
			script,
			`import { existsSync } from "node:fs";
import { verifyObserved } from ${JSON.stringify(fileURLToPath(new URL("./audit-verify.ts", import.meta.url)))};
self.onmessage = (event) => {
	if (existsSync(${JSON.stringify(hold)})) return;
	self.postMessage(verifyObserved(event.data));
};
`,
		);
		const verifier = createAuditVerifier({ workerUrl: pathToFileURL(script), deadlineMs: 500 });
		const alerts: WatchAlert[] = [];
		let recovers = 0;
		const watch = createAuditWatch({
			intervalMs: 1000,
			// The acknowledged fingerprint is unknown here, so every tick sees a change and judges it.
			stat: () => {
				const stat = statSync(path);
				return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
			},
			acknowledged: () => ({ fingerprint: undefined, seq: head.seq, hash: head.hash }),
			scan: (observed) => verifier.verify({ path, activeBytes: observed.size, activeIno: observed.ino }),
			onAlert: (alert) => alerts.push(alert),
			onRecover: () => {
				recovers += 1;
			},
		});

		await watch.tick();
		expect(alerts).toEqual([{ kind: "chain_broken", reason: "verifier failed: timed out after 500 ms" }]);

		// The hold lifts. The next tick scans again on a fresh worker, and its verdict matches the acknowledged head.
		rmSync(hold);
		await watch.tick();
		expect(alerts).toHaveLength(1);
		expect(recovers).toBe(1);
		verifier.close();
	});
});

describe("a dispatch that fails", () => {
	type FakeTimer = { readonly run: () => void; cleared: boolean };

	/** A stand-in worker that counts posts and terminations. `posted` resolves on the first post; the test delivers verdicts by hand. */
	function fakeWorker() {
		const state = { posts: 0, terminations: 0 };
		let markPosted: () => void = () => undefined;
		const posted = new Promise<void>((resolve) => {
			markPosted = resolve;
		});
		const fake = {
			onmessage: undefined as ((event: { data: ScanReply }) => void) | undefined,
			postMessage: (): void => {
				state.posts += 1;
				markPosted();
			},
			terminate: (): void => {
				state.terminations += 1;
			},
		};
		return { fake, state, posted };
	}

	test("a timer left by a failed dispatch does not terminate or reject the next request's worker", async () => {
		const later = fakeWorker();
		const timers: FakeTimer[] = [];
		let starts = 0;
		const verifier = createAuditVerifier({
			deadlineMs: 50,
			createWorker: () => {
				starts += 1;
				if (starts === 1) throw new Error("cannot start worker");
				return later.fake as unknown as Worker;
			},
			setTimer: (run) => {
				const timer: FakeTimer = { run, cleared: false };
				timers.push(timer);
				return timer;
			},
			clearTimer: (handle) => {
				(handle as FakeTimer).cleared = true;
			},
		});
		const request = { path: "unused", activeBytes: 0, activeIno: 0 };
		await expect(verifier.verify(request)).rejects.toThrow("cannot start worker");

		const verdict: ScanReply = { ok: true, records: 2, lastHash: "a".repeat(64) };
		const second = verifier.verify(request);
		await later.posted;
		later.fake.onmessage?.({ data: verdict });
		await expect(second).resolves.toEqual(verdict);
		// Every deadline that was never cancelled fires now, as it would once its deadline passed. Only a stale one can.
		for (const timer of timers) {
			if (!timer.cleared) timer.run();
		}
		expect(later.state.terminations).toBe(0);
		verifier.close();
	});
});
