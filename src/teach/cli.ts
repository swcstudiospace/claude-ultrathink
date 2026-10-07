// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `ultrathink teach <subcommand>`: the command-line face of Teachable Moments. Hosts (Hermes bridge, hooks, slash
 * commands) and people call the same entry point, so every subcommand has a human output and a `--json` output and
 * the same exit codes: 0 ok, 1 runtime failure / not ready / unknown id, 2 usage or invalid input. Every function it
 * calls fails open on its own; this module only turns outcomes into text, never throws, and never prints a key, a
 * prompt or an unredacted error message.
 */
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { toAgentCardFromMoments } from "./agent-card.ts";
import { captureMoment, confirmMoment, forgetMoment, syncOutbox, TeachInputError } from "./capture.ts";
import { teachContext, teachEnabled } from "./context.ts";
import type { TeachContextOptions } from "./context.ts";
import { parseDigest } from "./digest.ts";
import { observeDigest } from "./observe.ts";
import { filterSkillworthy, installSkill, markPromoted, promotionCandidates, renderSkillDraft, targetForHost } from "./promote.ts";
import { formatLessonsSection, recallLessons } from "./recall.ts";
import { redactText } from "./redact.ts";
import { hindsightReadiness, momentCounts, teachStatusLine } from "./status.ts";
import { openStore, storeDir } from "./store.ts";
import { MOMENT_KINDS, MOMENT_ORIGINS, MOMENT_STATUSES } from "./types.ts";
import type {
	CaptureInput,
	CaptureOutcome,
	CliResult,
	MomentKind,
	MomentOrigin,
	MomentStatus,
	RecallOutcome,
	RecallRequest,
	SkillDraft,
	SkillTarget,
	TeachableMoment,
	TeachContext,
	TeachStore,
} from "./types.ts";
import type { HindsightClient } from "../hindsight/types.ts";
import { resolveStateDir } from "../host/paths.ts";

/** `config`, `hindsight` and `complete` are test seams on top of the shared CommandDeps shape. */
export interface CommandDeps {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	stateDir?: string;
	storePath?: string;
	fetch?: typeof fetch;
	config?: TeachContext["config"];
	stdin?: () => Promise<string>;
	now?: () => number;
	hindsight?: HindsightClient;
	complete?: TeachContext["complete"];
}

const USAGE = `usage:
  teach status [--json]
  teach list [--status S] [--project P] [--json]
  teach show <id> [--json]
  teach capture (--stdin | --name N --body B [--description D] [--kind K] [--tag T]... [--phase P] [--artifact A]...) [--json]
  teach recall "<query>" [--limit N] [--project P|*] [--json]
  teach confirm <id> [--json]
  teach forget <id> [--json]
  teach sync [--json]
  teach observe (--stdin | --file <path>) [--json]
  teach promote --due [--json]
  teach promote <id>... [--target hermes|omp|claude|drafts] [--install] [--json]
  teach promote <id>... --mark-promoted --skill <name> --target <t> [--path P] [--json]
  teach export --a2a [<id>...]`;

const MAX_INPUT_CHARS = 2_000_000;
const ID_PREFIX_MIN = 4;
const SKILL_TARGETS: readonly SkillTarget[] = ["hermes", "omp", "claude", "drafts"];
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The store's id alphabet, without a leading dot, so an id can never name a path. */
const ID_TOKEN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$/;

/** Bad command line or bad input: exit 2. */
class UsageError extends Error {}

type FlagKind = "bool" | "value" | "multi";
interface Spec {
	flags: Record<string, FlagKind>;
	maxArgs: number;
}

const SPECS: Record<string, Spec> = {
	status: { flags: { json: "bool" }, maxArgs: 0 },
	list: { flags: { json: "bool", status: "value", project: "value" }, maxArgs: 0 },
	show: { flags: { json: "bool" }, maxArgs: 1 },
	capture: {
		flags: {
			json: "bool",
			stdin: "bool",
			name: "value",
			body: "value",
			description: "value",
			kind: "value",
			tag: "multi",
			phase: "value",
			artifact: "multi",
		},
		maxArgs: 0,
	},
	recall: { flags: { json: "bool", limit: "value", project: "value" }, maxArgs: Number.POSITIVE_INFINITY },
	confirm: { flags: { json: "bool" }, maxArgs: 1 },
	forget: { flags: { json: "bool" }, maxArgs: 1 },
	sync: { flags: { json: "bool" }, maxArgs: 0 },
	observe: { flags: { json: "bool", stdin: "bool", file: "value" }, maxArgs: 0 },
	promote: {
		flags: {
			json: "bool",
			due: "bool",
			install: "bool",
			"mark-promoted": "bool",
			target: "value",
			skill: "value",
			path: "value",
		},
		maxArgs: Number.POSITIVE_INFINITY,
	},
	export: { flags: { json: "bool", a2a: "bool" }, maxArgs: Number.POSITIVE_INFINITY },
};

interface Parsed {
	json: boolean;
	args: string[];
	has(name: string): boolean;
	one(name: string): string | undefined;
	all(name: string): string[];
}

function flagName(token: string): string {
	const eq = token.indexOf("=");
	return token.slice(2, eq < 0 ? undefined : eq);
}

/** Flags in any position, `--name value` or `--name=value`, repeatable value flags, `--` ends flags. */
function parseArgs(argv: readonly string[], spec: Spec): Parsed {
	const values = new Map<string, string[]>();
	const args: string[] = [];
	let rest = false;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] as string;
		if (rest || !token.startsWith("--") || token === "--") {
			if (!rest && token === "--") rest = true;
			else args.push(token);
			continue;
		}
		const name = flagName(token);
		const kind = Object.hasOwn(spec.flags, name) ? spec.flags[name] : undefined;
		if (kind === undefined) throw new UsageError(`unknown flag --${name.slice(0, 40)}`);
		if (kind === "bool") {
			if (token.includes("=")) throw new UsageError(`--${name} takes no value`);
			values.set(name, []);
			continue;
		}
		let value: string | undefined;
		if (token.includes("=")) value = token.slice(token.indexOf("=") + 1);
		else {
			const next = argv[i + 1];
			const looksLikeFlag = next !== undefined && next.startsWith("--") && (next === "--" || Object.hasOwn(spec.flags, flagName(next)));
			if (next !== undefined && !looksLikeFlag) {
				value = next;
				i += 1;
			}
		}
		if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
		const list = values.get(name) ?? [];
		if (kind === "multi") list.push(value);
		else list.splice(0, list.length, value);
		values.set(name, list);
	}
	if (args.length > spec.maxArgs) throw new UsageError("unexpected argument");
	return {
		json: values.has("json"),
		args,
		has: (name) => values.has(name),
		one: (name) => values.get(name)?.[0],
		all: (name) => values.get(name) ?? [],
	};
}

/** The first line of a message with secrets and home paths redacted; never throws. */
function oneLine(message: string): string {
	let text = message;
	try {
		text = redactText(message);
	} catch {
		text = "failed";
	}
	const line = (text.split(/\r?\n/)[0] ?? "").trim();
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function done(p: { json: boolean }, text: string, value: unknown, code = 0): CliResult {
	return { code, text: p.json ? JSON.stringify(value) : text };
}

function fail(json: boolean, code: number, message: string): CliResult {
	return { code, text: json ? JSON.stringify({ ok: false, error: message }) : message };
}

function asEnum<T extends string>(value: string, allowed: readonly T[], what: string): T {
	if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`unknown ${what}: ${value.slice(0, 40)}`);
	return value as T;
}

function offMessage(ctx: TeachContext): string | undefined {
	if (teachEnabled(ctx)) return undefined;
	return ctx.config.teach.enabled
		? "Teachable Moments is off (ULTRATHINK_TEACH=0)"
		: "Teachable Moments is off (opt-in: set teach.enabled)";
}

/** Opens the store only when it exists, so read-only commands never create it. */
function existingStore(ctx: TeachContext): TeachStore | undefined {
	const dir = storeDir(ctx.stateDir);
	return existsSync(dir) ? openStore(dir) : undefined;
}

/** Exact id, else a unique prefix of at least four characters; undefined when nothing matches. */
function findMoment(store: TeachStore | undefined, token: string): TeachableMoment | undefined {
	if (!ID_TOKEN.test(token)) throw new UsageError("invalid id");
	if (!store) return undefined;
	const exact = store.get(token);
	if (exact) return exact;
	if (token.length < ID_PREFIX_MIN) return undefined;
	const matches = store.list().filter((moment) => moment.id.startsWith(token));
	if (matches.length > 1) throw new UsageError(`id prefix ${token} is ambiguous`);
	return matches[0];
}

function newestFirst(moments: TeachableMoment[]): TeachableMoment[] {
	return [...moments].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id)));
}

function momentLine(moment: TeachableMoment): string {
	const name = moment.name.replace(/\s+/g, " ").trim();
	return `${moment.id.slice(0, 8)} ${moment.status} ${moment.kind} x${moment.occurrences} ${moment.project} ${name}`;
}

function captureLine(outcome: CaptureOutcome): string {
	const reason = outcome.reason ? ` · ${oneLine(outcome.reason)}` : "";
	return `${outcome.moment.id} (${outcome.created ? "created" : "merged"}) · retain ${outcome.retain}${reason}`;
}

function captureJson(outcome: CaptureOutcome): Record<string, unknown> {
	return { id: outcome.moment.id, created: outcome.created, retain: outcome.retain, reason: outcome.reason ?? null };
}

async function readInput(deps: CommandDeps): Promise<string> {
	const text = await (deps.stdin ?? (() => Bun.stdin.text()))();
	if (text.length > MAX_INPUT_CHARS) throw new UsageError("input is too large");
	return text;
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new UsageError(`${what} is not valid JSON`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UsageError(`${what} must be a JSON object`);
	return value as Record<string, unknown>;
}

function optString(o: Record<string, unknown>, key: string): string | undefined {
	const value = o[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new UsageError(`${key} must be a string`);
	return value;
}

function optStrings(o: Record<string, unknown>, key: string): string[] | undefined {
	const value = o[key];
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new UsageError(`${key} must be an array of strings`);
	return value as string[];
}

function optEnum<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
	const value = optString(o, key);
	return value === undefined ? undefined : asEnum(value, allowed, key);
}

function captureInputFromJson(o: Record<string, unknown>): CaptureInput {
	const name = optString(o, "name");
	const body = optString(o, "body");
	if (name === undefined || body === undefined) throw new UsageError("capture input needs name and body");
	const input: CaptureInput = { name, body };
	const description = optString(o, "description");
	if (description !== undefined) input.description = description;
	const kind = optEnum<MomentKind>(o, "kind", MOMENT_KINDS);
	if (kind) input.kind = kind;
	const tags = optStrings(o, "tags");
	if (tags) input.tags = tags;
	const sourcePhase = optString(o, "sourcePhase");
	if (sourcePhase !== undefined) input.sourcePhase = sourcePhase;
	const sourceArtifacts = optStrings(o, "sourceArtifacts");
	if (sourceArtifacts) input.sourceArtifacts = sourceArtifacts;
	const relatedIds = optStrings(o, "relatedIds");
	if (relatedIds) input.relatedIds = relatedIds;
	const confidence = o.confidence;
	if (confidence !== undefined && confidence !== null) {
		if (typeof confidence !== "number" || !Number.isFinite(confidence)) throw new UsageError("confidence must be a number");
		input.confidence = confidence;
	}
	const origin = optEnum<MomentOrigin>(o, "origin", MOMENT_ORIGINS);
	if (origin) input.origin = origin;
	const supersedes = optString(o, "supersedes");
	if (supersedes !== undefined) input.supersedes = supersedes;
	const status = optEnum<MomentStatus>(o, "status", MOMENT_STATUSES);
	if (status) input.status = status;
	return input;
}

function captureInputFromFlags(p: Parsed): CaptureInput {
	const name = p.one("name");
	const body = p.one("body");
	if (name === undefined || body === undefined) throw new UsageError("capture needs --stdin or both --name and --body");
	const input: CaptureInput = { name, body };
	const description = p.one("description");
	if (description !== undefined) input.description = description;
	const kind = p.one("kind");
	if (kind !== undefined) input.kind = asEnum(kind, MOMENT_KINDS, "kind");
	if (p.all("tag").length > 0) input.tags = p.all("tag");
	const phase = p.one("phase");
	if (phase !== undefined) input.sourcePhase = phase;
	if (p.all("artifact").length > 0) input.sourceArtifacts = p.all("artifact");
	return input;
}

function buildContext(deps: CommandDeps): TeachContext {
	const env = deps.env ?? process.env;
	const options: TeachContextOptions = { cwd: deps.cwd, env, stateDir: deps.stateDir ?? resolveStateDir(env) };
	if (deps.storePath !== undefined) options.storePath = deps.storePath;
	if (deps.fetch) options.fetch = deps.fetch;
	if (deps.now) options.now = deps.now;
	if (deps.config) options.config = deps.config;
	if (deps.hindsight) options.hindsight = deps.hindsight;
	if (deps.complete) options.complete = deps.complete;
	return teachContext(options);
}

/** `file` resolved to a real path inside `<stateDir>/teach/inbox/`, else a usage error. Symlinks are followed before the check. */
function inboxFile(ctx: TeachContext, cwd: string, file: string): string {
	const refusal = new UsageError("--file must be an existing file under <stateDir>/teach/inbox/");
	let real: string;
	let inbox: string;
	try {
		real = realpathSync(resolve(cwd, file));
		inbox = realpathSync(join(storeDir(ctx.stateDir), "inbox"));
		if (!statSync(real).isFile()) throw refusal;
	} catch {
		throw refusal;
	}
	const rel = relative(inbox, real);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw refusal;
	return real;
}

function status(ctx: TeachContext, p: Parsed): CliResult {
	const counts = momentCounts(ctx.stateDir);
	const { teach, hindsight } = ctx.config;
	const readiness = hindsightReadiness(hindsight, ctx.env, ctx.storePath);
	const value = {
		enabled: teachEnabled(ctx),
		capture: teach.capture,
		recall: teach.recall,
		hindsight: readiness.state,
		moments: counts.moments,
		outbox: counts.outbox,
	};
	const m = counts.moments;
	const text = [
		teachStatusLine(ctx.config, ctx.env, ctx.storePath, ctx.stateDir),
		`Moments: ${m.candidate} candidate, ${m.confirmed} confirmed, ${m.promoted} promoted, ${m.superseded} superseded · outbox ${counts.outbox}`,
	].join("\n");
	return done(p, text, value);
}

function list(ctx: TeachContext, p: Parsed): CliResult {
	const statusFilter = p.one("status");
	if (statusFilter !== undefined) asEnum(statusFilter, MOMENT_STATUSES, "status");
	const project = p.one("project")?.toLowerCase();
	const moments = newestFirst(
		(existingStore(ctx)?.list() ?? []).filter(
			(moment) => (statusFilter === undefined || moment.status === statusFilter) && (project === undefined || moment.project === project),
		),
	);
	return done(p, moments.length === 0 ? "No moments." : moments.map(momentLine).join("\n"), { count: moments.length, moments });
}

function show(ctx: TeachContext, p: Parsed): CliResult {
	const token = p.args[0];
	if (token === undefined) throw new UsageError("show needs <id>");
	const moment = findMoment(existingStore(ctx), token);
	if (!moment) return fail(p.json, 1, `no moment ${token}`);
	const lines = [`${moment.id} · ${moment.status} · ${moment.kind} · x${moment.occurrences} · ${moment.project}`, moment.name];
	if (moment.description) lines.push(moment.description);
	lines.push("", moment.body, "");
	lines.push(
		`tags: ${moment.tags.join(", ") || "-"} · host ${moment.host} · origin ${moment.origin} · confidence ${moment.confidence}`,
		`created ${moment.createdAt} · last seen ${moment.lastSeenAt} · recalled ${moment.recalled}x`,
	);
	if (moment.retained) lines.push(`retained ${moment.retained.at} (${moment.retained.bank})`);
	if (moment.promoted) lines.push(`promoted ${moment.promoted.at} → ${moment.promoted.skill} (${moment.promoted.target})`);
	return done(p, lines.join("\n"), moment);
}

async function capture(ctx: TeachContext, p: Parsed, deps: CommandDeps): Promise<CliResult> {
	const viaFlags = ["name", "body", "description", "kind", "tag", "phase", "artifact"].some((name) => p.has(name));
	if (p.has("stdin") && viaFlags) throw new UsageError("--stdin cannot be combined with --name/--body and the other capture flags");
	const input = p.has("stdin") ? captureInputFromJson(parseJsonObject(await readInput(deps), "stdin")) : captureInputFromFlags(p);
	const outcome = await captureMoment(input, ctx);
	return done(p, `Captured ${captureLine(outcome)}`, { ok: true, ...captureJson(outcome) });
}

async function recall(ctx: TeachContext, p: Parsed): Promise<CliResult> {
	const query = p.args.join(" ").trim();
	if (query === "") throw new UsageError("recall needs a query");
	const limitText = p.one("limit");
	let limit: number | undefined;
	if (limitText !== undefined) {
		limit = /^\d+$/.test(limitText) ? Number(limitText) : 0;
		if (limit < 1 || limit > 10) throw new UsageError("--limit must be 1..10");
	}
	const request: RecallRequest = { query };
	if (limit !== undefined) request.limit = limit;
	const project = p.one("project");
	if (project !== undefined) request.project = project;
	const off = offMessage(ctx);
	const outcome: RecallOutcome = off
		? { status: "off", lessons: [], source: "none", chars: 0, ms: 0, reason: off }
		: await recallLessons(request, ctx, { countUse: false });
	const value: Record<string, unknown> = {
		status: outcome.status,
		source: outcome.source,
		count: outcome.lessons.length,
		lessons: outcome.lessons.map((lesson) => ({
			id: lesson.id,
			name: lesson.name,
			description: lesson.description,
			body: lesson.body,
			kind: lesson.kind,
			project: lesson.project,
			host: lesson.host,
			occurrences: lesson.occurrences,
			createdAt: lesson.createdAt,
		})),
	};
	if (outcome.reason) value.reason = oneLine(outcome.reason);
	const count = outcome.lessons.length;
	let header = `${outcome.source} · ${count} ${count === 1 ? "lesson" : "lessons"}`;
	if (outcome.status === "off" || outcome.status === "error") {
		header += ` · ${outcome.status}${outcome.reason ? `: ${oneLine(outcome.reason)}` : ""}`;
	}
	const section = formatLessonsSection(outcome, ctx.config.teach.recallChars);
	return done(p, section ? `${header}\n${section}` : header, value, outcome.status === "error" ? 1 : 0);
}

async function confirm(ctx: TeachContext, p: Parsed): Promise<CliResult> {
	const token = p.args[0];
	if (token === undefined) throw new UsageError("confirm needs <id>");
	const id = findMoment(existingStore(ctx), token)?.id ?? token;
	const outcome = await confirmMoment(id, ctx);
	if (!outcome) return fail(p.json, 1, `no moment ${token}`);
	const reason = outcome.reason ? ` · ${oneLine(outcome.reason)}` : "";
	return done(p, `Confirmed ${outcome.moment.id} · retain ${outcome.retain}${reason}`, {
		ok: true,
		id: outcome.moment.id,
		status: outcome.moment.status,
		retain: outcome.retain,
		reason: outcome.reason ?? null,
	});
}

async function forget(ctx: TeachContext, p: Parsed): Promise<CliResult> {
	const token = p.args[0];
	if (token === undefined) throw new UsageError("forget needs <id>");
	const id = findMoment(existingStore(ctx), token)?.id ?? token;
	const outcome = await forgetMoment(id, ctx);
	if (!outcome.removed) return fail(p.json, 1, `no moment ${token}`);
	return done(p, `Forgot ${id} · remote ${outcome.remote}`, { ok: true, id, removed: true, remote: outcome.remote });
}

async function sync(ctx: TeachContext, p: Parsed): Promise<CliResult> {
	const outcome = await syncOutbox(ctx);
	const value: Record<string, unknown> = { done: outcome.done, pending: outcome.pending };
	if (outcome.reason) value.reason = oneLine(outcome.reason);
	const reason = outcome.reason ? ` · ${oneLine(outcome.reason)}` : "";
	return done(p, `Sync: ${outcome.done} done · ${outcome.pending} pending${reason}`, value, outcome.reason && outcome.pending > 0 ? 1 : 0);
}

async function observe(ctx: TeachContext, p: Parsed, deps: CommandDeps): Promise<CliResult> {
	const file = p.one("file");
	if (p.has("stdin") === (file !== undefined)) throw new UsageError("observe needs exactly one of --stdin and --file <path>");
	// A refused path is never deleted: it may not be ours.
	const inbox = file === undefined ? undefined : inboxFile(ctx, deps.cwd, file);
	try {
		const off = offMessage(ctx);
		if (off) return fail(p.json, 1, off);
		const text = inbox === undefined ? await readInput(deps) : readFileSync(inbox, "utf8");
		if (text.length > MAX_INPUT_CHARS) throw new UsageError("input is too large");
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			throw new UsageError("digest is not valid JSON");
		}
		const digest = parseDigest(raw);
		if (!digest) throw new UsageError("digest does not match the TeachDigest shape");
		const outcome = await observeDigest(digest, ctx);
		const value: Record<string, unknown> = {
			ok: true,
			captured: outcome.captured.map(captureJson),
			ms: outcome.ms,
			dropped: outcome.dropped,
			decisions: outcome.decisions,
		};
		if (outcome.skipped) value.skipped = outcome.skipped;
		const lines = outcome.skipped
			? [`Observe skipped: ${oneLine(outcome.skipped)}`]
			: [
					`Observed · ${outcome.captured.length} captured${outcome.dropped > 0 ? ` · ${outcome.dropped} dropped by Jev` : ""}`,
					...outcome.captured.map((c) => `Captured ${captureLine(c)}`),
				];
		if (outcome.decisions.length > 0) {
			const jev = outcome.decisions.map((d) => `${d.point} ${d.p === undefined ? "n/a" : d.p.toFixed(2)} ${d.action}`);
			lines.push(`Jev: ${jev.join(", ")}`);
		}
		return done(p, lines.join("\n"), value);
	} finally {
		if (inbox !== undefined) rmSync(inbox, { force: true });
	}
}

async function promote(ctx: TeachContext, p: Parsed): Promise<CliResult> {
	const store = existingStore(ctx);
	if (p.has("due")) {
		if (p.args.length > 0 || p.has("install") || p.has("mark-promoted") || p.has("target") || p.has("skill") || p.has("path")) {
			throw new UsageError("--due takes no ids and no other promote flags");
		}
		const due = promotionCandidates(ctx);
		const candidates = await filterSkillworthy(due, ctx);
		const skipped = due.length - candidates.length;
		const lines = candidates.length === 0 ? ["No moments are due for promotion."] : candidates.map(momentLine);
		if (skipped > 0) lines.push(`Jev skipped ${skipped} moment(s): not worth a standing skill.`);
		return done(p, lines.join("\n"), skipped > 0 ? { candidates, skipped } : { candidates });
	}
	if (p.args.length === 0) throw new UsageError("promote needs --due or at least one <id>");
	const marking = p.has("mark-promoted");
	if (!marking && (p.has("skill") || p.has("path"))) throw new UsageError("--skill and --path belong to --mark-promoted");
	if (marking && p.has("install")) throw new UsageError("--mark-promoted cannot be combined with --install");
	const targetText = p.one("target");
	const target = targetText === undefined ? undefined : asEnum<SkillTarget>(targetText, SKILL_TARGETS, "target");
	const moments: TeachableMoment[] = [];
	for (const token of p.args) {
		const moment = findMoment(store, token);
		if (!moment) return fail(p.json, 1, `no moment ${token}`);
		moments.push(moment);
	}
	const ids = moments.map((moment) => moment.id);

	if (marking) {
		const skill = p.one("skill");
		if (skill === undefined || target === undefined) throw new UsageError("--mark-promoted needs --skill <name> and --target <t>");
		if (!SKILL_NAME.test(skill)) throw new UsageError("--skill must be lowercase letters, digits and hyphens");
		const path = p.one("path");
		const marked = markPromoted(ids, path === undefined ? { skill, target } : { skill, target, path }, ctx);
		return done(p, `Marked ${marked.length} moment(s) promoted · ${skill} (${target})`, {
			ok: true,
			promoted: marked.map((moment) => moment.id),
		});
	}

	const chosen = target ?? targetForHost(ctx.host);
	let draft: SkillDraft;
	try {
		draft = renderSkillDraft(moments, ctx);
	} catch (error) {
		return fail(p.json, 1, oneLine(error instanceof Error ? error.message : String(error)));
	}
	const outcome = p.has("install") ? installSkill(draft, chosen, ctx) : null;
	let promoted: string[] = [];
	if (outcome && (outcome.action === "created" || outcome.action === "updated")) {
		promoted = markPromoted(ids, { skill: draft.name, target: chosen, path: outcome.path }, ctx).map((moment) => moment.id);
	}
	const value = {
		draft: { name: draft.name, description: draft.description, content: draft.content, warnings: draft.warnings },
		outcome,
		promoted,
	};
	const lines = [`Draft ${draft.name} · ${draft.description}`, ...draft.warnings.map((warning) => `warning: ${oneLine(warning)}`)];
	if (outcome) {
		lines.push(`${outcome.action} ${outcome.path}${outcome.reason ? ` · ${oneLine(outcome.reason)}` : ""}`);
		if (promoted.length > 0) lines.push(`Marked ${promoted.length} moment(s) promoted`);
	} else {
		lines.push("", draft.content);
	}
	return done(p, lines.join("\n"), value, outcome?.action === "refused" ? 1 : 0);
}

function exportCard(ctx: TeachContext, p: Parsed): CliResult {
	if (!p.has("a2a")) throw new UsageError("export needs --a2a");
	const store = existingStore(ctx);
	let moments: TeachableMoment[];
	if (p.args.length > 0) {
		moments = [];
		for (const token of p.args) {
			const moment = findMoment(store, token);
			if (!moment) return fail(p.json, 1, `no moment ${token}`);
			moments.push(moment);
		}
	} else {
		moments = newestFirst((store?.list() ?? []).filter((moment) => moment.status === "confirmed" || moment.status === "promoted"));
	}
	return { code: 0, text: JSON.stringify(toAgentCardFromMoments(moments, { name: "ultrathink" }), null, 2) };
}

/** Subcommands that change state; they refuse to run while Teachable Moments is off. */
const MUTATING: Record<string, true> = { capture: true, observe: true, confirm: true, forget: true, sync: true, promote: true };

async function dispatch(argv: readonly string[], deps: CommandDeps): Promise<CliResult> {
	const sub = argv[0];
	if (sub === undefined) throw new UsageError(`missing subcommand (${Object.keys(SPECS).join("|")})`);
	if (sub === "help" || sub === "--help" || sub === "-h") return { code: 0, text: USAGE };
	if (!Object.hasOwn(SPECS, sub)) throw new UsageError(`unknown subcommand ${sub.slice(0, 40)} (${Object.keys(SPECS).join("|")})`);
	const p = parseArgs(argv.slice(1), SPECS[sub] as Spec);
	const ctx = buildContext(deps);
	if (Object.hasOwn(MUTATING, sub) && sub !== "observe") {
		const off = offMessage(ctx);
		if (off) return fail(p.json, 1, off);
	}
	switch (sub) {
		case "status":
			return status(ctx, p);
		case "list":
			return list(ctx, p);
		case "show":
			return show(ctx, p);
		case "capture":
			return capture(ctx, p, deps);
		case "recall":
			return recall(ctx, p);
		case "confirm":
			return confirm(ctx, p);
		case "forget":
			return forget(ctx, p);
		case "sync":
			return sync(ctx, p);
		case "observe":
			return observe(ctx, p, deps);
		case "promote":
			return promote(ctx, p);
		default:
			return exportCard(ctx, p);
	}
}

/** `bin/ultrathink teach <argv…>`. Never rejects. `text` has no trailing newline. */
export async function runTeachCommand(argv: string[], deps: CommandDeps): Promise<CliResult> {
	const end = argv.indexOf("--");
	const json = (end < 0 ? argv : argv.slice(0, end)).includes("--json");
	try {
		return await dispatch(argv, deps);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof UsageError || error instanceof TeachInputError) return fail(json, 2, `teach: ${oneLine(message)}`);
		return fail(json, 1, `teach: ${oneLine(message)}`);
	}
}

