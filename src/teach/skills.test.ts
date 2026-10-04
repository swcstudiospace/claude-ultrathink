// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HINDSIGHT_CONFIG } from "../hindsight/types.ts";
import { formatSkillsSection, recallSkills, skillsLookup, SKILL_SECTION_CHARS } from "./skills.ts";
import { openStore, storeDir } from "./store.ts";
import { DEFAULT_TEACH_CONFIG, type RecalledSkill, type SkillRecallOutcome, type TeachableMoment, type TeachContext } from "./types.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-teach-skills-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function moment(id: string, overrides: Partial<TeachableMoment> = {}): TeachableMoment {
	return {
		id,
		name: `lesson ${id}`,
		description: "",
		body: "",
		sourcePhase: "",
		sourceArtifacts: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		tags: [],
		relatedIds: [],
		schema: 2,
		kind: "pitfall",
		status: "confirmed",
		origin: "explicit",
		project: "proj",
		host: "omp",
		confidence: 1,
		occurrences: 1,
		lastSeenAt: "2026-01-01T00:00:00.000Z",
		dedupeKey: `key-${id}`,
		recalled: 0,
		...overrides,
	};
}

function promoted(id: string, skill: string, overrides: Partial<TeachableMoment> = {}): TeachableMoment {
	return moment(id, {
		status: "promoted",
		promoted: { at: "2026-02-01T00:00:00.000Z", skill, target: "omp", path: `/skills/${skill}/SKILL.md` },
		...overrides,
	});
}

function setup(options: { teach?: Partial<typeof DEFAULT_TEACH_CONFIG>; env?: NodeJS.ProcessEnv } = {}) {
	const root = tempDir();
	const cwd = join(root, "proj");
	mkdirSync(join(cwd, ".git"), { recursive: true });
	const ctx: TeachContext = {
		host: "omp",
		cwd,
		config: { teach: { ...DEFAULT_TEACH_CONFIG, enabled: true, ...options.teach }, hindsight: { ...DEFAULT_HINDSIGHT_CONFIG } },
		env: { HOME: root, ...options.env },
		stateDir: join(root, "state"),
		now: () => Date.parse("2026-06-01T00:00:00.000Z"),
	};
	return { ctx, root };
}

function draftsDir(ctx: TeachContext): string {
	return join(storeDir(ctx.stateDir), "skill-drafts");
}

function writeDraft(
	ctx: TeachContext,
	dir: string,
	{ name, description = `Use when ${name}.`, project = "proj", occurrences = 2, ids = "aaa" }: {
		name: string;
		description?: string;
		project?: string;
		occurrences?: number;
		ids?: string;
	},
): string {
	const path = join(draftsDir(ctx), dir, "SKILL.md");
	mkdirSync(join(draftsDir(ctx), dir), { recursive: true });
	const yamlDescription = description.includes("#") ? JSON.stringify(description) : description;
	writeFileSync(
		path,
		`---\nname: ${name}\ndescription: ${yamlDescription}\n---\n# ${name}\n\n## Evidence\n\n- Occurrences: ${occurrences}\n- Project: ${project}\n- Moments: ${ids}\n\n<!-- ultrathink:teach ids=${ids} -->\n`,
	);
	return path;
}

function skillObj(overrides: Partial<RecalledSkill> = {}): RecalledSkill {
	return {
		name: "lesson-bun-test",
		description: "Use when running the test suite.",
		path: "/state/teach/skill-drafts/lesson-bun-test/SKILL.md",
		target: "drafts",
		sourceIds: ["aaa"],
		occurrences: 3,
		...overrides,
	};
}

function used(skills: RecalledSkill[]): SkillRecallOutcome {
	return { status: "used", skills, chars: 0, ms: 0 };
}

describe("recallSkills: gates", () => {
	test("off unless Teachable Moments and recall are on; the kill switch wins", async () => {
		const { ctx } = setup();
		const store = openStore(storeDir(ctx.stateDir));
		store.put(promoted("a1", "lesson-bun", { name: "bun test from root", description: "run suite", body: "bun test" }));
		expect((await recallSkills({ query: "bun test" }, ctx)).status).toBe("used");

		const disabled = setup({ teach: { enabled: false } });
		expect(await recallSkills({ query: "bun test" }, disabled.ctx)).toMatchObject({ status: "off", reason: "teach is off" });

		const noRecall = setup({ teach: { recall: false } });
		expect(await recallSkills({ query: "bun test" }, noRecall.ctx)).toMatchObject({ status: "off", reason: "recall is off" });

		const killed = setup({ env: { ULTRATHINK_TEACH: "0" } });
		expect((await recallSkills({ query: "bun test" }, killed.ctx)).status).toBe("off");
	});

	test("none on an empty query, an empty store, or no match", async () => {
		const { ctx } = setup();
		expect((await recallSkills({ query: "  " }, ctx)).status).toBe("none");
		expect((await recallSkills({ query: "nothing matches this" }, ctx)).status).toBe("none");
		const store = openStore(storeDir(ctx.stateDir));
		store.put(promoted("a1", "lesson-bun", { name: "bun test from root", body: "bun test" }));
		expect((await recallSkills({ query: "kubernetes ingress" }, ctx)).status).toBe("none");
	});
});

describe("recallSkills: promoted moments", () => {
	test("matches name, description and body; other statuses never recall", async () => {
		const { ctx } = setup();
		const store = openStore(storeDir(ctx.stateDir));
		store.put(promoted("a1", "lesson-bun", { name: "bun test from root", description: "", body: "from the repository root" }));
		store.put(promoted("a2", "lesson-lock", { name: "unrelated", description: "pin the lockfile", body: "" }));
		store.put(promoted("a3", "lesson-ci", { name: "unrelated", description: "", body: "the ci workflow drifts" }));
		store.put(moment("c1", { name: "bun test from root", status: "confirmed" }));
		store.put(moment("c2", { name: "bun test from root", status: "candidate" }));
		const outcome = await recallSkills({ query: "bun root lockfile workflow" }, ctx);
		expect(outcome.status).toBe("used");
		expect(outcome.skills.map((skill) => skill.name).sort()).toEqual(["lesson-bun", "lesson-ci", "lesson-lock"]);
		const bun = outcome.skills.find((skill) => skill.name === "lesson-bun")!;
		expect(bun).toMatchObject({ target: "omp", path: "/skills/lesson-bun/SKILL.md", sourceIds: ["a1"], occurrences: 1 });
	});

	test("other projects are skipped unless the query asks for every project", async () => {
		const { ctx } = setup();
		const store = openStore(storeDir(ctx.stateDir));
		store.put(promoted("a1", "lesson-bun", { name: "bun test from root", project: "other" }));
		expect((await recallSkills({ query: "bun test" }, ctx)).status).toBe("none");
		expect((await recallSkills({ query: "bun test", project: "*" }, ctx)).status).toBe("used");
		expect((await recallSkills({ query: "bun test", project: "other" }, ctx)).status).toBe("used");
	});

	test("a promoted record wins over a draft of the same skill", async () => {
		const { ctx } = setup();
		const store = openStore(storeDir(ctx.stateDir));
		store.put(promoted("a1", "lesson-bun", { name: "bun test from root", occurrences: 5 }));
		writeDraft(ctx, "lesson-bun", { name: "lesson-bun", occurrences: 2 });
		const outcome = await recallSkills({ query: "bun test" }, ctx);
		expect(outcome.skills).toHaveLength(1);
		expect(outcome.skills[0]).toMatchObject({ name: "lesson-bun", target: "omp", occurrences: 5 });
	});

	test("respects the limit", async () => {
		const { ctx } = setup();
		const store = openStore(storeDir(ctx.stateDir));
		for (let n = 1; n <= 4; n++) store.put(promoted(`a${n}`, `lesson-bun-${n}`, { name: "bun test from root" }));
		expect((await recallSkills({ query: "bun test", limit: 2 }, ctx)).skills).toHaveLength(2);
	});
});

describe("recallSkills: drafts", () => {
	test("a draft matches on its trigger and reports its path", async () => {
		const { ctx } = setup();
		const path = writeDraft(ctx, "lesson-bun", { name: "lesson-bun", description: "Use when running bun test." });
		const outcome = await recallSkills({ query: "bun test suite" }, ctx);
		expect(outcome.status).toBe("used");
		expect(outcome.skills[0]).toMatchObject({ name: "lesson-bun", description: "Use when running bun test.", path, target: "drafts" });
		expect(outcome.skills[0]?.sourceIds).toEqual(["aaa"]);
		expect(outcome.skills[0]?.occurrences).toBe(2);
	});

	test("a JSON-quoted description parses; a scoped draft filters by project", async () => {
		const { ctx } = setup();
		writeDraft(ctx, "lesson-hash", { name: "lesson-hash", description: "Use when the ticket has #hash tags.", project: "other" });
		expect((await recallSkills({ query: "ticket hash" }, ctx)).status).toBe("none");
		const outcome = await recallSkills({ query: "ticket hash", project: "other" }, ctx);
		expect(outcome.skills[0]?.description).toBe("Use when the ticket has #hash tags.");
	});

	test("malformed drafts and symlinks are skipped, never thrown", async () => {
		const { ctx } = setup();
		const dir = draftsDir(ctx);
		mkdirSync(join(dir, "no-frontmatter"), { recursive: true });
		writeFileSync(join(dir, "no-frontmatter", "SKILL.md"), "# no frontmatter here\n");
		mkdirSync(join(dir, "empty-name"), { recursive: true });
		writeFileSync(join(dir, "empty-name", "SKILL.md"), "---\nname: \ndescription: x\n---\n");
		writeDraft(ctx, "real", { name: "lesson-real", description: "Use when testing drafts." });
		symlinkSync(join(dir, "real"), join(dir, "linked-dir"));
		mkdirSync(join(dir, "linked-file"), { recursive: true });
		symlinkSync(join(dir, "real", "SKILL.md"), join(dir, "linked-file", "SKILL.md"));
		const outcome = await recallSkills({ query: "testing drafts" }, ctx);
		expect(outcome.skills.map((skill) => skill.name)).toEqual(["lesson-real"]);
	});
});

describe("formatSkillsSection", () => {
	test("renders pointers with paths, framed as untrusted evidence", () => {
		const text = formatSkillsSection(used([skillObj(), skillObj({ name: "second-skill", path: undefined, target: "claude" })]), SKILL_SECTION_CHARS);
		expect(text).toContain("## Relevant skills");
		expect(text).toContain("- **lesson-bun-test** — Use when running the test suite.");
		expect(text).toContain("/state/teach/skill-drafts/lesson-bun-test/SKILL.md (drafts)");
		expect(text).toContain("- **second-skill** — Use when running the test suite.");
		expect(text).not.toContain("undefined");
	});

	test("empty unless used with skills and budget", () => {
		expect(formatSkillsSection({ status: "none", skills: [], chars: 0, ms: 0 }, SKILL_SECTION_CHARS)).toBe("");
		expect(formatSkillsSection(used([]), SKILL_SECTION_CHARS)).toBe("");
		expect(formatSkillsSection(used([skillObj()]), 0)).toBe("");
		expect(formatSkillsSection(used([skillObj()]), 10)).toBe("");
	});

	test("drops entries from the end to fit", () => {
		const skills = [skillObj({ name: "aaa-skill" }), skillObj({ name: "zzz-skill" })];
		const full = formatSkillsSection(used(skills), SKILL_SECTION_CHARS);
		expect(full).toContain("zzz-skill");
		const cut = formatSkillsSection(used(skills), full.length - 10);
		expect(cut).toContain("aaa-skill");
		expect(cut).not.toContain("zzz-skill");
	});
});

describe("skillsLookup", () => {
	test("names only, with the reason passed through", () => {
		expect(skillsLookup(used([skillObj({ name: "aaa" }), skillObj({ name: "bbb" })]))).toMatchObject({
			outcome: "used",
			count: 2,
			names: ["aaa", "bbb"],
		});
		expect(skillsLookup({ status: "error", skills: [], chars: 0, ms: 1, reason: "nope" })).toMatchObject({
			outcome: "error",
			count: 0,
			names: [],
			reason: "nope",
		});
	});
});
