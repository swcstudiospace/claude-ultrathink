// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Declarative anomaly rules for the audit trail (AUDIT-03).
 *
 * A rule counts events of one name, optionally grouped by one field and filtered by exact field values. When the
 * count inside a sliding window reaches the rule's `count`, the key alerts once and stays quiet for `windowSec`.
 * Audit-own events never count, so an alert cannot trigger another alert.
 *
 * Pure: the clock is injected and nothing here writes to disk.
 */

type Primitive = string | number | boolean;

export interface AnomalyRule {
	readonly name: string;
	readonly event: string;
	readonly count: number;
	readonly windowSec: number;
	readonly groupBy?: string;
	readonly where?: Readonly<Record<string, Primitive>>;
}

export interface AnomalyAlert {
	readonly rule: string;
	readonly key: string;
	readonly count: number;
	readonly windowSec: number;
}

export interface AnomalyDetectorOptions {
	readonly rules: readonly AnomalyRule[];
	/** Milliseconds since the epoch. Defaults to `Date.now`. */
	readonly now?: () => number;
}

export interface AnomalyDetector {
	observe(event: string, fields: Record<string, Primitive>): AnomalyAlert[];
}

/** The three defaults from CONTEXT D8. */
export const DEFAULT_ANOMALY_RULES: readonly AnomalyRule[] = [
	{ name: "login_failed", event: "login_failed", count: 10, windowSec: 300, groupBy: "ip" },
	{ name: "refresh_reuse_detected", event: "refresh_reuse_detected", count: 1, windowSec: 3600, groupBy: "clientId" },
	{ name: "rate_limited", event: "rate_limited", count: 50, windowSec: 300, groupBy: "ip" },
];

/** Events the audit trail appends itself. No rule may match them and the detector never counts them. */
const AUDIT_OWN_EVENTS: Readonly<Record<string, true>> = {
	audit_anchor: true,
	anomaly_detected: true,
	audit_tamper_detected: true,
	audit_retention_pruned: true,
};

const RULE_FIELDS: Readonly<Record<string, true>> = {
	name: true,
	event: true,
	count: true,
	windowSec: true,
	groupBy: true,
	where: true,
};

const MAX_COUNT = 10_000;
const MAX_WINDOW_SEC = 86_400;
/** Distinct keys tracked per rule; the oldest-inserted key is evicted beyond this. */
const MAX_KEYS_PER_RULE = 10_000;
const UNGROUPED_KEY = "*";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is Primitive {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function ruleFailure(index: number, name: unknown, problem: string): RangeError {
	const label = typeof name === "string" && name.length > 0 ? ` ("${name}")` : "";
	return new RangeError(`anomaly rule ${index}${label}: ${problem}`);
}

function parseWhere(raw: unknown, index: number, name: unknown): Record<string, Primitive> {
	if (!isPlainObject(raw)) throw ruleFailure(index, name, "where must be an object");
	const where: Record<string, Primitive> = {};
	for (const [field, value] of Object.entries(raw)) {
		if (!isPrimitive(value)) throw ruleFailure(index, name, `where.${field} must be a string, number or boolean`);
		where[field] = value;
	}
	return where;
}

function parseRule(raw: unknown, index: number, names: Set<string>): AnomalyRule {
	if (!isPlainObject(raw)) throw ruleFailure(index, undefined, "must be an object");
	const name = raw.name;
	for (const field of Object.keys(raw)) {
		if (RULE_FIELDS[field] !== true) throw ruleFailure(index, name, `unknown field "${field}"`);
	}
	if (typeof name !== "string" || name.length === 0) throw ruleFailure(index, name, "name must be a non-empty string");
	if (names.has(name)) throw ruleFailure(index, name, "duplicate name");
	names.add(name);

	const event = raw.event;
	if (typeof event !== "string" || event.length === 0) throw ruleFailure(index, name, "event must be a non-empty string");
	if (AUDIT_OWN_EVENTS[event] === true) throw ruleFailure(index, name, `event "${event}" is written by the audit trail and cannot be counted`);

	if (!isIntegerIn(raw.count, 1, MAX_COUNT)) throw ruleFailure(index, name, `count must be an integer 1..${MAX_COUNT}`);
	if (!isIntegerIn(raw.windowSec, 1, MAX_WINDOW_SEC)) throw ruleFailure(index, name, `windowSec must be an integer 1..${MAX_WINDOW_SEC}`);

	const rule: { name: string; event: string; count: number; windowSec: number; groupBy?: string; where?: Record<string, Primitive> } = {
		name,
		event,
		count: raw.count,
		windowSec: raw.windowSec,
	};
	if (raw.groupBy !== undefined) {
		if (typeof raw.groupBy !== "string" || raw.groupBy.length === 0) throw ruleFailure(index, name, "groupBy must be a non-empty string");
		rule.groupBy = raw.groupBy;
	}
	if (raw.where !== undefined) rule.where = parseWhere(raw.where, index, name);
	return rule;
}

/**
 * Validates an untrusted rule list (for example the parsed `ULTRATHINK_AUDIT_RULES`). Throws `RangeError` naming the
 * offending rule by index and, when it has one, by name.
 */
export function parseAnomalyRules(value: unknown): AnomalyRule[] {
	if (!Array.isArray(value)) throw new RangeError("anomaly rules must be an array");
	const names = new Set<string>();
	return value.map((raw, index) => parseRule(raw, index, names));
}

interface KeyState {
	/** Timestamps of the most recent `count` events, oldest first. */
	readonly recent: number[];
	/** Alerts for this key are suppressed while `now` is below this value. */
	suppressedUntil: number;
}

interface RuleState {
	readonly rule: AnomalyRule;
	readonly keys: Map<string, KeyState>;
}

function matchesWhere(where: Readonly<Record<string, Primitive>> | undefined, fields: Record<string, Primitive>): boolean {
	if (where === undefined) return true;
	for (const [field, expected] of Object.entries(where)) {
		if (fields[field] !== expected) return false;
	}
	return true;
}

/** Records one event for `key` and returns an alert when the window threshold is crossed and not suppressed. */
function record(state: RuleState, key: string, now: number): AnomalyAlert | undefined {
	const { rule, keys } = state;
	let entry = keys.get(key);
	if (entry === undefined) {
		if (keys.size >= MAX_KEYS_PER_RULE) {
			const oldest = keys.keys().next();
			if (!oldest.done) keys.delete(oldest.value);
		}
		entry = { recent: [], suppressedUntil: Number.NEGATIVE_INFINITY };
		keys.set(key, entry);
	}

	entry.recent.push(now);
	if (entry.recent.length > rule.count) entry.recent.shift();
	if (entry.recent.length < rule.count) return undefined;

	const windowMs = rule.windowSec * 1000;
	const oldest = entry.recent[0] ?? Number.NEGATIVE_INFINITY;
	if (oldest <= now - windowMs) return undefined;
	if (now < entry.suppressedUntil) return undefined;

	entry.suppressedUntil = now + windowMs;
	return { rule: rule.name, key, count: rule.count, windowSec: rule.windowSec };
}

export function createAnomalyDetector(options: AnomalyDetectorOptions): AnomalyDetector {
	const rules = parseAnomalyRules(options.rules);
	const now = options.now ?? Date.now;
	const states: RuleState[] = rules.map((rule) => ({ rule, keys: new Map<string, KeyState>() }));

	return {
		observe(event, fields) {
			if (AUDIT_OWN_EVENTS[event] === true) return [];
			const at = now();
			const alerts: AnomalyAlert[] = [];
			for (const state of states) {
				const { rule } = state;
				if (rule.event !== event || !matchesWhere(rule.where, fields)) continue;
				let key = UNGROUPED_KEY;
				if (rule.groupBy !== undefined) {
					const value = fields[rule.groupBy];
					// An event without the grouping field cannot be attributed to a key; it is not counted.
					if (value === undefined) continue;
					key = String(value);
				}
				const alert = record(state, key, at);
				if (alert !== undefined) alerts.push(alert);
			}
			return alerts;
		},
	};
}
