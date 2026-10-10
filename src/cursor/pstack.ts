// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Cursor pstack bridge — pure resolution, detection and instruction-block logic.
 *
 * Ported one-to-one from the passing phase-23 prototype
 * (`.planning/phases/23-cursor-bridge-design-and-detection-proof/23-proof.mjs`),
 * which is the behavioral spec for this module. Resolves Cursor's plugin cache
 * to the newest completed pstack install, maps `/gsd-*` slash commands in a
 * prompt to a workflow stage, and renders the block that tells the agent which
 * pstack skills to run alongside the GSD step. Pure: no env reads, no writes,
 * and never a throw — every failure path returns `{ reason }`.
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent, type Stats } from "node:fs";
import { join } from "node:path";

/** The workflow stages a prompt can map to; "orchestrate" fans out over the other four. */
export type PstackStage = "discuss" | "plan" | "execute" | "review" | "orchestrate";

/** The stages that own a mapping entry. */
type StageKey = Exclude<PstackStage, "orchestrate">;

/** A resolved pstack cache, or the failure to resolve one. */
export type PstackResolution = { root: string; version: string; skillsDir: string } | { reason: string };

/** Anything {@link skillPath} and {@link buildBlock} accept: a resolution, a failure, or a stand-in context. */
export type PstackInput = { skillsDir?: string | undefined; reason?: string | undefined };

/** The sync fs surface this module needs; injectable so tests can force failures. */
export interface PstackFs {
	existsSync(path: string): boolean;
	readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
	readFileSync(path: string, encoding: "utf8"): string;
	statSync(path: string): Stats;
}

const defaultFs = { existsSync, readdirSync, readFileSync, statSync } satisfies PstackFs;

/** Where detection says the prompt sits in the workflow; `stage: null` plus a `reason` when it does not. */
export interface StageDetection {
	stage: PstackStage | null;
	command?: string | undefined;
	/** Present only for "orchestrate": the four stages the router walks. */
	router?: readonly StageKey[] | undefined;
	reason?: string | undefined;
}

/** Skill names per stage; an override replaces the stage's list rather than merging. */
export type StageMapping = Partial<Record<StageKey, readonly string[]>>;

const COMMAND_STAGE: ReadonlyArray<readonly [RegExp, PstackStage]> = [
	[/^gsd-discuss-phase$/, "discuss"],
	[/^gsd-(plan-phase|ultraplan-phase|spec-phase)$/, "plan"],
	[/^gsd-(execute-phase|fast|quick|quick-batch)$/, "execute"],
	[/^gsd-(verify-work|code-review|ui-review|audit-uat|audit-fix|audit-milestone)$/, "review"],
	[/^gsd-ship$/, "review"],
	[/^gsd-autonomous$/, "orchestrate"],
];

const ALL_STAGES: readonly StageKey[] = ["discuss", "plan", "execute", "review"];

const cacheComplete = (dir: string, fs: PstackFs): boolean => {
	try {
		return fs.statSync(join(dir, ".cache-complete")).size === 0;
	} catch {
		return false;
	}
};

const semver = (version: string): number[] => String(version).split(".").map((part) => Number.parseInt(part, 10) || 0);

/**
 * Find the newest completed pstack plugin under
 * `<cursorDir>/plugins/cache/cursor-public/pstack`. A candidate needs a
 * `.cursor-plugin/plugin.json` with `name === "pstack"` and a 0-byte
 * `.cache-complete` marker; the highest manifest semver wins (marker mtime
 * breaks ties). Any failure — including an injected one — is a `reason`.
 */
export function resolvePstack(cursorDir: string, fs: PstackFs = defaultFs): PstackResolution {
	try {
		const base = join(cursorDir, "plugins", "cache", "cursor-public", "pstack");
		if (!fs.existsSync(base)) return { reason: "pstack cache directory not found" };
		const candidates: Array<{ dir: string; version: string; mtime: number }> = [];
		for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = join(base, entry.name);
			const manifestPath = join(dir, ".cursor-plugin", "plugin.json");
			if (!fs.existsSync(manifestPath)) continue;
			if (!cacheComplete(dir, fs)) continue;
			let manifest: { name?: unknown; version?: unknown };
			try {
				manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: unknown; version?: unknown };
			} catch {
				continue;
			}
			if (manifest.name !== "pstack") continue;
			candidates.push({
				dir,
				version: String(manifest.version ?? "0.0.0"),
				mtime: fs.statSync(join(dir, ".cache-complete")).mtimeMs,
			});
		}
		if (candidates.length === 0) return { reason: "no completed pstack plugin directory in cache" };
		candidates.sort((a, b) => {
			const va = semver(a.version);
			const vb = semver(b.version);
			for (let i = 0; i < 3; i++) {
				const na = va[i];
				const nb = vb[i];
				if (na !== nb) return Number(nb) - Number(na);
			}
			return b.mtime - a.mtime;
		});
		const winner = candidates[0]!;
		return { root: winner.dir, version: winner.version, skillsDir: join(winner.dir, "skills") };
	} catch (error) {
		return { reason: `resolution failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * The SKILL.md path for a skill inside a resolved cache, or why it is unusable.
 * Only an existing regular file resolves; anything else is a `reason`, never a throw.
 */
export function skillPath(resolved: PstackInput | undefined, name: string): { path: string } | { reason: string } {
	if (!resolved?.skillsDir) return { reason: resolved?.reason ?? "pstack not resolved" };
	const path = join(resolved.skillsDir, name, "SKILL.md");
	try {
		if (!statSync(path).isFile()) return { reason: `skill ${name}: not a file` };
		return { path };
	} catch {
		return { reason: `skill ${name}: missing` };
	}
}

/**
 * Detect the workflow stage implied by `/gsd-*` slash commands in the prompt.
 * Non-string payloads and prompts without a mapped command return
 * `stage: null` with a reason; "orchestrate" carries the four-stage router.
 */
export function detectStage(prompt: unknown): StageDetection {
	if (typeof prompt !== "string") return { stage: null, reason: "payload prompt is not a string" };
	const tokens = prompt.toLowerCase().match(/\/gsd-[a-z0-9-]+/g) ?? [];
	const stages: PstackStage[] = [];
	let matched: string | undefined;
	for (const token of tokens) {
		const command = token.slice(1);
		for (const [pattern, stage] of COMMAND_STAGE) {
			if (pattern.test(command)) {
				if (!stages.includes(stage)) stages.push(stage);
				matched ??= command;
			}
		}
	}
	if (stages.length === 0) {
		return { stage: null, reason: matched ? `unmapped gsd command ${matched}` : "no gsd command in prompt" };
	}
	if (stages.includes("orchestrate")) return { stage: "orchestrate", command: matched, router: ALL_STAGES };
	const stage = stages[0] ?? null;
	return { stage, command: matched };
}

/** The default skill set per stage. */
export const DEFAULT_MAPPING: Record<StageKey, readonly string[]> = {
	discuss: ["how"],
	plan: ["architect", "arena"],
	execute: ["tdd"],
	review: ["interrogate", "no-comments"],
};

const PURPOSES: Record<string, string> = {
	how: "read-only walkthrough of how the subsystem works before discussing changes",
	architect: "settle caller usage, types and module shape before the plan locks a design",
	arena: "run parallel alternative attempts and keep the best parts before committing to a design",
	tdd: "write the failing test first, then the fix, while executing",
	interrogate: "have different models try to break the diff during verification or review",
	"no-comments": "strip comments before review and fix accepted findings during verification or review",
};

const MOMENTS: Record<StageKey, string> = {
	discuss: "while gathering context, before proposing the design",
	plan: "while designing the phase, before the plan is finalized",
	execute: "while writing the change, test first",
	review: "while verifying and reviewing the completed change",
};

/** A rendered instruction block, or why none could be produced. */
export type StageBlock = { block: string; skills: number } | { reason: string };

/**
 * Render the "run these pstack skills" block for a stage (or, for
 * "orchestrate", one block spanning all four stages at their moments). Skills
 * that fail to resolve are skipped and noted inside the block; when nothing
 * resolves — or even one entry cannot fit under `cap` — the result is a
 * `reason` instead of a block truncated past usefulness.
 */
export function buildBlock(
	stage: PstackStage,
	resolved: PstackInput,
	mapping: StageMapping = DEFAULT_MAPPING,
	cap = 2000,
): StageBlock {
	const stages: readonly StageKey[] = stage === "orchestrate" ? ALL_STAGES : [stage];
	const entries: Array<{ stage: StageKey; name: string; path: string; purpose: string }> = [];
	const dropped: string[] = [];
	for (const s of stages) {
		for (const name of mapping[s] ?? []) {
			const skill = skillPath(resolved, name);
			if ("reason" in skill) {
				dropped.push(`${s}/${name}: ${skill.reason}`);
				continue;
			}
			entries.push({ stage: s, name, path: skill.path, purpose: PURPOSES[name] ?? `pstack ${name} skill` });
		}
	}
	if (entries.length === 0) {
		return { reason: `no resolvable skills${dropped.length ? ` (${dropped.join("; ")})` : ""}` };
	}
	const header = `pstack alongside GSD (${stage === "orchestrate" ? "orchestrate: apply each at its moment" : stage})`;
	const render = (list: typeof entries): string => {
		const lines = [
			header,
			"Run these pstack skills alongside the GSD step, by reading each SKILL.md, then continue the GSD workflow unchanged:",
		];
		for (const e of list) lines.push(`- [${e.stage}] ${e.name} — read ${e.path} — ${e.purpose} (${MOMENTS[e.stage]})`);
		if (dropped.length) lines.push(`- skipped: ${dropped.join("; ")}`);
		return lines.join("\n");
	};
	let list = entries;
	let block = render(list);
	while (block.length > cap && list.length > 1) {
		list = list.slice(0, -1);
		block = render(list) + `\n- (truncated by cap; ${entries.length - list.length} more skill(s) omitted)`;
	}
	if (block.length > cap) return { reason: `cap ${cap} too small for even one skill (needed ${block.length})` };
	return { block, skills: list.length };
}
