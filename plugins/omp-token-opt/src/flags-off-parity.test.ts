/**
 * Regression test for v0.2 audit gap 2: with every flag off (eight in flags.ts, graphSingleflight included), the plugin's output for every recorded fixture
 * must equal its committed golden in bench/fixtures/flags-off/.
 *
 * Goldens were recorded on origin/main (a67ddea) with every flag off, and this test pins that output. They do not re-verify
 * the pre-integration baseline in AUDIT.md. Its 10523 -> 1979 figure covers five fixtures and cannot be reproduced from the
 * current fixture bytes (five-fixture subset: 11657 -> 2004). On main the six-fixture replay gives 15815 -> 3513. The feature
 * branch gave 3511, because repeat-second's pointer text gained " for <subject>" in PR #44. That change is unflagged.
 *
 * Re-record only after an intended, reviewed change to flags-off output:
 *   bun bench/record-flags-off.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ALL_FLAGS_OFF, readFlags } from "./flags.ts";
import { type FixtureReplay, GOLDEN_DIR, listFixtureFiles, replayFixtures, serializeGolden } from "../bench/record-flags-off.ts";

const fixtures = listFixtureFiles();
const replays = new Map<string, FixtureReplay>();

beforeAll(async () => {
	for (const replay of await replayFixtures()) replays.set(replay.fixture, replay);
});

describe("all flags off parity", () => {
	test("every flag defaults to off when no flag env is set", () => {
		// A default-on flag whose code path leaves tool-result output unchanged would pass the golden checks below,
		// so the defaults are asserted directly.
		expect(readFlags({})).toEqual(ALL_FLAGS_OFF);
	});

	test("goldens and fixtures match one to one", () => {
		const goldens = readdirSync(GOLDEN_DIR)
			.filter((file) => file.endsWith(".json"))
			.sort();
		expect(goldens).toEqual(fixtures);
		expect([...replays.keys()].sort()).toEqual(fixtures);
	});

	for (const fixture of fixtures) {
		test(`${fixture} replays to its flags-off golden, byte for byte`, () => {
			const replay = replays.get(fixture);
			if (replay === undefined) throw new Error(`offline replay produced no output for ${fixture}`);
			expect(serializeGolden(replay)).toBe(readFileSync(join(GOLDEN_DIR, fixture), "utf8"));
		});
	}
});
