// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Deterministic ship signals: git branch state, GSD roadmap progress and the
 * plan's graph shape. Every probe fails open (missing -> undefined/0).
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { SessionRecord } from "../claude/state.ts";
import { defaultRun } from "./run.ts";
import type { GitSignals, GsdSignals, MilestoneEvidence, Run, ShipSignals } from "./types.ts";

const DIFF_CAP = 8000;
/** The judge reads the patch itself; larger diffs are truncated, never dropped. */
const PATCH_CAP = 24_000;

export interface ShipDiff {
	stat: string;
	log: string;
	patch?: string;
	/** True when gatherDiff cut the patch at 24,000 chars. */
	patchTruncated?: true;
}

function out(run: Run, argv: string[], cwd: string, timeoutMs?: number): string | undefined {
	const result = run(argv, { cwd, timeoutMs });
	if (result.exitCode !== 0) return undefined;
	const text = result.stdout.trim();
	return text || undefined;
}

export function parseRemote(url: string): string | undefined {
	const match = url.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
	return match ? `${match[1]}/${match[2]}` : undefined;
}

function resolveBase(run: Run, cwd: string): string | undefined {
	const gh = out(run, ["gh", "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], cwd);
	if (gh) return gh;
	const ref = out(run, ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
	return ref?.replace(/^origin\//, "");
}

function collectGit(run: Run, cwd: string): GitSignals {
	const rawBranch = out(run, ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);
	const branch = rawBranch && rawBranch !== "HEAD" ? rawBranch : undefined;
	const base = resolveBase(run, cwd);
	let ahead = 0;
	if (base) {
		run(["git", "fetch", "--quiet", "origin", base], { cwd, timeoutMs: 30_000 });
		const count = Number(out(run, ["git", "rev-list", "--count", `origin/${base}..HEAD`], cwd));
		ahead = Number.isFinite(count) ? count : 0;
	}
	const dirty: string[] = [];
	let untracked = 0;
	const status = run(["git", "status", "--porcelain"], { cwd });
	if (status.exitCode === 0) {
		for (const line of status.stdout.split("\n")) {
			if (!line.trim()) continue;
			if (line.startsWith("??")) untracked++;
			else dirty.push(line.slice(3).trim());
		}
	}
	const remote = out(run, ["git", "remote", "get-url", "origin"], cwd);
	const upstream = out(run, ["git", "rev-parse", "@{u}"], cwd);
	const head = out(run, ["git", "rev-parse", "HEAD"], cwd);
	return {
		branch,
		base,
		onBase: branch !== undefined && branch === base,
		ahead,
		dirty,
		untracked,
		repo: remote ? parseRemote(remote) : undefined,
		pushed: upstream !== undefined && upstream === head,
	};
}

function frontmatterStatus(text: string): string | undefined {
	const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const status = block?.[1]?.match(/^status:\s*["']?([^"'\r\n]+?)["']?\s*$/m);
	return status?.[1];
}

function latestVerification(cwd: string): GsdSignals["verification"] {
	try {
		const phasesDir = join(cwd, ".planning", "phases");
		const phases = readdirSync(phasesDir).sort().reverse();
		for (const phase of phases) {
			let files: string[];
			try {
				files = readdirSync(join(phasesDir, phase));
			} catch {
				continue;
			}
			const file = files.filter((name) => name.endsWith("-VERIFICATION.md")).sort().at(-1);
			if (!file) continue;
			const status = frontmatterStatus(readFileSync(join(phasesDir, phase, file), "utf8"));
			if (status) return { phase, status };
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** Frontmatter `scores:` map: the indented `key: value` lines directly under it, values trimmed of quotes. */
function frontmatterScores(text: string): Record<string, string> {
	const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
	const scores: Record<string, string> = {};
	if (!block) return scores;
	const lines = block.split(/\r?\n/);
	const start = lines.findIndex((line) => /^scores:\s*$/.test(line));
	if (start < 0) return scores;
	for (const line of lines.slice(start + 1)) {
		const entry = line.match(/^\s+([^:\s][^:]*?):\s*(.*?)\s*$/);
		if (!entry?.[1]) break;
		scores[entry[1]] = (entry[2] ?? "").replace(/^["']|["']$/g, "");
	}
	return scores;
}

/** Numeric per-component compare of `v1.10`-style versions; v1.10 > v1.9. */
function compareVersions(a: string, b: string): number {
	const pa = a.slice(1).split(".").map(Number);
	const pb = b.slice(1).split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * The newest milestone archived under `.planning/milestones/` (what `gsd-autonomous` leaves behind once the active
 * phases are gone): its phase verifications and audit. Fails open to undefined.
 */
export function latestMilestone(cwd: string): MilestoneEvidence | undefined {
	try {
		const milestonesDir = join(cwd, ".planning", "milestones");
		const version = readdirSync(milestonesDir)
			.map((name) => name.match(/^(v\d+(?:\.\d+)*)-phases$/)?.[1])
			.filter((name): name is string => name !== undefined)
			.sort(compareVersions)
			.at(-1);
		if (!version) return undefined;
		const phasesDir = join(milestonesDir, `${version}-phases`);
		const verifications: MilestoneEvidence["verifications"] = [];
		for (const phase of readdirSync(phasesDir).sort()) {
			let files: string[];
			try {
				files = readdirSync(join(phasesDir, phase));
			} catch {
				continue;
			}
			// A phase without a readable, status-bearing verification counts as "missing", never as silently passed.
			const file = files.filter((name) => name.endsWith("-VERIFICATION.md")).sort().at(-1);
			const status = file ? frontmatterStatus(readFileSync(join(phasesDir, phase, file), "utf8")) : undefined;
			verifications.push({ phase, status: status ?? "missing" });
		}
		const auditPath = join(milestonesDir, `${version}-MILESTONE-AUDIT.md`);
		let audit: MilestoneEvidence["audit"];
		if (existsSync(auditPath)) {
			const text = readFileSync(auditPath, "utf8");
			const status = frontmatterStatus(text);
			if (status) audit = { status, scores: frontmatterScores(text) };
		}
		return { version, verifications, ...(audit ? { audit } : {}) };
	} catch {
		return undefined;
	}
}

type Env = Record<string, string | undefined>;

/** The project-local install locations (the first candidates); a copy tracked by the repository is repository code, never run. */
const LOCAL_CANDIDATES = 4;

/** Where GSD installs gsd-tools.cjs, in lookup order: project-local installs (incl. legacy), then each host's config dir, then the legacy home path. */
export function gsdToolsCandidates(cwd: string, env: Env, home: string): string[] {
	const tool = (dir: string): string => join(dir, "gsd-core", "bin", "gsd-tools.cjs");
	return [
		tool(cwd),
		tool(join(cwd, ".claude")),
		tool(join(cwd, ".codex")),
		join(cwd, ".claude", "get-shit-done", "bin", "gsd-tools.cjs"),
		...(env.CLAUDE_CONFIG_DIR ? [tool(env.CLAUDE_CONFIG_DIR)] : []),
		tool(join(home, ".claude")),
		tool(join(home, ".agents")),
		tool(env.HERMES_HOME || join(home, ".hermes")),
		tool(env.CODEX_HOME || join(home, ".codex")),
		tool(env.GEMINI_CONFIG_DIR || join(home, ".gemini")),
		tool(join(home, ".cursor")),
		tool(join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")),
		join(home, ".claude", "get-shit-done", "bin", "gsd-tools.cjs"),
	];
}

export interface GsdToolsLookup {
	/** `GSD_TOOLS` when set, else the first installed gsd-tools.cjs that is not repository code; undefined when none. */
	path?: string;
	/** Project-local copies that exist but are tracked by the repository being shipped, so were skipped. */
	tracked: string[];
}

export interface GsdToolsInput {
	cwd: string;
	env?: Env;
	home?: string;
	exists?: (path: string) => boolean;
	/** Whether a project-local candidate is tracked by the repository; defaults to `git ls-files --error-unmatch` via `run`. */
	isTracked?: (path: string) => boolean;
	run?: Run;
}

/** `path` with symlinks resolved; `path` itself when it cannot be resolved. */
function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Finds gsd-tools.cjs. A project-local candidate is used only when the repository does not track it: a committed copy
 * is code controlled by whoever authored the repository and would otherwise run on `ship assess|pr`.
 */
export function lookupGsdTools(input: GsdToolsInput): GsdToolsLookup {
	const env = input.env ?? process.env;
	if (env.GSD_TOOLS) return { path: env.GSD_TOOLS, tracked: [] };
	const exists = input.exists ?? existsSync;
	const run = input.run ?? defaultRun;
	const isTracked =
		input.isTracked ??
		((path: string) => {
			// A tracked symlink must not hide the code it leads to, so the check runs on the resolved path.
			const root = realOrSelf(input.cwd);
			const target = relative(root, realOrSelf(path));
			if (target === "" || target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) return false;
			return run(["git", "ls-files", "--error-unmatch", target], { cwd: input.cwd }).exitCode === 0;
		});
	const tracked: string[] = [];
	const candidates = gsdToolsCandidates(input.cwd, env, input.home ?? homedir());
	const path = candidates.find((candidate, index) => {
		if (!exists(candidate)) return false;
		if (index >= LOCAL_CANDIDATES || !isTracked(candidate)) return true;
		tracked.push(candidate);
		return false;
	});
	return { path, tracked };
}

/** `GSD_TOOLS` when set, else the first installed gsd-tools.cjs; undefined when GSD is not installed anywhere known. */
export function resolveGsdTools(input: GsdToolsInput): string | undefined {
	return lookupGsdTools(input).path;
}

function collectGsd(run: Run, cwd: string, tools: GsdToolsLookup): GsdSignals | undefined {
	if (!existsSync(join(cwd, ".planning", "ROADMAP.md"))) return undefined;
	const trusted =
		run(["git", "ls-files", "--error-unmatch", ".planning/ROADMAP.md"], { cwd }).exitCode === 0 ||
		run(["git", "check-ignore", "-q", ".planning"], { cwd }).exitCode === 0;
	let state: string | undefined;
	try {
		state = frontmatterStatus(readFileSync(join(cwd, ".planning", "STATE.md"), "utf8"));
	} catch {
		state = undefined;
	}
	// Roadmap counts fail open to 0/0; trust and state still gate shipping. Tools or node that are not installed are a gap.
	let phaseCount = 0;
	let completedPhases = 0;
	const verification = latestVerification(cwd);
	// Archived milestone evidence only stands in when no active phase has a verification.
	const milestone = verification ? undefined : latestMilestone(cwd);
	const archived = milestone ? { milestone } : {};
	// A tracked project-local copy is reported so the operator sees why it was not used.
	const skipped = tools.tracked.length ? { toolsTracked: true } : {};
	const gsdTools = tools.path;
	if (!gsdTools) {
		return { phaseCount, completedPhases, trusted, state, verification, ...archived, ...skipped, toolsMissing: true };
	}
	const analyzed = run(["node", gsdTools, "query", "roadmap.analyze", "--cwd", cwd], { cwd });
	if (analyzed.exitCode === 127 || /ENOENT/.test(analyzed.stderr)) {
		return { phaseCount, completedPhases, trusted, state, verification, ...archived, ...skipped, nodeMissing: true };
	}
	const text = analyzed.exitCode === 0 ? analyzed.stdout.trim() : "";
	try {
		const parsed = text ? (JSON.parse(text) as { phase_count?: unknown; completed_phases?: unknown }) : {};
		if (typeof parsed.phase_count === "number") phaseCount = parsed.phase_count;
		if (typeof parsed.completed_phases === "number") completedPhases = parsed.completed_phases;
	} catch {
		phaseCount = 0;
	}
	return { phaseCount, completedPhases, trusted, state, verification, ...archived, ...skipped };
}

function collectGraph(record: SessionRecord): ShipSignals["graph"] {
	const graph = record.graph;
	if (!graph) return undefined;
	const conclusion = graph.nodes.find((node) => node.kind === "synthesize")?.conclusion ?? "";
	const workflowUnits = conclusion.split("\n").filter((line) => /^\s*(?:[-*]\s*)?\**Wave\b/i.test(line)).length;
	return { nodes: graph.nodes.length, workflowUnits };
}

export function collectSignals(input: {
	cwd: string;
	record: SessionRecord;
	run?: Run;
	gsdTools?: string;
	env?: Env;
	home?: string;
}): ShipSignals {
	const run = input.run ?? defaultRun;
	const tools =
		input.gsdTools === undefined
			? lookupGsdTools({ cwd: input.cwd, env: input.env, home: input.home, run })
			: { path: input.gsdTools, tracked: [] };
	return {
		git: collectGit(run, input.cwd),
		gsd: collectGsd(run, input.cwd, tools),
		graph: collectGraph(input.record),
	};
}

function cap(text: string, limit = DIFF_CAP): string {
	return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text;
}

const LOCKFILES = [":(exclude)*.lock", ":(exclude)*.lockb", ":(exclude)package-lock.json", ":(exclude)pnpm-lock.yaml"];

export function gatherDiff(input: { cwd: string; base: string; run?: Run }): ShipDiff {
	const run = input.run ?? defaultRun;
	const range = `origin/${input.base}...HEAD`;
	const stat = cap(out(run, ["git", "diff", "--stat", range], input.cwd) ?? "");
	const log = cap(out(run, ["git", "log", "--oneline", `origin/${input.base}..HEAD`], input.cwd) ?? "");
	const patch = out(run, ["git", "diff", range, "--", ".", ...LOCKFILES], input.cwd) ?? "";
	return { stat, log, patch: cap(patch, PATCH_CAP), ...(patch.length > PATCH_CAP ? { patchTruncated: true as const } : {}) };
}
