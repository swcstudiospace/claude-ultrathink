// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Static validation of the three config layers. The merge in `src/config.ts` ignores unknown keys and wrong or out-of-range
 * values by design, so a typo such as `ship.autoMerg` silently does nothing; this check is the visible half of that design.
 * It never changes the merge: known sections and keys come from `defaultConfig()` plus supported optional backends,
 * and "ignored or adjusted" compares every written leaf with the merge over the accumulated lower layers.
 * Findings carry key names, types and effective values, never the written value or the file content.
 */
import { readFileSync } from "node:fs";
import { claudeConfigPaths, defaultConfig, mergeConfig, type UltrathinkConfig } from "../config.ts";
import { isPlainObject } from "../decisions/client.ts";
import { HOSTS, isHostId } from "../host/types.ts";
import type { DoctorDeps, DoctorLevel, Finding } from "./types.ts";

type Json = Record<string, unknown>;

const MAX_PARSE_MESSAGE_CHARS = 160;
const MAX_VALUE_CHARS = 80;
const MODELS_KEYS = ["hosts", "providerDefaults"] as const;
const HOST_OVERRIDE_KEYS = ["provider", "model"] as const;
const BACKEND_SECTIONS = ["hindsight", "ragflow", "substrate"] as const;

function kindOf(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value === "object" ? "object" : typeof value;
}

function editDistance(a: string, b: string): number {
	const unrelated = a.length + b.length;
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		const aChar = a.charAt(i - 1);
		for (let j = 1; j <= b.length; j++) {
			const diagonal = previous[j - 1];
			const above = previous[j];
			const left = current[j - 1];
			// Every index is inside the row. A missing cell means the row was built short, so the names are unrelated.
			if (diagonal === undefined || above === undefined || left === undefined) return unrelated;
			const substitution = diagonal + (aChar === b.charAt(j - 1) ? 0 : 1);
			current[j] = Math.min(above + 1, left + 1, substitution);
		}
		previous = current;
	}
	return previous[b.length] ?? unrelated;
}

function sharedPrefix(a: string, b: string): number {
	let length = 0;
	while (length < a.length && length < b.length && a[length] === b[length]) length++;
	return length;
}

/** The closest candidate: an edit distance of at most 2 (case-insensitive), or a shared prefix of at least 4. */
export function suggestName(name: string, candidates: readonly string[]): string | undefined {
	const lower = name.toLowerCase();
	let best: { candidate: string; distance: number; prefix: number } | undefined;
	for (const candidate of candidates) {
		const other = candidate.toLowerCase();
		const distance = editDistance(lower, other);
		const prefix = sharedPrefix(lower, other);
		const near = distance <= 2 && distance < Math.min(lower.length, other.length);
		if (!near && prefix < 4) continue;
		if (!best || distance < best.distance || (distance === best.distance && prefix > best.prefix)) {
			best = { candidate, distance, prefix };
		}
	}
	return best?.candidate;
}

function describeValue(value: unknown): string {
	const text = JSON.stringify(value) ?? String(value);
	return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

/** What the merge compares: trimmed strings (URL-like keys also lose trailing slashes), arrays element by element. */
function comparable(value: unknown, key: string): string {
	const normalize = (item: unknown): unknown => {
		if (typeof item === "string") {
			const trimmed = item.trim();
			return /url$/i.test(key) ? trimmed.replace(/\/+$/, "") : trimmed;
		}
		return Array.isArray(item) ? item.map(normalize) : item;
	};
	return JSON.stringify(normalize(value)) ?? "undefined";
}

interface Layer {
	id: string;
	label: string;
	path: string;
	project: boolean;
}

interface Collector {
	findings: Finding[];
	layer: Layer;
	add: (level: DoctorLevel, kind: string, keyPath: string, title: string, detail?: string, fix?: string) => void;
}

function collector(layer: Layer): Collector {
	const findings: Finding[] = [];
	return {
		findings,
		layer,
		add(level, kind, keyPath, title, detail, fix) {
			findings.push({
				id: `config.${layer.id}.${kind}${keyPath ? `.${keyPath}` : ""}`,
				section: "config",
				level,
				title: `${layer.label}: ${title}`,
				...(detail ? { detail } : {}),
				...(fix ? { fix } : {}),
			});
		},
	};
}

function unknownName(out: Collector, kind: "section" | "key", keyPath: string, candidates: readonly string[], prefix: string): void {
	const internal = kind === "section" && keyPath === "modelProvenance";
	const name = prefix ? keyPath.slice(prefix.length + 1) : keyPath;
	const suggestion = internal ? undefined : suggestName(name, candidates);
	const detail = internal
		? `Internal state the merge records in memory; it is never read from a file. File: ${out.layer.path}`
		: `${kind === "section" ? "The whole section is" : "The key is"} ignored by the merge. File: ${out.layer.path}`;
	out.add(
		"warn",
		`unknown-${kind}`,
		keyPath,
		`unknown ${kind} ${keyPath}`,
		detail,
		suggestion ? `Did you mean ${prefix ? `${prefix}.${suggestion}` : suggestion}?` : undefined,
	);
}

function checkModels(out: Collector, value: unknown, effective: Json): void {
	if (!isPlainObject(value)) {
		out.add("warn", "wrong-type", "models", `models ignored: expected object, got ${kindOf(value)}`, `File: ${out.layer.path}`);
		return;
	}
	const effectiveModels = isPlainObject(effective.models) ? effective.models : {};
	const effectiveDefaults = isPlainObject(effectiveModels.providerDefaults) ? effectiveModels.providerDefaults : {};
	for (const [key, section] of Object.entries(value)) {
		if (key === "hosts") {
			if (!isPlainObject(section)) {
				out.add("warn", "wrong-type", "models.hosts", `models.hosts ignored: expected object, got ${kindOf(section)}`, `File: ${out.layer.path}`);
				continue;
			}
			for (const [host, entry] of Object.entries(section)) {
				const keyPath = `models.hosts.${host}`;
				if (!isHostId(host)) {
					const suggestion = suggestName(host, HOSTS);
					out.add(
						"warn",
						"unknown-host",
						keyPath,
						`unknown host ${keyPath}`,
						`Valid host ids: ${HOSTS.join(", ")}. The entry is ignored. File: ${out.layer.path}`,
						suggestion ? `Did you mean models.hosts.${suggestion}?` : undefined,
					);
					continue;
				}
				if (!isPlainObject(entry)) {
					out.add("warn", "wrong-type", keyPath, `${keyPath} ignored: expected object, got ${kindOf(entry)}`, `File: ${out.layer.path}`);
					continue;
				}
				for (const [field, selector] of Object.entries(entry)) {
					const fieldPath = `${keyPath}.${field}`;
					if (!(HOST_OVERRIDE_KEYS as readonly string[]).includes(field)) {
						unknownName(out, "key", fieldPath, HOST_OVERRIDE_KEYS, keyPath);
					} else if (typeof selector !== "string") {
						out.add("warn", "wrong-type", fieldPath, `${fieldPath} ignored: expected string, got ${kindOf(selector)}`, `File: ${out.layer.path}`);
					}
				}
			}
		} else if (key === "providerDefaults") {
			if (!isPlainObject(section)) {
				out.add(
					"warn",
					"wrong-type",
					"models.providerDefaults",
					`models.providerDefaults ignored: expected object, got ${kindOf(section)}`,
					`File: ${out.layer.path}`,
				);
				continue;
			}
			for (const [provider, selector] of Object.entries(section)) {
				const keyPath = `models.providerDefaults.${provider}`;
				if (typeof selector !== "string") {
					out.add("warn", "wrong-type", keyPath, `${keyPath} ignored: expected string, got ${kindOf(selector)}`, `File: ${out.layer.path}`);
				} else if (selector.trim() !== "" && effectiveDefaults[provider] !== selector.trim()) {
					out.add("warn", "ignored", keyPath, `${keyPath} ignored by the merge`, `A reserved provider name is never merged. File: ${out.layer.path}`);
				}
			}
		} else {
			unknownName(out, "key", `models.${key}`, MODELS_KEYS, "models");
		}
	}
}

function checkLeaf(out: Collector, section: string, key: string, written: unknown, fallback: unknown, merged: Json, asUser: Json): void {
	const keyPath = `${section}.${key}`;
	const expected = kindOf(fallback);
	const got = kindOf(written);
	if (expected !== got) {
		out.add(
			"warn",
			"wrong-type",
			keyPath,
			`${keyPath} ignored: expected ${expected}, got ${got}`,
			`The value from a lower layer, or the default, stays in effect. File: ${out.layer.path}`,
		);
		return;
	}
	const value = isPlainObject(merged[section]) ? merged[section][key] : undefined;
	// The merge intentionally omits an optional direct backend from its output.
	const effective = key === "backend" && value === undefined ? "direct" : value;
	const wanted = comparable(written, key);
	const validBackend = key !== "backend" || written === "direct" || written === "gateway";
	if (validBackend && wanted === comparable(effective, key)) return;
	if (keyPath === "decisions.enabled") {
		out.add(
			"warn",
			"ignored",
			keyPath,
			`${keyPath} ignored: Jev is always on; set ULTRATHINK_DECISIONS=0 to turn it off`,
			`File: ${out.layer.path}`,
		);
		return;
	}
	const userBackend = isPlainObject(asUser[section]) ? asUser[section][key] : undefined;
	const userValue = key === "backend" && userBackend === undefined ? "direct" : userBackend;
	if (out.layer.project && validBackend && wanted === comparable(userValue, key)) {
		out.add(
			"info",
			"project-restricted",
			keyPath,
			`${keyPath} ignored in a project file by design`,
			`A file a cloned repository controls cannot set this key (or can only tighten it). File: ${out.layer.path}`,
			"Set it in your user config if you want it.",
		);
		return;
	}
	out.add(
		"warn",
		"ignored",
		keyPath,
		`${keyPath} ignored or adjusted: effective value is ${describeValue(effective)}`,
		`The written value is outside what the merge accepts (type, range or allowed values). File: ${out.layer.path}`,
	);
}

function checkLayer(layer: Layer, data: Json, known: Json, base: UltrathinkConfig, merged: Json): Finding[] {
	const out = collector(layer);
	const asUser: Json = layer.project ? { ...mergeConfig(data, base, { project: false }) } : merged;
	const sections = Object.keys(known);
	for (const [section, value] of Object.entries(data)) {
		if (!Object.hasOwn(known, section)) {
			unknownName(out, "section", section, sections, "");
			continue;
		}
		if (section === "models") {
			checkModels(out, value, merged);
			continue;
		}
		const defaults = known[section] as Json;
		if (!isPlainObject(value)) {
			out.add("warn", "wrong-type", section, `${section} ignored: expected object, got ${kindOf(value)}`, `File: ${layer.path}`);
			continue;
		}
		for (const [key, written] of Object.entries(value)) {
			if (!Object.hasOwn(defaults, key)) {
				unknownName(out, "key", `${section}.${key}`, Object.keys(defaults), section);
				continue;
			}
			checkLeaf(out, section, key, written, defaults[key], merged, asUser);
		}
	}
	if (out.findings.length === 0) {
		out.add("ok", "valid", "", "valid, nothing unknown or ignored", `File: ${layer.path}`);
	}
	return out.findings;
}

/** One group of findings per config layer, lowest precedence first. Never throws and never reads anything but the config files. */
export function checkConfig(deps: DoctorDeps): Finding[] {
	const known: Json = { ...defaultConfig() };
	delete known.modelProvenance;
	for (const section of BACKEND_SECTIONS) known[section] = { ...(known[section] as Json), backend: "direct" };
	let effective = defaultConfig();
	const findings: Finding[] = [];
	claudeConfigPaths(deps.cwd, deps.env).forEach((source, index) => {
		const project = typeof source !== "string";
		const layer: Layer = {
			id: project ? "project" : index === 0 ? "user" : "claude-user",
			label: project ? "project config" : index === 0 ? "user config" : "Claude user config",
			path: project ? source.path : source,
			project,
		};
		const fail = (level: DoctorLevel, kind: string, title: string, detail?: string): void => {
			const out = collector(layer);
			out.add(level, kind, "", title, detail);
			findings.push(...out.findings);
		};
		let text: string;
		try {
			text = readFileSync(layer.path, "utf8");
		} catch (error) {
			const rawCode = error instanceof Error && "code" in error ? error.code : undefined;
			const code = typeof rawCode === "string" ? rawCode : undefined;
			if (code === "ENOENT") fail("info", "missing", "not found (optional)", `File: ${layer.path}`);
			else fail("error", "unreadable", `cannot be read (${code ?? "unknown error"})`, `File: ${layer.path}`);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			// Some runtimes quote the offending token in the message; a quoted token could be a pasted secret, so it is dropped.
			const message = (error instanceof Error ? error.message : String(error)).replace(/"[^"]*"|'[^']*'/g, "…");
			fail("error", "invalid-json", "not valid JSON; every key in it is ignored", `File: ${layer.path}\n${message.slice(0, MAX_PARSE_MESSAGE_CHARS)}`);
			return;
		}
		if (!isPlainObject(parsed)) {
			fail("error", "not-object", `top level is ${kindOf(parsed)}, expected an object; every key in it is ignored`, `File: ${layer.path}`);
			return;
		}
		const merged = mergeConfig(parsed, effective, { project });
		findings.push(...checkLayer(layer, parsed, known, effective, { ...merged }));
		effective = merged;
	});
	return findings;
}
