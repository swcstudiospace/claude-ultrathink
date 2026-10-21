// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { formatStamp, nextStamp, parseStamp, pickAtOrBefore, retentionPlan, type RetentionWindows } from "./snapshots.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-21T12:03:17.000Z");
const WINDOWS: RetentionWindows = { recentMs: HOUR, thinMs: 5 * MINUTE, windowMs: DAY };
const CLI = fileURLToPath(new URL("./snapshots-cli.ts", import.meta.url));

function at(ms: number): string {
	return `ultrathink-${formatStamp(ms)}.sqlite`;
}

function sorted(names: readonly string[]): string[] {
	return [...names].sort();
}

async function cli(args: string[], stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, CLI, ...args], {
		stdin: new Blob([stdin]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, stdout, stderr };
}

describe("parseStamp", () => {
	test("accepts the ms and seconds forms in every snapshot suffix", () => {
		const ms = Date.UTC(2026, 9, 21, 12, 0, 0, 123);
		const whole = Date.UTC(2026, 9, 21, 12, 0, 0, 0);
		expect(parseStamp("ultrathink-20261021T120000123Z.sqlite")).toBe(ms);
		expect(parseStamp("ultrathink-20261021T120000123Z")).toBe(ms);
		expect(parseStamp("ultrathink-20261021T120000123Z.tar.gz")).toBe(ms);
		expect(parseStamp("ultrathink-20261021T120000123Z.tar.gz.age")).toBe(ms);
		expect(parseStamp("ultrathink-20261021T120000Z.sqlite")).toBe(whole);
		expect(parseStamp("ultrathink-20261021T120000Z.tar.gz.age")).toBe(whole);
	});

	test("rejects names that are not real calendar times", () => {
		expect(parseStamp("ultrathink-20261301T120000123Z.sqlite")).toBeUndefined(); // month 13
		expect(parseStamp("ultrathink-20260230T120000123Z.sqlite")).toBeUndefined(); // Feb 30
		expect(parseStamp("ultrathink-20260229T120000123Z.sqlite")).toBeUndefined(); // 2026 is not a leap year
		expect(parseStamp("ultrathink-20261021T240000123Z.sqlite")).toBeUndefined(); // hour 24
		expect(parseStamp("ultrathink-20261021T126000123Z.sqlite")).toBeUndefined(); // minute 60
	});

	test("rejects .tmp- names and ultrathink- followed by letters", () => {
		expect(parseStamp(".tmp-20261021T120000123Z.sqlite")).toBeUndefined();
		expect(parseStamp(".tmp-ultrathink-20261021T120000123Z.sqlite")).toBeUndefined();
		expect(parseStamp("ultrathink-latest.sqlite")).toBeUndefined();
		expect(parseStamp("ultrathink-abcdefghTijklmnZ.sqlite")).toBeUndefined();
	});

	test("rejects other suffixes and trailing junk", () => {
		expect(parseStamp("ultrathink-20261021T120000123Z.sqlite.part")).toBeUndefined();
		expect(parseStamp("ultrathink-20261021T120000123Z.tar")).toBeUndefined();
		expect(parseStamp("notes.txt")).toBeUndefined();
	});
});

describe("formatStamp", () => {
	test("throws RangeError for non-finite input", () => {
		expect(() => formatStamp(Number.NaN)).toThrow(RangeError);
		expect(() => formatStamp(Number.POSITIVE_INFINITY)).toThrow(RangeError);
	});

	test("round-trips across midnight and through 2028-02-29", () => {
		expect(formatStamp(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe("20261231T235959999Z");
		expect(formatStamp(Date.UTC(2027, 0, 1, 0, 0, 0, 0))).toBe("20270101T000000000Z");
		expect(parseStamp("ultrathink-20270101T000000000Z.sqlite")).toBe(Date.UTC(2027, 0, 1));
		expect(formatStamp(Date.UTC(2028, 1, 29, 12, 30, 15, 7))).toBe("20280229T123015007Z");
		expect(parseStamp("ultrathink-20280229T123015007Z.sqlite")).toBe(Date.UTC(2028, 1, 29, 12, 30, 15, 7));
		for (const ms of [0, NOW, Date.UTC(2028, 1, 29, 23, 59, 59, 999), Date.UTC(2027, 0, 1) - 1]) {
			expect(parseStamp(`ultrathink-${formatStamp(ms)}`)).toBe(ms);
		}
	});
});

describe("nextStamp", () => {
	test("returns now when now is later than the newest name", () => {
		expect(nextStamp(NOW, [at(NOW - 5 * MINUTE), "notes.txt"])).toBe(formatStamp(NOW));
		expect(nextStamp(NOW, [])).toBe(formatStamp(NOW));
	});

	test("returns newest + 1 ms when now is not later, so no name repeats or sorts backward", () => {
		expect(nextStamp(NOW, [at(NOW + HOUR)])).toBe(formatStamp(NOW + HOUR + 1));
		expect(nextStamp(NOW, [at(NOW)])).toBe(formatStamp(NOW + 1));
	});

	test("stays strictly increasing across a backward clock step", () => {
		const names: string[] = [];
		for (const clock of [NOW, NOW - HOUR, NOW - HOUR, NOW - 2 * DAY, NOW + 1]) {
			names.push(`ultrathink-${nextStamp(clock, names)}.sqlite`);
		}
		const parsed = names.flatMap((name) => {
			const ms = parseStamp(name);
			return ms === undefined ? [] : [ms];
		});
		expect(parsed).toHaveLength(names.length);
		expect(new Set(names).size).toBe(names.length);
		expect(parsed).toEqual([...parsed].sort((a, b) => a - b));
		expect(new Set(parsed).size).toBe(parsed.length);
	});
});

describe("pickAtOrBefore", () => {
	const names = [at(NOW + HOUR), at(NOW - 2 * HOUR), at(NOW), "notes.txt", at(NOW - HOUR)];

	test("returns the greatest stamp at or before the target, regardless of input order", () => {
		expect(pickAtOrBefore(names, NOW - 30 * MINUTE)).toBe(at(NOW - HOUR));
		expect(pickAtOrBefore(names, NOW + 30 * MINUTE)).toBe(at(NOW));
	});

	test("includes an equal target", () => {
		expect(pickAtOrBefore(names, NOW)).toBe(at(NOW));
	});

	test("returns undefined before the first snapshot", () => {
		expect(pickAtOrBefore(names, NOW - 3 * HOUR)).toBeUndefined();
		expect(pickAtOrBefore([], NOW)).toBeUndefined();
	});

	test("rejects a non-finite target", () => {
		expect(() => pickAtOrBefore(names, Number.NaN)).toThrow(RangeError);
	});
});

describe("retentionPlan", () => {
	test("keeps a lone three-day-old snapshot (rule 1) and deletes older siblings (rule 5)", () => {
		const old3d = at(NOW - 3 * DAY);
		const old4d = at(NOW - 4 * DAY);
		const old5d = at(NOW - 5 * DAY);
		expect(retentionPlan([old3d], NOW, WINDOWS)).toEqual({ keep: [old3d], delete: [] });
		const plan = retentionPlan([old3d, old4d, old5d], NOW, WINDOWS);
		expect(plan.keep).toEqual([old3d]);
		expect(sorted(plan.delete)).toEqual(sorted([old4d, old5d]));
	});

	test("keeps everything within recentMs and keeps exactly one name per bucket in the band", () => {
		// Align the band to whole buckets so bucket membership is exact.
		const thinBase = Math.floor(NOW / (5 * MINUTE)) * (5 * MINUTE);
		const bandStart = thinBase - 2 * HOUR;
		const recent = [NOW, NOW - 30 * MINUTE, NOW - HOUR];
		const bandFirstBucket = [bandStart, bandStart + MINUTE, bandStart + 2 * MINUTE, bandStart + 4 * MINUTE];
		const bandSecondBucket = [bandStart + 5 * MINUTE, bandStart + 7 * MINUTE];
		const old = NOW - 25 * HOUR;

		const names = [...recent, ...bandFirstBucket, ...bandSecondBucket, old].map(at);
		const plan = retentionPlan(names, NOW, WINDOWS);

		expect(sorted(plan.keep)).toEqual(
			sorted([...recent, bandStart + 4 * MINUTE, bandStart + 7 * MINUTE].map(at)),
		);
		expect(sorted(plan.delete)).toEqual(
			sorted([bandStart, bandStart + MINUTE, bandStart + 2 * MINUTE, bandStart + 5 * MINUTE, old].map(at)),
		);
	});

	test("keeps future-dated names, keeps the newest non-future name, and deletes the rest", () => {
		const future = at(NOW + HOUR);
		const twoHours = at(NOW - 2 * HOUR);
		const threeDays = at(NOW - 3 * DAY);
		const plan = retentionPlan([future, twoHours, threeDays], NOW, WINDOWS);
		expect(sorted(plan.keep)).toEqual(sorted([future, twoHours]));
		expect(plan.delete).toEqual([threeDays]);
	});

	test("a future-dated name does not count as newest", () => {
		const future = at(NOW + HOUR);
		const twoDays = at(NOW - 2 * DAY);
		const threeDays = at(NOW - 3 * DAY);
		const plan = retentionPlan([future, twoDays, threeDays], NOW, WINDOWS);
		expect(sorted(plan.keep)).toEqual(sorted([future, twoDays]));
		expect(plan.delete).toEqual([threeDays]);
	});

	test("names that do not parse appear in neither list", () => {
		const current = at(NOW);
		const plan = retentionPlan(["notes.txt", ".tmp-20261021T120000123Z.sqlite", current], NOW, WINDOWS);
		expect(plan.keep).toEqual([current]);
		expect(plan.delete).toEqual([]);
	});

	test("rejects non-positive thinMs and non-finite inputs", () => {
		expect(() => retentionPlan([], NOW, { ...WINDOWS, thinMs: 0 })).toThrow(RangeError);
		expect(() => retentionPlan([], Number.NaN, WINDOWS)).toThrow(RangeError);
		expect(() => retentionPlan([], NOW, { ...WINDOWS, windowMs: -1 })).toThrow(RangeError);
	});
});

describe("snapshots-cli", () => {
	test("plan with a non-numeric argument exits 2", async () => {
		const result = await cli(["plan", "soon", "3600000", "300000", "86400000"]);
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
	});

	test("plan with the wrong argument count exits 2", async () => {
		expect((await cli(["plan", String(NOW), "3600000"])).code).toBe(2);
	});

	test("plan with a negative thinMs exits 2", async () => {
		expect((await cli(["plan", String(NOW), "3600000", "-1", "86400000"])).code).toBe(2);
	});

	test("next with names on stdin prints the expected stamp", async () => {
		const result = await cli(["next", String(NOW)], `${at(NOW - 5 * MINUTE)}\nnotes.txt\n`);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(`${formatStamp(NOW)}\n`);

		const monotonic = await cli(["next", String(NOW)], `${at(NOW + HOUR)}\n`);
		expect(monotonic.stdout).toBe(`${formatStamp(NOW + HOUR + 1)}\n`);
	});

	test("pick prints the name, and exits 1 when nothing is at or before the target", async () => {
		const names = `${at(NOW - HOUR)}\n${at(NOW)}\n`;
		expect(await cli(["pick", String(NOW - 30 * MINUTE)], names)).toEqual({
			code: 0,
			stdout: `${at(NOW - HOUR)}\n`,
			stderr: "",
		});
		expect((await cli(["pick", String(NOW - 3 * HOUR)], names)).code).toBe(1);
	});

	test("plan prints one delete line per name to remove", async () => {
		const old3d = at(NOW - 3 * DAY);
		const old4d = at(NOW - 4 * DAY);
		const result = await cli(["plan", String(NOW), String(HOUR), String(5 * MINUTE), String(DAY)], `${old3d}\n${old4d}\n`);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(`delete ${old4d}\n`);
	});

	test("stamp prints the stamp for a time; an unknown command exits 2", async () => {
		expect(await cli(["stamp", String(NOW)])).toEqual({ code: 0, stdout: `${formatStamp(NOW)}\n`, stderr: "" });
		expect((await cli(["bogus"])).code).toBe(2);
	});
});
