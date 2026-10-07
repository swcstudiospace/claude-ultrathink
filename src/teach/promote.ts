// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Skill promotion: turns confirmed lessons into SKILL.md files. Rendering is deterministic (no LLM) and respects the
 * strictest skill rules among the hosts: Hermes' (new-skill description of at most 60 characters, one sentence, trigger
 * first; at most 100 000 characters) and Omp's managed skills (name `[a-z0-9][a-z0-9-]{0,63}`, at most 64 000 bytes).
 *
 * Installing never overwrites a skill somebody else wrote: Omp and Claude Code files are only touched when they carry
 * the `ultrathink:teach` marker comment, and symlinked skill directories or files are refused. A marked file is only
 * replaced when every moment id in its marker is among the lessons being installed (a re-install, or a merge that
 * includes them): Claude Code and Grok Build keep separate lesson stores but share `~/.claude/skills`, so a marked
 * skill made from other lessons keeps its name and the install takes the next free `<name>-2` … `<name>-9`. Hermes and
 * unknown hosts only get a draft under `<stateDir>/teach/skill-drafts`: Hermes installs through `skill_manage` so its
 * `skills.write_approval` gate applies, and ultrathink never writes `~/.hermes/skills`.
 */
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSkillworthyState } from "../decisions/questions.ts";
import { SKILLWORTHY_AT } from "../decisions/types.ts";
import { askLesson, lessonDecisions } from "./context.ts";
import { documentIdFor, tagsFor } from "./mapping.ts";
import { redactText } from "./redact.ts";
import { openStore, storeDir } from "./store.ts";
import { TEACH_KILL_ENV } from "./types.ts";
import type { InstallOutcome, MomentKind, SkillDraft, SkillTarget, TeachableMoment, TeachContext } from "./types.ts";

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Hermes' limit for the description of a new skill. */
const DESCRIPTION_MAX = 60;
/** Omp refuses managed skills over 64 000 bytes; leave headroom. */
export const CONTENT_MAX_BYTES = 60_000;
const NAME_MAX = 48;
const TRIGGER = "Use when ";
const MARKER_RE = /<!--\s*ultrathink:teach\b/;
const MARKER_IDS_RE = /<!--\s*ultrathink:teach ids=([^\s>]+)\s*-->/;
/** A host install tries the draft's name, then `-2` … `-9`. */
const MAX_NAME_SUFFIX = 9;
const EVIDENCE_ARTIFACTS = 20;

const HOST_TARGETS: Record<string, SkillTarget> = {
	omp: "omp",
	"claude-code": "claude",
	"grok-build": "claude",
	hermes: "hermes",
};

const SECTION: Record<MomentKind, string> = {
	bug: "Pitfall",
	pitfall: "Pitfall",
	pattern: "Pattern",
	decision: "Decision",
	playbook: "Procedure",
};

export function targetForHost(host: string): SkillTarget {
	return HOST_TARGETS[host] ?? "drafts";
}

export function promotionCandidates(ctx: TeachContext): TeachableMoment[] {
	const after = ctx.config.teach.promoteAfter;
	try {
		return openStore(storeDir(ctx.stateDir))
			.list()
			.filter((m) => m.status === "confirmed" && !m.promoted && (m.occurrences >= after || m.kind === "playbook"))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
	} catch {
		return [];
	}
}

/**
 * Jev's veto over `promote --due` and `promoteDue`: a moment whose P(skillworthy) is below `decisions.skillworthyAt` is left out,
 * everything else (Jev off, no key, any failure) stays. An explicit `teach promote <id>` never goes through here: that is a human decision.
 */
export async function filterSkillworthy(moments: TeachableMoment[], ctx: TeachContext): Promise<TeachableMoment[]> {
	const jev = lessonDecisions(ctx);
	if (!jev) return moments;
	const at = ctx.config.decisions?.skillworthyAt ?? SKILLWORTHY_AT;
	const redact = { home: ctx.env.HOME ?? ctx.env.USERPROFILE, repoRoot: ctx.cwd };
	const kept: TeachableMoment[] = [];
	for (const moment of moments) {
		const state = buildSkillworthyState({
			name: redactText(moment.name, redact),
			description: redactText(moment.description, redact),
			body: redactText(moment.body, redact),
			kind: moment.kind,
			occurrences: moment.occurrences,
		});
		const verdict = await askLesson(ctx, jev, "skillworthy", state, { threshold: at, action: (p) => (p < at ? "skip" : "keep") });
		if (verdict.status === "ok" && verdict.p < at) continue;
		kept.push(moment);
	}
	return kept;
}

function slugOf(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** A moment id as the `ultrathink:teach ids=` marker writes it. */
function markerId(id: string): string {
	return id.replace(/[^A-Za-z0-9_.:-]/g, "");
}

/** Moment ids in a skill's `<!-- ultrathink:teach ids=… -->` marker; empty when there is none. */
export function markerIds(text: string): string[] {
	const raw = text.match(MARKER_IDS_RE)?.[1] ?? "";
	return raw
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
}

/** `draft` under `name` (frontmatter included). */
function renamed(draft: SkillDraft, name: string): SkillDraft {
	return { ...draft, name, content: draft.content.replace(`\nname: ${draft.name}\n`, `\nname: ${name}\n`) };
}

function suffixed(name: string, n: number): string {
	const suffix = `-${n}`;
	return `${name.slice(0, 64 - suffix.length).replace(/-+$/, "")}${suffix}`;
}

/** Cuts at a word boundary within `max` characters (code points), then drops trailing punctuation. */
function cutAtWord(text: string, max: number): string {
	const chars = Array.from(text);
	let out = text;
	if (chars.length > max) {
		const head = chars.slice(0, max);
		const atBoundary = chars[max] === " ";
		const lastSpace = head.lastIndexOf(" ");
		out = (atBoundary || lastSpace <= 0 ? head : head.slice(0, lastSpace)).join("");
	}
	return out.replace(/[\s,.;!?-]+$/, "");
}

/** One lowercase clause with none of the characters Omp strips or YAML and Markdown trip over. */
function clause(text: string): string {
	return text
		.replace(/[\p{Cc}\p{Cf}`<>~]/gu, " ")
		.replace(/\s*:\s*/g, ", ")
		.replace(/[.!?;]+\s+/g, ", ")
		.replace(/(\s*,)+\s*/g, ", ")
		.replace(/\s+/g, " ")
		.replace(/^[\s,.;!?-]+/, "")
		.toLowerCase();
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter((v) => v !== ""))];
}

function validateDraft(name: string, description: string, content: string, body: string): void {
	if (!SKILL_NAME_RE.test(name)) throw new Error(`skill name "${name}" is not a valid skill name`);
	if (description === "") throw new Error("skill description is empty");
	if (Array.from(description).length > DESCRIPTION_MAX) {
		throw new Error(`skill description is longer than ${DESCRIPTION_MAX} characters`);
	}
	if (!description.endsWith(".")) throw new Error("skill description must end with a period");
	if (/[:`<>\p{Cc}]/u.test(description) || /[.!?]\s/.test(description)) {
		throw new Error("skill description must be one plain sentence");
	}
	if (body.trim() === "") throw new Error("skill body is empty");
	if (Buffer.byteLength(content, "utf8") > CONTENT_MAX_BYTES) {
		throw new Error(`skill is larger than ${CONTENT_MAX_BYTES} bytes`);
	}
}

export function renderSkillDraft(moments: TeachableMoment[], ctx: TeachContext): SkillDraft {
	if (moments.length === 0) throw new Error("no lessons to promote");
	// Stable sort: the most repeated lesson is primary, ties keep the caller's order.
	const ordered = [...moments].sort((a, b) => b.occurrences - a.occurrences);
	const primary = ordered[0] as TeachableMoment;

	const home = ctx.env.HOME?.trim() || homedir();
	let changed = false;
	const red = (text: string): string => {
		const out = redactText(text, { home, repoRoot: ctx.cwd });
		if (out !== text) changed = true;
		return out;
	};
	const clean = ordered.map((m) => ({
		m,
		name: red(m.name).replace(/\s+/g, " ").trim(),
		description: red(m.description).trim(),
		body: red(m.body).trim(),
	}));
	const lead = clean[0] as (typeof clean)[number];
	if (!clean.some((c) => c.body !== "")) throw new Error("lesson has no body text");

	const slug = slugOf(lead.name) || slugOf(primary.id);
	if (slug === "") throw new Error("lesson has no usable name");
	const full = `lesson-${slug}`;
	const cut = full.slice(0, NAME_MAX);
	const boundary = cut.lastIndexOf("-");
	// Prefer a word boundary, unless the whole slug is one word.
	const midWord = full.length > NAME_MAX && full[NAME_MAX] !== "-" && boundary > "lesson-".length;
	const name = (midWord ? cut.slice(0, boundary) : cut).replace(/-+$/, "");

	const trigger = cutAtWord(clause(lead.name) || clause(lead.description), DESCRIPTION_MAX - TRIGGER.length - 1);
	if (trigger === "") throw new Error("lesson has no usable name or description");
	const description = `${TRIGGER}${trigger}.`;

	const several = clean.length > 1;
	const when = clean.map((c) => c.description || c.name);
	const sections = new Map<string, string[]>();
	for (const c of clean) {
		if (c.body === "") continue;
		const heading = SECTION[c.m.kind];
		const parts = sections.get(heading) ?? [];
		parts.push(several ? `### ${c.name}\n\n${c.body}` : c.body);
		sections.set(heading, parts);
	}

	const phases = unique(ordered.map((m) => red(m.sourcePhase).trim()));
	const artifacts = unique(ordered.flatMap((m) => m.sourceArtifacts.map((a) => red(a).trim())));
	const ids = ordered.map((m) => markerId(m.id));
	const evidence = [
		`- Occurrences: ${ordered.reduce((sum, m) => sum + m.occurrences, 0)}`,
		`- Project: ${unique(ordered.map((m) => m.project)).join(", ")}`,
		`- First seen: ${ordered.map((m) => m.createdAt).sort()[0]}`,
		`- Last seen: ${ordered.map((m) => m.lastSeenAt).sort().reverse()[0]}`,
		...(phases.length > 0 ? [`- Source phase: ${phases.join(", ")}`] : []),
		...(artifacts.length > 0 ? [`- Source artifacts: ${artifacts.slice(0, EVIDENCE_ARTIFACTS).join(", ")}`] : []),
		`- Moments: ${ids.join(", ")}`,
	];

	const body = [
		`# ${lead.name}`,
		"## When to use",
		several ? when.map((w) => `- ${w.replace(/\s+/g, " ").trim()}`).join("\n") : (when[0] as string),
		...[...sections].map(([heading, parts]) => `## ${heading}\n\n${parts.join("\n\n")}`),
		`## Evidence\n\n${evidence.join("\n")}`,
		`<!-- ultrathink:teach ids=${ids.join(",")} -->`,
	].join("\n\n");

	// A description with `#` would need YAML quoting (colons are rejected by validation).
	const yamlDescription = description.includes("#") ? JSON.stringify(description) : description;
	const content = `---\nname: ${name}\ndescription: ${yamlDescription}\n---\n${body}\n`;
	validateDraft(name, description, content, body);
	return {
		name,
		description,
		body,
		content,
		sourceIds: ordered.map((m) => m.id),
		warnings: changed ? ["secrets or local paths were redacted from the lesson text"] : [],
	};
}

function lstatOrUndefined(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function failure(error: unknown): string {
	const code = (error as NodeJS.ErrnoException).code;
	return `could not write the skill (${typeof code === "string" ? code : "error"})`;
}

/** Writes `content` to a sibling temp file; the caller renames it into place and removes it on failure. */
function stage(dir: string, content: string, mode: number): string {
	const tmp = join(dir, `.SKILL.md.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	writeFileSync(tmp, content, { flag: "wx", mode });
	chmodSync(tmp, mode);
	return tmp;
}

function installDraft(draft: SkillDraft, stateDir: string, target: SkillTarget): InstallOutcome {
	const drafts = join(storeDir(stateDir), "skill-drafts");
	const dir = join(drafts, draft.name);
	const path = join(dir, "SKILL.md");
	let tmp: string | undefined;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(drafts, 0o700);
		chmodSync(dir, 0o700);
		tmp = stage(dir, draft.content, 0o600);
		renameSync(tmp, path);
		tmp = undefined;
	} catch (error) {
		return { target, path, action: "refused", reason: failure(error) };
	} finally {
		if (tmp) rmSync(tmp, { force: true });
	}
	return target === "hermes"
		? {
				target,
				path,
				action: "drafted",
				reason: "install through Hermes skill_manage so skills.write_approval applies; ultrathink never writes ~/.hermes/skills",
			}
		: { target, path, action: "drafted" };
}

/** What a host skill slot holds for an install of the lessons `ids`: refused slots are never written. */
type Slot = "free" | "ours" | "theirs" | { refused: string };

function slotOf(dir: string, path: string, ids: ReadonlySet<string>): Slot {
	try {
		const dirStat = lstatOrUndefined(dir);
		if (!dirStat) return "free";
		if (dirStat.isSymbolicLink()) return { refused: "skill directory is a symlink" };
		if (!dirStat.isDirectory()) return { refused: "skill path is not a directory" };
		const fileStat = lstatOrUndefined(path);
		if (!fileStat) return "free";
		if (fileStat.isSymbolicLink()) return { refused: "SKILL.md is a symlink" };
		if (!fileStat.isFile()) return { refused: "SKILL.md is not a regular file" };
	} catch (error) {
		return { refused: failure(error) };
	}
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// Unreadable: it may be anybody's, so it is taken.
		return "theirs";
	}
	if (!MARKER_RE.test(text)) return { refused: "a skill with this name exists and was not written by ultrathink" };
	// Ours only when it was made from lessons this install includes; a marker without ids is taken.
	const held = markerIds(text);
	return held.length > 0 && held.every((id) => ids.has(id)) ? "ours" : "theirs";
}

function writeHostSkill(draft: SkillDraft, target: SkillTarget, dir: string, replace: boolean): InstallOutcome {
	const path = join(dir, "SKILL.md");
	const refuse = (reason: string): InstallOutcome => ({ target, path, action: "refused", reason });
	let tmp: string | undefined;
	let placeholder = false;
	try {
		if (!replace) mkdirSync(dir, { recursive: true, mode: 0o755 });
		tmp = stage(dir, draft.content, 0o644);
		if (!replace) {
			// O_EXCL claims the name, so a skill that appeared since the lstat is never replaced.
			closeSync(openSync(path, "wx", 0o644));
			placeholder = true;
		}
		renameSync(tmp, path);
		tmp = undefined;
		placeholder = false;
		return { target, path, action: replace ? "updated" : "created" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return refuse("a skill with this name appeared meanwhile");
		return refuse(failure(error));
	} finally {
		if (tmp) rmSync(tmp, { force: true });
		if (placeholder) rmSync(path, { force: true });
	}
}

/**
 * Installs under the draft's name, or the first of `<name>-2` … `<name>-9` that is free or already holds these lessons,
 * skipping `avoid`. The draft's own name refuses a symlink or an authored skill as before; a fallback name that is not
 * usable is simply taken.
 */
function installIntoHost(draft: SkillDraft, target: SkillTarget, root: string, avoid: ReadonlySet<string>): InstallOutcome {
	const ids = new Set(draft.sourceIds.map(markerId));
	for (let n = 1; n <= MAX_NAME_SUFFIX; n++) {
		const name = n === 1 ? draft.name : suffixed(draft.name, n);
		if (avoid.has(name)) continue;
		const dir = join(root, name);
		const slot = slotOf(dir, join(dir, "SKILL.md"), ids);
		if (slot === "theirs") continue;
		if (typeof slot === "object") {
			if (n === 1) return { target, path: join(dir, "SKILL.md"), action: "refused", reason: slot.refused };
			continue;
		}
		const outcome = writeHostSkill(n === 1 ? draft : renamed(draft, name), target, dir, slot === "ours");
		if (n === 1 || outcome.action === "refused") return outcome;
		return { ...outcome, skill: name, reason: `${draft.name} is a skill made from other lessons` };
	}
	return {
		target,
		path: join(root, draft.name, "SKILL.md"),
		action: "refused",
		reason: `every name from ${draft.name} to ${suffixed(draft.name, MAX_NAME_SUFFIX)} is taken by another skill`,
	};
}

/** `avoid`: names a host install must not take (promoteDue passes the names its own store already promoted). */
export function installSkill(draft: SkillDraft, target: SkillTarget, ctx: TeachContext, avoid: ReadonlySet<string> = new Set()): InstallOutcome {
	if (!SKILL_NAME_RE.test(draft.name) || draft.content.trim() === "") {
		return { target, path: "", action: "refused", reason: "invalid skill draft" };
	}
	if (Buffer.byteLength(draft.content, "utf8") > CONTENT_MAX_BYTES) {
		return { target, path: "", action: "refused", reason: "skill draft is too large" };
	}
	if (target === "drafts" || target === "hermes") return installDraft(draft, ctx.stateDir, target);
	const home = ctx.env.HOME?.trim() || homedir();
	if (target === "omp") {
		const piDir = ctx.env.PI_CODING_AGENT_DIR?.trim() || join(home, ".omp", "agent");
		return installIntoHost(draft, target, join(piDir, "managed-skills"), avoid);
	}
	const claudeDir = ctx.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
	return installIntoHost(draft, target, join(claudeDir, "skills"), avoid);
}

export function markPromoted(
	ids: string[],
	info: { skill: string; target: SkillTarget; path?: string },
	ctx: TeachContext,
): TeachableMoment[] {
	const store = openStore(storeDir(ctx.stateDir));
	const nowMs = (ctx.now ?? Date.now)();
	const at = new Date(nowMs).toISOString();
	const updated: TeachableMoment[] = [];
	for (const id of ids) {
		const moment = store.get(id);
		if (!moment) continue;
		const next: TeachableMoment = {
			...moment,
			status: "promoted",
			promoted: { at, skill: info.skill, target: info.target, ...(info.path ? { path: info.path } : {}) },
		};
		store.put(next);
		// The Hindsight copy carries `status:<status>`, so a retained moment needs its tags refreshed.
		if (moment.retained) store.enqueue({ op: "tags", documentId: documentIdFor(id), tags: tagsFor(next) }, nowMs);
		updated.push(next);
	}
	return updated;
}

/** A skill name no other promoted lesson (or an earlier draft of this run) already uses. */
function freeName(draft: SkillDraft, taken: Set<string>): SkillDraft {
	if (!taken.has(draft.name)) return draft;
	for (let n = 2; ; n++) {
		const name = suffixed(draft.name, n);
		if (!taken.has(name)) return renamed(draft, name);
	}
}

export async function promoteDue(ctx: TeachContext): Promise<{ drafted: InstallOutcome[]; installed: InstallOutcome[] }> {
	const result = { drafted: [] as InstallOutcome[], installed: [] as InstallOutcome[] };
	const { teach } = ctx.config;
	if (!teach.autoPromote || !teach.enabled || ctx.env[TEACH_KILL_ENV] === "0") return result;

	const target = targetForHost(ctx.host);
	let taken: Set<string>;
	try {
		taken = new Set(
			openStore(storeDir(ctx.stateDir))
				.list()
				.flatMap((m) => (m.promoted ? [m.promoted.skill] : [])),
		);
	} catch {
		return result;
	}
	for (const moment of await filterSkillworthy(promotionCandidates(ctx), ctx)) {
		try {
			const rendered = renderSkillDraft([moment], ctx);
			// The host install picks the name first (another host's lessons may hold it), so the draft and the promotion
			// record carry the name the skill really has. Nothing installed: the draft keeps a name unique in this store.
			const outcome = target === "hermes" || target === "drafts" ? undefined : installSkill(rendered, target, ctx, taken);
			const installed = outcome?.action === "created" || outcome?.action === "updated";
			let draft = freeName(rendered, taken);
			if (installed) draft = outcome?.skill ? renamed(rendered, outcome.skill) : rendered;
			taken.add(draft.name);
			result.drafted.push(installSkill(draft, "drafts", ctx));
			if (!outcome) continue;
			result.installed.push(outcome);
			if (installed) markPromoted([moment.id], { skill: draft.name, target, path: outcome.path }, ctx);
		} catch {
			// One unrenderable lesson must not stop the others.
		}
	}
	return result;
}
