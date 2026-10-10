// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Behavioral probes for the shared read-model: boundaries, scoping,
 * noncreation, persisted-state stability, sanitizer order and card exclusion.
 * No source-string assertions, no host/renderer wiring, no exact-copy pins.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionPath } from "../claude/state.ts";
import { formatP, DEFAULT_DECISIONS_CONFIG } from "../decisions/types.ts";
import { DEFAULT_HINDSIGHT_CONFIG } from "../hindsight/types.ts";
import { projectOf } from "../teach/mapping.ts";
import { storeDir } from "../teach/store.ts";
import { DEFAULT_TEACH_CONFIG } from "../teach/types.ts";
import type { TeachableMoment, TeachConfig, TeachContext } from "../teach/types.ts";
import {
	formatInsightText,
	insightLessonRevision,
	readInsightSnapshot,
	sanitizeInsightText,
	toInsightCardSnapshot,
} from "./omp-insights.ts";
import type { InsightScope } from "./omp-insights.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = `${ESC}[31m`;
const OSC_OPEN = `${ESC}]8;;http://example.invalid`;
const C1_NEXT_LINE = String.fromCharCode(133);
const BACKSPACE = String.fromCharCode(8);
const BIDI_OVERRIDE = String.fromCharCode(0x202e);

let root: string;
let stateDir: string;
let cwd: string;
let project: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ut-insights-"));
	stateDir = join(root, "state");
	cwd = join(root, "shop");
	mkdirSync(cwd, { recursive: true });
	project = projectOf(cwd);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeCtx(overrides: { teach?: Partial<TeachConfig>; env?: NodeJS.ProcessEnv; decisions?: boolean } = {}): TeachContext {
	return {
		host: "omp",
		cwd,
		config: {
			teach: { ...DEFAULT_TEACH_CONFIG, ...overrides.teach },
			hindsight: { ...DEFAULT_HINDSIGHT_CONFIG },
			...(overrides.decisions === false ? {} : { decisions: { ...DEFAULT_DECISIONS_CONFIG } }),
		},
		env: { ...process.env, ...overrides.env },
		stateDir,
	} as TeachContext;
}

function scopeFor(sessionId: string, dir: string = cwd): InsightScope {
	return { sessionId, cwd: dir, stateDir, epoch: 1 };
}

function writeSessionRecord(sessionId: string, decisions: unknown): void {
	mkdirSync(join(stateDir, "sessions"), { recursive: true });
	writeFileSync(sessionPath(stateDir, sessionId), JSON.stringify({ sessionId, at: 1, result: {}, decisions }));
}

let momentSeq = 0;
function writeMoment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	momentSeq += 1;
	const id = (overrides.id as string | undefined) ?? `lesson-${momentSeq}`;
	const record: Record<string, unknown> = {
		schema: 2,
		name: `Lesson ${id}`,
		description: "a short description",
		body: "lesson body text",
		sourcePhase: "plan",
		sourceArtifacts: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		tags: [],
		relatedIds: [],
		kind: "pattern",
		status: "candidate",
		origin: "explicit",
		project,
		host: "omp",
		confidence: 1,
		occurrences: 1,
		lastSeenAt: "2026-01-02T00:00:00.000Z",
		dedupeKey: `dedupe-${id}`,
		recalled: 0,
		...overrides,
		id,
	};
	mkdirSync(join(stateDir, "teach", "moments"), { recursive: true });
	writeFileSync(join(stateDir, "teach", "moments", `${id}.json`), JSON.stringify(record));
	return record;
}

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		point: "plan",
		outcome: "ok",
		model: "test-model",
		p: 0.5,
		probabilities: { plan_worthy: 0.5 },
		threshold: 0.2,
		action: "plan",
		latencyMs: 10,
		attempts: 1,
		at: 1000,
		...overrides,
	};
}

function snapshotFiles(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (current: string): void => {
		let entries: string[] = [];
		try {
			entries = readdirSync(current);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(current, entry);
			const stat = lstatSync(full);
			if (stat.isDirectory()) walk(full);
			else if (stat.isFile()) {
				out.set(full, `${stat.mtimeMs}:${stat.size}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
			} else {
				out.set(full, `other:${stat.mtimeMs}`);
			}
		}
	};
	walk(dir);
	return out;
}

describe("sanitizeInsightText", () => {
	test("control-split secrets still redact after stripping", () => {
		const split = `api_key=super${CSI}secretvalue`;
		const clean = sanitizeInsightText(split, { maxChars: 500 });
		expect(clean).toContain("[redacted]");
		expect(clean).not.toContain("supersecretvalue");
	});

	test("osc hyperlink payloads and csi colors are removed, text survives", () => {
		const clean = sanitizeInsightText(`${OSC_OPEN}${BEL}click${ESC}\\ here ${CSI}red`, { maxChars: 500 });
		expect(clean).not.toContain(ESC);
		expect(clean).toContain("click");
		expect(clean).toContain("here");
		expect(clean).toContain("red");
		expect(clean).not.toContain("example.invalid");
	});

	test("c1, carriage return, backspace, tab and bidi marks are removed", () => {
		const dirty = `a\rb${BACKSPACE}X\tc${BIDI_OVERRIDE}d${C1_NEXT_LINE}e`;
		expect(sanitizeInsightText(dirty, { maxChars: 500 })).toBe("abXcde");
	});

	test("private keys and url credentials redact", () => {
		const key = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
		const cleanedKey = sanitizeInsightText(key, { maxChars: 500 });
		expect(cleanedKey).toContain("[redacted]");
		expect(cleanedKey).not.toContain("BEGIN PRIVATE KEY");
		const url = sanitizeInsightText("fetch https://alice:s3cret@example.com/path now", { maxChars: 500 });
		expect(url).not.toContain("s3cret");
		expect(url).toContain("example.com");
	});

	test("multiline keeps newlines, single-line folds them", () => {
		expect(sanitizeInsightText("line1\nline2", { multiline: true, maxChars: 500 })).toBe("line1\nline2");
		expect(sanitizeInsightText("line1\nline2", { maxChars: 500 })).toBe("line1 line2");
	});

	test("cap applies after redaction and counts code points", () => {
		const long = `api_key=${"x".repeat(5000)}`;
		const clean = sanitizeInsightText(long, { maxChars: 20 });
		expect(Array.from(clean).length).toBeLessThanOrEqual(20);
		expect(clean).toContain("[redacted]");
	});

	test("non-strings yield empty text", () => {
		expect(sanitizeInsightText(undefined)).toBe("");
		expect(sanitizeInsightText(42)).toBe("");
		expect(sanitizeInsightText({ text: "hi" })).toBe("");
	});
});

describe("insightLessonRevision", () => {
	test("stable for identical source, moves with body/occurrences/status, ignores recall count", () => {
		const base: TeachableMoment = {
			id: "rev-1",
			schema: 2,
			name: "n",
			description: "d",
			body: "b",
			sourcePhase: "plan",
			sourceArtifacts: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			tags: [],
			relatedIds: [],
			kind: "pattern",
			status: "candidate",
			origin: "explicit",
			project: "shop",
			host: "omp",
			confidence: 1,
			occurrences: 1,
			lastSeenAt: "2026-01-02T00:00:00.000Z",
			dedupeKey: "dedupe-rev-1",
			recalled: 0,
		};
		const first = insightLessonRevision(base);
		expect(insightLessonRevision({ ...base })).toBe(first);
		expect(insightLessonRevision({ ...base, body: "changed" })).not.toBe(first);
		expect(insightLessonRevision({ ...base, occurrences: 4 })).not.toBe(first);
		expect(insightLessonRevision({ ...base, status: "confirmed" })).not.toBe(first);
		expect(insightLessonRevision({ ...base, recalled: 9 })).toBe(first);
	});
});

describe("readInsightSnapshot Jev scope", () => {
	test("missing file, absent decisions and empty decisions each explain differently", () => {
		return (async () => {
			const ctx = makeCtx();
			const missing = await readInsightSnapshot(scopeFor("no-such-session"), ctx);
			writeSessionRecord("sess-b", undefined as unknown as undefined);
			const absent = await readInsightSnapshot(scopeFor("sess-b"), ctx);
			writeSessionRecord("sess-c", []);
			const empty = await readInsightSnapshot(scopeFor("sess-c"), ctx);
			for (const snap of [missing, absent, empty]) {
				expect(snap.decisions).toEqual([]);
				expect(snap.partial).toBe(false);
				expect(snap.limitations.length).toBeGreaterThan(0);
			}
			const texts = [missing, absent, empty].map((snap) => JSON.stringify(snap.limitations));
			expect(new Set(texts).size).toBe(3);
		})();
	});

	test("another session's last.json is never consulted", () => {
		return (async () => {
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(join(stateDir, "last.json"), JSON.stringify({ sessionId: "other", at: 1, result: {}, decisions: [decision()] }));
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(snap.decisions).toEqual([]);
		})();
	});

	test("record attributed to a different session id is refused, not shown", () => {
		return (async () => {
			mkdirSync(join(stateDir, "sessions"), { recursive: true });
			writeFileSync(
				sessionPath(stateDir, "sess-a"),
				JSON.stringify({ sessionId: "sess-b", at: 1, result: {}, decisions: [decision()] }),
			);
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(snap.decisions).toEqual([]);
			expect(snap.partial).toBe(true);
		})();
	});

	test("newest settled first, stored order survives ties, duplicates stay separate", () => {
		return (async () => {
			const first = decision({ at: 500, p: 0.1, probabilities: { plan_worthy: 0.1 } });
			const second = decision({ at: 500, p: 0.2, probabilities: { plan_worthy: 0.2 } });
			const late = decision({ at: 3000, p: 0.9, probabilities: { plan_worthy: 0.9 } });
			const early = decision({ at: 1000, p: 0.3, probabilities: { plan_worthy: 0.3 } });
			const twin = decision({ at: 3000, p: 0.9, probabilities: { plan_worthy: 0.9 } });
			writeSessionRecord("sess-a", [first, second, late, early, twin]);
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(snap.decisions.map((row) => row.at)).toEqual([3000, 3000, 1000, 500, 500]);
			expect(snap.decisions.slice(3).map((row) => row.p)).toEqual([0.1, 0.2]);
			expect(snap.decisions.length).toBe(5);
		})();
	});

	test("zero attempts, latency and p survive; recorded p is never recomputed", () => {
		return (async () => {
			writeSessionRecord("sess-a", [decision({ p: 0, attempts: 0, latencyMs: 0, cost: 0, probabilities: {} })]);
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(snap.decisions.length).toBe(1);
			expect(snap.decisions[0]?.p).toBe(0);
			expect(snap.decisions[0]?.attempts).toBe(0);
			expect(snap.decisions[0]?.latencyMs).toBe(0);
			expect(snap.decisions[0]?.cost).toBe(0);
			writeSessionRecord("sess-b", [decision({ p: 0.199, probabilities: { plan_worthy: 0.199 } })]);
			const precise = await readInsightSnapshot(scopeFor("sess-b"), makeCtx());
			expect(precise.decisions[0]?.p).toBe(0.199);
			expect(formatP(0.199)).toBe("0.19");
		})();
	});

	test("out-of-range and unknown rows are rejected, never clamped", () => {
		return (async () => {
			writeSessionRecord("sess-a", [
				decision({ p: 2 }),
				decision({ p: null }),
				decision({ threshold: -0.5 }),
				decision({ threshold: 7 }),
				decision({ attempts: -1 }),
				decision({ latencyMs: Number.POSITIVE_INFINITY }),
				decision({ action: "fly" }),
				decision({ point: "nope" }),
				decision({ error: "bogus", outcome: "error" }),
				decision({ outcome: "ok", error: "timeout" }),
				decision({ p: 1, threshold: 1, action: "keep" }),
			]);
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(snap.decisions.length).toBe(1);
			expect(snap.decisions[0]?.p).toBe(1);
			expect(snap.partial).toBe(true);
		})();
	});

	test("error rows keep kind with zero attempts; missing p stays missing", () => {
		return (async () => {
			writeSessionRecord("sess-a", [
				{ point: "plan", outcome: "error", model: "m", probabilities: {}, threshold: 0.2, action: "fail-open", latencyMs: 5, attempts: 0, at: 9, error: "timeout" },
			]);
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(snap.decisions.length).toBe(1);
			expect(snap.decisions[0]?.error).toBe("timeout");
			expect(snap.decisions[0]?.p).toBeUndefined();
			expect(snap.decisions[0]?.attempts).toBe(0);
		})();
	});

	test("collections cap at one hundred newest with a disclosed limit", () => {
		return (async () => {
			const rows = Array.from({ length: 101 }, (_, index) => decision({ at: 1000 + index, p: 0.5 }));
			writeSessionRecord("sess-a", rows);
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(snap.decisions.length).toBe(100);
			expect(snap.decisions[0]?.at).toBe(1100);
			// A complete read capped for display is not a failed read: neutral
			// limitation note, and the snapshot never warns partial.
			expect(snap.partial).toBe(false);
			expect(snap.limitations).toContain("Only the newest 100 records are shown.");
		})();
	});
});

describe("readInsightSnapshot lessons", () => {
	test("missing store stays missing and reads as empty without partial", () => {
		return (async () => {
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(snap.lessons).toEqual([]);
			expect(snap.counts).toEqual({ candidate: 0, confirmed: 0, promoted: 0, superseded: 0 });
			expect(snap.partial).toBe(false);
			expect(existsSync(storeDir(stateDir))).toBe(false);
		})();
	});

	test("corrupt, oversized and symlinked rows are skipped with partial, valid rows survive", () => {
		return (async () => {
			writeMoment({ id: "good-1", status: "confirmed", occurrences: 9 });
			mkdirSync(join(stateDir, "teach", "moments"), { recursive: true });
			writeFileSync(join(stateDir, "teach", "moments", "bad-1.json"), "{not json");
			const big = { ...writeMoment({ id: "big-1" }), body: "x".repeat(70_000) };
			writeFileSync(join(stateDir, "teach", "moments", "big-1.json"), JSON.stringify(big));
			symlinkSync(join(stateDir, "teach", "moments", "good-1.json"), join(stateDir, "teach", "moments", "link-1.json"));
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(snap.lessons.map((lesson) => lesson.id).sort()).toEqual(["big-1", "good-1"].sort().filter((id) => id === "good-1"));
			expect(snap.partial).toBe(true);
		})();
	});

	test("an unreadable moments directory is disclosed as partial; a missing one stays honestly empty", () => {
		return (async () => {
			mkdirSync(join(stateDir, "teach"), { recursive: true });
			writeFileSync(join(stateDir, "teach", "moments"), "not a directory");
			const unreadable = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(unreadable.lessons).toEqual([]);
			expect(unreadable.partial).toBe(true);
			expect(unreadable.limitations.some((note) => note.includes("lesson directory could not be read"))).toBe(true);
			rmSync(join(stateDir, "teach", "moments"), { force: true });
			const missing = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(missing.lessons).toEqual([]);
			expect(missing.partial).toBe(false);
		})();
	});

	test("similar project names never leak across scopes", () => {
		return (async () => {
			const dirA = join(root, "shop");
			const dirB = join(root, "shop2");
			mkdirSync(dirA, { recursive: true });
			mkdirSync(dirB, { recursive: true });
			const projectA = projectOf(dirA);
			const projectB = projectOf(dirB);
			expect(projectA).not.toBe(projectB);
			writeMoment({ id: "a-1", project: projectA, status: "confirmed", occurrences: 9 });
			writeMoment({ id: "b-1", project: projectB, status: "confirmed", occurrences: 9 });
			const snapA = await readInsightSnapshot(scopeFor("sess-a", dirA), makeCtx());
			expect(snapA.lessons.map((lesson) => lesson.id)).toEqual(["a-1"]);
			expect(snapA.counts.confirmed).toBe(1);
			const snapB = await readInsightSnapshot(scopeFor("sess-a", dirB), makeCtx());
			expect(snapB.lessons.map((lesson) => lesson.id)).toEqual(["b-1"]);
		})();
	});

	test("id prefixes resolve as exact full ids only", () => {
		return (async () => {
			writeMoment({ id: "item-1", createdAt: "2026-01-01T00:00:00.000Z" });
			writeMoment({ id: "item-10", createdAt: "2026-01-02T00:00:00.000Z" });
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(snap.lessons.map((lesson) => lesson.selection.id).sort()).toEqual(["item-1", "item-10"]);
		})();
	});

	test("newest created first with id tie-break", () => {
		return (async () => {
			writeMoment({ id: "m-b", createdAt: "2026-02-01T00:00:00.000Z" });
			writeMoment({ id: "m-a", createdAt: "2026-02-01T00:00:00.000Z" });
			writeMoment({ id: "m-c", createdAt: "2026-03-01T00:00:00.000Z" });
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(snap.lessons.map((lesson) => lesson.id)).toEqual(["m-c", "m-a", "m-b"]);
		})();
	});

	test("deterministic eligibility follows saved-lesson rules at the boundary", () => {
		return (async () => {
			const ctx = makeCtx({ teach: { promoteAfter: 3 } });
			writeMoment({ id: "below", status: "confirmed", kind: "pattern", occurrences: 2 });
			writeMoment({ id: "at", status: "confirmed", kind: "pattern", occurrences: 3 });
			writeMoment({ id: "above", status: "confirmed", kind: "pattern", occurrences: 4 });
			writeMoment({ id: "play", status: "confirmed", kind: "playbook", occurrences: 1 });
			writeMoment({ id: "cand", status: "candidate", kind: "pattern", occurrences: 99 });
			writeMoment({ id: "sup", status: "superseded", kind: "pattern", occurrences: 99 });
			writeMoment({ id: "done", status: "promoted", kind: "pattern", occurrences: 9, promoted: { at: "2026-01-01T00:00:00.000Z", skill: "s", target: "omp" } });
			const snap = await readInsightSnapshot(scopeFor("sess-a"), ctx);
			const byId = new Map(snap.lessons.map((lesson) => [lesson.id, lesson]));
			expect(byId.get("below")?.eligible).toBe(false);
			expect(byId.get("at")?.eligible).toBe(true);
			expect(byId.get("above")?.eligible).toBe(true);
			expect(byId.get("play")?.eligible).toBe(true);
			expect(byId.get("cand")?.eligible).toBe(false);
			expect(byId.get("sup")?.eligible).toBe(false);
			expect(byId.get("done")?.eligible).toBe(false);
			expect(snap.eligible).toBe(3);
			expect(snap.promoted).toBe(1);
		})();
	});

	test("recorded promotion reads as recorded metadata, and missing optionals stay missing", () => {
		return (async () => {
			writeMoment({
				id: "prom-1",
				status: "promoted",
				occurrences: 5,
				recalled: 0,
				promoted: { at: "2026-02-02T00:00:00.000Z", skill: "my-skill", target: "omp", path: "/skills/my-skill" },
			});
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			const lesson = snap.lessons.find((row) => row.id === "prom-1");
			expect(lesson?.promoted?.skill).toBe("my-skill");
			expect(lesson?.promoted?.target).toBe("omp");
			expect(lesson?.recalled).toBe(0);
			writeMoment({ id: "plain-1", status: "candidate" });
			const second = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(second.lessons.find((row) => row.id === "plain-1")?.promoted).toBeUndefined();
		})();
	});

	test("long bodies are capped in bound, not passed through whole", () => {
		return (async () => {
			writeMoment({ id: "long-1", body: "y".repeat(5000) });
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			const body = snap.lessons.find((row) => row.id === "long-1")?.body ?? "";
			expect(Array.from(body).length).toBeLessThanOrEqual(2400);
			expect(body.length).toBeGreaterThan(0);
		})();
	});

	test("repeated reads change no files, bump no counters and enqueue nothing", () => {
		return (async () => {
			writeSessionRecord("sess-a", [decision()]);
			writeMoment({ id: "stable-1", status: "confirmed", occurrences: 3, recalled: 2 });
			const ctx = makeCtx();
			const before = snapshotFiles(stateDir);
			await readInsightSnapshot(scopeFor("sess-a"), ctx);
			await readInsightSnapshot(scopeFor("sess-a"), ctx);
			const after = snapshotFiles(stateDir);
			expect(Array.from(after.entries())).toEqual(Array.from(before.entries()));
			const snap = await readInsightSnapshot(scopeFor("sess-a"), ctx);
			expect(snap.lessons.find((row) => row.id === "stable-1")?.recalled).toBe(2);
		})();
	});

	test("aborted reads resolve to safe partial snapshots, never throw or publish", () => {
		return (async () => {
			writeSessionRecord("sess-a", [decision()]);
			writeMoment({ id: "abort-1" });
			const controller = new AbortController();
			controller.abort();
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx(), controller.signal);
			expect(snap.partial).toBe(true);
			expect(Array.isArray(snap.lessons)).toBe(true);
			expect(Array.isArray(snap.decisions)).toBe(true);
		})();
	});

	test("policy reflects effective config, kill switch and jev presence", () => {
		return (async () => {
			const off = await readInsightSnapshot(scopeFor("sess-a"), makeCtx({ env: { ULTRATHINK_TEACH: "0" } }));
			expect(off.policy.enabled).toBe(false);
			const on = await readInsightSnapshot(scopeFor("sess-a"), makeCtx({ teach: { capture: "explicit", autoPromote: false, promoteAfter: 7 } }));
			expect(on.policy.enabled).toBe(true);
			expect(on.policy.capture).toBe("explicit");
			expect(on.policy.autoPromote).toBe(false);
			expect(on.policy.promoteAfter).toBe(7);
			expect(on.policy.jevEnabled).toBe(true);
			const noJev = await readInsightSnapshot(scopeFor("sess-a"), makeCtx({ decisions: false }));
			expect(noJev.policy.jevEnabled).toBe(false);
		})();
	});

	test("counts cover every lifecycle over shown rows", () => {
		return (async () => {
			writeMoment({ id: "c-1", status: "candidate" });
			writeMoment({ id: "c-2", status: "confirmed", occurrences: 1 });
			writeMoment({ id: "c-3", status: "promoted", promoted: { at: "2026-01-01T00:00:00.000Z", skill: "s", target: "omp" } });
			writeMoment({ id: "c-4", status: "superseded" });
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(snap.counts).toEqual({ candidate: 1, confirmed: 1, promoted: 1, superseded: 1 });
		})();
	});
});

describe("toInsightCardSnapshot", () => {
	test("bodies, revisions and runtime scope are excluded while rows survive", () => {
		return (async () => {
			writeSessionRecord("sess-a", [decision({ p: 0.42 })]);
			writeMoment({ id: "card-1", body: "SENTINEL-BODY-9f8e7d", status: "confirmed", occurrences: 9 });
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			const card = toInsightCardSnapshot(snap);
			const serialized = JSON.stringify(card);
			expect(serialized).not.toContain("SENTINEL-BODY-9f8e7d");
			expect(serialized).not.toContain("revision");
			expect(serialized).not.toContain(stateDir);
			expect(serialized).not.toContain(cwd);
			expect(card.decisions.length).toBe(1);
			expect(card.decisions[0]?.p).toBe(0.42);
			expect(card.lessons.length).toBe(1);
			expect(card.lessons[0]?.id).toBe("card-1");
			expect(card.policy.capture).toBe(snap.policy.capture);
			expect(card.counts).toEqual(snap.counts);
		})();
	});

	test("untrusted persisted details are re-sanitized on intake", () => {
		return (async () => {
			writeMoment({ id: "evil-1", name: `nice${ESC}[31m api_key=topsecretvalue`, status: "candidate" });
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			const card = toInsightCardSnapshot({ ...snap, project: `p${ESC}[2K` });
			expect(JSON.stringify(card)).not.toContain(ESC);
			expect(JSON.stringify(card)).not.toContain("topsecretvalue");
		})();
	});

	test("card rows stay bounded for transcript persistence", () => {
		return (async () => {
			for (let index = 0; index < 30; index += 1) {
				writeMoment({ id: `bulk-${index}`, createdAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z` });
			}
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			expect(snap.lessons.length).toBe(30);
			expect(toInsightCardSnapshot(snap).lessons.length).toBeLessThanOrEqual(24);
		})();
	});

	test("24-row truncation appends bounded omission notes without widening the DTO", () => {
		return (async () => {
			writeSessionRecord(
				"sess-a",
				Array.from({ length: 30 }, (_, index) => decision({ at: 1000 + index })),
			);
			for (let index = 0; index < 30; index += 1) {
				writeMoment({ id: `bulk-${index}`, createdAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z` });
			}
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			const card = toInsightCardSnapshot(snap);
			expect(card.decisions.length).toBe(24);
			expect(card.lessons.length).toBe(24);
			const notes = card.limitations.join("\n");
			expect(notes).toContain("6 more decisions omitted");
			expect(notes).toContain("6 more lessons omitted");
			expect(notes).toContain("/ultrathink-ui");
		})();
	});

	test("question keys and promotion pointers are re-sanitized with no path leak", () => {
		return (async () => {
			writeSessionRecord("sess-a", [decision({ probabilities: { ok: 0.5, [`bad${ESC}[31mkey`]: 0.7 } })]);
			writeMoment({
				id: "promo-1",
				status: "promoted",
				promoted: { at: "2026-01-04T00:00:00Z", skill: "some-skill", target: "omp", path: "/secret/SENTINEL-PATH-4d2c" },
			});
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			const card = toInsightCardSnapshot(snap);
			const serialized = JSON.stringify(card);
			expect(serialized).not.toContain(ESC);
			expect(serialized).not.toContain("SENTINEL-PATH-4d2c");
			expect(serialized).toContain("some-skill");
		})();
	});
});

describe("formatInsightText", () => {
	test("fallback counts only rendered lessons and discloses the rest within its budget", async () => {
		for (let index = 0; index < 30; index += 1) writeMoment({ id: `fallback-${index}` });
		const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
		const rows = formatInsightText(snap).split("\n");
		const displayed = rows.filter((row) => row.startsWith("- [")).length;
		expect(rows.find((row) => row.startsWith("Lessons for"))).toContain(`(${displayed} of 30 shown)`);
		expect(rows.join("\n")).toContain(`${30 - displayed} more lessons omitted`);
		expect(displayed).toBeLessThan(30);
		expect(rows.length).toBeLessThanOrEqual(24);
		expect(rows.at(-1)).toContain("Omp TUI");
	});

	test("stored timestamps strip controls before redacting supported secret patterns", async () => {
		const secret = `sk-${"x".repeat(40)}`;
		const splitSecret = `${secret.slice(0, 12)}${CSI}${secret.slice(12)}`;
		writeMoment({
			id: "timestamp-intake",
			createdAt: splitSecret,
			lastSeenAt: splitSecret,
			status: "promoted",
			promoted: { at: splitSecret, target: "omp", skill: "fixture" },
		});
		const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
		const lesson = snap.lessons[0];
		for (const timestamp of [lesson?.createdAt, lesson?.lastSeenAt, lesson?.promoted?.at]) {
			expect(timestamp).toContain("[redacted]");
			expect(timestamp).not.toContain(secret);
			expect(timestamp).not.toContain(ESC);
		}
	});

	test("fallback stays within row and column bounds with no controls", () => {
		return (async () => {
			writeSessionRecord("sess-a", [decision({ p: 0.75 })]);
			writeMoment({ id: "t-1", name: "x".repeat(400), status: "confirmed", occurrences: 9 });
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			const text = formatInsightText(snap);
			const rows = text.split("\n");
			expect(rows.length).toBeLessThanOrEqual(24);
			for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(120);
			expect(text).not.toContain(ESC);
			expect(text).not.toContain("\r");
			expect(text).toContain(snap.project);
			expect(text).toContain(snap.session);
		})();
	});

	test("empty snapshots report zero shown rows and stay bounded", () => {
		return (async () => {
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			const text = formatInsightText(snap);
			expect(text).toContain("0 shown");
			expect(text.split("\n").length).toBeLessThanOrEqual(24);
		})();
	});

	test("saved probabilities never round across their threshold in the fallback", () => {
		return (async () => {
			writeSessionRecord("sess-a", [decision({ p: 0.199, threshold: 0.2 })]);
			const snap = await readInsightSnapshot(scopeFor("sess-a"), makeCtx());
			const text = formatInsightText(snap);
			expect(text).toContain("(P 0.19)");
			expect(text).not.toContain("(P 0.2)");
		})();
	});
});
