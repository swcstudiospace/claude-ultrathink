// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DECISIONS_CONFIG, type DecisionsConfig } from "../decisions/types.ts";
import { DEFAULT_HINDSIGHT_CONFIG } from "../hindsight/types.ts";
import type { HindsightClient, HindsightError, HindsightResult, RecallHit, RetainItem } from "../hindsight/types.ts";
import { runTeachCommand } from "./cli.ts";
import type { CommandDeps } from "./cli.ts";
import { contentFor, documentIdFor, metadataFor, projectOf, tagsFor } from "./mapping.ts";
import { openStore, storeDir } from "./store.ts";
import { DEFAULT_TEACH_CONFIG } from "./types.ts";
import type { CliResult, TeachableMoment, TeachConfig } from "./types.ts";

type Json = Record<string, unknown>;

const NOW = Date.parse("2026-03-01T00:00:00.000Z");
const OFF_MESSAGE = "Teachable Moments is off (opt-in: set teach.enabled)";

let root: string;
let stateDir: string;
let storePath: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ut-teach-cli-"));
	stateDir = join(root, "state");
	storePath = join(root, "credentials.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface FakeHindsight {
	client: HindsightClient;
	retained: RetainItem[];
	deleted: string[];
	queries: string[];
	hits: RecallHit[];
	failRetain: boolean;
	failDelete: boolean;
}

const NETWORK_ERROR: HindsightError = { kind: "network", message: "connection refused" };

function fakeHindsight(): FakeHindsight {
	const fake: FakeHindsight = {
		retained: [],
		deleted: [],
		queries: [],
		hits: [],
		failRetain: false,
		failDelete: false,
		client: undefined as unknown as HindsightClient,
	};
	const ok = <T>(value: T): HindsightResult<T> => ({ ok: true, value });
	fake.client = {
		bank: "ultrathink",
		health: async () => ok({ ok: true, apiVersion: "0.9.1", databaseConnected: true, features: {} }),
		ensureBank: async () => ok({ bankId: "ultrathink", created: false, extractionMode: "chunks" }),
		retain: async (item) => {
			if (fake.failRetain) return { ok: false, error: NETWORK_ERROR };
			fake.retained.push(item);
			return ok({ bankId: "ultrathink", documentId: item.documentId, itemsCount: 1 });
		},
		recall: async (query) => {
			fake.queries.push(query.query);
			return ok(fake.hits);
		},
		getDocument: async () => ok(null),
		deleteDocument: async (id) => {
			if (fake.failDelete) return { ok: false, error: NETWORK_ERROR };
			fake.deleted.push(id);
			return ok(true);
		},
		setDocumentTags: async () => ok(true as const),
		deleteBank: async () => ok(true as const),
	};
	return fake;
}

function config(teach: Partial<TeachConfig> = {}, hindsightEnabled = true) {
	return {
		teach: { ...DEFAULT_TEACH_CONFIG, enabled: true, capture: "observe" as const, observeMinToolCalls: 4, ...teach },
		hindsight: { ...DEFAULT_HINDSIGHT_CONFIG, enabled: hindsightEnabled, url: "http://127.0.0.1:8899" },
	};
}

function baseEnv(): NodeJS.ProcessEnv {
	return {
		HOME: root,
		CLAUDE_CONFIG_DIR: join(root, "claude"),
		HINDSIGHT_API_KEY: "test-key-do-not-print",
		ULTRATHINK_HOST: "claude-code",
	};
}

let fake: FakeHindsight;
beforeEach(() => {
	fake = fakeHindsight();
});

function run(argv: string[], over: Partial<CommandDeps> = {}): Promise<CliResult> {
	return runTeachCommand(argv, {
		cwd: root,
		env: baseEnv(),
		stateDir,
		storePath,
		config: config(),
		hindsight: fake.client,
		now: () => NOW,
		...over,
	});
}

/** Runs with the default config (Teachable Moments off). */
function runOff(argv: string[], over: Partial<CommandDeps> = {}): Promise<CliResult> {
	return run(argv, { config: { teach: { ...DEFAULT_TEACH_CONFIG }, hindsight: { ...DEFAULT_HINDSIGHT_CONFIG } }, ...over });
}

/** Fake OpenRouter key. Not a real credential; the credential file in this harness is empty. */
const JEV_KEY = "sk-or-v1-UTTESTKEY-0123456789abcdef";

function decisionsOn(over: Partial<DecisionsConfig> = {}): DecisionsConfig {
	return { ...DEFAULT_DECISIONS_CONFIG, enabled: true, points: ["skillworthy"], ...over };
}

/** Same Decisions response shape as observe.test.ts, answering skillworthy. */
function jevFetch(p: number, calls: { n: number }): typeof fetch {
	return (async (_url: string | URL | Request, init?: RequestInit) => {
		calls.n += 1;
		void init;
		return Response.json({
			model: "typesafe/jev-1.13-20260917",
			answers: { skillworthy: { type: "noul", noul: p } },
			usage: { input_tokens: 10, output_tokens: 0 },
		});
	}) as typeof fetch;
}

function json(result: CliResult): Json {
	return JSON.parse(result.text) as Json;
}

function store() {
	return openStore(storeDir(stateDir));
}

function moment(id: string, over: Partial<TeachableMoment> = {}): TeachableMoment {
	return {
		id,
		name: `Lesson ${id}`,
		description: "when it matters",
		body: "what to do about it",
		sourcePhase: "",
		sourceArtifacts: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		tags: [],
		relatedIds: [],
		schema: 2,
		kind: "pitfall",
		status: "confirmed",
		origin: "explicit",
		project: projectOf(root),
		host: "claude-code",
		confidence: 1,
		occurrences: 1,
		lastSeenAt: "2026-01-01T00:00:00.000Z",
		dedupeKey: id.padEnd(32, "0"),
		recalled: 0,
		...over,
	};
}

function seed(...moments: TeachableMoment[]): void {
	const target = store();
	for (const item of moments) target.put(item);
}

function hitFor(item: TeachableMoment): RecallHit {
	return { id: `hit-${item.id}`, text: contentFor(item), documentId: documentIdFor(item.id), tags: tagsFor(item), metadata: metadataFor(item) };
}

describe("parsing and usage errors", () => {
	test("no subcommand, unknown subcommand, unknown flag and extra arguments exit 2 with one line", async () => {
		for (const argv of [[], ["frobnicate"], ["status", "--bogus"], ["status", "extra"], ["list", "--status"], ["capture", "--name"]]) {
			const result = await run(argv);
			expect(result.code).toBe(2);
			expect(result.text).toStartWith("teach: ");
			expect(result.text).not.toContain("\n");
		}
		expect((await run([])).text).toContain("missing subcommand");
		expect((await run(["frobnicate"])).text).toContain("unknown subcommand frobnicate");
		expect((await run(["status", "--bogus"])).text).toContain("unknown flag --bogus");
		expect((await run(["capture", "--name"])).text).toContain("--name needs a value");
	});

	test("with --json a usage error is {ok:false,error}", async () => {
		const result = await run(["status", "--bogus", "--json"]);
		expect(result.code).toBe(2);
		expect(json(result)).toEqual({ ok: false, error: "teach: unknown flag --bogus" });
	});

	test("help prints the usage with exit 0", async () => {
		const result = await run(["help"]);
		expect(result.code).toBe(0);
		expect(result.text).toStartWith("usage:");
		expect(result.text).toContain("teach capture");
	});

	test("a value flag never swallows the next known flag", async () => {
		const result = await run(["capture", "--name", "--body", "text"]);
		expect(result.code).toBe(2);
		expect(result.text).toContain("--name needs a value");
	});

	test("a value that merely starts with dashes is a value", async () => {
		const result = await run(["capture", "--name", "Dashes", "--body", "-- not a flag", "--json"]);
		expect(result.code).toBe(0);
		const id = json(result).id as string;
		expect(store().get(id)?.body).toBe("-- not a flag");
	});

	test("flags may come before, between and after values, as --flag=value, and repeat", async () => {
		const result = await run([
			"capture",
			"--json",
			"--tag",
			"alpha",
			"--name=Repeated flags",
			"--tag=beta",
			"--artifact",
			"a.ts",
			"--body",
			"body text",
			"--artifact",
			"b.ts",
			"--phase",
			"phase-1",
		]);
		expect(result.code).toBe(0);
		const saved = store().get(json(result).id as string);
		expect(saved?.name).toBe("Repeated flags");
		expect(saved?.tags).toEqual(expect.arrayContaining(["alpha", "beta"]));
		expect(saved?.sourceArtifacts).toEqual(["a.ts", "b.ts"]);
		expect(saved?.sourcePhase).toBe("phase-1");
	});

	test("-- ends flags: later tokens are arguments", async () => {
		const extra = await run(["capture", "--name", "N", "--", "--body", "x"]);
		expect(extra.code).toBe(2);
		expect(extra.text).toContain("unexpected argument");
		const lookup = await run(["show", "--", "--json"]);
		expect(lookup.code).toBe(1);
		expect(lookup.text).toBe("no moment --json");
	});

	test("boolean flags take no value", async () => {
		const result = await run(["status", "--json=1"]);
		expect(result.code).toBe(2);
		expect(result.text).toContain("--json takes no value");
	});
});

describe("when Teachable Moments is off", () => {
	const STDIN = async () => "{}";
	const mutating: Array<[string, string[]]> = [
		["capture", ["capture", "--name", "N", "--body", "B"]],
		["observe", ["observe", "--stdin"]],
		["confirm", ["confirm", "abcd1234"]],
		["forget", ["forget", "abcd1234"]],
		["sync", ["sync"]],
		["promote", ["promote", "--due"]],
	];

	for (const [name, argv] of mutating) {
		test(`${name} says so and exits 1, in text and in JSON`, async () => {
			const text = await runOff(argv, { stdin: STDIN });
			expect(text).toEqual({ code: 1, text: OFF_MESSAGE });
			const asJson = await runOff([...argv, "--json"], { stdin: STDIN });
			expect(asJson.code).toBe(1);
			expect(json(asJson)).toEqual({ ok: false, error: OFF_MESSAGE });
		});
	}

	test("nothing is stored and Hindsight is never contacted", async () => {
		await runOff(["capture", "--name", "N", "--body", "B"]);
		await runOff(["sync"]);
		expect(existsSync(storeDir(stateDir))).toBe(false);
		expect(fake.retained).toEqual([]);
		expect(fake.queries).toEqual([]);
	});

	test("ULTRATHINK_TEACH=0 turns an enabled config off and names the switch", async () => {
		const result = await run(["capture", "--name", "N", "--body", "B"], { env: { ...baseEnv(), ULTRATHINK_TEACH: "0" } });
		expect(result).toEqual({ code: 1, text: "Teachable Moments is off (ULTRATHINK_TEACH=0)" });
	});

	test("status, list, show and export still work read-only", async () => {
		seed(moment("feed0001-a"), moment("feed0002-b", { status: "candidate" }));
		const status = await runOff(["status"]);
		expect(status.code).toBe(0);
		expect(status.text.split("\n")[0]).toBe("Teach: off (opt-in: set teach.enabled)");
		expect(json(await runOff(["status", "--json"])).enabled).toBe(false);
		expect((await runOff(["list"])).text.split("\n")).toHaveLength(2);
		expect((await runOff(["show", "feed0001"])).text).toContain("Lesson feed0001-a");
		const card = json(await runOff(["export", "--a2a"]));
		expect((card.skills as Json[]).map((skill) => skill.id)).toEqual(["feed0001-a"]);
	});

	test("recall reports status off with exit 0 and does not look anything up", async () => {
		const text = await runOff(["recall", "anything"]);
		expect(text.code).toBe(0);
		expect(text.text).toBe(`none · 0 lessons · off: ${OFF_MESSAGE}`);
		const asJson = await runOff(["recall", "anything", "--json"]);
		expect(json(asJson)).toEqual({ status: "off", source: "none", count: 0, lessons: [], reason: OFF_MESSAGE });
		expect(fake.queries).toEqual([]);
	});

	test("observe --file inside the inbox still deletes the file (it holds unredacted text)", async () => {
		const file = writeInbox("{}");
		const result = await runOff(["observe", "--file", file]);
		expect(result).toEqual({ code: 1, text: OFF_MESSAGE });
		expect(existsSync(file)).toBe(false);
	});
});

describe("status", () => {
	test("--json has exactly the contract keys and counts", async () => {
		seed(moment("aaaa0001", { status: "candidate" }), moment("aaaa0002"), moment("aaaa0003"), moment("aaaa0004", { status: "promoted" }));
		store().enqueue({ op: "retain", momentId: "aaaa0002" }, NOW);
		const result = await run(["status", "--json"]);
		expect(result.code).toBe(0);
		expect(json(result)).toEqual({
			enabled: true,
			capture: "observe",
			recall: true,
			hindsight: "ready",
			moments: { candidate: 1, confirmed: 2, promoted: 1, superseded: 0 },
			outbox: 1,
		});
	});

	test("hindsight is off when disabled and unready without a key", async () => {
		expect(json(await run(["status", "--json"], { config: config({}, false) })).hindsight).toBe("off");
		const noKey = await run(["status", "--json"], { env: { HOME: root } });
		expect(json(noKey).hindsight).toBe("unready");
	});

	test("human output is the status line plus a counts line, with no key", async () => {
		seed(moment("aaaa0001"));
		const result = await run(["status"]);
		expect(result.text.split("\n")).toEqual([
			"Teach: on · capture observe · recall on · 1 confirmed, 0 candidate · Hindsight ready · outbox 0",
			"Moments: 0 candidate, 1 confirmed, 0 promoted, 0 superseded · outbox 0",
		]);
		expect(result.text).not.toContain("test-key-do-not-print");
	});

	test("an empty state reads as zeros and creates nothing", async () => {
		const result = await run(["status", "--json"]);
		expect((json(result).moments as Json).confirmed).toBe(0);
		expect(existsSync(storeDir(stateDir))).toBe(false);
	});
});

describe("list and show", () => {
	test("list prints `<id8> <status> <kind> x<n> <project> <name>`, newest first", async () => {
		seed(
			moment("feed0001-old", { createdAt: "2026-01-01T00:00:00.000Z", name: "Older lesson", occurrences: 3, kind: "bug" }),
			moment("feed0002-new", { createdAt: "2026-02-01T00:00:00.000Z", name: "Newer lesson", status: "candidate" }),
		);
		const project = projectOf(root);
		expect((await run(["list"])).text.split("\n")).toEqual([
			`feed0002 candidate pitfall x1 ${project} Newer lesson`,
			`feed0001 confirmed bug x3 ${project} Older lesson`,
		]);
	});

	test("list filters by status and project (case-insensitive) and validates the status", async () => {
		seed(moment("feed0001-a"), moment("feed0002-b", { status: "candidate", project: "other" }));
		expect((await run(["list", "--status", "candidate"])).text).toStartWith("feed0002");
		expect((await run(["list", "--project", "OTHER"])).text).toStartWith("feed0002");
		expect((await run(["list", "--status", "candidate", "--project", projectOf(root)])).text).toBe("No moments.");
		expect((await run(["list", "--status", "weird"])).code).toBe(2);
	});

	test("list --json carries the count and the full moments; an absent store is empty", async () => {
		expect(json(await run(["list", "--json"]))).toEqual({ count: 0, moments: [] });
		seed(moment("feed0001-a"));
		const body = json(await run(["list", "--json"]));
		expect(body.count).toBe(1);
		expect((body.moments as Json[])[0]).toEqual({ ...moment("feed0001-a") });
	});

	test("show finds by full id and by unique prefix, in text and JSON", async () => {
		seed(moment("feed0001-a", { name: "Pin the lockfile", body: "Run bun install --frozen-lockfile." }));
		const text = await run(["show", "feed0001-a"]);
		expect(text.code).toBe(0);
		expect(text.text).toContain("Pin the lockfile");
		expect(text.text).toContain("Run bun install --frozen-lockfile.");
		expect(json(await run(["show", "feed", "--json"])).id).toBe("feed0001-a");
		expect(json(await run(["show", "feed0001", "--json"]))).toEqual({ ...moment("feed0001-a", { name: "Pin the lockfile", body: "Run bun install --frozen-lockfile." }) });
	});

	test("show: unknown id exits 1, ambiguous prefix and invalid ids exit 2", async () => {
		seed(moment("abcd1234-one"), moment("abcd1234-two"));
		const unknown = await run(["show", "zzzz9999", "--json"]);
		expect(unknown.code).toBe(1);
		expect(json(unknown)).toEqual({ ok: false, error: "no moment zzzz9999" });
		expect((await run(["show", "abc"])).code).toBe(1);
		const ambiguous = await run(["show", "abcd1234"]);
		expect(ambiguous.code).toBe(2);
		expect(ambiguous.text).toContain("ambiguous");
		expect((await run(["show", "../x"])).code).toBe(2);
		expect((await run(["show"])).code).toBe(2);
	});
});

describe("capture", () => {
	test("--name/--body stores a confirmed moment and retains it; --json has exact keys", async () => {
		const result = await run(["capture", "--name", "Pin the lockfile", "--body", "Use --frozen-lockfile.", "--kind", "pitfall", "--json"]);
		expect(result.code).toBe(0);
		const body = json(result);
		expect(Object.keys(body).sort()).toEqual(["created", "id", "ok", "reason", "retain"]);
		expect(body).toMatchObject({ ok: true, created: true, retain: "retained", reason: null });
		const saved = store().get(body.id as string);
		expect(saved).toMatchObject({ name: "Pin the lockfile", kind: "pitfall", status: "confirmed", origin: "explicit" });
		expect(fake.retained.map((item) => item.documentId)).toEqual([documentIdFor(body.id as string)]);
	});

	test("human output: Captured <id> (created|merged) · retain <state>", async () => {
		const argv = ["capture", "--name", "Same lesson", "--body", "Same body."];
		const first = await run(argv);
		expect(first.text).toMatch(/^Captured \S+ \(created\) · retain retained$/);
		const second = await run(argv);
		expect(second.text).toMatch(/^Captured \S+ \(merged\) · retain retained/);
		expect(store().list()).toHaveLength(1);
		expect(store().list()[0]?.occurrences).toBe(2);
	});

	test("a Hindsight failure is not a CLI failure: the moment is kept and queued", async () => {
		fake.failRetain = true;
		const result = await run(["capture", "--name", "Queued lesson", "--body", "Body.", "--json"]);
		expect(result.code).toBe(0);
		expect(json(result).retain).toBe("queued");
		expect(store().list()).toHaveLength(1);
		expect(store().outbox()).toHaveLength(1);
	});

	test("--stdin reads one CaptureInput object", async () => {
		const stdin = async () =>
			JSON.stringify({ name: "From stdin", body: "Body text.", description: "A description", kind: "bug", tags: ["x"], sourcePhase: "p1", sourceArtifacts: ["f.ts"] });
		const result = await run(["capture", "--stdin", "--json"], { stdin });
		expect(result.code).toBe(0);
		expect(store().get(json(result).id as string)).toMatchObject({
			name: "From stdin",
			description: "A description",
			kind: "bug",
			sourcePhase: "p1",
			sourceArtifacts: ["f.ts"],
		});
	});

	test("--stdin input errors exit 2", async () => {
		const cases: Array<[string, string]> = [
			["not json", "{nope"],
			["array", "[]"],
			["missing body", JSON.stringify({ name: "N" })],
			["unknown kind", JSON.stringify({ name: "N", body: "B", kind: "weird" })],
			["tags not strings", JSON.stringify({ name: "N", body: "B", tags: [1] })],
			["name not a string", JSON.stringify({ name: 5, body: "B" })],
			["confidence not a number", JSON.stringify({ name: "N", body: "B", confidence: "high" })],
		];
		for (const [label, input] of cases) {
			const result = await run(["capture", "--stdin", "--json"], { stdin: async () => input });
			expect({ label, code: result.code }).toEqual({ label, code: 2 });
			expect(json(result).ok).toBe(false);
		}
		expect(store().list()).toHaveLength(0);
	});

	test("flag errors exit 2: missing body, unknown kind, blank name, --stdin with --name", async () => {
		expect((await run(["capture", "--name", "N"])).code).toBe(2);
		expect((await run(["capture", "--body", "B"])).code).toBe(2);
		expect((await run(["capture", "--name", "N", "--body", "B", "--kind", "weird"])).code).toBe(2);
		expect((await run(["capture", "--name", "   ", "--body", "B"])).code).toBe(2);
		const both = await run(["capture", "--stdin", "--name", "N"], { stdin: async () => "{}" });
		expect(both.code).toBe(2);
		expect(both.text).toContain("--stdin cannot be combined");
		expect(store().list()).toHaveLength(0);
	});

	test("a failure that is not the user's input exits 1 and keeps the message to one redacted line", async () => {
		const result = await run(["capture", "--stdin"], {
			stdin: async () => {
				throw new Error("pipe broke\nsecond line");
			},
		});
		expect(result).toEqual({ code: 1, text: "teach: pipe broke" });
	});

	test("oversized stdin is refused before parsing", async () => {
		const result = await run(["capture", "--stdin"], { stdin: async () => " ".repeat(2_000_001) });
		expect(result.code).toBe(2);
		expect(result.text).toContain("too large");
	});
});

describe("recall", () => {
	test("--json lists the lessons with the contract keys", async () => {
		const lesson = moment("feed0001-a", { name: "Pin the lockfile", kind: "bug", occurrences: 2 });
		fake.hits = [hitFor(lesson)];
		const result = await run(["recall", "lockfile", "drift", "--json"]);
		expect(result.code).toBe(0);
		expect(fake.queries.some((query) => query.includes("lockfile drift"))).toBe(true);
		const body = json(result);
		expect(body).toMatchObject({ status: "used", source: "hindsight", count: 1 });
		const first = (body.lessons as Json[])[0] as Json;
		expect(Object.keys(first).sort()).toEqual(["body", "createdAt", "description", "host", "id", "kind", "name", "occurrences", "project"]);
		expect(first).toMatchObject({ id: "feed0001-a", name: "Pin the lockfile", kind: "bug", occurrences: 2 });
	});

	test("human output: `source · n lesson(s)` then the formatted lessons", async () => {
		fake.hits = [hitFor(moment("feed0001-a", { name: "Pin the lockfile" }))];
		const result = await run(["recall", "lockfile"]);
		const lines = result.text.split("\n");
		expect(lines[0]).toBe("hindsight · 1 lesson");
		expect(result.text).toContain("## Lessons from earlier work");
		expect(result.text).toContain("Pin the lockfile");
	});

	test("--limit caps the lessons; --project * is accepted", async () => {
		fake.hits = [hitFor(moment("feed0001-a")), hitFor(moment("feed0002-b", { name: "Second" })), hitFor(moment("feed0003-c", { name: "Third" }))];
		const result = await run(["recall", "lockfile", "--limit", "2", "--project", "*", "--json"]);
		expect(result.code).toBe(0);
		expect(json(result).count).toBe(2);
	});

	test("does not count the lookup as a use", async () => {
		seed(moment("feed0001-a"));
		fake.hits = [hitFor(moment("feed0001-a"))];
		await run(["recall", "lockfile"]);
		expect(store().get("feed0001-a")?.recalled).toBe(0);
	});

	test("usage errors: no query, bad --limit", async () => {
		expect((await run(["recall"])).code).toBe(2);
		expect((await run(["recall", "--json"])).code).toBe(2);
		for (const limit of ["0", "11", "abc", "-1"]) {
			expect({ limit, code: (await run(["recall", "q", "--limit", limit])).code }).toEqual({ limit, code: 2 });
		}
	});
});

describe("confirm and forget", () => {
	test("confirm turns a candidate into a confirmed, retained moment", async () => {
		seed(moment("feed0001-a", { status: "candidate", origin: "observe" }));
		const result = await run(["confirm", "feed0001", "--json"]);
		expect(result.code).toBe(0);
		expect(json(result)).toEqual({ ok: true, id: "feed0001-a", status: "confirmed", retain: "retained", reason: null });
		expect(store().get("feed0001-a")?.status).toBe("confirmed");
		expect(fake.retained).toHaveLength(1);
		const human = await run(["confirm", "feed0001-a"]);
		expect(human.text).toMatch(/^Confirmed feed0001-a · retain /);
	});

	test("confirm of an unknown id exits 1; a missing id exits 2", async () => {
		const unknown = await run(["confirm", "nope0001", "--json"]);
		expect(unknown.code).toBe(1);
		expect(json(unknown)).toEqual({ ok: false, error: "no moment nope0001" });
		expect((await run(["confirm"])).code).toBe(2);
	});

	test("forget removes the local moment and deletes the Hindsight document", async () => {
		seed(moment("feed0001-a", { retained: { at: "2026-01-02T00:00:00.000Z", bank: "ultrathink", documentId: "tm:feed0001-a" } }));
		const result = await run(["forget", "feed0001", "--json"]);
		expect(result.code).toBe(0);
		expect(json(result)).toEqual({ ok: true, id: "feed0001-a", removed: true, remote: "deleted" });
		expect(store().get("feed0001-a")).toBeUndefined();
		expect(fake.deleted).toEqual(["tm:feed0001-a"]);
	});

	test("forget queues the remote delete when Hindsight is unreachable", async () => {
		fake.failDelete = true;
		seed(moment("feed0001-a", { retained: { at: "2026-01-02T00:00:00.000Z", bank: "ultrathink", documentId: "tm:feed0001-a" } }));
		const result = await run(["forget", "feed0001-a"]);
		expect(result).toEqual({ code: 0, text: "Forgot feed0001-a · remote queued" });
		expect(store().get("feed0001-a")).toBeUndefined();
		expect(store().outbox()).toHaveLength(1);
	});

	test("forget of an unknown id exits 1", async () => {
		const result = await run(["forget", "nope0001"]);
		expect(result).toEqual({ code: 1, text: "no moment nope0001" });
	});
});

describe("sync", () => {
	test("an empty outbox is done 0, pending 0 with exactly those keys", async () => {
		const result = await run(["sync", "--json"]);
		expect(result.code).toBe(0);
		expect(json(result)).toEqual({ done: 0, pending: 0 });
		expect((await run(["sync"])).text).toBe("Sync: 0 done · 0 pending");
	});

	test("retries queued writes once Hindsight is back", async () => {
		fake.failRetain = true;
		await run(["capture", "--name", "Queued", "--body", "Body."]);
		expect(store().outbox()).toHaveLength(1);
		fake.failRetain = false;
		const later = () => NOW + 24 * 3_600_000;
		const result = await run(["sync", "--json"], { now: later });
		expect(result.code).toBe(0);
		expect(json(result)).toEqual({ done: 1, pending: 0 });
		expect(fake.retained).toHaveLength(1);
		expect(store().outbox()).toHaveLength(0);
	});

	test("a failed capture queues one due entry and sync delivers it exactly once", async () => {
		fake.failRetain = true;
		const captured = await run(["capture", "--name", "Queued", "--body", "Body."]);
		expect(captured.code).toBe(0);
		expect(captured.text).toContain("retain queued");
		const moments = store().list();
		expect(moments).toHaveLength(1);
		const entries = store().outbox();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ op: { op: "retain", momentId: moments[0]?.id }, attempts: 0, enqueuedAt: NOW, nextAt: NOW });
		fake.failRetain = false;
		const result = await run(["sync", "--json"]);
		expect(result.code).toBe(0);
		expect(json(result)).toEqual({ done: 1, pending: 0 });
		expect(fake.retained).toHaveLength(1);
		expect(fake.retained[0]?.documentId).toBe(`tm:${moments[0]?.id}`);
		expect(store().outbox()).toHaveLength(0);
		expect(json(await run(["sync", "--json"]))).toEqual({ done: 0, pending: 0 });
		expect(fake.retained).toHaveLength(1);
	});

	test("exits 1 with the reason while writes stay pending", async () => {
		fake.failRetain = true;
		await run(["capture", "--name", "Queued", "--body", "Body."]);
		const result = await run(["sync", "--json"], { now: () => NOW + 24 * 3_600_000 });
		expect(result.code).toBe(1);
		const body = json(result);
		expect(body).toMatchObject({ done: 0, pending: 1 });
		expect(typeof body.reason).toBe("string");
	});
});

function digest(over: Json = {}): Json {
	return {
		host: "claude-code",
		sessionId: "session-1",
		cwd: root,
		at: "2026-03-01T00:00:00.000Z",
		toolCalls: 5,
		outcome: "completed",
		turns: [
			{ role: "user", text: "make the build pass" },
			{ role: "tool", tool: "Bash", text: "error: lockfile out of date", isError: true },
			{ role: "tool", tool: "Bash", text: "ok" },
			{ role: "assistant", text: "fixed by refreshing the lockfile" },
		],
		...over,
	};
}

const DISTILLED = JSON.stringify({
	lessons: [{ name: "Refresh the lockfile first", description: "build fails on a stale lockfile", body: "Run bun install before the build.", kind: "pitfall", confidence: 0.7 }],
});

function writeInbox(content: string, name = "d1.json"): string {
	const dir = join(storeDir(stateDir), "inbox");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

describe("observe", () => {
	test("--stdin distills a digest into a local candidate", async () => {
		const result = await run(["observe", "--stdin", "--json"], {
			stdin: async () => JSON.stringify(digest()),
			complete: async () => DISTILLED,
		});
		expect(result.code).toBe(0);
		const body = json(result);
		expect(body.ok).toBe(true);
		expect(body.skipped).toBeUndefined();
		const captured = body.captured as Json[];
		expect(captured).toHaveLength(1);
		expect(captured[0]).toMatchObject({ created: true, retain: "local-only" });
		expect(typeof captured[0]?.reason).toBe("string");
		expect(store().list()[0]).toMatchObject({ status: "candidate", origin: "observe", name: "Refresh the lockfile first" });
		expect(fake.retained).toEqual([]);
	});

	test("human output lists what was captured", async () => {
		const result = await run(["observe", "--stdin"], { stdin: async () => JSON.stringify(digest()), complete: async () => DISTILLED });
		const lines = result.text.split("\n");
		expect(lines[0]).toBe("Observed · 1 captured");
		expect(lines[1]).toMatch(/^Captured \S+ \(created\) · retain local-only/);
	});

	test("a digest below the tool-call floor is skipped with exit 0", async () => {
		const result = await run(["observe", "--stdin", "--json"], {
			stdin: async () => JSON.stringify(digest({ toolCalls: 1 })),
			complete: async () => {
				throw new Error("must not be called");
			},
		});
		expect(result.code).toBe(0);
		expect(json(result)).toMatchObject({ ok: true, captured: [], skipped: "too few tool calls" });
		expect((await run(["observe", "--stdin"], { stdin: async () => JSON.stringify(digest({ toolCalls: 1 })) })).text).toBe("Observe skipped: too few tool calls");
	});

	test("a malformed digest exits 2", async () => {
		for (const input of ["{oops", "[]", JSON.stringify({ host: "x" }), JSON.stringify(digest({ toolCalls: -1 }))]) {
			const result = await run(["observe", "--stdin"], { stdin: async () => input });
			expect({ input, code: result.code }).toEqual({ input, code: 2 });
		}
	});

	test("exactly one of --stdin and --file", async () => {
		expect((await run(["observe"])).code).toBe(2);
		expect((await run(["observe", "--stdin", "--file", "x.json"])).code).toBe(2);
	});

	test("--file inside the inbox is processed and deleted (relative paths resolve from cwd)", async () => {
		const file = writeInbox(JSON.stringify(digest()));
		const result = await run(["observe", "--file", "state/teach/inbox/d1.json", "--json"], { complete: async () => DISTILLED });
		expect(result.code).toBe(0);
		expect((json(result).captured as Json[]).length).toBe(1);
		expect(existsSync(file)).toBe(false);
	});

	test("--file is deleted when the distiller fails", async () => {
		const file = writeInbox(JSON.stringify(digest()));
		const result = await run(["observe", "--file", file, "--json"], {
			complete: async () => {
				throw new Error("engine down");
			},
		});
		expect(result.code).toBe(0);
		expect(json(result)).toMatchObject({ ok: true, captured: [], skipped: "distiller failed" });
		expect(existsSync(file)).toBe(false);
		expect(store().list()).toEqual([]);
	});

	test("--file is deleted even when its content is not a digest (exit 2)", async () => {
		const file = writeInbox("{broken");
		const result = await run(["observe", "--file", file]);
		expect(result.code).toBe(2);
		expect(existsSync(file)).toBe(false);
	});

	test("--file outside the inbox is refused with exit 2 and left alone", async () => {
		const outside = join(root, "elsewhere.json");
		writeFileSync(outside, JSON.stringify(digest()));
		mkdirSync(join(storeDir(stateDir), "inbox"), { recursive: true });
		const result = await run(["observe", "--file", outside, "--json"], { complete: async () => DISTILLED });
		expect(result.code).toBe(2);
		expect(json(result).ok).toBe(false);
		expect(readFileSync(outside, "utf8")).toBe(JSON.stringify(digest()));
		expect(store().list()).toEqual([]);
	});

	test("--file in a sibling directory whose name starts like the inbox is refused", async () => {
		const sibling = join(storeDir(stateDir), "inbox-other");
		mkdirSync(sibling, { recursive: true });
		mkdirSync(join(storeDir(stateDir), "inbox"), { recursive: true });
		const file = join(sibling, "d1.json");
		writeFileSync(file, JSON.stringify(digest()));
		const result = await run(["observe", "--file", file]);
		expect(result.code).toBe(2);
		expect(existsSync(file)).toBe(true);
	});

	test("--file that is a symlink leaving the inbox is refused and the target survives", async () => {
		const target = join(root, "secret-target.json");
		writeFileSync(target, JSON.stringify(digest()));
		mkdirSync(join(storeDir(stateDir), "inbox"), { recursive: true });
		const link = join(storeDir(stateDir), "inbox", "link.json");
		symlinkSync(target, link);
		const result = await run(["observe", "--file", link]);
		expect(result.code).toBe(2);
		expect(existsSync(target)).toBe(true);
	});

	test("--file that does not exist, is a directory, or has no inbox exits 2", async () => {
		expect((await run(["observe", "--file", join(stateDir, "teach", "inbox", "none.json")])).code).toBe(2);
		const dir = join(storeDir(stateDir), "inbox", "sub");
		mkdirSync(dir, { recursive: true });
		const result = await run(["observe", "--file", dir]);
		expect(result.code).toBe(2);
		expect(existsSync(dir)).toBe(true);
	});

	test("--json includes Jev decisions of {point, p, action} and not the lesson body", async () => {
		const body = "LESSON-BODY-9f3e do not leak this sentence into json";
		const calls: string[] = [];
		const result = await run(["observe", "--stdin", "--json"], {
			stdin: async () => JSON.stringify(digest()),
			complete: async () =>
				JSON.stringify({
					lessons: [{ name: "Refresh the lockfile first", description: "build fails on a stale lockfile", body, kind: "pitfall", confidence: 0.7 }],
				}),
			env: { ...baseEnv(), OPENROUTER_API_KEY: JEV_KEY },
			config: { ...config(), decisions: decisionsOn({ points: ["teachable"] }) },
			fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
				calls.push(String(init?.body ?? ""));
				return Response.json({
					model: "typesafe/jev-1.13-20260917",
					answers: { teachable: { type: "noul", noul: 0.31 } },
					usage: { input_tokens: 10, output_tokens: 0 },
				});
			}) as typeof fetch,
		});
		expect(result.code).toBe(0);
		expect(json(result).decisions).toEqual([{ point: "teachable", p: 0.31, action: "keep" }]);
		expect(result.text).not.toContain(body);
		expect(calls).toHaveLength(1);
		expect(calls[0]).not.toContain(JEV_KEY);
	});
});

describe("promote", () => {
	const playbook = () =>
		moment("feed0001-a", {
			name: "Pin the lockfile before building",
			description: "builds fail on a stale lockfile",
			body: "Run bun install --frozen-lockfile before the build.",
			kind: "playbook",
		});

	test("--due lists promotion candidates", async () => {
		seed(
			playbook(),
			moment("feed0002-b", { occurrences: 3 }),
			moment("feed0003-c", { occurrences: 1 }),
			moment("feed0004-d", { occurrences: 5, status: "candidate" }),
		);
		const result = await run(["promote", "--due", "--json"]);
		expect(result.code).toBe(0);
		const ids = (json(result).candidates as Json[]).map((item) => item.id).sort();
		expect(ids).toEqual(["feed0001-a", "feed0002-b"]);
		const human = await run(["promote", "--due"]);
		expect(human.text.split("\n")).toHaveLength(2);
		expect(human.text).toContain("feed0002 confirmed pitfall x3");
	});

	test("--due lists newest first and the rendered draft passes the Hermes rules", async () => {
		seed(
			moment("feed0007-g", { occurrences: 9, createdAt: "2026-01-01T00:00:00.000Z" }),
			moment("feed0008-h", { occurrences: 3, createdAt: "2026-03-01T00:00:00.000Z" }),
			moment("feed0009-i", { occurrences: 2, createdAt: "2026-04-01T00:00:00.000Z" }),
		);
		const human = await run(["promote", "--due"]);
		expect(human.text.split("\n")).toHaveLength(2);
		expect(human.text.indexOf("feed0008")).toBeLessThan(human.text.indexOf("feed0007"));
		expect(human.text).not.toContain("feed0009");
		const result = await run(["promote", "feed0008", "--json"]);
		expect(result.code).toBe(0);
		const content = (json(result).draft as Json).content as string;
		expect(content.startsWith("---\n")).toBe(true);
		const end = content.indexOf("\n---\n", 3);
		expect(end).toBeGreaterThan(0);
		const fields: Record<string, string> = {};
		for (const line of content.slice(4, end).split("\n")) {
			const split = line.indexOf(": ");
			fields[line.slice(0, split)] = line.slice(split + 2);
		}
		const name = fields["name"] ?? "";
		const rawDescription = fields["description"] ?? "";
		const description = rawDescription.startsWith('"') ? (JSON.parse(rawDescription) as string) : rawDescription;
		expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
		expect(description.length).toBeGreaterThan(0);
		expect(description.length).toBeLessThanOrEqual(60);
		expect(description.endsWith(".")).toBe(true);
		expect(description).not.toMatch(/[:`<>\n]/);
		expect(description).not.toMatch(/[.!?]\s/);
		expect(content.slice(end + 5).trim().length).toBeGreaterThan(0);
		expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(64_000);
	});

	test("--due with nothing due says so; --due with ids is a usage error", async () => {
		expect((await run(["promote", "--due"])).text).toBe("No moments are due for promotion.");
		expect((await run(["promote", "--due", "feed0001"])).code).toBe(2);
	});

	test("renders a draft without writing anything", async () => {
		seed(playbook());
		const result = await run(["promote", "feed0001", "--json"]);
		expect(result.code).toBe(0);
		const body = json(result);
		expect(Object.keys(body).sort()).toEqual(["draft", "outcome", "promoted"]);
		const draft = body.draft as Json;
		expect(Object.keys(draft).sort()).toEqual(["content", "description", "name", "warnings"]);
		expect(draft.name).toStartWith("lesson-");
		expect(draft.content).toContain(`name: ${draft.name as string}`);
		expect(body.outcome).toBeNull();
		expect(body.promoted).toEqual([]);
		expect(store().get("feed0001-a")?.status).toBe("confirmed");
		expect(existsSync(join(root, "claude", "skills"))).toBe(false);
		const human = await run(["promote", "feed0001"]);
		expect(human.text).toStartWith("Draft lesson-");
		expect(human.text).toContain("---\nname: lesson-");
	});

	test("--install --target drafts writes under skill-drafts and does not mark the moment", async () => {
		seed(playbook());
		const result = await run(["promote", "feed0001", "--install", "--target", "drafts", "--json"]);
		expect(result.code).toBe(0);
		const body = json(result);
		const outcome = body.outcome as Json;
		expect(outcome.action).toBe("drafted");
		expect(outcome.path as string).toStartWith(join(storeDir(stateDir), "skill-drafts"));
		expect(existsSync(outcome.path as string)).toBe(true);
		expect(body.promoted).toEqual([]);
		expect(store().get("feed0001-a")?.status).toBe("confirmed");
	});

	test("--install defaults to the host's target and marks the moment promoted", async () => {
		seed(playbook());
		const result = await run(["promote", "feed0001", "--install", "--json"]);
		expect(result.code).toBe(0);
		const body = json(result);
		const outcome = body.outcome as Json;
		const name = (body.draft as Json).name as string;
		expect(outcome).toMatchObject({ target: "claude", action: "created", path: join(root, "claude", "skills", name, "SKILL.md") });
		expect(existsSync(outcome.path as string)).toBe(true);
		expect(body.promoted).toEqual(["feed0001-a"]);
		expect(store().get("feed0001-a")).toMatchObject({ status: "promoted", promoted: { skill: name, target: "claude", path: outcome.path } });
	});

	test("a draft that cannot be made exits 1 with the reason", async () => {
		seed(playbook(), moment("feed0005-e", { body: "", kind: "playbook" }));
		const result = await run(["promote", "feed0005-e"]);
		expect(result.code).toBe(1);
		expect(result.text).toBe("lesson has no body text");
	});

	test("--mark-promoted records a skill staged elsewhere (Hermes skill_manage)", async () => {
		seed(playbook());
		const result = await run(["promote", "feed0001", "--mark-promoted", "--skill", "lesson-pin-lockfile", "--target", "hermes", "--path", "/skills/x", "--json"]);
		expect(result.code).toBe(0);
		expect(json(result)).toEqual({ ok: true, promoted: ["feed0001-a"] });
		expect(store().get("feed0001-a")).toMatchObject({
			status: "promoted",
			promoted: { skill: "lesson-pin-lockfile", target: "hermes", path: "/skills/x" },
		});
		seed(moment("feed0006-f"));
		const human = await run(["promote", "feed0006-f", "--mark-promoted", "--skill", "other-skill", "--target", "omp"]);
		expect(human.text).toBe("Marked 1 moment(s) promoted · other-skill (omp)");
	});

	test("usage errors", async () => {
		seed(playbook());
		const cases: string[][] = [
			["promote"],
			["promote", "feed0001", "--target", "windows"],
			["promote", "feed0001", "--mark-promoted", "--target", "omp"],
			["promote", "feed0001", "--mark-promoted", "--skill", "Bad Name", "--target", "omp"],
			["promote", "feed0001", "--mark-promoted", "--skill", "ok-name"],
			["promote", "feed0001", "--mark-promoted", "--install", "--skill", "ok-name", "--target", "omp"],
			["promote", "feed0001", "--skill", "ok-name"],
			["promote", "--due", "--install"],
			["promote", "--due", "--target", "omp"],
			["promote", "--due", "--skill", "ok-name"],
			["promote", "--due", "--path", "/tmp/x"],
		];
		for (const argv of cases) {
			const result = await run(argv);
			expect({ argv, code: result.code }).toEqual({ argv, code: 2 });
		}
		expect((await run(["promote", "nope0001"])).code).toBe(1);
		expect(store().get("feed0001-a")?.status).toBe("confirmed");
	});

	test("explicit promote renders the draft and does not call Jev", async () => {
		seed(playbook());
		const calls = { n: 0 };
		const result = await run(["promote", "feed0001"], {
			env: { ...baseEnv(), OPENROUTER_API_KEY: JEV_KEY },
			config: { ...config(), decisions: decisionsOn() },
			fetch: jevFetch(0.1, calls),
		});
		expect(result.code).toBe(0);
		expect(result.text).toStartWith("Draft lesson-");
		expect(result.text).toContain("Run bun install --frozen-lockfile before the build.");
		expect(calls.n).toBe(0);
		expect(store().get("feed0001-a")?.status).toBe("confirmed");
	});

	test("--due with a low P omits the moment and says Jev skipped; decisions off lists it", async () => {
		seed(playbook());
		const lowCalls = { n: 0 };
		const low = await run(["promote", "--due"], {
			env: { ...baseEnv(), OPENROUTER_API_KEY: JEV_KEY },
			config: { ...config(), decisions: decisionsOn() },
			fetch: jevFetch(0.1, lowCalls),
		});
		expect(low.code).toBe(0);
		expect(low.text).toContain("Jev skipped");
		expect(low.text).not.toContain("feed0001");
		expect(lowCalls.n).toBe(1);

		const offCalls = { n: 0 };
		const off = await run(["promote", "--due"], {
			env: { ...baseEnv(), OPENROUTER_API_KEY: JEV_KEY },
			config: { ...config(), decisions: decisionsOn({ enabled: false }) },
			fetch: jevFetch(0.1, offCalls),
		});
		expect(off.code).toBe(0);
		expect(off.text).toContain("feed0001");
		expect(off.text).not.toContain("Jev skipped");
		expect(offCalls.n).toBe(0);
	});
});

describe("export", () => {
	test("--a2a prints an Agent Card of the confirmed and promoted moments", async () => {
		seed(
			moment("feed0001-a", { createdAt: "2026-01-03T00:00:00.000Z" }),
			moment("feed0002-b", { status: "promoted", createdAt: "2026-01-02T00:00:00.000Z" }),
			moment("feed0003-c", { status: "candidate" }),
			moment("feed0004-d", { status: "superseded" }),
		);
		const result = await run(["export", "--a2a"]);
		expect(result.code).toBe(0);
		expect(result.text).toContain('\n  "name": "ultrathink"');
		const card = JSON.parse(result.text) as Json;
		expect(card.name).toBe("ultrathink");
		expect((card.skills as Json[]).map((skill) => skill.id)).toEqual(["feed0001-a", "feed0002-b"]);
	});

	test("given ids it exports exactly those moments, whatever their status", async () => {
		seed(moment("feed0001-a"), moment("feed0003-c", { status: "candidate" }));
		const card = JSON.parse((await run(["export", "--a2a", "feed0003"])).text) as Json;
		expect((card.skills as Json[]).map((skill) => skill.id)).toEqual(["feed0003-c"]);
	});

	test("needs --a2a; an unknown id exits 1", async () => {
		expect((await run(["export"])).code).toBe(2);
		expect((await run(["export", "--a2a", "nope0001"])).code).toBe(1);
	});
});
