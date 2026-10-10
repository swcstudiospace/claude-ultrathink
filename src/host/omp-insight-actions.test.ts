// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_HINDSIGHT_CONFIG,
	type HindsightClient,
	type HindsightResult,
	type RetainItem,
	type RetainOutcome,
} from "../hindsight/types.ts";
import { captureMoment } from "../teach/capture.ts";
import { renderSkillDraft } from "../teach/promote.ts";
import { openStore, storeDir } from "../teach/store.ts";
import { DEFAULT_TEACH_CONFIG, type CaptureInput, type TeachableMoment, type TeachContext, type TeachStore } from "../teach/types.ts";
import { confirmInsightLesson, installInsightSkill, previewInsightSkill } from "./omp-insight-actions.ts";
import type { InsightActionRuntime } from "./omp-insight-actions.ts";
import { insightLessonRevision } from "./omp-insights.ts";
import type { LessonSelection, SkillPreview } from "./omp-insights.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ok = <T>(value: T): HindsightResult<T> => ({ ok: true, value });

function fullClient(overrides: Partial<HindsightClient> = {}): HindsightClient {
	return {
		bank: "ultrathink",
		health: async () => ok({ ok: true, apiVersion: "0.9.1", databaseConnected: true, features: {} }),
		ensureBank: async () => ok({ bankId: "ultrathink", created: false, extractionMode: "chunks" }),
		retain: async (item) => ok({ bankId: "ultrathink", documentId: item.documentId, itemsCount: 1 }),
		recall: async () => ok([]),
		getDocument: async () => ok(null),
		deleteDocument: async () => ok(true),
		setDocumentTags: async () => ok(true as const),
		deleteBank: async () => ok(true as const),
		...overrides,
	};
}

interface Harness {
	root: string;
	cwd: string;
	ctx: TeachContext;
	current: { value: boolean };
	controller: AbortController;
	runtime: InsightActionRuntime;
	store: TeachStore;
}

function harness(options: { hindsight?: HindsightClient; enabled?: boolean; killSwitch?: boolean; autoPromote?: boolean } = {}): Harness {
	const root = mkdtempSync(join(tmpdir(), "ultrathink-insight-actions-"));
	dirs.push(root);
	const cwd = join(root, "proj");
	mkdirSync(cwd, { recursive: true });
	const env: NodeJS.ProcessEnv = { HOME: root, PI_CODING_AGENT_DIR: join(root, "omp-agent") };
	if (options.killSwitch) env.ULTRATHINK_TEACH = "0";
	const ctx: TeachContext = {
		host: "omp",
		cwd,
		config: {
			teach: { ...DEFAULT_TEACH_CONFIG, enabled: options.enabled ?? true, autoPromote: options.autoPromote ?? true },
			hindsight: { ...DEFAULT_HINDSIGHT_CONFIG },
		},
		env,
		stateDir: join(root, "state"),
	};
	if (options.hindsight) ctx.hindsight = options.hindsight;
	const current = { value: true };
	const controller = new AbortController();
	const runtime: InsightActionRuntime = {
		scope: { sessionId: "sess-1", cwd, stateDir: ctx.stateDir, epoch: 1 },
		getContext: () => ctx,
		isCurrent: () => current.value,
		signal: controller.signal,
	};
	return { root, cwd, ctx, current, controller, runtime, store: openStore(storeDir(ctx.stateDir)) };
}

function lessonInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
	return { name: "Retry with backoff", description: "Retry loop.", body: "Use capped exponential backoff around the fetch.", ...overrides };
}

async function seedCandidate(h: Harness, overrides: Partial<CaptureInput> = {}): Promise<TeachableMoment> {
	const outcome = await captureMoment(lessonInput({ status: "candidate", ...overrides }), h.ctx);
	const stored = h.store.get(outcome.moment.id);
	if (!stored || stored.status !== "candidate") throw new Error("candidate seeding failed");
	return stored;
}

async function seedEligible(h: Harness, overrides: Partial<CaptureInput> = {}): Promise<TeachableMoment> {
	const outcome = await captureMoment(lessonInput(overrides), h.ctx);
	const confirmed = { ...outcome.moment, occurrences: 3 };
	h.store.put(confirmed);
	const stored = h.store.get(confirmed.id);
	if (!stored) throw new Error("eligible seeding failed");
	return stored;
}

function selectionOf(moment: TeachableMoment): LessonSelection {
	return { id: moment.id, revision: insightLessonRevision(moment) };
}

describe("confirmInsightLesson", () => {
	test("confirms a candidate and reports retained retention from actual persisted state", async () => {
		const h = harness({ hindsight: fullClient() });
		const moment = await seedCandidate(h);
		const result = await confirmInsightLesson(selectionOf(moment), h.runtime);
		expect(result.status).toBe("ok");
		expect(result.message).toContain("Candidate confirmed. Retention: retained.");
		const stored = h.store.get(moment.id);
		expect(stored?.status).toBe("confirmed");
		expect(stored?.retained?.documentId).toBe(`tm:${moment.id}`);
	});

	test("distinguishes queued retention from retained success", async () => {
		const failing = fullClient({ retain: async () => ({ ok: false, error: { kind: "server", message: "down" } }) });
		const h = harness({ hindsight: failing });
		const moment = await seedCandidate(h);
		const result = await confirmInsightLesson(selectionOf(moment), h.runtime);
		expect(result.status).toBe("ok");
		expect(result.message).toContain("Retention: queued.");
		expect(h.store.get(moment.id)?.status).toBe("confirmed");
		expect(h.store.get(moment.id)?.retained).toBeUndefined();
		expect(h.store.outbox().map((entry) => entry.op)).toEqual([{ op: "retain", momentId: moment.id }]);
	});

	test("distinguishes local-only retention when no client is ready", async () => {
		const h = harness();
		const moment = await seedCandidate(h);
		const result = await confirmInsightLesson(selectionOf(moment), h.runtime);
		expect(result.status).toBe("ok");
		expect(result.message).toContain("Retention: local-only.");
		expect(h.store.get(moment.id)?.status).toBe("confirmed");
		expect(h.store.outbox()).toEqual([]);
	});

	test("refuses a stale revision without touching the lesson", async () => {
		const h = harness({ hindsight: fullClient() });
		const moment = await seedCandidate(h);
		const stale = selectionOf(moment);
		h.store.put({ ...moment, body: "Changed body that invalidates the old receipt." });
		const result = await confirmInsightLesson(stale, h.runtime);
		expect(result.status).toBe("refused");
		expect(result.message).toContain("Lesson or preview changed.");
		expect(h.store.get(moment.id)?.status).toBe("candidate");
	});

	test("refuses an already-confirmed lesson instead of claiming success", async () => {
		const h = harness({ hindsight: fullClient() });
		const moment = await seedEligible(h);
		const result = await confirmInsightLesson(selectionOf(moment), h.runtime);
		expect(result.status).toBe("refused");
		expect(result.message).toContain("Candidate was not confirmed");
	});

	test("refuses when teaching is disabled and when the kill switch is set", async () => {
		const off = harness();
		const offMoment = await seedCandidate(off);
		off.ctx.config.teach.enabled = false;
		const offResult = await confirmInsightLesson(selectionOf(offMoment), off.runtime);
		expect(offResult.status).toBe("refused");
		expect(offResult.message).toContain("Teaching is off.");
		expect(off.store.get(offMoment.id)?.status).toBe("candidate");

		const killed = harness({ hindsight: fullClient() });
		const killedMoment = await seedCandidate(killed);
		killed.ctx.env.ULTRATHINK_TEACH = "0";
		const killedResult = await confirmInsightLesson(selectionOf(killedMoment), killed.runtime);
		expect(killedResult.status).toBe("refused");
		expect(killedResult.message).toContain("kill switch");
		expect(killed.store.get(killedMoment.id)?.status).toBe("candidate");
	});

	test("refuses an unknown id without dispatching", async () => {
		const h = harness({ hindsight: fullClient() });
		const result = await confirmInsightLesson({ id: "missing0001", revision: "anything" }, h.runtime);
		expect(result.status).toBe("refused");
		expect(result.message).toContain("no longer in this snapshot");
	});

	test("refuses when the session is no longer current and changes nothing", async () => {
		const h = harness({ hindsight: fullClient() });
		const moment = await seedCandidate(h);
		h.current.value = false;
		const result = await confirmInsightLesson(selectionOf(moment), h.runtime);
		expect(result.status).toBe("refused");
		expect(result.message).toContain("Session changed.");
		expect(h.store.get(moment.id)?.status).toBe("candidate");
	});

	test("reports cancellation before dispatch without mutating", async () => {
		const h = harness({ hindsight: fullClient() });
		const moment = await seedCandidate(h);
		h.controller.abort();
		const result = await confirmInsightLesson(selectionOf(moment), h.runtime);
		expect(result.status).toBe("cancelled");
		expect(result.message).toContain("cancelled before it started");
		expect(h.store.get(moment.id)?.status).toBe("candidate");
	});

	test("blocks a second mutation while one is in flight", async () => {
		const seen: RetainItem[] = [];
		let release!: (value: HindsightResult<RetainOutcome>) => void;
		const gate = new Promise<HindsightResult<RetainOutcome>>((resolve) => {
			release = resolve;
		});
		const h = harness({
			hindsight: fullClient({
				retain: async (item) => {
					seen.push(item);
					return gate;
				},
			}),
		});
		const first = await seedCandidate(h, { name: "First lesson", body: "First body text." });
		const secondMoment = await seedCandidate(h, { name: "Second lesson", body: "Second body text." });
		const pending = confirmInsightLesson(selectionOf(first), h.runtime);
		const duplicate = await confirmInsightLesson(selectionOf(secondMoment), h.runtime);
		expect(duplicate.status).toBe("refused");
		expect(duplicate.message).toContain("already running");
		expect(seen).toHaveLength(1);
		release(ok({ bankId: "ultrathink", documentId: (seen[0] as RetainItem).documentId, itemsCount: 1 }));
		const completed = await pending;
		expect(completed.status).toBe("ok");
		expect(h.store.get(first.id)?.status).toBe("confirmed");
		expect(h.store.get(secondMoment.id)?.status).toBe("candidate");
	});
});

describe("previewInsightSkill", () => {
	test("previews an eligible lesson locally with a fingerprint receipt and no side effects", async () => {
		const h = harness();
		const moment = await seedEligible(h);
		const momentsBefore = readdirSync(join(h.ctx.stateDir, "teach", "moments")).length;
		const result = await previewInsightSkill(selectionOf(moment), h.runtime);
		expect(result.status).toBe("ok");
		expect(result.message).toContain("Preview only");
		if (result.status !== "ok" || !result.preview) throw new Error("expected ok preview with receipt");
		const preview = result.preview;
		expect(preview.selection).toEqual(selectionOf(h.store.get(moment.id) as TeachableMoment));
		expect(preview.fingerprint).toBe(createHash("sha256").update(preview.content, "utf8").digest("hex"));
		expect(preview.content).toContain("ultrathink:teach");
		expect(Buffer.byteLength(preview.content, "utf8")).toBeLessThanOrEqual(60_000);
		expect(readdirSync(join(h.ctx.stateDir, "teach", "moments"))).toHaveLength(momentsBefore);
		expect(existsSync(join(h.root, "omp-agent"))).toBe(false);
	});

	test("refuses preview for a candidate and for a superseded lesson", async () => {
		const h = harness();
		const candidate = await seedCandidate(h);
		expect((await previewInsightSkill(selectionOf(candidate), h.runtime)).status).toBe("refused");
		const eligible = await seedEligible(h, { name: "Old lesson", body: "Old body." });
		h.store.put({ ...eligible, status: "superseded" });
		const superseded = h.store.get(eligible.id) as TeachableMoment;
		const refused = await previewInsightSkill(selectionOf(superseded), h.runtime);
		expect(refused.status).toBe("refused");
		expect(refused.message).toContain("read-only");
	});

	test("refuses preview when the lesson changed after selection", async () => {
		const h = harness();
		const moment = await seedEligible(h);
		const stale = selectionOf(moment);
		h.store.put({ ...moment, body: "Rewritten body text." });
		const result = await previewInsightSkill(stale, h.runtime);
		expect(result.status).toBe("refused");
		expect(result.message).toContain("Lesson or preview changed.");
	});

	test("refuses preview for a stale session and a cancelled lifetime", async () => {
		const h = harness();
		const moment = await seedEligible(h);
		h.current.value = false;
		expect((await previewInsightSkill(selectionOf(moment), h.runtime)).status).toBe("refused");
		h.current.value = true;
		h.controller.abort();
		const cancelled = await previewInsightSkill(selectionOf(moment), h.runtime);
		expect(cancelled.status).toBe("cancelled");
	});

	test("manual preview works with autoPromote:false", async () => {
		const h = harness({ autoPromote: false });
		const moment = await seedEligible(h);
		const result = await previewInsightSkill(selectionOf(moment), h.runtime);
		expect(result.status).toBe("ok");
	});
});

describe("installInsightSkill", () => {
	async function previewed(h: Harness, overrides: Partial<CaptureInput> = {}): Promise<{ moment: TeachableMoment; preview: SkillPreview }> {
		const moment = await seedEligible(h, overrides);
		const result = await previewInsightSkill(selectionOf(moment), h.runtime);
		if (result.status !== "ok" || !result.preview) throw new Error("preview seeding failed");
		return { moment, preview: result.preview };
	}

	function managedPath(h: Harness, name: string): string {
		return join(h.root, "omp-agent", "managed-skills", name, "SKILL.md");
	}

	test("refuses install without a separate affirmative confirmation", async () => {
		const h = harness();
		const { preview } = await previewed(h);
		const result = await installInsightSkill(preview, false, h.runtime);
		expect(result.status).toBe("refused");
		expect(result.message).toContain("separate confirmation");
		expect(existsSync(join(h.root, "omp-agent"))).toBe(false);
	});

	test("installs a previewed draft into Omp and records the promotion", async () => {
		const h = harness();
		const { moment, preview } = await previewed(h);
		const result = await installInsightSkill(preview, true, h.runtime);
		expect(result.status).toBe("ok");
		expect(result.message).toContain("Skill created in Omp.");
		const stored = h.store.get(moment.id) as TeachableMoment;
		expect(stored.status).toBe("promoted");
		expect(stored.promoted?.target).toBe("omp");
		expect(stored.promoted?.skill).toBe(preview.name);
		const installed = readFileSync(managedPath(h, preview.name), "utf8");
		expect(installed).toContain("ultrathink:teach");
	});

	test("installs with autoPromote:false since automation policy does not gate manual approval", async () => {
		const h = harness({ autoPromote: false });
		const { preview } = await previewed(h);
		const result = await installInsightSkill(preview, true, h.runtime);
		expect(result.status).toBe("ok");
		expect(existsSync(managedPath(h, preview.name))).toBe(true);
	});

	test("refuses install when the lesson changed after preview", async () => {
		const h = harness();
		const { moment, preview } = await previewed(h);
		h.store.put({ ...moment, body: "Rewritten after the preview receipt." });
		const result = await installInsightSkill(preview, true, h.runtime);
		expect(result.status).toBe("refused");
		expect(result.message).toContain("Lesson or preview changed.");
		expect(existsSync(join(h.root, "omp-agent"))).toBe(false);
		expect(h.store.get(moment.id)?.status).toBe("confirmed");
	});

	test("refuses an authored slot without replacing it", async () => {
		const h = harness();
		const { moment, preview } = await previewed(h, { name: "Authored slot lesson", body: "Authored slot body." });
		const path = managedPath(h, preview.name);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "# Human skill\n\nHand-written content.\n");
		const result = await installInsightSkill(preview, true, h.runtime);
		expect(result.status).toBe("refused");
		expect(result.message).toContain("Installation refused");
		expect(readFileSync(path, "utf8")).toBe("# Human skill\n\nHand-written content.\n");
		expect(h.store.get(moment.id)?.status).toBe("confirmed");
	});

	test("refuses slots held by other lessons or by a marker without source ids", async () => {
		const h = harness();
		const first = await previewed(h, { name: "Held slot lesson", body: "Held slot body." });
		const firstPath = managedPath(h, first.preview.name);
		mkdirSync(join(firstPath, ".."), { recursive: true });
		writeFileSync(firstPath, "# Other\n\nBody.\n\n<!-- ultrathink:teach ids=other-lesson -->\n");
		const firstResult = await installInsightSkill(first.preview, true, h.runtime);
		expect(firstResult.status).toBe("refused");
		expect(h.store.get(first.moment.id)?.status).toBe("confirmed");

		const secondSeed = await seedEligible(h, { name: "Unmarked slot lesson", body: "Unmarked slot body." });
		const secondDraft = renderSkillDraft([secondSeed], h.ctx);
		const secondPath = managedPath(h, secondDraft.name);
		mkdirSync(join(secondPath, ".."), { recursive: true });
		writeFileSync(secondPath, "# Legacy\n\nBody.\n\n<!-- ultrathink:teach -->\n");
		const secondOutcome = await previewInsightSkill(selectionOf(secondSeed), h.runtime);
		if (secondOutcome.status !== "ok" || !secondOutcome.preview) throw new Error("preview seeding failed");
		const secondPreview = secondOutcome.preview;
		const secondResult = await installInsightSkill(secondPreview, true, h.runtime);
		expect(secondResult.status).toBe("refused");
		expect(h.store.get(secondSeed.id)?.status).toBe("confirmed");
	});

	test("refuses a symlinked skill slot", async () => {
		const h = harness();
		const { moment, preview } = await previewed(h, { name: "Symlink slot lesson", body: "Symlink slot body." });
		const managed = join(h.root, "omp-agent", "managed-skills");
		mkdirSync(managed, { recursive: true });
		const target = join(h.root, "real-skills", preview.name);
		mkdirSync(target, { recursive: true });
		symlinkSync(target, join(managed, preview.name));
		const result = await installInsightSkill(preview, true, h.runtime);
		expect(result.status).toBe("refused");
		expect(result.message).toContain("Installation refused");
		expect(h.store.get(moment.id)?.status).toBe("confirmed");
	});

	test("reports cancellation before install dispatch without writing", async () => {
		const h = harness();
		const { preview } = await previewed(h);
		h.controller.abort();
		const result = await installInsightSkill(preview, true, h.runtime);
		expect(result.status).toBe("cancelled");
		expect(existsSync(join(h.root, "omp-agent"))).toBe(false);
	});

	test("requires a new preview after an install recorded the promotion", async () => {
		const h = harness();
		const { moment, preview } = await previewed(h);
		expect((await installInsightSkill(preview, true, h.runtime)).status).toBe("ok");
		const again = await installInsightSkill(preview, true, h.runtime);
		expect(again.status).toBe("refused");
		expect(h.store.get(moment.id)?.status).toBe("promoted");
	});
});
