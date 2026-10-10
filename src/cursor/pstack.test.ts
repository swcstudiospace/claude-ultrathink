// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
// Covers the 19 prototype behaviors from
// .planning/phases/23-cursor-bridge-design-and-detection-proof/23-proof.mjs
// against synthetic fixture caches under a temp dir (never the live ~/.cursor),
// plus one injected-fs failure.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildBlock,
	DEFAULT_MAPPING,
	detectStage,
	resolvePstack,
	skillPath,
	type PstackFs,
	type PstackResolution,
	type StageBlock,
} from "./pstack.ts";

const SIX = [
	DEFAULT_MAPPING.discuss,
	DEFAULT_MAPPING.plan,
	DEFAULT_MAPPING.execute,
	DEFAULT_MAPPING.review,
].flat();

let dir = "";
let cursorDir = "";
let multiDir = "";

/** Build one cache entry the way Cursor lays it out: manifest, a `how` skill, optional completion marker. */
function mkPlugin(cacheRoot: string, ref: string, version: string, completeMarker: boolean, name = "pstack"): string {
	const pluginDir = join(cacheRoot, ref);
	mkdirSync(join(pluginDir, ".cursor-plugin"), { recursive: true });
	writeFileSync(join(pluginDir, ".cursor-plugin", "plugin.json"), JSON.stringify({ name, version }));
	mkdirSync(join(pluginDir, "skills", "how"), { recursive: true });
	writeFileSync(join(pluginDir, "skills", "how", "SKILL.md"), "# how\n");
	if (completeMarker) writeFileSync(join(pluginDir, ".cache-complete"), "");
	return pluginDir;
}

function resolvedOrThrow(resolution: PstackResolution): { root: string; version: string; skillsDir: string } {
	if ("reason" in resolution) throw new Error(resolution.reason);
	return resolution;
}

function blockOrThrow(result: StageBlock): { block: string; skills: number } {
	if ("reason" in result) throw new Error(result.reason);
	return result;
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pstack-core-"));
	cursorDir = join(dir, "single");
	const singleCache = join(cursorDir, "plugins", "cache", "cursor-public", "pstack");
	mkdirSync(singleCache, { recursive: true });
	const root = mkPlugin(singleCache, "only-ref", "0.15.15", true);
	for (const name of SIX) {
		if (name === "how") continue;
		mkdirSync(join(root, "skills", name));
		writeFileSync(join(root, "skills", name, "SKILL.md"), `# ${name}\n`);
	}
	multiDir = join(dir, "multi");
	const multiCache = join(multiDir, "plugins", "cache", "cursor-public", "pstack");
	mkdirSync(multiCache, { recursive: true });
	mkPlugin(multiCache, "older-ref", "0.14.0", true);
	mkPlugin(multiCache, "newest-ref", "0.15.15", true);
	mkPlugin(multiCache, "incomplete-ref", "0.16.0", false);
	mkPlugin(multiCache, "wrong-name-ref", "9.9.9", true, "other-plugin");
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("resolvePstack", () => {
	test("resolves the completed pstack cache with version and root", () => {
		const real = resolvedOrThrow(resolvePstack(cursorDir));
		expect(real.version).toBe("0.15.15");
		expect(real.root.endsWith("only-ref")).toBe(true);
	});

	test("newest completed pstack wins over older, incomplete, and wrong-name caches", () => {
		const synth = resolvedOrThrow(resolvePstack(multiDir));
		expect(synth.version).toBe("0.15.15");
		expect(synth.root.endsWith("newest-ref")).toBe(true);
	});

	test("missing cursor dir yields a reason, never a throw", () => {
		const missing = resolvePstack(join(dir, "nope"));
		expect("reason" in missing).toBe(true);
	});

	test("injected fs failure (readdirSync throws) yields a reason, never a throw", () => {
		const boom: PstackFs = {
			existsSync: () => true,
			readdirSync: () => {
				throw new Error("disk unavailable");
			},
			readFileSync: () => "",
			statSync: () => {
				throw new Error("unreachable");
			},
		};
		const failed = resolvePstack(cursorDir, boom);
		if (!("reason" in failed)) throw new Error("expected a reason");
		expect(failed.reason).toBe("resolution failed: disk unavailable");
	});
});

describe("skillPath", () => {
	test("the six default skills resolve to their SKILL.md files", () => {
		const real = resolvedOrThrow(resolvePstack(cursorDir));
		for (const name of SIX) {
			const found = skillPath(real, name);
			if (!("path" in found)) throw new Error(`${name}: ${found.reason}`);
			expect(found.path.endsWith(join("skills", name, "SKILL.md"))).toBe(true);
		}
	});
});

describe("detectStage", () => {
	test("/gsd-plan-phase maps to plan", () => {
		expect(detectStage("/gsd-plan-phase 23").stage).toBe("plan");
	});

	test("/gsd-execute-phase maps to execute", () => {
		expect(detectStage("/gsd-execute-phase").stage).toBe("execute");
	});

	test("/gsd-verify-work maps to review", () => {
		expect(detectStage("/gsd-verify-work 24").stage).toBe("review");
	});

	test("/gsd-discuss-phase maps to discuss", () => {
		expect(detectStage("/gsd-discuss-phase 23").stage).toBe("discuss");
	});

	test("/gsd-fast maps to execute", () => {
		expect(detectStage("/gsd-fast fix the typo").stage).toBe("execute");
	});

	test("/gsd-autonomous maps to orchestrate with the four-stage router", () => {
		const auto = detectStage("/gsd-autonomous --from 23");
		expect(auto.stage).toBe("orchestrate");
		expect(auto.router?.join(",")).toBe(["discuss", "plan", "execute", "review"].join(","));
	});

	test("a non-gsd question maps to null", () => {
		expect(detectStage("how does the ship gate work?").stage).toBeNull();
	});

	test("a pstack command is not a gsd command", () => {
		expect(detectStage("/architect this please").stage).toBeNull();
	});

	test("an empty prompt maps to null", () => {
		expect(detectStage("").stage).toBeNull();
	});

	test("malformed payloads map to null without throwing", () => {
		expect(detectStage(undefined).stage).toBeNull();
		expect(detectStage(undefined).reason).toBe("payload prompt is not a string");
		expect(detectStage(42).stage).toBeNull();
	});

	test("a question or a quoted example that only mentions a command is not an invocation", () => {
		expect(detectStage("What does `/gsd-ship` do?").stage).toBeNull();
		expect(detectStage("What does /gsd-ship do?").stage).toBeNull();
		expect(detectStage('"/gsd-plan-phase"').stage).toBeNull();
		expect(detectStage("`/gsd-ship`").stage).toBeNull();
		expect(detectStage('"\n/gsd-ship\n"').stage).toBeNull();
		expect(detectStage("'\n/gsd-plan-phase 23\n'").stage).toBeNull();
		expect(detectStage("What does\n`/gsd-ship`\ndo?").stage).toBeNull();
		expect(detectStage("```\n/gsd-ship\n```").stage).toBeNull();
		expect(detectStage("\u201c\n/gsd-ship\n\u201d").stage).toBeNull();
	});

	test("a contraction before a command on the next line is still an invocation", () => {
		expect(detectStage("don't stop\n/gsd-plan-phase 23").stage).toBe("plan");
		expect(detectStage('notes\n"\n/gsd-ship\n"\n/gsd-plan-phase 23').stage).toBe("plan");
	});

	test("an inch mark is not a quote, so a command between it and a later quote is still an invocation", () => {
		const prompt = 'The panel is 12" wide.\n/gsd-plan-phase 24\nUse the label "Continue".';
		expect(detectStage(prompt).stage).toBe("plan");
		expect(detectStage(prompt).command).toBe("gsd-plan-phase");
		expect(detectStage('12"\n/gsd-plan-phase 24').stage).toBe("plan");
		expect(detectStage('"12"\n/gsd-plan-phase 24').stage).toBe("plan");
	});

	test("a command at the start of a later line is still an invocation", () => {
		expect(detectStage("notes about the milestone\n/gsd-plan-phase 23").stage).toBe("plan");
		expect(detectStage("/gsd-plan-phase 23\nWhat does `/gsd-ship` do?").stage).toBe("plan");
	});
});

describe("buildBlock", () => {
	test("plan carries architect and arena with real paths", () => {
		const real = resolvedOrThrow(resolvePstack(cursorDir));
		const planBlock = blockOrThrow(buildBlock("plan", real));
		expect(planBlock.skills).toBe(2);
		expect(planBlock.block.includes("architect")).toBe(true);
		expect(planBlock.block.includes(join(real.skillsDir, "architect", "SKILL.md"))).toBe(true);
		expect(planBlock.block.includes("arena")).toBe(true);
	});

	test("orchestrate router carries all four moments within the default cap", () => {
		const autoBlock = blockOrThrow(buildBlock("orchestrate", resolvePstack(cursorDir)));
		for (const name of SIX) expect(autoBlock.block.includes(name)).toBe(true);
		expect(autoBlock.block.length).toBeLessThanOrEqual(2000);
	});

	test("cap truncates from the right and notes the omission", () => {
		const capped = blockOrThrow(buildBlock("plan", resolvePstack(cursorDir), undefined, 600));
		expect(capped.block.length).toBeLessThanOrEqual(600);
		expect(capped.block.includes("truncated by cap")).toBe(true);
		expect(capped.skills).toBe(1);
	});

	test("a null plugin.json does not hide a valid sibling", () => {
		const root = mkdtempSync(join(tmpdir(), "pstack-null-manifest-"));
		try {
			const cache = join(root, "plugins", "cache", "cursor-public", "pstack");
			mkPlugin(cache, "broken", "9.9.9", true);
			writeFileSync(join(cache, "broken", ".cursor-plugin", "plugin.json"), "null");
			mkPlugin(cache, "good", "1.0.0", true);
			const resolved = resolvedOrThrow(resolvePstack(root));
			expect(resolved.version).toBe("1.0.0");
			expect(resolved.root.endsWith("good")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an impossible cap yields a reason", () => {
		const tight = buildBlock("plan", resolvePstack(cursorDir), undefined, 300);
		expect("reason" in tight).toBe(true);
	});

	test("unresolved skills yield a reason (fail-open)", () => {
		const brokenBlock = buildBlock("plan", { skillsDir: "/nonexistent" });
		expect("reason" in brokenBlock).toBe(true);
	});

	test("a skipped-skill note is shortened or dropped before a usable instruction is removed", () => {
		const real = resolvedOrThrow(resolvePstack(cursorDir));
		const both = blockOrThrow(buildBlock("plan", real, { plan: ["architect", "arena"] }));
		const short = `${both.block}\n- skipped: 1 missing skill(s)`;
		const shortened = buildBlock("plan", real, { plan: ["architect", "arena", "not-a-skill"] }, short.length);
		if (!("block" in shortened)) throw new Error(shortened.reason);
		expect(shortened.skills).toBe(2);
		expect(shortened.block).toContain("missing skill(s)");
		expect(shortened.block).not.toContain("not-a-skill");
		expect(shortened.block).not.toContain("truncated by cap");

		const bare = blockOrThrow(buildBlock("plan", real, { plan: ["architect"] }));
		const dropped = buildBlock("plan", real, { plan: ["architect", "not-a-skill"] }, bare.block.length);
		if (!("block" in dropped)) throw new Error(dropped.reason);
		expect(dropped.skills).toBe(1);
		expect(dropped.block).toContain("architect");
		expect(dropped.block).not.toContain("not-a-skill");
		expect(dropped.block.length).toBeLessThanOrEqual(bare.block.length);
	});
});
