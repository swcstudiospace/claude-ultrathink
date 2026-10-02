// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HINDSIGHT_CONFIG } from "../hindsight/types.ts";
import type { HindsightConfig } from "../hindsight/types.ts";
import { momentCounts, teachStatusLine } from "./status.ts";
import { openStore, storeDir } from "./store.ts";
import { DEFAULT_TEACH_CONFIG } from "./types.ts";
import type { MomentStatus, TeachableMoment, TeachConfig } from "./types.ts";

let root: string;
let stateDir: string;
/** Never exists: keeps every test away from the operator's real credential store. */
let storePath: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ut-teach-status-"));
	stateDir = join(root, "state");
	storePath = join(root, "credentials.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function config(teach: Partial<TeachConfig> = {}, hindsight: Partial<HindsightConfig> = {}) {
	return {
		teach: { ...DEFAULT_TEACH_CONFIG, enabled: true, ...teach },
		hindsight: { ...DEFAULT_HINDSIGHT_CONFIG, ...hindsight },
	};
}

function moment(id: string, status: MomentStatus): TeachableMoment {
	return {
		id,
		name: `Lesson ${id}`,
		description: "",
		body: "body",
		sourcePhase: "",
		sourceArtifacts: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		tags: [],
		relatedIds: [],
		schema: 2,
		kind: "pitfall",
		status,
		origin: "explicit",
		project: "demo",
		host: "claude-code",
		confidence: 1,
		occurrences: 1,
		lastSeenAt: "2026-01-01T00:00:00.000Z",
		dedupeKey: id.padEnd(32, "0"),
		recalled: 0,
	};
}

describe("teachStatusLine", () => {
	test("off by default, and says how to opt in", () => {
		const line = teachStatusLine({ teach: DEFAULT_TEACH_CONFIG, hindsight: DEFAULT_HINDSIGHT_CONFIG }, {}, storePath);
		expect(line).toBe("Teach: off (opt-in: set teach.enabled)");
	});

	test("the kill switch wins over an enabled config", () => {
		expect(teachStatusLine(config(), { ULTRATHINK_TEACH: "0" }, storePath)).toBe("Teach: off (ULTRATHINK_TEACH=0)");
	});

	test("on without a state directory omits the counts and the outbox", () => {
		expect(teachStatusLine(config(), {}, storePath)).toBe("Teach: on · capture explicit · recall on · Hindsight off");
	});

	test("shows the capture mode and recall switch", () => {
		const line = teachStatusLine(config({ capture: "auto", recall: false }), {}, storePath);
		expect(line).toBe("Teach: on · capture auto · recall off · Hindsight off");
	});

	test("counts confirmed and candidate moments and the outbox from the store", () => {
		const store = openStore(storeDir(stateDir));
		store.put(moment("aaaa0001", "confirmed"));
		store.put(moment("aaaa0002", "confirmed"));
		store.put(moment("aaaa0003", "candidate"));
		store.put(moment("aaaa0004", "promoted"));
		store.enqueue({ op: "retain", momentId: "aaaa0001" }, 0);
		const line = teachStatusLine(config({ capture: "observe", recall: false }), {}, storePath, stateDir);
		expect(line).toBe("Teach: on · capture observe · recall off · 2 confirmed, 1 candidate · Hindsight off · outbox 1");
	});

	test("an absent store reads as zero and is not created", () => {
		const line = teachStatusLine(config(), {}, storePath, stateDir);
		expect(line).toBe("Teach: on · capture explicit · recall on · 0 confirmed, 0 candidate · Hindsight off · outbox 0");
		expect(existsSync(storeDir(stateDir))).toBe(false);
	});

	test("Hindsight states: no URL, bad URL, no key, ready, and off when disabled", () => {
		const word = (hindsight: Partial<HindsightConfig>, env: NodeJS.ProcessEnv = {}) =>
			teachStatusLine(config({}, hindsight), env, storePath).split("Hindsight ")[1];
		expect(word({ enabled: true })).toBe("no URL");
		expect(word({ enabled: true, url: "ftp://example.com" })).toBe("bad URL");
		expect(word({ enabled: true, url: "http://example.com" })).toBe("bad URL");
		expect(word({ enabled: true, url: "http://127.0.0.1:8888" })).toBe("no key");
		expect(word({ enabled: true, url: "http://127.0.0.1:8888" }, { HINDSIGHT_API_KEY: "k" })).toBe("ready");
		expect(word({ enabled: false, url: "http://127.0.0.1:8888" }, { HINDSIGHT_API_KEY: "k" })).toBe("off");
		expect(word({ enabled: true, url: "http://127.0.0.1:8888" }, { HINDSIGHT_API_KEY: "k", ULTRATHINK_HINDSIGHT: "0" })).toBe("off");
	});

	test("never contains the key", () => {
		const line = teachStatusLine(
			config({}, { enabled: true, url: "http://127.0.0.1:8888" }),
			{ HINDSIGHT_API_KEY: "secret-key-value" },
			storePath,
		);
		expect(line).not.toContain("secret-key-value");
	});
});

describe("momentCounts", () => {
	test("zero for every status when the store is missing", () => {
		expect(momentCounts(stateDir)).toEqual({
			moments: { candidate: 0, confirmed: 0, promoted: 0, superseded: 0 },
			outbox: 0,
		});
	});

	test("counts each status", () => {
		const store = openStore(storeDir(stateDir));
		store.put(moment("bbbb0001", "superseded"));
		store.put(moment("bbbb0002", "promoted"));
		store.put(moment("bbbb0003", "promoted"));
		expect(momentCounts(stateDir).moments).toEqual({ candidate: 0, confirmed: 0, promoted: 2, superseded: 1 });
	});
});
