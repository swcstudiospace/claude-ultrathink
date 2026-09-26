// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Deterministic ship signals: git branch state, GSD roadmap progress and the
 * plan's graph shape. Every probe fails open (missing -> undefined/0).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** `GSD_TOOLS` when set, else the first installed gsd-tools.cjs; undefined when GSD is not installed anywhere known. */
export function resolveGsdTools(input: {
	cwd: string;
	env?: Env;
	home?: string;
	exists?: (path: string) => boolean;
}): string | undefined {
	const env = input.env ?? process.env;
	if (env.GSD_TOOLS) return env.GSD_TOOLS;
	const exists = input.exists ?? existsSync;
	return gsdToolsCandidates(input.cwd, env, input.home ?? homedir()).find((path) => exists(path));
}

function collectGsd(run: Run, cwd: string, gsdTools: string | undefined): GsdSignals | undefined {
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
	if (!gsdTools) return { phaseCount, completedPhases, trusted, state, verification, ...archived, toolsMissing: true };
	const analyzed = run(["node", gsdTools, "query", "roadmap.analyze", "--cwd", cwd], { cwd });
	if (analyzed.exitCode === 127 || /ENOENT/.test(analyzed.stderr)) {
		return { phaseCount, completedPhases, trusted, state, verification, ...archived, nodeMissing: true };
	}
	const text = analyzed.exitCode === 0 ? analyzed.stdout.trim() : "";
	try {
		const parsed = text ? (JSON.parse(text) as { phase_count?: unknown; completed_phases?: unknown }) : {};
		if (typeof parsed.phase_count === "number") phaseCount = parsed.phase_count;
		if (typeof parsed.completed_phases === "number") completedPhases = parsed.completed_phases;
	} catch {
		phaseCount = 0;
	}
	return { phaseCount, completedPhases, trusted, state, verification, ...archived };
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
	const gsdTools = input.gsdTools ?? resolveGsdTools({ cwd: input.cwd, env: input.env, home: input.home });
	return {
		git: collectGit(run, input.cwd),
		gsd: collectGsd(run, input.cwd, gsdTools),
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
	return {
		stat: cap(out(run, ["git", "diff", "--stat", range], input.cwd) ?? ""),
		log: cap(out(run, ["git", "log", "--oneline", `origin/${input.base}..HEAD`], input.cwd) ?? ""),
		patch: cap(out(run, ["git", "diff", range, "--", ".", ...LOCKFILES], input.cwd) ?? "", PATCH_CAP),
	};
}
