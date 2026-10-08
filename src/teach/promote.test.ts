// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUESTIONS } from "../decisions/questions.ts";
import { DEFAULT_DECISIONS_CONFIG, type DecisionsConfig } from "../decisions/types.ts";
import { DEFAULT_HINDSIGHT_CONFIG } from "../hindsight/types.ts";
import { documentIdFor, tagsFor } from "./mapping.ts";
import {
	filterSkillworthy,
	installSkill,
	markerIds,
	markPromoted,
	promoteDue,
	promotionCandidates,
	renderSkillDraft,
	targetForHost,
} from "./promote.ts";
import { openStore, storeDir } from "./store.ts";
import { DEFAULT_TEACH_CONFIG, MOMENT_KINDS } from "./types.ts";
import type { MomentKind, SkillDraft, TeachableMoment, TeachConfig, TeachContext } from "./types.ts";

const roots: string[] = [];
const NOW = Date.parse("2026-10-01T00:00:00.000Z");

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
	root: string;
	home: string;
	stateDir: string;
	piDir: string;
	claudeDir: string;
	ctx: (over?: { host?: string; teach?: Partial<TeachConfig>; env?: NodeJS.ProcessEnv }) => TeachContext;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "ultrathink-promote-"));
	roots.push(root);
	const home = join(root, "home");
	const stateDir = join(root, "state");
	const piDir = join(root, "pi");
	const claudeDir = join(root, "claude");
	return {
		root,
		home,
		stateDir,
		piDir,
		claudeDir,
		ctx: (over = {}) => ({
			host: over.host ?? "omp",
			cwd: join(root, "repo"),
			config: { teach: { ...DEFAULT_TEACH_CONFIG, enabled: true, ...over.teach }, hindsight: DEFAULT_HINDSIGHT_CONFIG },
			env: over.env ?? { HOME: home, PI_CODING_AGENT_DIR: piDir, CLAUDE_CONFIG_DIR: claudeDir },
			stateDir,
			now: () => NOW,
		}),
	};
}

let seq = 0;
function moment(over: Partial<TeachableMoment> = {}): TeachableMoment {
	seq += 1;
	return {
		id: `abc${seq.toString().padStart(4, "0")}`,
		name: `lesson number ${seq}`,
		description: "Something went wrong the first time.",
		body: "Check the config before running the command.",
		sourcePhase: "",
		sourceArtifacts: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		tags: [],
		relatedIds: [],
		schema: 2,
		kind: "pitfall",
		status: "confirmed",
		origin: "explicit",
		project: "demo",
		host: "claude-code",
		confidence: 1,
		occurrences: 1,
		lastSeenAt: "2026-01-02T00:00:00.000Z",
		dedupeKey: `key${seq}`,
		recalled: 0,
		...over,
	};
}

/** Mirrors the rules Hermes enforces on a new skill (scout C section 3). */
function validateLikeHermes(content: string): { name: string; description: string; body: string } {
	expect(content.startsWith("---")).toBe(true);
	const end = content.indexOf("\n---\n", 3);
	expect(end).toBeGreaterThan(0);
	const fields: Record<string, string> = {};
	for (const line of content.slice(4, end).split("\n")) {
		const split = line.indexOf(": ");
		expect(split).toBeGreaterThan(0);
		const raw = line.slice(split + 2);
		fields[line.slice(0, split)] = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
	}
	expect(Object.keys(fields).sort()).toEqual(["description", "name"]);
	const { name = "", description = "" } = fields;
	expect(name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
	expect(name.length).toBeLessThanOrEqual(64);
	expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
	expect(description.length).toBeGreaterThan(0);
	expect(description.length).toBeLessThanOrEqual(60);
	expect(description.endsWith(".")).toBe(true);
	expect(description).not.toMatch(/[:`<>\n]/);
	expect(description).not.toMatch(/[.!?]\s/);
	const body = content.slice(end + 5);
	expect(body.trim().length).toBeGreaterThan(0);
	expect(content.length).toBeLessThanOrEqual(100_000);
	expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(64_000);
	return { name, description, body };
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

describe("targetForHost", () => {
	test("maps each host to the place its skills belong", () => {
		expect(targetForHost("omp")).toBe("omp");
		expect(targetForHost("claude-code")).toBe("claude");
		expect(targetForHost("grok-build")).toBe("claude");
		expect(targetForHost("hermes")).toBe("hermes");
		expect(targetForHost("prime-agent")).toBe("prime-agent");
		expect(targetForHost("muse")).toBe("drafts");
		expect(targetForHost("something-else")).toBe("drafts");
	});
});

describe("renderSkillDraft names and descriptions", () => {
	const { ctx } = fixture();

	test("a typical lesson becomes a short trigger-first skill", () => {
		const draft = renderSkillDraft([moment({ name: "tsc rejects value imports of types: use import type" })], ctx());
		expect(draft.name).toBe("lesson-tsc-rejects-value-imports-of-types-use");
		expect(draft.description).toBe("Use when tsc rejects value imports of types, use import.");
		expect(draft.content.startsWith(`---\nname: ${draft.name}\ndescription: ${draft.description}\n---\n`)).toBe(true);
		validateLikeHermes(draft.content);
	});

	const names = [
		"word ".repeat(80),
		"supercalifragilisticexpialidocious".repeat(8),
		"!!! Wow: `code` <b>x</b>. Next sentence; done",
		"Colons: everywhere: in: the: name:",
		"Überprüfung naïve café",
		"日本語のレッスン",
		"  spaced \t out \n name  ",
		"e.g. a lesson. With sentences! And questions? Yes",
		"~~strike~~ and `tick`",
	];
	for (const name of names) {
		test(`produces a valid skill for ${JSON.stringify(name.slice(0, 30))}`, () => {
			const draft = renderSkillDraft([moment({ name })], ctx());
			const parsed = validateLikeHermes(draft.content);
			expect(parsed.name).toBe(draft.name);
			expect(parsed.description).toBe(draft.description);
			expect(draft.name.length).toBeLessThanOrEqual(48);
			expect(draft.name.endsWith("-")).toBe(false);
		});
	}

	test("long names are cut at a word boundary", () => {
		const draft = renderSkillDraft([moment({ name: "word ".repeat(80) })], ctx());
		expect(draft.name).toBe(`lesson-${"word-".repeat(8)}`.replace(/-$/, ""));
		expect(draft.description).toBe(`Use when ${"word ".repeat(10).trim()}.`);
	});

	test("unicode letters are folded for the name and kept in the description", () => {
		const draft = renderSkillDraft([moment({ name: "Überprüfung naïve café" })], ctx());
		expect(draft.name).toBe("lesson-uberprufung-naive-cafe");
		expect(draft.description).toBe("Use when überprüfung naïve café.");
	});

	test("a name without latin letters falls back to the moment id for the skill name", () => {
		const draft = renderSkillDraft([moment({ id: "Tm-Z9", name: "日本語のレッスン" })], ctx());
		expect(draft.name).toBe("lesson-tm-z9");
		expect(draft.description).toBe("Use when 日本語のレッスン.");
	});

	test("a name with nothing usable falls back to the description for the trigger", () => {
		const draft = renderSkillDraft([moment({ name: "!!!", description: "Quoting breaks in zsh" })], ctx());
		expect(draft.description).toBe("Use when quoting breaks in zsh.");
	});

	test("colons never reach the description; a hash gets the description quoted", () => {
		const colon = renderSkillDraft([moment({ name: "Bug: a: b" })], ctx());
		expect(colon.description).toBe("Use when bug, a, b.");
		expect(colon.content).toContain(`description: ${colon.description}\n`);

		const hash = renderSkillDraft([moment({ name: "C# generics fail" })], ctx());
		expect(hash.description).toBe("Use when c# generics fail.");
		expect(hash.content).toContain(`description: ${JSON.stringify(hash.description)}\n`);
		validateLikeHermes(hash.content);
	});

	test("throws a one-line error when no valid draft can be made", () => {
		const attempts: Array<() => unknown> = [
			() => renderSkillDraft([], ctx()),
			() => renderSkillDraft([moment({ body: "   " })], ctx()),
			() => renderSkillDraft([moment({ id: "!!!", name: "???", description: "..." })], ctx()),
			() => renderSkillDraft([moment({ body: "lorem ipsum ".repeat(6_000) })], ctx()),
		];
		for (const attempt of attempts) {
			let message = "";
			try {
				attempt();
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message).not.toBe("");
			expect(message).not.toContain("\n");
		}
	});
});

describe("renderSkillDraft body", () => {
	const { ctx } = fixture();
	const sections: Record<MomentKind, string> = {
		bug: "## Pitfall",
		pitfall: "## Pitfall",
		pattern: "## Pattern",
		decision: "## Decision",
		playbook: "## Procedure",
	};

	for (const kind of MOMENT_KINDS) {
		test(`a ${kind} lesson gets the ${sections[kind]} section with its body`, () => {
			const draft = renderSkillDraft([moment({ kind, name: `A ${kind} lesson`, body: `Body of the ${kind}.` })], ctx());
			const headings = draft.body.split("\n").filter((l) => l.startsWith("## "));
			expect(headings).toEqual(["## When to use", sections[kind], "## Evidence"]);
			expect(draft.body).toContain(`${sections[kind]}\n\nBody of the ${kind}.`);
			expect(draft.body.startsWith(`# A ${kind} lesson\n\n## When to use\n\nSomething went wrong the first time.`)).toBe(
				true,
			);
			expect(draft.body).not.toContain("---\nname:");
		});
	}

	test("the evidence lists occurrences, project, dates, sources and ids, and the file is marked", () => {
		const m = moment({
			occurrences: 4,
			project: "demo",
			createdAt: "2026-02-03T00:00:00.000Z",
			lastSeenAt: "2026-03-04T00:00:00.000Z",
			sourcePhase: "phase-7",
			sourceArtifacts: ["src/a.ts", "docs/b.md"],
		});
		const draft = renderSkillDraft([m], ctx());
		for (const line of [
			"- Occurrences: 4",
			"- Project: demo",
			"- First seen: 2026-02-03T00:00:00.000Z",
			"- Last seen: 2026-03-04T00:00:00.000Z",
			"- Source phase: phase-7",
			"- Source artifacts: src/a.ts, docs/b.md",
			`- Moments: ${m.id}`,
		]) {
			expect(draft.body).toContain(line);
		}
		expect(draft.body.endsWith(`<!-- ultrathink:teach ids=${m.id} -->`)).toBe(true);
		expect(draft.sourceIds).toEqual([m.id]);
		expect(draft.warnings).toEqual([]);
	});

	test("merged lessons use the most repeated one as primary and keep each body", () => {
		const a = moment({ name: "Minor lesson", body: "Minor body.", occurrences: 2, kind: "pitfall" });
		const b = moment({ name: "Major lesson", body: "Major body.", occurrences: 5, kind: "pattern" });
		const draft = renderSkillDraft([a, b], ctx());
		expect(draft.name).toBe("lesson-major-lesson");
		expect(draft.body.startsWith("# Major lesson")).toBe(true);
		expect(draft.body).toContain("## Pattern\n\n### Major lesson\n\nMajor body.");
		expect(draft.body).toContain("## Pitfall\n\n### Minor lesson\n\nMinor body.");
		expect(draft.body).toContain("- Occurrences: 7");
		expect(draft.body).toContain(`<!-- ultrathink:teach ids=${b.id},${a.id} -->`);
		expect(draft.sourceIds).toEqual([b.id, a.id]);
		validateLikeHermes(draft.content);
	});

	test("secrets are redacted from the skill and a warning says so", () => {
		const secret = "abcdefghijklmnopqrstuvwxyz0123456789";
		const draft = renderSkillDraft(
			[moment({ body: `The call failed with header Authorization: Bearer ${secret} in the log.` })],
			ctx(),
		);
		expect(draft.content).not.toContain(secret);
		expect(draft.body).toContain("## Pitfall");
		expect(draft.warnings).toHaveLength(1);
		expect(draft.warnings[0]).toContain("redacted");
	});
});

describe("installSkill", () => {
	function draftOf(f: Fixture, name = "Install me"): SkillDraft {
		return renderSkillDraft([moment({ name })], f.ctx());
	}

	test("drafts land under the state directory with private modes and no leftovers", () => {
		const f = fixture();
		const draft = draftOf(f);
		const outcome = installSkill(draft, "drafts", f.ctx());
		const dir = join(f.stateDir, "teach", "skill-drafts", draft.name);
		expect(outcome).toEqual({ target: "drafts", path: join(dir, "SKILL.md"), action: "drafted" });
		expect(readFileSync(outcome.path, "utf8")).toBe(draft.content);
		expect(mode(outcome.path)).toBe(0o600);
		expect(mode(dir)).toBe(0o700);
		expect(mode(join(f.stateDir, "teach", "skill-drafts"))).toBe(0o700);
		expect(readdirSync(dir)).toEqual(["SKILL.md"]);

		const again = installSkill({ ...draft, content: `${draft.content}\nmore\n` }, "drafts", f.ctx());
		expect(again.action).toBe("drafted");
		expect(readFileSync(again.path, "utf8")).toBe(`${draft.content}\nmore\n`);
		expect(readdirSync(dir)).toEqual(["SKILL.md"]);
		expect(existsSync(f.piDir)).toBe(false);
		expect(existsSync(f.claudeDir)).toBe(false);
	});

	test("hermes only gets a draft and the reason names skill_manage", () => {
		const f = fixture();
		const draft = draftOf(f);
		const outcome = installSkill(draft, "hermes", f.ctx({ host: "hermes" }));
		expect(outcome.action).toBe("drafted");
		expect(outcome.target).toBe("hermes");
		expect(outcome.path).toBe(join(f.stateDir, "teach", "skill-drafts", draft.name, "SKILL.md"));
		expect(outcome.reason).toContain("skill_manage");
		expect(outcome.reason).toContain("skills.write_approval");
		expect(existsSync(join(f.home, ".hermes"))).toBe(false);
	});

	test("omp: creates under managed-skills, then updates its own file", () => {
		const f = fixture();
		const draft = draftOf(f);
		const created = installSkill(draft, "omp", f.ctx());
		const dir = join(f.piDir, "managed-skills", draft.name);
		expect(created).toEqual({ target: "omp", path: join(dir, "SKILL.md"), action: "created" });
		expect(readFileSync(created.path, "utf8")).toBe(draft.content);

		const next = { ...draft, content: draft.content.replace("Check the config", "Check the settings") };
		const updated = installSkill(next, "omp", f.ctx());
		expect(updated.action).toBe("updated");
		expect(updated.path).toBe(created.path);
		expect(readFileSync(created.path, "utf8")).toBe(next.content);
		expect(readdirSync(dir)).toEqual(["SKILL.md"]);
	});

	test("omp defaults to ~/.omp/agent and claude defaults to ~/.claude", () => {
		const f = fixture();
		const env = { HOME: f.home };
		const draft = draftOf(f);
		const omp = installSkill(draft, "omp", f.ctx({ env }));
		expect(omp.path).toBe(join(f.home, ".omp", "agent", "managed-skills", draft.name, "SKILL.md"));
		expect(omp.action).toBe("created");
		const claude = installSkill(draft, "claude", f.ctx({ env, host: "claude-code" }));
		expect(claude.path).toBe(join(f.home, ".claude", "skills", draft.name, "SKILL.md"));
		expect(claude.action).toBe("created");
	});

	test("prime-agent: installs under PRIME_AGENT_CODING_AGENT_DIR/skills, else ~/.prime/agent/skills", () => {
		const f = fixture();
		const draft = draftOf(f);
		const scoped = installSkill(draft, "prime-agent", f.ctx({ env: { HOME: f.home, PRIME_AGENT_CODING_AGENT_DIR: join(f.home, "prime") }, host: "prime-agent" }));
		expect(scoped).toEqual({ target: "prime-agent", path: join(f.home, "prime", "skills", draft.name, "SKILL.md"), action: "created" });
		expect(readFileSync(scoped.path, "utf8")).toBe(draft.content);
		const home = installSkill(draft, "prime-agent", f.ctx({ env: { HOME: f.home }, host: "prime-agent" }));
		expect(home.path).toBe(join(f.home, ".prime", "agent", "skills", draft.name, "SKILL.md"));
		expect(home.action).toBe("created");
		expect(installSkill(draft, "prime-agent", f.ctx({ env: { HOME: f.home }, host: "prime-agent" })).action).toBe("updated");
	});

	test("claude: honors CLAUDE_CONFIG_DIR and updates only its own file", () => {
		const f = fixture();
		const draft = draftOf(f);
		const created = installSkill(draft, "claude", f.ctx({ host: "claude-code" }));
		expect(created.path).toBe(join(f.claudeDir, "skills", draft.name, "SKILL.md"));
		expect(created.action).toBe("created");
		expect(installSkill(draft, "claude", f.ctx({ host: "claude-code" })).action).toBe("updated");
		expect(readdirSync(join(f.claudeDir, "skills", draft.name))).toEqual(["SKILL.md"]);
	});

	for (const target of ["omp", "claude"] as const) {
		const root = (f: Fixture) => join(target === "omp" ? join(f.piDir, "managed-skills") : join(f.claudeDir, "skills"));

		test(`${target}: a skill somebody else wrote is never overwritten`, () => {
			const f = fixture();
			const draft = draftOf(f);
			const dir = join(root(f), draft.name);
			mkdirSync(dir, { recursive: true });
			const authored = `---\nname: ${draft.name}\ndescription: Mine.\n---\nHand written.\n`;
			writeFileSync(join(dir, "SKILL.md"), authored);
			const outcome = installSkill(draft, target, f.ctx());
			expect(outcome.action).toBe("refused");
			expect(outcome.path).toBe(join(dir, "SKILL.md"));
			expect(outcome.reason).toContain("not written by ultrathink");
			expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe(authored);
			expect(readdirSync(dir)).toEqual(["SKILL.md"]);
		});

		test(`${target}: a symlinked skill directory is refused and its target untouched`, () => {
			const f = fixture();
			const draft = draftOf(f);
			const elsewhere = join(f.root, "elsewhere");
			mkdirSync(elsewhere, { recursive: true });
			mkdirSync(root(f), { recursive: true });
			symlinkSync(elsewhere, join(root(f), draft.name));
			const outcome = installSkill(draft, target, f.ctx());
			expect(outcome.action).toBe("refused");
			expect(outcome.reason).toContain("symlink");
			expect(readdirSync(elsewhere)).toEqual([]);
		});

		test(`${target}: a symlinked SKILL.md is refused even when its target carries the marker`, () => {
			const f = fixture();
			const draft = draftOf(f);
			const dir = join(root(f), draft.name);
			mkdirSync(dir, { recursive: true });
			const outside = join(f.root, "outside.md");
			writeFileSync(outside, "<!-- ultrathink:teach ids=x -->\n");
			symlinkSync(outside, join(dir, "SKILL.md"));
			const outcome = installSkill(draft, target, f.ctx());
			expect(outcome.action).toBe("refused");
			expect(outcome.reason).toContain("symlink");
			expect(readFileSync(outside, "utf8")).toBe("<!-- ultrathink:teach ids=x -->\n");
			expect(readdirSync(dir)).toEqual(["SKILL.md"]);
		});

		test(`${target}: a symlinked skills root is followed (dotfile setups) but the skill itself must be real`, () => {
			const f = fixture();
			const draft = draftOf(f);
			const real = join(f.root, "dotfiles-skills");
			mkdirSync(real, { recursive: true });
			mkdirSync(join(root(f), ".."), { recursive: true });
			symlinkSync(real, root(f));
			const outcome = installSkill(draft, target, f.ctx());
			expect(outcome.action).toBe("created");
			expect(readFileSync(join(real, draft.name, "SKILL.md"), "utf8")).toBe(draft.content);
		});
	}

	test("a marked skill made from other lessons is refused and left untouched", () => {
		const f = fixture();
		const mine = renderSkillDraft([moment({ name: "Shared name" })], f.ctx());
		const theirs = renderSkillDraft([moment({ name: "Shared name" })], f.ctx());
		expect(theirs.name).toBe(mine.name);
		const path = join(f.claudeDir, "skills", mine.name, "SKILL.md");
		expect(installSkill(theirs, "claude", f.ctx())).toEqual({ target: "claude", path, action: "created" });

		expect(installSkill(mine, "claude", f.ctx())).toEqual({
			target: "claude",
			path,
			action: "refused",
			reason: "name taken by a skill made from other lessons",
		});
		expect(readFileSync(path, "utf8")).toBe(theirs.content);
		expect(readdirSync(join(f.claudeDir, "skills"))).toEqual([mine.name]);
	});

	test("re-promoting the same lessons, or a merge that includes them, updates in place; other lessons are refused", () => {
		const f = fixture();
		const a = moment({ name: "Merge target", occurrences: 5 });
		const b = moment({ name: "Merge target", occurrences: 1 });
		const c = moment({ name: "Merge target", occurrences: 1 });
		const path = join(f.piDir, "managed-skills", "lesson-merge-target", "SKILL.md");
		const alone = renderSkillDraft([a], f.ctx());
		expect(alone.name).toBe("lesson-merge-target");
		expect(installSkill(alone, "omp", f.ctx())).toEqual({ target: "omp", path, action: "created" });
		expect(installSkill(alone, "omp", f.ctx())).toEqual({ target: "omp", path, action: "updated" });

		// [a, b] over an installed [a].
		const merged = renderSkillDraft([a, b], f.ctx());
		expect(merged.name).toBe(alone.name);
		expect(installSkill(merged, "omp", f.ctx())).toEqual({ target: "omp", path, action: "updated" });
		expect(readFileSync(path, "utf8")).toBe(merged.content);

		// An installed [a, b] blocks a lone [c] (and a lone [b]: it did not make the merge on its own).
		for (const lone of [c, b]) {
			const outcome = installSkill(renderSkillDraft([lone], f.ctx()), "omp", f.ctx());
			expect(outcome).toMatchObject({ action: "refused", path, reason: "name taken by a skill made from other lessons" });
		}
		expect(readFileSync(path, "utf8")).toBe(merged.content);
		expect(readdirSync(join(f.piDir, "managed-skills"))).toEqual([alone.name]);
	});

	test("a marker quoted in a lesson body is not the skill's marker: the skill re-installs in place", () => {
		const f = fixture();
		const m = moment({ name: "Marker example", body: "Skills end with a marker like this one:\n\n<!-- ultrathink:teach ids=x -->\n\nKeep it last." });
		const draft = renderSkillDraft([m], f.ctx());
		expect(draft.content.indexOf("<!-- ultrathink:teach ids=x -->")).toBeLessThan(draft.content.indexOf(`ids=${m.id} -->`));
		expect(markerIds(draft.content)).toEqual([m.id]);

		const path = join(f.claudeDir, "skills", draft.name, "SKILL.md");
		expect(installSkill(draft, "claude", f.ctx())).toEqual({ target: "claude", path, action: "created" });
		expect(installSkill(draft, "claude", f.ctx())).toEqual({ target: "claude", path, action: "updated" });
		expect(readFileSync(path, "utf8")).toBe(draft.content);
		expect(readdirSync(join(f.claudeDir, "skills"))).toEqual([draft.name]);
	});

	test("a marker without ids counts as theirs", () => {
		const f = fixture();
		const draft = draftOf(f, "Legacy lesson");
		const dir = join(f.claudeDir, "skills", draft.name);
		const legacy = "---\nname: x\ndescription: Old.\n---\nOld.\n\n<!-- ultrathink:teach -->\n";
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), legacy);
		expect(markerIds(legacy)).toEqual([]);
		const outcome = installSkill(draft, "claude", f.ctx());
		expect(outcome).toMatchObject({ action: "refused", reason: "name taken by a skill made from other lessons" });
		expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe(legacy);
		expect(readdirSync(join(f.claudeDir, "skills"))).toEqual([draft.name]);
	});

	test("a draft that is not a valid skill is refused without writing", () => {
		const f = fixture();
		const draft = draftOf(f);
		for (const bad of [{ ...draft, name: "../evil" }, { ...draft, name: "Upper" }, { ...draft, content: "  " }]) {
			const outcome = installSkill(bad, "omp", f.ctx());
			expect(outcome.action).toBe("refused");
			expect(outcome.path).toBe("");
		}
		const huge = installSkill({ ...draft, content: "x".repeat(60_001) }, "claude", f.ctx());
		expect(huge.action).toBe("refused");
		expect(existsSync(f.piDir)).toBe(false);
		expect(existsSync(f.claudeDir)).toBe(false);
	});
});

describe("markPromoted", () => {
	test("marks existing moments, skips unknown ids and queues a tags op only for retained ones", () => {
		const f = fixture();
		const ctx = f.ctx();
		const store = openStore(storeDir(f.stateDir));
		const local = moment();
		const retained = moment({ retained: { at: "2026-01-05T00:00:00.000Z", bank: "ultrathink", documentId: "tm:x" } });
		store.put(local);
		store.put(retained);

		const updated = markPromoted(
			[local.id, "nope", retained.id],
			{ skill: "lesson-demo", target: "omp", path: "/skills/lesson-demo/SKILL.md" },
			ctx,
		);
		expect(updated.map((m) => m.id)).toEqual([local.id, retained.id]);
		for (const id of [local.id, retained.id]) {
			const stored = store.get(id);
			expect(stored?.status).toBe("promoted");
			expect(stored?.promoted).toEqual({
				at: "2026-10-01T00:00:00.000Z",
				skill: "lesson-demo",
				target: "omp",
				path: "/skills/lesson-demo/SKILL.md",
			});
		}

		const outbox = store.outbox();
		expect(outbox).toHaveLength(1);
		expect(outbox[0]?.op).toEqual({
			op: "tags",
			documentId: documentIdFor(retained.id),
			tags: tagsFor(store.get(retained.id) as TeachableMoment),
		});
	});

	test("the path is optional", () => {
		const f = fixture();
		const store = openStore(storeDir(f.stateDir));
		const m = moment();
		store.put(m);
		markPromoted([m.id], { skill: "lesson-x", target: "hermes" }, f.ctx());
		expect(store.get(m.id)?.promoted).toEqual({ at: "2026-10-01T00:00:00.000Z", skill: "lesson-x", target: "hermes" });
	});
});

describe("promotionCandidates", () => {
	test("keeps confirmed, unpromoted lessons that repeated enough or are playbooks, newest first", () => {
		const f = fixture();
		const store = openStore(storeDir(f.stateDir));
		const promoted = { at: "2026-02-01T00:00:00.000Z", skill: "lesson-x", target: "omp" as const };
		const oldest = moment({ occurrences: 5, createdAt: "2026-01-01T00:00:00.000Z" });
		const middle = moment({ occurrences: 3, createdAt: "2026-01-02T00:00:00.000Z" });
		const newest = moment({ kind: "playbook", occurrences: 1, createdAt: "2026-01-03T00:00:00.000Z" });
		for (const m of [
			oldest,
			middle,
			newest,
			moment({ occurrences: 2, createdAt: "2026-01-04T00:00:00.000Z" }),
			moment({ occurrences: 9, status: "candidate" }),
			moment({ occurrences: 9, status: "promoted", promoted }),
			moment({ occurrences: 9, promoted }),
			moment({ occurrences: 9, status: "superseded" }),
			moment({ kind: "playbook", status: "candidate" }),
		]) {
			store.put(m);
		}
		expect(promotionCandidates(f.ctx()).map((m) => m.id)).toEqual([newest.id, middle.id, oldest.id]);
		expect(promotionCandidates(f.ctx({ teach: { promoteAfter: 5 } })).map((m) => m.id)).toEqual([newest.id, oldest.id]);
	});

	test("an empty store has no candidates", () => {
		expect(promotionCandidates(fixture().ctx())).toEqual([]);
	});
});

describe("promoteDue", () => {
	function seed(f: Fixture, ...over: Array<Partial<TeachableMoment>>): TeachableMoment[] {
		const store = openStore(storeDir(f.stateDir));
		return over.map((o) => {
			const m = moment({ occurrences: 3, ...o });
			store.put(m);
			return m;
		});
	}

	test("does nothing unless autoPromote is on", async () => {
		const f = fixture();
		seed(f, {});
		const result = await promoteDue(f.ctx({ teach: { autoPromote: false } }));
		expect(result).toEqual({ drafted: [], installed: [] });
		expect(existsSync(join(f.stateDir, "teach", "skill-drafts"))).toBe(false);
		expect(existsSync(f.piDir)).toBe(false);
	});

	test("does nothing while Teachable Moments is off or killed", async () => {
		const f = fixture();
		seed(f, {});
		expect(await promoteDue(f.ctx({ teach: { autoPromote: true, enabled: false } }))).toEqual({ drafted: [], installed: [] });
		const killed = f.ctx({
			teach: { autoPromote: true },
			env: { HOME: f.home, PI_CODING_AGENT_DIR: f.piDir, ULTRATHINK_TEACH: "0" },
		});
		expect(await promoteDue(killed)).toEqual({ drafted: [], installed: [] });
		expect(existsSync(f.piDir)).toBe(false);
	});

	test("omp: drafts, installs and marks each due lesson", async () => {
		const f = fixture();
		const [a, b] = seed(f, { name: "First lesson" }, { name: "Second lesson" });
		const result = await promoteDue(f.ctx({ teach: { autoPromote: true } }));
		expect(result.drafted.map((o) => o.action)).toEqual(["drafted", "drafted"]);
		expect(result.installed.map((o) => o.action)).toEqual(["created", "created"]);
		const store = openStore(storeDir(f.stateDir));
		for (const [m, skill] of [
			[a, "lesson-first-lesson"],
			[b, "lesson-second-lesson"],
		] as const) {
			const stored = store.get(m?.id ?? "");
			expect(stored?.status).toBe("promoted");
			expect(stored?.promoted?.skill).toBe(skill);
			expect(stored?.promoted?.target).toBe("omp");
			expect(stored?.promoted?.path).toBe(join(f.piDir, "managed-skills", skill, "SKILL.md"));
			expect(existsSync(stored?.promoted?.path ?? "")).toBe(true);
			expect(existsSync(join(f.stateDir, "teach", "skill-drafts", skill, "SKILL.md"))).toBe(true);
		}
		expect(promotionCandidates(f.ctx())).toEqual([]);
	});

	test("claude-code installs into the Claude skills directory", async () => {
		const f = fixture();
		seed(f, { name: "Claude lesson" });
		const result = await promoteDue(f.ctx({ host: "claude-code", teach: { autoPromote: true } }));
		expect(result.installed).toHaveLength(1);
		expect(result.installed[0]?.path).toBe(join(f.claudeDir, "skills", "lesson-claude-lesson", "SKILL.md"));
		expect(existsSync(join(f.piDir, "managed-skills"))).toBe(false);
	});

	for (const host of ["hermes", "muse", "unknown-host"]) {
		test(`${host} only drafts and leaves the lessons unpromoted`, async () => {
			const f = fixture();
			const [m] = seed(f, { name: "Drafted lesson" });
			const result = await promoteDue(f.ctx({ host, teach: { autoPromote: true } }));
			expect(result.drafted.map((o) => o.action)).toEqual(["drafted"]);
			expect(result.installed).toEqual([]);
			expect(openStore(storeDir(f.stateDir)).get(m?.id ?? "")?.status).toBe("confirmed");
			expect(existsSync(f.piDir)).toBe(false);
			expect(existsSync(f.claudeDir)).toBe(false);
			expect(existsSync(join(f.home, ".hermes"))).toBe(false);
		});
	}

	test("lessons with the same name get distinct skills", async () => {
		const f = fixture();
		const [a, b] = seed(f, { name: "Same name" }, { name: "Same name" });
		const result = await promoteDue(f.ctx({ teach: { autoPromote: true } }));
		expect(result.installed.map((o) => o.action)).toEqual(["created", "created"]);
		const store = openStore(storeDir(f.stateDir));
		const skills = [a, b].map((m) => store.get(m?.id ?? "")?.promoted?.skill);
		expect(new Set(skills).size).toBe(2);
		for (const skill of skills) {
			const content = readFileSync(join(f.piDir, "managed-skills", skill ?? "", "SKILL.md"), "utf8");
			expect(validateLikeHermes(content).name).toBe(skill as string);
		}
	});

	test("a refused install leaves the lesson unpromoted and the others still go through", async () => {
		const f = fixture();
		const [blocked, fine] = seed(f, { name: "Blocked lesson" }, { name: "Fine lesson" });
		const dir = join(f.piDir, "managed-skills", "lesson-blocked-lesson");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "---\nname: lesson-blocked-lesson\ndescription: Mine.\n---\nAuthored.\n");
		const result = await promoteDue(f.ctx({ teach: { autoPromote: true } }));
		expect(result.installed.map((o) => o.action).sort()).toEqual(["created", "refused"]);
		const store = openStore(storeDir(f.stateDir));
		expect(store.get(blocked?.id ?? "")?.status).toBe("confirmed");
		expect(store.get(fine?.id ?? "")?.status).toBe("promoted");
	});

	test("claude-code and grok-build share ~/.claude/skills: a same-named lesson from the other store is refused and keeps its draft", async () => {
		const f = fixture();
		const claude = f.ctx({ host: "claude-code", teach: { autoPromote: true } });
		const grok: TeachContext = { ...f.ctx({ host: "grok-build", teach: { autoPromote: true } }), stateDir: join(f.root, "grok-state") };
		const fromClaude = moment({ name: "Shared lesson", occurrences: 3, body: "Claude's advice." });
		const fromGrok = moment({ name: "Shared lesson", occurrences: 3, body: "Grok's advice." });
		openStore(storeDir(claude.stateDir)).put(fromClaude);
		openStore(storeDir(grok.stateDir)).put(fromGrok);
		const path = join(f.claudeDir, "skills", "lesson-shared-lesson", "SKILL.md");

		const first = await promoteDue(claude);
		expect(first.installed).toEqual([{ target: "claude", path, action: "created" }]);
		const installed = readFileSync(path, "utf8");
		const record = openStore(storeDir(claude.stateDir)).get(fromClaude.id)?.promoted;

		const second = await promoteDue(grok);
		expect(second.installed).toEqual([
			{ target: "claude", path, action: "refused", reason: "name taken by a skill made from other lessons" },
		]);

		// Claude Code's skill and record are untouched.
		expect(readFileSync(path, "utf8")).toBe(installed);
		expect(markerIds(installed)).toEqual([fromClaude.id]);
		expect(installed).toContain("Claude's advice.");
		expect(openStore(storeDir(claude.stateDir)).get(fromClaude.id)?.promoted).toEqual(record);
		expect(readdirSync(join(f.claudeDir, "skills"))).toEqual(["lesson-shared-lesson"]);

		// Grok Build's lesson stays confirmed with its draft.
		expect(openStore(storeDir(grok.stateDir)).get(fromGrok.id)?.status).toBe("confirmed");
		const draftPath = join(grok.stateDir, "teach", "skill-drafts", "lesson-shared-lesson", "SKILL.md");
		expect(second.drafted).toEqual([{ target: "drafts", path: draftPath, action: "drafted" }]);
		const draft = readFileSync(draftPath, "utf8");
		expect(markerIds(draft)).toEqual([fromGrok.id]);
		expect(draft).toContain("Grok's advice.");
	});
});

/** A test key and a token-shaped secret. Neither is a real credential. */
const JEV_KEY = "sk-or-v1-UTTESTKEY-0123456789abcdef";
const LESSON_SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";

interface JevCall {
	state: Record<string, unknown>;
	questions: Record<string, unknown>;
}

/**
 * Decisions on, key from env, credential file absent so the operator store is never read.
 * `decisions: false` omits the section. A custom `fetch` replaces the recording one.
 */
function withSkillworthy(
	f: Fixture,
	answers: Array<number | Response | Error>,
	over: { decisions?: Partial<DecisionsConfig> | false; env?: NodeJS.ProcessEnv; teach?: Partial<TeachConfig>; fetch?: typeof fetch } = {},
): { ctx: TeachContext; calls: JevCall[] } {
	const calls: JevCall[] = [];
	const base = f.ctx({
		teach: over.teach,
		env: {
			HOME: f.home,
			PI_CODING_AGENT_DIR: f.piDir,
			CLAUDE_CONFIG_DIR: f.claudeDir,
			OPENROUTER_API_KEY: JEV_KEY,
			...over.env,
		},
	});
	const decisions =
		over.decisions === false
			? undefined
			: { ...DEFAULT_DECISIONS_CONFIG, enabled: true, points: ["skillworthy" as const], ...over.decisions };
	const ctx: TeachContext = {
		...base,
		storePath: join(f.root, "credentials.json"),
		config: decisions ? { ...base.config, decisions: { ...decisions, points: [...decisions.points] } } : base.config,
		fetch:
			over.fetch ??
			((async (_url: string | URL | Request, init?: RequestInit) => {
				calls.push(JSON.parse(String(init?.body)) as JevCall);
				const next = answers[Math.min(calls.length, Math.max(answers.length, 1)) - 1];
				if (next instanceof Error) throw next;
				if (next instanceof Response) return next.clone();
				return Response.json({
					model: "typesafe/jev-1.13-20260917",
					answers: { skillworthy: { type: "noul", noul: next } },
					usage: { input_tokens: 10, output_tokens: 0 },
				});
			}) as typeof fetch),
	};
	return { ctx, calls };
}

describe("filterSkillworthy", () => {
	test("drops only an ok verdict below skillworthyAt; equal stays, and the request is clipped, redacted and skillworthy", async () => {
		const f = fixture();
		const at = 0.62;
		const below = moment({
			name: `name ${LESSON_SECRET}`,
			description: "a plain description",
			body: `token ${LESSON_SECRET} ${"x".repeat(1000)}`,
			occurrences: 4,
		});
		const equal = moment({ name: "equal lesson", body: "equal body" });
		const above = moment({ name: "above lesson", body: "above body" });
		const { ctx, calls } = withSkillworthy(f, [0.61, at, 0.9], { decisions: { skillworthyAt: at } });
		const kept = await filterSkillworthy([below, equal, above], ctx);
		expect(kept.map((item) => item.id)).toEqual([equal.id, above.id]);
		expect(calls).toHaveLength(3);
		expect(calls[0]?.questions).toEqual({ skillworthy: QUESTIONS.skillworthy });
		expect(calls[1]?.questions).toEqual({ skillworthy: QUESTIONS.skillworthy });
		const state = calls[0]?.state as { name: string; description: string; body: string; kind: string; occurrences: number };
		expect(state).toMatchObject({ description: "a plain description", kind: "pitfall", occurrences: 4 });
		expect(state.name).toBe("name [redacted]");
		expect(state.body.length).toBe(800);
		expect(state.body.startsWith("token [redacted]")).toBe(true);
		expect(JSON.stringify(calls)).not.toContain(LESSON_SECRET);
		expect(JSON.stringify(calls)).not.toContain(JEV_KEY);
	});

	test("with nothing to judge no request fires, even with Decisions on", async () => {
		const f = fixture();
		const { ctx, calls } = withSkillworthy(f, [0.01], { teach: { autoPromote: true } });
		expect(await filterSkillworthy([], ctx)).toEqual([]);
		expect(calls).toHaveLength(0);
		const idle = await promoteDue(ctx);
		expect(idle).toEqual({ drafted: [], installed: [] });
		expect(calls).toHaveLength(0);
	});

	test("no decisions section, a point list without skillworthy, or the kill switch keeps every moment and asks nothing", async () => {
		const lessons = [moment({ name: "one" }), moment({ name: "two" })];
		const cases: Array<{ decisions?: Partial<DecisionsConfig> | false; env?: NodeJS.ProcessEnv }> = [
			{ decisions: false },
			{ decisions: { points: ["plan"] } },
			{ env: { ULTRATHINK_DECISIONS: "0" } },
		];
		for (const over of cases) {
			const f = fixture();
			const { ctx, calls } = withSkillworthy(f, [0.01], over);
			const kept = await filterSkillworthy(lessons, ctx);
			expect(kept.map((item) => item.id)).toEqual(lessons.map((item) => item.id));
			expect(calls).toHaveLength(0);
		}
	});

	test("a thrown fetch, HTTP 500, or a timeout keeps every moment", async () => {
		const lessons = [moment({ name: "one" }), moment({ name: "two" })];
		const thrown = fixture();
		const boom = withSkillworthy(thrown, [new Error("connection refused")], { decisions: { timeoutMs: 400 } });
		expect((await filterSkillworthy(lessons, boom.ctx)).map((item) => item.id)).toEqual(lessons.map((item) => item.id));
		expect(boom.calls.length).toBeGreaterThan(0);

		const upstream = fixture();
		const down = withSkillworthy(upstream, [Response.json({ error: { message: "down" } }, { status: 500 })], { decisions: { timeoutMs: 400 } });
		expect((await filterSkillworthy(lessons, down.ctx)).map((item) => item.id)).toEqual(lessons.map((item) => item.id));
		expect(down.calls.length).toBeGreaterThan(0);

		const hung = fixture();
		let timeouts = 0;
		const slow = withSkillworthy(hung, [], {
			decisions: { timeoutMs: 30 },
			fetch: ((_url: string | URL | Request, init?: RequestInit) => {
				timeouts += 1;
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				});
			}) as typeof fetch,
		});
		expect((await filterSkillworthy(lessons, slow.ctx)).map((item) => item.id)).toEqual(lessons.map((item) => item.id));
		expect(timeouts).toBe(lessons.length);
	});
});

describe("promoteDue skillworthy gate", () => {
	test("with autoPromote on, drafts only the moments filterSkillworthy keeps", async () => {
		const f = fixture();
		const store = openStore(storeDir(f.stateDir));
		const skip = moment({ name: "Skip lesson", occurrences: 3, createdAt: "2026-02-02T00:00:00.000Z" });
		const keep = moment({ name: "Keep lesson", occurrences: 3, createdAt: "2026-01-01T00:00:00.000Z" });
		store.put(skip);
		store.put(keep);
		const { ctx, calls } = withSkillworthy(f, [0.1, 0.8], { teach: { autoPromote: true }, decisions: { skillworthyAt: 0.5 } });
		const result = await promoteDue(ctx);
		expect(calls).toHaveLength(2);
		expect(result.drafted.map((outcome) => outcome.path)).toEqual([
			join(f.stateDir, "teach", "skill-drafts", "lesson-keep-lesson", "SKILL.md"),
		]);
		expect(existsSync(join(f.stateDir, "teach", "skill-drafts", "lesson-skip-lesson"))).toBe(false);
		expect(store.get(skip.id)?.status).toBe("confirmed");
		expect(store.get(keep.id)?.status).toBe("promoted");
	});
});
