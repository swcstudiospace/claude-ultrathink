// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_HINDSIGHT_CONFIG,
	type HindsightClient,
	type HindsightError,
	type HindsightResult,
	type RetainItem,
	type RetainOutcome,
} from "../hindsight/types.ts";
import { captureMoment, confirmMoment, forgetMoment, syncOutbox, TeachInputError } from "./capture.ts";
import { contentFor, dedupeKeyFor, documentIdFor } from "./mapping.ts";
import { openStore, storeDir } from "./store.ts";
import { DEFAULT_TEACH_CONFIG, MAX_BODY_CHARS, MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS, type CaptureInput, type TeachContext, type TeachableMoment } from "./types.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-teach-capture-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ok = <T>(value: T): HindsightResult<T> => ({ ok: true, value });
const err = (kind: HindsightError["kind"], message = "boom"): HindsightResult<never> => ({ ok: false, error: { kind, message } });

interface FakeOptions {
	bank?: string;
	retain?: (item: RetainItem) => HindsightResult<RetainOutcome>;
	deleteDocument?: (id: string) => HindsightResult<boolean>;
	setDocumentTags?: (id: string, tags: string[]) => HindsightResult<true>;
}

function fakeClient(options: FakeOptions = {}) {
	const calls = { retain: [] as RetainItem[], deleteDocument: [] as string[], setDocumentTags: [] as { id: string; tags: string[] }[] };
	const bank = options.bank ?? "ultrathink";
	const client: HindsightClient = {
		bank,
		health: async () => ok({ ok: true, apiVersion: "0.9.1", databaseConnected: true, features: {} }),
		ensureBank: async () => ok({ bankId: bank, created: false, extractionMode: "chunks" }),
		retain: async (item) => {
			calls.retain.push(item);
			return options.retain ? options.retain(item) : ok({ bankId: bank, documentId: item.documentId, itemsCount: 1 });
		},
		recall: async () => ok([]),
		getDocument: async () => ok(null),
		deleteDocument: async (id) => {
			calls.deleteDocument.push(id);
			return options.deleteDocument ? options.deleteDocument(id) : ok(true);
		},
		setDocumentTags: async (id, tags) => {
			calls.setDocumentTags.push({ id, tags });
			return options.setDocumentTags ? options.setDocumentTags(id, tags) : ok(true as const);
		},
		deleteBank: async () => ok(true as const),
	};
	return { client, calls };
}

/** Repository `<root>/proj` inside a home directory `<root>`, state in `<root>/state`, a controllable clock. */
function setup(options: { hindsight?: HindsightClient; enabled?: boolean } = {}) {
	const root = tempDir();
	const cwd = join(root, "proj");
	mkdirSync(join(cwd, ".git"), { recursive: true });
	const clock = { now: Date.parse("2026-06-01T00:00:00.000Z") };
	const ctx: TeachContext = {
		host: "omp",
		cwd,
		config: { teach: { ...DEFAULT_TEACH_CONFIG, enabled: options.enabled ?? true }, hindsight: { ...DEFAULT_HINDSIGHT_CONFIG } },
		env: { HOME: root },
		stateDir: join(root, "state"),
		now: () => clock.now,
	};
	if (options.hindsight) ctx.hindsight = options.hindsight;
	return { root, cwd, ctx, clock, store: openStore(storeDir(ctx.stateDir)) };
}

function lesson(overrides: Partial<CaptureInput> = {}): CaptureInput {
	return { name: "tsc rejects value imports of types", body: "Use import type for type-only imports.", ...overrides };
}

describe("captureMoment: off and validation", () => {
	test("when Teachable Moments is off nothing is stored or sent, and the outcome carries a normalized moment", async () => {
		const { client, calls } = fakeClient();
		for (const env of [{ enabled: false }, { enabled: true }]) {
			const { ctx, store } = setup({ hindsight: client, ...env });
			if (env.enabled) ctx.env.ULTRATHINK_TEACH = "0";
			const outcome = await captureMoment(lesson({ name: "  padded name  " }), ctx);
			expect(outcome).toMatchObject({ created: false, retain: "off", reason: "teach is off" });
			expect(outcome.moment.name).toBe("padded name");
			expect(store.list()).toEqual([]);
		}
		expect(calls.retain).toHaveLength(0);
	});

	test("off does not throw even for input that would be invalid", async () => {
		const { ctx } = setup({ enabled: false });
		const outcome = await captureMoment({ name: "", body: "", kind: "nonsense" as never }, ctx);
		expect(outcome.retain).toBe("off");
		expect(outcome.moment.kind).toBe("pitfall");
	});

	test.each<[string, Partial<CaptureInput>, string]>([
		["empty name", { name: "   " }, "name is required"],
		["empty body", { body: "\n\t " }, "body is required"],
		["unknown kind", { kind: "weird" as never }, "kind must be one of"],
		["unknown origin", { origin: "web" as never }, "origin must be one of"],
		["a status capture cannot set", { status: "promoted" }, "status must be candidate or confirmed"],
		["a non-numeric confidence", { confidence: Number.NaN }, "confidence must be a number"],
		["a supersedes that is not an id", { supersedes: "../other" }, "supersedes must be a moment id"],
	])("invalid input throws TeachInputError and stores nothing: %s", async (_label, overrides, message) => {
		const { client, calls } = fakeClient();
		const { ctx, store } = setup({ hindsight: client });
		const promise = captureMoment(lesson(overrides), ctx);
		await expect(promise).rejects.toBeInstanceOf(TeachInputError);
		await expect(promise).rejects.toThrow(message);
		expect(store.list()).toEqual([]);
		expect(calls.retain).toHaveLength(0);
	});
});

describe("captureMoment: normalization and redaction", () => {
	test("defaults, caps and identity fields", async () => {
		const { ctx } = setup();
		const outcome = await captureMoment(
			{ name: `${"N".repeat(200)}\n second line`, description: "D".repeat(500), body: `${"b".repeat(3000)}\r\nmore` },
			ctx,
		);
		const m = outcome.moment;
		expect(m).toMatchObject({
			schema: 2,
			kind: "pitfall",
			status: "confirmed",
			origin: "explicit",
			confidence: 1,
			occurrences: 1,
			recalled: 0,
			project: "proj",
			host: "omp",
			createdAt: "2026-06-01T00:00:00.000Z",
			lastSeenAt: "2026-06-01T00:00:00.000Z",
		});
		expect(m.name).toHaveLength(120);
		expect(m.description).toHaveLength(300);
		expect(m.body).toHaveLength(2400);
		expect(m.name).not.toContain("\n");
		expect(m.dedupeKey).toBe(dedupeKeyFor("proj", "pitfall", m.name));
		expect(outcome.created).toBe(true);
		expect(outcome.retain).toBe("local-only");
	});

	test("secrets and out-of-repo paths are gone before anything is hashed, stored or sent", async () => {
		const { client, calls } = fakeClient();
		const { root, cwd, ctx, store } = setup({ hindsight: client });
		const secret = `sk-${"q7Z1".repeat(6)}`;
		const outcome = await captureMoment(
			{
				name: `Rotate ${secret} after leak`,
				description: `Header Authorization: Bearer ${secret}`,
				body: `Set OPENAI_API_KEY=${secret}\nRead ${cwd}/src/a.ts and ${root}/.ssh/id_rsa`,
				tags: [`tok-${secret}`, "plain"],
				sourceArtifacts: [`${root}/other/deep/file.ts`],
				sourcePhase: `phase postgres://u:pw@db/${secret}`,
			},
			ctx,
		);
		const m = outcome.moment;
		const everything = JSON.stringify(m) + JSON.stringify(calls.retain) + readdirSync(join(store.dir, "moments")).map((f) => readFileSync(join(store.dir, "moments", f), "utf8")).join("");
		expect(everything).not.toContain(secret);
		expect(everything).not.toContain("u:pw");
		expect(m.name).toBe("Rotate [redacted] after leak");
		expect(m.body).toContain("OPENAI_API_KEY=[redacted]");
		expect(m.body).toContain(`${cwd}/src/a.ts`);
		expect(m.body).toContain("~/.ssh/id_rsa");
		expect(m.sourceArtifacts).toEqual(["~/.../deep/file.ts"]);
		// Hashing happened after redaction, so two different leaked keys are one lesson.
		const other = await captureMoment({ name: `Rotate sk-${"m3X9".repeat(6)} after leak`, body: "again" }, ctx);
		expect(other.moment.id).toBe(m.id);
		expect(other.created).toBe(false);
	});

	test("field caps hold at the limit and just over it", async () => {
		const { ctx } = setup();
		const exact = await captureMoment({ name: "N".repeat(MAX_NAME_CHARS), description: "D".repeat(MAX_DESCRIPTION_CHARS), body: "b".repeat(MAX_BODY_CHARS) }, ctx);
		expect(exact.moment.name).toHaveLength(MAX_NAME_CHARS);
		expect(exact.moment.description).toHaveLength(MAX_DESCRIPTION_CHARS);
		expect(exact.moment.body).toHaveLength(MAX_BODY_CHARS);
		const over = await captureMoment(
			{ name: `other ${"N".repeat(MAX_NAME_CHARS)}`, description: "D".repeat(MAX_DESCRIPTION_CHARS + 1), body: `z${"b".repeat(MAX_BODY_CHARS)}` },
			ctx,
		);
		expect(over.moment.name).toHaveLength(MAX_NAME_CHARS);
		expect(over.moment.description).toHaveLength(MAX_DESCRIPTION_CHARS);
		expect(over.moment.body).toHaveLength(MAX_BODY_CHARS);
		expect(over.moment.body.startsWith("z")).toBe(true);
	});

	test("related ids are kept only when they are valid ids, tags and artifacts are capped lists of lines", async () => {
		const { ctx } = setup();
		const { moment } = await captureMoment(
			lesson({ relatedIds: ["ok-1", "../bad", "also.ok"], tags: ["a", "a", "  b  "], sourceArtifacts: Array.from({ length: 40 }, (_, i) => `f${i}.ts`) }),
			ctx,
		);
		expect(moment.relatedIds).toEqual(["ok-1", "also.ok"]);
		expect(moment.tags).toEqual(["a", "b"]);
		expect(moment.sourceArtifacts).toHaveLength(20);
	});

	test("origin observe defaults to a 0.5 confidence candidate; explicit values win", async () => {
		const { ctx } = setup();
		const observed = await captureMoment(lesson({ origin: "observe" }), ctx);
		expect(observed.moment).toMatchObject({ status: "candidate", confidence: 0.5, origin: "observe" });
		const imported = await captureMoment(lesson({ name: "other", origin: "import", confidence: 7 }), ctx);
		expect(imported.moment).toMatchObject({ status: "confirmed", confidence: 1, origin: "import" });
	});
});

describe("captureMoment: Hindsight paths", () => {
	test("a confirmed moment is retained with document id tm:<id>, tags, string metadata and capped content", async () => {
		const { client, calls } = fakeClient({ bank: "lessons" });
		const { ctx, store, clock } = setup({ hindsight: client });
		const outcome = await captureMoment(lesson({ tags: ["Needs Review"], body: "x".repeat(2400) }), ctx);
		expect(outcome.retain).toBe("retained");
		expect(outcome.reason).toBeUndefined();
		const item = calls.retain[0] as RetainItem;
		expect(item.documentId).toBe(documentIdFor(outcome.moment.id));
		expect(item.documentId).toBe(`tm:${outcome.moment.id}`);
		expect(item.context).toBe("ultrathink teachable moment");
		expect(item.timestamp).toBe(outcome.moment.createdAt);
		expect(item.tags).toEqual([
			"ultrathink",
			"teachable",
			"project:proj",
			"host:omp",
			"kind:pitfall",
			"status:confirmed",
			"needs-review",
		]);
		expect(item.content.length).toBeLessThanOrEqual(3000);
		expect(item.content).toBe(contentFor(outcome.moment));
		expect(item.content.startsWith("# tsc rejects value imports of types\n\n")).toBe(true);
		expect(Object.values(item.metadata ?? {}).every((value) => typeof value === "string")).toBe(true);
		expect(item.metadata).toMatchObject({ tm_id: outcome.moment.id, schema: "tm/2", status: "confirmed", project: "proj", host: "omp", occurrences: "1" });
		const stored = store.get(outcome.moment.id);
		expect(stored?.retained).toEqual({ at: new Date(clock.now).toISOString(), bank: "lessons", documentId: item.documentId });
		expect(store.outbox()).toEqual([]);
	});

	test("a failed retain is queued with a one-line redacted reason and the moment stays stored", async () => {
		const { client } = fakeClient({ retain: () => err("server", "upstream said\nBearer abc123secret") });
		const { ctx, store } = setup({ hindsight: client });
		const outcome = await captureMoment(lesson(), ctx);
		expect(outcome.retain).toBe("queued");
		expect(outcome.reason).toBe("retain failed (server): upstream said [redacted]");
		expect(store.get(outcome.moment.id)?.retained).toBeUndefined();
		expect(store.outbox().map((entry) => entry.op)).toEqual([{ op: "retain", momentId: outcome.moment.id }]);
	});

	test("a client that throws is treated like a failed retain", async () => {
		const { client } = fakeClient({
			retain: () => {
				throw new Error("socket closed");
			},
		});
		const { ctx, store } = setup({ hindsight: client });
		const outcome = await captureMoment(lesson(), ctx);
		expect(outcome).toMatchObject({ retain: "queued", reason: "retain failed: socket closed" });
		expect(store.outbox()).toHaveLength(1);
	});

	test("with no ready client the moment is local-only with the reason and no outbox entry", async () => {
		const { ctx, store } = setup();
		const outcome = await captureMoment(lesson(), ctx);
		expect(outcome).toMatchObject({ created: true, retain: "local-only", reason: "hindsight is off (disabled)" });
		expect(store.list()).toHaveLength(1);
		expect(store.outbox()).toEqual([]);

		ctx.config.hindsight = { ...DEFAULT_HINDSIGHT_CONFIG, enabled: true };
		const unready = await captureMoment(lesson({ name: "second lesson" }), ctx);
		expect(unready).toMatchObject({ retain: "local-only", reason: "hindsight is not ready (no-url)" });
		expect(store.outbox()).toEqual([]);
	});

	test("a candidate is never retained", async () => {
		const { client, calls } = fakeClient();
		const { ctx, store } = setup({ hindsight: client });
		const outcome = await captureMoment(lesson({ origin: "observe" }), ctx);
		expect(outcome.retain).toBe("local-only");
		expect(outcome.moment.status).toBe("candidate");
		const again = await captureMoment(lesson({ status: "candidate" }), ctx);
		expect(again.retain).toBe("local-only");
		expect(calls.retain).toHaveLength(0);
		expect(store.outbox()).toEqual([]);
	});

	test("an unusable state directory degrades to an off outcome instead of throwing", async () => {
		const { cwd, ctx } = setup();
		mkdirSync(join(cwd, ".planning"));
		ctx.stateDir = join(cwd, ".planning", "state");
		const outcome = await captureMoment(lesson(), ctx);
		expect(outcome).toMatchObject({ created: false, retain: "off", reason: "teach store is unavailable" });
		expect(readdirSync(join(cwd, ".planning"))).toEqual([]);
	});

	test("capturing with a .planning directory in the working tree writes nothing into it", async () => {
		const { client } = fakeClient();
		const { cwd, ctx } = setup({ hindsight: client });
		mkdirSync(join(cwd, ".planning"));
		await captureMoment(lesson(), ctx);
		await captureMoment(lesson({ name: "second", origin: "observe" }), ctx);
		await syncOutbox(ctx);
		expect(readdirSync(join(cwd, ".planning"))).toEqual([]);
		expect(readdirSync(cwd).sort()).toEqual([".git", ".planning"]);
	});
});

describe("captureMoment: repeats", () => {
	test("the same lesson merges: occurrences, lastSeenAt, unions, better body, and a fresh retain of the same document", async () => {
		const { client, calls } = fakeClient();
		const { ctx, store, clock } = setup({ hindsight: client });
		const first = await captureMoment(lesson({ tags: ["a"], sourceArtifacts: ["x.ts"], confidence: 0.6, body: "old body" }), ctx);
		clock.now += 60_000;
		const second = await captureMoment(
			lesson({ name: "TSC rejects value-imports of types!", tags: ["b"], sourceArtifacts: ["y.ts"], relatedIds: ["r1"], confidence: 0.8, body: "new body", description: "new description" }),
			ctx,
		);
		expect(second.created).toBe(false);
		expect(second.moment.id).toBe(first.moment.id);
		expect(second.moment).toMatchObject({
			occurrences: 2,
			createdAt: "2026-06-01T00:00:00.000Z",
			lastSeenAt: "2026-06-01T00:01:00.000Z",
			body: "new body",
			description: "new description",
			confidence: 0.8,
			tags: ["a", "b"],
			sourceArtifacts: ["x.ts", "y.ts"],
			relatedIds: ["r1"],
			name: first.moment.name,
		});
		expect(store.list()).toHaveLength(1);
		expect(second.retain).toBe("retained");
		expect(calls.retain.map((item) => item.documentId)).toEqual([documentIdFor(first.moment.id), documentIdFor(first.moment.id)]);
		expect(calls.retain[1]?.metadata?.occurrences).toBe("2");
	});

	test("double capture is one file with occurrences 2 and one tm document", async () => {
		const { client, calls } = fakeClient();
		const { ctx, store } = setup({ hindsight: client });
		const first = await captureMoment(lesson(), ctx);
		const second = await captureMoment(lesson(), ctx);
		expect(second.created).toBe(false);
		expect(second.moment.id).toBe(first.moment.id);
		expect(second.moment.occurrences).toBe(2);
		expect(readdirSync(join(store.dir, "moments"))).toEqual([`${first.moment.id}.json`]);
		const onDisk = JSON.parse(readFileSync(join(store.dir, "moments", `${first.moment.id}.json`), "utf8")) as TeachableMoment;
		expect(onDisk).toMatchObject({ id: first.moment.id, occurrences: 2 });
		// The repeat re-retains the updated moment, but it is one document: same tm:<id> every time.
		expect(calls.retain.length).toBeGreaterThan(0);
		expect(new Set(calls.retain.map((item) => item.documentId))).toEqual(new Set([`tm:${first.moment.id}`]));
		expect(readdirSync(join(store.dir, "moments")).filter((file) => file.endsWith(".tmp"))).toEqual([]);
	});

	test("a lower-confidence repeat counts but does not replace the body", async () => {
		const { ctx } = setup();
		await captureMoment(lesson({ body: "keep me", confidence: 1 }), ctx);
		const repeat = await captureMoment(lesson({ body: "weaker", confidence: 0.4 }), ctx);
		expect(repeat.moment).toMatchObject({ occurrences: 2, body: "keep me", confidence: 1 });
	});

	test("status only moves up: a candidate is confirmed by a repeat, a confirmed moment is not demoted, promoted stays promoted", async () => {
		const { client } = fakeClient();
		const { ctx, store } = setup({ hindsight: client });
		const candidate = await captureMoment(lesson({ origin: "observe" }), ctx);
		expect(candidate.moment.status).toBe("candidate");
		const confirmed = await captureMoment(lesson({ origin: "explicit" }), ctx);
		expect(confirmed.moment.status).toBe("confirmed");
		expect(confirmed.retain).toBe("retained");
		const observedAgain = await captureMoment(lesson({ origin: "observe" }), ctx);
		expect(observedAgain.moment).toMatchObject({ status: "confirmed", occurrences: 3 });

		store.put({ ...observedAgain.moment, status: "promoted", promoted: { at: "2026-06-02T00:00:00.000Z", skill: "s", target: "omp" } });
		const repeat = await captureMoment(lesson(), ctx);
		expect(repeat.moment.status).toBe("promoted");
		expect(repeat.moment.promoted?.skill).toBe("s");
	});

	test("a superseded lesson captured again is a new moment, and the replaced one is left alone", async () => {
		const { ctx, store } = setup();
		const old = await captureMoment(lesson(), ctx);
		store.put({ ...old.moment, status: "superseded" });
		const fresh = await captureMoment(lesson(), ctx);
		expect(fresh.created).toBe(true);
		expect(fresh.moment.id).not.toBe(old.moment.id);
		expect(store.get(old.moment.id)).toMatchObject({ status: "superseded", occurrences: 1 });
		expect(store.findByDedupeKey(fresh.moment.dedupeKey)?.id).toBe(fresh.moment.id);
	});
});

describe("captureMoment: supersedes", () => {
	test("the replaced moment becomes superseded and its Hindsight tags are updated", async () => {
		const { client, calls } = fakeClient();
		const { ctx, store } = setup({ hindsight: client });
		const old = await captureMoment(lesson({ name: "old way" }), ctx);
		const next = await captureMoment(lesson({ name: "new way", supersedes: old.moment.id }), ctx);
		expect(next.moment.supersedes).toBe(old.moment.id);
		expect(store.get(old.moment.id)?.status).toBe("superseded");
		expect(store.get(next.moment.id)?.status).toBe("confirmed");
		expect(calls.setDocumentTags).toHaveLength(1);
		expect(calls.setDocumentTags[0]?.id).toBe(`tm:${old.moment.id}`);
		expect(calls.setDocumentTags[0]?.tags).toContain("status:superseded");
		expect(calls.setDocumentTags[0]?.tags).not.toContain("status:confirmed");
		expect(store.outbox()).toEqual([]);
	});

	test("when the tag update fails it waits in the outbox as a tags op", async () => {
		const { client } = fakeClient({ setDocumentTags: () => err("server") });
		const { ctx, store } = setup({ hindsight: client });
		const old = await captureMoment(lesson({ name: "old way" }), ctx);
		await captureMoment(lesson({ name: "new way", supersedes: old.moment.id }), ctx);
		const ops = store.outbox().map((entry) => entry.op);
		expect(ops).toHaveLength(1);
		expect(ops[0]).toMatchObject({ op: "tags", documentId: `tm:${old.moment.id}` });
	});

	test("a replaced moment that never reached Hindsight needs no tag update; an unknown id changes nothing", async () => {
		const { ctx, store } = setup();
		const old = await captureMoment(lesson({ name: "old way" }), ctx);
		await captureMoment(lesson({ name: "new way", supersedes: old.moment.id }), ctx);
		expect(store.get(old.moment.id)?.status).toBe("superseded");
		expect(store.outbox()).toEqual([]);
		const orphan = await captureMoment(lesson({ name: "third way", supersedes: "no-such-id" }), ctx);
		expect(orphan.created).toBe(true);
		expect(store.list()).toHaveLength(3);
	});
});

describe("confirmMoment", () => {
	test("a candidate becomes confirmed and is retained", async () => {
		const { client, calls } = fakeClient();
		const { ctx, store } = setup({ hindsight: client });
		const candidate = await captureMoment(lesson({ origin: "observe" }), ctx);
		const outcome = await confirmMoment(candidate.moment.id, ctx);
		expect(outcome).toMatchObject({ created: false, retain: "retained" });
		expect(outcome?.moment.status).toBe("confirmed");
		expect(store.get(candidate.moment.id)).toMatchObject({ status: "confirmed" });
		expect(store.get(candidate.moment.id)?.retained?.documentId).toBe(`tm:${candidate.moment.id}`);
		expect(calls.retain).toHaveLength(1);
		expect(calls.retain[0]?.tags).toContain("status:confirmed");
	});

	test("an unknown or invalid id gives undefined", async () => {
		const { ctx } = setup();
		expect(await confirmMoment("nope", ctx)).toBeUndefined();
		expect(await confirmMoment("../nope", ctx)).toBeUndefined();
	});

	test("an up-to-date retained moment is not sent again; an unretained confirmed one is retried; the status of others is unchanged", async () => {
		const { client, calls } = fakeClient();
		const { ctx, store } = setup({ hindsight: client });
		const retained = await captureMoment(lesson(), ctx);
		expect((await confirmMoment(retained.moment.id, ctx))?.retain).toBe("retained");
		expect(calls.retain).toHaveLength(1);

		const local = setup();
		const unretained = await captureMoment(lesson(), local.ctx);
		local.ctx.hindsight = client;
		expect((await confirmMoment(unretained.moment.id, local.ctx))?.retain).toBe("retained");

		store.put({ ...retained.moment, status: "superseded" });
		const superseded = await confirmMoment(retained.moment.id, ctx);
		expect(superseded).toMatchObject({ retain: "local-only", moment: { status: "superseded" } });
	});

	test("a failed retain on confirm is queued; with no client it is local-only; when off nothing changes", async () => {
		const failing = fakeClient({ retain: () => err("timeout") });
		const queued = setup({ hindsight: failing.client });
		const candidate = await captureMoment(lesson({ origin: "observe" }), queued.ctx);
		const outcome = await confirmMoment(candidate.moment.id, queued.ctx);
		expect(outcome).toMatchObject({ retain: "queued", reason: "retain failed (timeout): boom" });
		expect(queued.store.outbox()).toHaveLength(1);

		const plain = setup();
		const c2 = await captureMoment(lesson({ origin: "observe" }), plain.ctx);
		expect((await confirmMoment(c2.moment.id, plain.ctx))?.retain).toBe("local-only");

		const c3 = await captureMoment(lesson({ name: "another", origin: "observe" }), plain.ctx);
		plain.ctx.config.teach.enabled = false;
		const off = await confirmMoment(c3.moment.id, plain.ctx);
		expect(off).toMatchObject({ retain: "off", moment: { status: "candidate" } });
		expect(plain.store.get(c3.moment.id)?.status).toBe("candidate");
	});
});

describe("forgetMoment", () => {
	test("a moment that never left the machine is just removed", async () => {
		const { client, calls } = fakeClient();
		const { ctx, store } = setup();
		const local = await captureMoment(lesson(), ctx);
		ctx.hindsight = client;
		expect(await forgetMoment(local.moment.id, ctx)).toEqual({ removed: true, remote: "none" });
		expect(store.get(local.moment.id)).toBeUndefined();
		expect(calls.deleteDocument).toEqual([]);
		expect(await forgetMoment(local.moment.id, ctx)).toEqual({ removed: false, remote: "none" });
		expect(await forgetMoment("../x", ctx)).toEqual({ removed: false, remote: "none" });
	});

	test("a retained moment's document is deleted; a 404 counts as deleted", async () => {
		const { client, calls } = fakeClient({ deleteDocument: () => ok(false) });
		const { ctx, store } = setup({ hindsight: client });
		const retained = await captureMoment(lesson(), ctx);
		expect(await forgetMoment(retained.moment.id, ctx)).toEqual({ removed: true, remote: "deleted" });
		expect(calls.deleteDocument).toEqual([`tm:${retained.moment.id}`]);
		expect(store.list()).toEqual([]);
		expect(store.outbox()).toEqual([]);
	});

	test("when the delete fails, or there is no client, it is queued", async () => {
		const failing = fakeClient({ deleteDocument: () => err("server") });
		const a = setup({ hindsight: failing.client });
		const retained = await captureMoment(lesson(), a.ctx);
		expect(await forgetMoment(retained.moment.id, a.ctx)).toEqual({ removed: true, remote: "queued" });
		expect(a.store.outbox().map((e) => e.op)).toEqual([{ op: "delete", documentId: `tm:${retained.moment.id}` }]);

		const { client } = fakeClient();
		const b = setup({ hindsight: client });
		const second = await captureMoment(lesson(), b.ctx);
		delete b.ctx.hindsight;
		expect(await forgetMoment(second.moment.id, b.ctx)).toEqual({ removed: true, remote: "queued" });
		expect(b.store.outbox()).toHaveLength(1);
	});

	test("a moment waiting for its first retain loses that op and has any remote copy deleted", async () => {
		const failing = fakeClient({ retain: () => err("server") });
		const { ctx, store } = setup({ hindsight: failing.client });
		const pending = await captureMoment(lesson(), ctx);
		expect(store.outbox().map((e) => e.op.op)).toEqual(["retain"]);
		expect(await forgetMoment(pending.moment.id, ctx)).toEqual({ removed: true, remote: "deleted" });
		expect(store.outbox()).toEqual([]);
		expect(failing.calls.deleteDocument).toEqual([`tm:${pending.moment.id}`]);
	});

	test("with Teachable Moments off a forget stays local and queues the remote delete", async () => {
		const { client, calls } = fakeClient();
		const { ctx, store } = setup({ hindsight: client });
		const retained = await captureMoment(lesson(), ctx);
		ctx.env.ULTRATHINK_TEACH = "0";
		expect(await forgetMoment(retained.moment.id, ctx)).toEqual({ removed: true, remote: "queued" });
		expect(calls.deleteDocument).toEqual([]);
		expect(store.outbox()).toHaveLength(1);
	});
});

describe("syncOutbox", () => {
	function queuedMoment(overrides: FakeOptions = {}) {
		const failing = fakeClient({ retain: () => err("server") });
		const box = setup({ hindsight: failing.client });
		return { box, failing, healthy: fakeClient(overrides) };
	}

	test("a due retain is replayed, acked, and the moment records it", async () => {
		const { box, healthy } = queuedMoment();
		const outcome = await captureMoment(lesson(), box.ctx);
		box.ctx.hindsight = healthy.client;
		expect(await syncOutbox(box.ctx)).toEqual({ done: 1, pending: 0 });
		expect(box.store.get(outcome.moment.id)?.retained?.documentId).toBe(`tm:${outcome.moment.id}`);
		expect(box.store.outbox()).toEqual([]);
		expect(healthy.calls.retain).toHaveLength(1);
	});

	test("a failure is recorded with backoff and the entry is not retried before it is due", async () => {
		const { box, failing } = queuedMoment();
		await captureMoment(lesson(), box.ctx);
		const first = await syncOutbox(box.ctx);
		expect(first).toMatchObject({ done: 0, pending: 1, reason: "retain failed (server): boom" });
		const entry = box.store.outbox()[0];
		expect(entry).toMatchObject({ attempts: 1, nextAt: box.clock.now + 60_000, lastError: "retain failed (server): boom" });

		expect(failing.calls.retain).toHaveLength(2);
		const second = await syncOutbox(box.ctx);
		expect(second).toEqual({ done: 0, pending: 1 });
		expect(box.store.outbox()[0]?.attempts).toBe(1);
		expect(failing.calls.retain).toHaveLength(2);

		box.clock.now += 60_000;
		await syncOutbox(box.ctx);
		expect(box.store.outbox()[0]).toMatchObject({ attempts: 2, nextAt: box.clock.now + 120_000 });
	});

	test("a retain for a moment that was forgotten or is already retained is acked without a request", async () => {
		const { client, calls } = fakeClient();
		const { ctx, store } = setup({ hindsight: client });
		store.enqueue({ op: "retain", momentId: "ghost" }, ctx.now?.() ?? 0);
		const retained = await captureMoment(lesson(), ctx);
		store.enqueue({ op: "retain", momentId: retained.moment.id }, ctx.now?.() ?? 0);
		const callsBefore = calls.retain.length;
		expect(await syncOutbox(ctx)).toEqual({ done: 2, pending: 0 });
		expect(calls.retain).toHaveLength(callsBefore);
	});

	test("delete and tags entries are replayed; a tags entry for a vanished document is done", async () => {
		const { client, calls } = fakeClient({ setDocumentTags: (id) => (id === "tm:gone" ? err("not-found") : ok(true as const)) });
		const { ctx, store } = setup({ hindsight: client });
		const past = (ctx.now?.() ?? 0) - 1000;
		store.enqueue({ op: "delete", documentId: "tm:a" }, past);
		store.enqueue({ op: "tags", documentId: "tm:b", tags: ["x"] }, past + 1);
		store.enqueue({ op: "tags", documentId: "tm:gone", tags: ["x"] }, past + 2);
		expect(await syncOutbox(ctx)).toEqual({ done: 3, pending: 0 });
		expect(calls.deleteDocument).toEqual(["tm:a"]);
		expect(calls.setDocumentTags.map((call) => call.id)).toEqual(["tm:b", "tm:gone"]);
	});

	test("the first auth error stops the run: later entries are not attempted and no backfill follows", async () => {
		const auth = fakeClient({ deleteDocument: () => err("auth", "key rejected"), retain: () => err("auth", "key rejected") });
		const { ctx, store } = setup({ hindsight: auth.client });
		const past = (ctx.now?.() ?? 0) - 1000;
		store.enqueue({ op: "delete", documentId: "tm:a" }, past);
		store.enqueue({ op: "delete", documentId: "tm:b" }, past + 1);
		ctx.hindsight = undefined;
		const local = await captureMoment(lesson(), ctx);
		ctx.hindsight = auth.client;
		const outcome = await syncOutbox(ctx);
		expect(outcome).toEqual({ done: 0, pending: 2, reason: "delete failed (auth): key rejected" });
		expect(auth.calls.deleteDocument).toEqual(["tm:a"]);
		expect(auth.calls.retain).toHaveLength(0);
		expect(store.get(local.moment.id)?.retained).toBeUndefined();
	});

	test("confirmed moments that never reached Hindsight are retained; candidates and superseded ones are not", async () => {
		const { client, calls } = fakeClient();
		const { ctx, store } = setup();
		const a = await captureMoment(lesson({ name: "a" }), ctx);
		const b = await captureMoment(lesson({ name: "b" }), ctx);
		const c = await captureMoment(lesson({ name: "c", origin: "observe" }), ctx);
		const d = await captureMoment(lesson({ name: "d" }), ctx);
		store.put({ ...d.moment, status: "superseded" });
		ctx.hindsight = client;
		expect(await syncOutbox(ctx)).toEqual({ done: 2, pending: 0 });
		expect(calls.retain.map((item) => item.documentId).sort()).toEqual([`tm:${a.moment.id}`, `tm:${b.moment.id}`].sort());
		expect(store.get(c.moment.id)?.retained).toBeUndefined();
		expect(store.get(d.moment.id)?.retained).toBeUndefined();
		expect(await syncOutbox(ctx)).toEqual({ done: 0, pending: 0 });
	});

	test("a failed backfill is queued with backoff instead of being retried on every sync", async () => {
		const failing = fakeClient({ retain: () => err("server") });
		const { ctx, store } = setup();
		await captureMoment(lesson({ name: "a" }), ctx);
		await captureMoment(lesson({ name: "b" }), ctx);
		ctx.hindsight = failing.client;
		const outcome = await syncOutbox(ctx);
		expect(outcome).toMatchObject({ done: 0, pending: 2, reason: "retain failed (server): boom" });
		expect(store.outbox().map((entry) => entry.attempts)).toEqual([1, 1]);
		await syncOutbox(ctx);
		expect(failing.calls.retain).toHaveLength(2);
	});

	test("at most 20 entries per call: due entries first, then backfill with what is left of the budget", async () => {
		const { client, calls } = fakeClient();
		const { ctx, store } = setup();
		const past = (ctx.now?.() ?? 0) - 1000;
		for (let i = 0; i < 25; i++) store.enqueue({ op: "delete", documentId: `tm:d${i}` }, past + i);
		ctx.hindsight = client;
		expect(await syncOutbox(ctx)).toEqual({ done: 20, pending: 5 });
		expect(calls.deleteDocument).toHaveLength(20);
		expect(await syncOutbox(ctx)).toEqual({ done: 5, pending: 0 });

		ctx.hindsight = undefined;
		for (let i = 0; i < 25; i++) await captureMoment(lesson({ name: `lesson number ${i}` }), ctx);
		ctx.hindsight = client;
		expect(await syncOutbox(ctx)).toEqual({ done: 20, pending: 0 });
		expect(await syncOutbox(ctx)).toEqual({ done: 5, pending: 0 });
		expect(calls.retain).toHaveLength(25);
	});

	test("it reports why nothing happened when off or without a client, and never throws", async () => {
		const { ctx, store } = setup();
		store.enqueue({ op: "delete", documentId: "tm:a" }, 0);
		expect(await syncOutbox(ctx)).toEqual({ done: 0, pending: 1, reason: "hindsight is off (disabled)" });
		ctx.config.teach.enabled = false;
		expect(await syncOutbox(ctx)).toEqual({ done: 0, pending: 1, reason: "teach is off" });
		const { cwd, ctx: broken } = setup();
		broken.stateDir = join(cwd, ".planning", "state");
		expect((await syncOutbox(broken)).reason).toBe("teach store is unavailable");
	});
});

describe("stored shape", () => {
	test("the persisted moment is the one in the outcome", async () => {
		const { ctx, store } = setup();
		const outcome = await captureMoment(lesson({ tags: ["x"], sourcePhase: "p1" }), ctx);
		const stored: TeachableMoment | undefined = store.get(outcome.moment.id);
		expect(stored).toEqual(outcome.moment);
	});
});
