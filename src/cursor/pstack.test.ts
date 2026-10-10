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

	test("an impossible cap yields a reason", () => {
		const tight = buildBlock("plan", resolvePstack(cursorDir), undefined, 300);
		expect("reason" in tight).toBe(true);
	});

	test("unresolved skills yield a reason (fail-open)", () => {
		const brokenBlock = buildBlock("plan", { skillsDir: "/nonexistent" });
		expect("reason" in brokenBlock).toBe(true);
	});
});
