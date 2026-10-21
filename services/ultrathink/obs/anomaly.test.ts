// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type AnomalyDetector, createAnomalyDetector, DEFAULT_ANOMALY_RULES, parseAnomalyRules } from "./anomaly.ts";

/** Seconds to the milliseconds the detector's clock uses. */
const at = (seconds: number): number => seconds * 1000;

/** A detector whose clock is set explicitly by the test. */
function detectorAt(rules: Parameters<typeof createAnomalyDetector>[0]["rules"]): { detector: AnomalyDetector; setNow: (seconds: number) => void } {
	let now = 0;
	const detector = createAnomalyDetector({ rules, now: () => now });
	return { detector, setNow: (seconds) => (now = at(seconds)) };
}

/** Runs `fn` and returns the RangeError it throws; fails the test if it throws anything else or nothing. */
function rangeErrorOf(fn: () => unknown): RangeError {
	try {
		fn();
	} catch (error) {
		if (error instanceof RangeError) return error;
		throw error;
	}
	throw new Error("expected a RangeError");
}

describe("sliding window threshold", () => {
	test("count 3 in 60 s: events at 0, 30 and 61 do not alert; a fourth at 62 alerts once; a fifth at 63 does not", () => {
		const { detector, setNow } = detectorAt([{ name: "burst", event: "e", count: 3, windowSec: 60 }]);
		const observe = (seconds: number) => {
			setNow(seconds);
			return detector.observe("e", {});
		};

		expect(observe(0)).toEqual([]);
		expect(observe(30)).toEqual([]);
		expect(observe(61)).toEqual([]);
		expect(observe(62)).toEqual([{ rule: "burst", key: "*", count: 3, windowSec: 60 }]);
		expect(observe(63)).toEqual([]);
	});

	test("a key alerts again after its suppression window and a fresh threshold crossing", () => {
		const { detector, setNow } = detectorAt([{ name: "burst", event: "e", count: 3, windowSec: 60 }]);
		const observe = (seconds: number) => {
			setNow(seconds);
			return detector.observe("e", {});
		};

		observe(0);
		observe(1);
		expect(observe(2)).toHaveLength(1);
		// Suppressed until 62 s; the three events 200, 201 and 202 are a new threshold crossing.
		observe(200);
		observe(201);
		expect(observe(202)).toHaveLength(1);
	});
});

describe("groupBy", () => {
	test("three events for ip A and two for ip B with count 3 alert only for A", () => {
		const { detector, setNow } = detectorAt([{ name: "fail", event: "login_failed", count: 3, windowSec: 60, groupBy: "ip" }]);
		const alerts = [];
		for (const [second, ip] of [
			[0, "A"],
			[1, "B"],
			[2, "A"],
			[3, "B"],
			[4, "A"],
		] as const) {
			setNow(second);
			alerts.push(...detector.observe("login_failed", { ip }));
		}

		expect(alerts).toEqual([{ rule: "fail", key: "A", count: 3, windowSec: 60 }]);
	});

	test("an event without the grouping field is not counted", () => {
		const { detector, setNow } = detectorAt([{ name: "fail", event: "login_failed", count: 1, windowSec: 60, groupBy: "ip" }]);
		setNow(0);
		expect(detector.observe("login_failed", {})).toEqual([]);
	});
});

describe("where filter", () => {
	test("events that do not match the where object are not counted", () => {
		const { detector, setNow } = detectorAt([{ name: "denied", event: "consent_denied", count: 1, windowSec: 60, where: { client: "web", kind: 2 } }]);
		setNow(0);
		expect(detector.observe("consent_denied", { client: "mobile", kind: 2 })).toEqual([]);
		expect(detector.observe("consent_denied", { client: "web", kind: 3 })).toEqual([]);
		expect(detector.observe("consent_denied", { kind: 2 })).toEqual([]);
		expect(detector.observe("consent_denied", { client: "web", kind: 2 })).toEqual([{ rule: "denied", key: "*", count: 1, windowSec: 60 }]);
	});
});

describe("audit-own events", () => {
	test("anomaly_detected and audit_tamper_detected never count, even under a matching rule name", () => {
		const { detector, setNow } = detectorAt([{ name: "any", event: "login_failed", count: 1, windowSec: 60 }]);
		setNow(0);
		expect(detector.observe("anomaly_detected", {})).toEqual([]);
		expect(detector.observe("audit_tamper_detected", {})).toEqual([]);
		expect(detector.observe("login_failed", {})).toHaveLength(1);
	});

	test("a rule that names an audit-own event is rejected at parse time", () => {
		const error = rangeErrorOf(() => parseAnomalyRules([{ name: "loop", event: "anomaly_detected", count: 1, windowSec: 60 }]));
		expect(error.message).toContain("loop");
	});
});

describe("bounded memory", () => {
	test("50000 distinct keys complete, and a new key can still alert afterwards", () => {
		const { detector, setNow } = detectorAt([{ name: "per_ip", event: "login_failed", count: 1, windowSec: 60, groupBy: "ip" }]);
		setNow(0);

		let alerts = 0;
		for (let i = 0; i < 50_000; i += 1) {
			alerts += detector.observe("login_failed", { ip: `10.${Math.floor(i / 65_536)}.${Math.floor(i / 256) % 256}.${i % 256}` }).length;
		}
		expect(alerts).toBe(50_000);

		expect(detector.observe("login_failed", { ip: "192.0.2.1" })).toEqual([{ rule: "per_ip", key: "192.0.2.1", count: 1, windowSec: 60 }]);
	});
});

describe("rule validation", () => {
	const valid = { name: "ok", event: "login_failed", count: 3, windowSec: 60 };

	test("count 0 is rejected and the message names the rule", () => {
		const error = rangeErrorOf(() => parseAnomalyRules([{ ...valid, name: "zero", count: 0 }]));
		expect(error.message).toContain("zero");
		expect(error.message).toContain("count");
	});

	test("windowSec 86401 is rejected and the message names the rule", () => {
		const error = rangeErrorOf(() => parseAnomalyRules([{ ...valid, name: "too_long", windowSec: 86_401 }]));
		expect(error.message).toContain("too_long");
		expect(error.message).toContain("windowSec");
	});

	test("duplicate names are rejected, and the message names the second rule by index and name", () => {
		const error = rangeErrorOf(() => parseAnomalyRules([valid, { ...valid, event: "rate_limited" }]));
		expect(error.message).toContain("ok");
		expect(error.message).toContain("1");
	});

	test("a non-array value is rejected", () => {
		expect(() => parseAnomalyRules({ name: "ok" })).toThrow(RangeError);
		expect(() => parseAnomalyRules("[]")).toThrow(RangeError);
	});

	test("an empty event is rejected and the message names the rule", () => {
		const error = rangeErrorOf(() => parseAnomalyRules([{ ...valid, name: "blank", event: "" }]));
		expect(error.message).toContain("blank");
		expect(error.message).toContain("event");
	});

	test("an unknown field is rejected, so a misspelled optional key is not silently dropped", () => {
		const error = rangeErrorOf(() => parseAnomalyRules([{ ...valid, name: "typo", groupby: "ip" }]));
		expect(error.message).toContain("typo");
		expect(error.message).toContain("groupby");
	});

	test("a where value that is not a primitive is rejected", () => {
		const error = rangeErrorOf(() => parseAnomalyRules([{ ...valid, name: "nested", where: { ip: { a: 1 } } }]));
		expect(error.message).toContain("nested");
	});

	test("the detector validates its rules with the same parser", () => {
		expect(() => createAnomalyDetector({ rules: [{ name: "x", event: "e", count: 0, windowSec: 1 }] })).toThrow(RangeError);
	});

	test("DEFAULT_ANOMALY_RULES passes parseAnomalyRules and carries the CONTEXT D8 values", () => {
		expect(parseAnomalyRules(DEFAULT_ANOMALY_RULES)).toEqual([
			{ name: "login_failed", event: "login_failed", count: 10, windowSec: 300, groupBy: "ip" },
			{ name: "refresh_reuse_detected", event: "refresh_reuse_detected", count: 1, windowSec: 3600, groupBy: "clientId" },
			{ name: "rate_limited", event: "rate_limited", count: 50, windowSec: 300, groupBy: "ip" },
		]);
	});

	test("the default login_failed rule alerts on the tenth failure from one IP", () => {
		const { detector, setNow } = detectorAt(DEFAULT_ANOMALY_RULES);
		const alerts = [];
		for (let second = 0; second < 10; second += 1) {
			setNow(second);
			alerts.push(...detector.observe("login_failed", { ip: "203.0.113.7" }));
		}
		expect(alerts).toEqual([{ rule: "login_failed", key: "203.0.113.7", count: 10, windowSec: 300 }]);
	});
});
