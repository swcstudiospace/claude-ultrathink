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
import type { GitSignals, GsdSignals, Run, ShipSignals } from "./types.ts";

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

function collectGsd(run: Run, cwd: string, gsdTools: string): GsdSignals | undefined {
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
	// Roadmap counts fail open to 0/0; trust and state still gate shipping.
	let phaseCount = 0;
	let completedPhases = 0;
	const text = out(run, ["node", gsdTools, "query", "roadmap.analyze", "--cwd", cwd], cwd);
	try {
		const parsed = text ? (JSON.parse(text) as { phase_count?: unknown; completed_phases?: unknown }) : {};
		if (typeof parsed.phase_count === "number") phaseCount = parsed.phase_count;
		if (typeof parsed.completed_phases === "number") completedPhases = parsed.completed_phases;
	} catch {
		phaseCount = 0;
	}
	return { phaseCount, completedPhases, trusted, state, verification: latestVerification(cwd) };
}

function collectGraph(record: SessionRecord): ShipSignals["graph"] {
	const graph = record.graph;
	if (!graph) return undefined;
	const conclusion = graph.nodes.find((node) => node.kind === "synthesize")?.conclusion ?? "";
	const workflowUnits = conclusion.split("\n").filter((line) => /^\s*(?:[-*]\s*)?\**Wave\b/i.test(line)).length;
	return { nodes: graph.nodes.length, workflowUnits };
}

export function collectSignals(input: { cwd: string; record: SessionRecord; run?: Run; gsdTools?: string }): ShipSignals {
	const run = input.run ?? defaultRun;
	const gsdTools =
		input.gsdTools ?? process.env.GSD_TOOLS ?? join(homedir(), ".agents", "gsd-core", "bin", "gsd-tools.cjs");
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
