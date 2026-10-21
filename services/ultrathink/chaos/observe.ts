// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/** One observed response from the system under chaos. */
export interface ChaosResponse {
	status: number;
	headers: Headers;
	text: string;
}

/** What the runner talks to: the in-process app or a remote staging base URL. */
export interface ChaosTarget {
	request(method: "GET" | "POST", path: string, body?: unknown): Promise<ChaosResponse>;
	close(): Promise<void>;
}

interface Sample {
	name: string;
	labels: Record<string, string>;
	value: number;
}

interface Cursor {
	text: string;
	pos: number;
}

const METRIC_NAME = /[a-zA-Z_:][a-zA-Z0-9_:]*/y;
const LABEL_NAME = /[a-zA-Z_][a-zA-Z0-9_]*/y;
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Reads one series from Prometheus text exposition. The label set must match `labels` exactly (absent labels mean the
 * empty set), so `foo{a="1",b="2"}` does not match `{a: "1"}`. Comment and blank lines are ignored. An absent series is
 * `undefined`, never 0.
 */
export function parsePrometheusValue(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
	for (const line of text.split("\n")) {
		const sample = parseSample(line);
		if (sample && sample.name === name && sameLabels(sample.labels, labels)) return sample.value;
	}
	return undefined;
}

function parseSample(line: string): Sample | undefined {
	const text = line.trim();
	if (text === "" || text.startsWith("#")) return undefined;
	const cursor: Cursor = { text, pos: 0 };
	const name = readToken(cursor, METRIC_NAME);
	if (name === undefined) return undefined;
	const labels: Record<string, string> = {};
	if (text[cursor.pos] === "{") {
		cursor.pos += 1;
		if (!readLabels(cursor, labels)) return undefined;
	}
	const [valueToken] = text.slice(cursor.pos).trim().split(/\s+/);
	if (valueToken === undefined) return undefined;
	const value = parseValue(valueToken);
	if (value === undefined) return undefined;
	return { name, labels, value };
}

// Reads `name="value"` pairs up to and including the closing brace. Returns false on malformed input.
function readLabels(cursor: Cursor, labels: Record<string, string>): boolean {
	for (;;) {
		skipSpaces(cursor);
		if (cursor.text[cursor.pos] === "}") {
			cursor.pos += 1;
			return true;
		}
		const label = readToken(cursor, LABEL_NAME);
		if (label === undefined) return false;
		skipSpaces(cursor);
		if (cursor.text[cursor.pos] !== "=") return false;
		cursor.pos += 1;
		skipSpaces(cursor);
		const value = readQuoted(cursor);
		if (value === undefined) return false;
		labels[label] = value;
		skipSpaces(cursor);
		const next = cursor.text[cursor.pos];
		if (next === ",") {
			cursor.pos += 1;
		} else if (next === "}") {
			cursor.pos += 1;
			return true;
		} else {
			return false;
		}
	}
}

function readToken(cursor: Cursor, pattern: RegExp): string | undefined {
	pattern.lastIndex = cursor.pos;
	const match = pattern.exec(cursor.text);
	if (!match) return undefined;
	cursor.pos += match[0].length;
	return match[0];
}

// Reads a double-quoted label value with the three escapes the exposition format defines.
function readQuoted(cursor: Cursor): string | undefined {
	if (cursor.text[cursor.pos] !== '"') return undefined;
	cursor.pos += 1;
	let out = "";
	while (cursor.pos < cursor.text.length) {
		const char = cursor.text[cursor.pos];
		cursor.pos += 1;
		if (char === '"') return out;
		if (char !== "\\") {
			out += char;
			continue;
		}
		const escaped = cursor.text[cursor.pos];
		cursor.pos += 1;
		if (escaped === "\\") out += "\\";
		else if (escaped === '"') out += '"';
		else if (escaped === "n") out += "\n";
		else return undefined;
	}
	return undefined;
}

function skipSpaces(cursor: Cursor): void {
	while (cursor.text[cursor.pos] === " " || cursor.text[cursor.pos] === "\t") cursor.pos += 1;
}

function parseValue(token: string): number | undefined {
	if (token === "NaN") return Number.NaN;
	if (token === "+Inf" || token === "Inf") return Number.POSITIVE_INFINITY;
	if (token === "-Inf") return Number.NEGATIVE_INFINITY;
	if (!NUMBER.test(token)) return undefined;
	return Number(token);
}

function sameLabels(actual: Record<string, string>, expected: Record<string, string>): boolean {
	const keys = Object.keys(actual);
	if (keys.length !== Object.keys(expected).length) return false;
	return keys.every((key) => Object.hasOwn(expected, key) && actual[key] === expected[key]);
}

/** The fetch shape `httpTarget` needs; tests inject a fake. */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A target that talks HTTP(S) to a base URL. Only `http:` and `https:` are accepted, so a `file:` or other scheme is
 * rejected before any request is made.
 */
export function httpTarget(baseUrl: string, fetchImpl: HttpFetch = fetch): ChaosTarget {
	const base = new URL(baseUrl);
	if (base.protocol !== "http:" && base.protocol !== "https:") {
		throw new TypeError(`chaos http target must use http or https, not ${base.protocol}`);
	}
	const root = new URL(base.href.endsWith("/") ? base.href : `${base.href}/`);
	return {
		async request(method, path, body) {
			const headers: Record<string, string> = {};
			let payload: string | undefined;
			if (body !== undefined) {
				headers["content-type"] = "application/json";
				payload = JSON.stringify(body);
			}
			const url = new URL(path.replace(/^\/+/, ""), root);
			const response = await fetchImpl(url.href, { method, headers, body: payload });
			return { status: response.status, headers: response.headers, text: await response.text() };
		},
		async close() {},
	};
}
