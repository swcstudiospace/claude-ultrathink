#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * scripts/release-check.ts — proves that every place that carries the plugin
 * version agrees before a release can be cut.
 *
 * The version lives in eight places (package.json, the Claude Code, Omp and
 * Muse manifests, the Hermes plugin.yaml and the Prime Agent pyproject.toml)
 * and nothing else ties them together. package.json is the authority: every
 * other source must equal it, it must be a semver, CHANGELOG.md must carry a
 * dated section for it plus an [Unreleased] heading, and a release tag must be
 * `v<version>`. The guard test runs checkRelease on this repository on every
 * `bun test`, and the release workflow runs the CLI before it publishes.
 *
 * Read-only: it never writes a file, never touches git and never reads the
 * environment. The CLI is `bun scripts/release-check.ts [--tag vX.Y.Z]
 * [--notes] [--root <dir>]`.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject } from "../src/decisions/client.ts";

export type VersionSource = { file: string; label: string; version: string | undefined };

export type ReleaseReport = {
	ok: boolean;
	version: string | undefined;
	sources: VersionSource[];
	problems: string[];
};

export type CliIo = {
	out: (line: string) => void;
	err: (line: string) => void;
	/** The repository root used when `--root` is absent. */
	root: string;
};

const AUTHORITY_FILE = "package.json";
const CHANGELOG_FILE = "CHANGELOG.md";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const USAGE = "usage: bun scripts/release-check.ts [--tag vX.Y.Z] [--notes] [--root <dir>]";

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function readJson(path: string): unknown {
	const text = readText(path);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function versionOf(value: unknown): string | undefined {
	return isPlainObject(value) && typeof value.version === "string" ? value.version : undefined;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonSources(root: string, file: string): VersionSource[] {
	const parsed = readJson(join(root, file));
	return [{ file, label: "version", version: versionOf(parsed) }];
}

/** A marketplace carries its own version under `metadata` and one per listed plugin. */
function marketplaceSources(root: string, file: string): VersionSource[] {
	const parsed = readJson(join(root, file));
	const sources: VersionSource[] = [{ file, label: "metadata.version", version: isPlainObject(parsed) ? versionOf(parsed.metadata) : undefined }];
	const plugins = isPlainObject(parsed) && Array.isArray(parsed.plugins) ? parsed.plugins : [];
	if (plugins.length === 0) {
		sources.push({ file, label: "plugins[]", version: undefined });
		return sources;
	}
	for (const [index, plugin] of plugins.entries()) {
		const name = isPlainObject(plugin) && typeof plugin.name === "string" ? plugin.name : String(index);
		sources.push({ file, label: `plugins[${name}].version`, version: versionOf(plugin) });
	}
	return sources;
}

function hermesSource(root: string): VersionSource {
	const file = "hosts/hermes/plugin.yaml";
	const text = readText(join(root, file));
	const match = text === undefined ? null : /^version:[ \t]*["']?([^"'\s#]+)["']?[ \t]*(?:#.*)?$/m.exec(text);
	return { file, label: "version", version: match?.[1] };
}

/** The `version = "…"` line inside the `[project]` table only, so a tool table's version is never mistaken for it. */
function primeAgentSource(root: string): VersionSource {
	const file = "hosts/prime-agent/pyproject.toml";
	const text = readText(join(root, file));
	let version: string | undefined;
	if (text !== undefined) {
		const table = /^\[project\][ \t]*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text);
		version = table ? /^version[ \t]*=[ \t]*"([^"]*)"/m.exec(table[1] ?? "")?.[1] : undefined;
	}
	return { file, label: "[project] version", version };
}

/** Every version the plugin ships under, `package.json` first. A missing file or field yields `version: undefined`. */
export function collectVersions(root: string): VersionSource[] {
	return [
		...jsonSources(root, AUTHORITY_FILE),
		...jsonSources(root, ".claude-plugin/plugin.json"),
		...marketplaceSources(root, ".claude-plugin/marketplace.json"),
		...marketplaceSources(root, ".omp-plugin/marketplace.json"),
		...jsonSources(root, ".muse-plugin/plugin.json"),
		hermesSource(root),
		primeAgentSource(root),
	];
}

/** The body under `## [<version>] - <date>` up to the next `## [` heading, trimmed; `undefined` when there is no such section. */
export function changelogSection(root: string, version: string): string | undefined {
	const text = readText(join(root, CHANGELOG_FILE));
	if (text === undefined) return undefined;
	const lines = text.split(/\r?\n/);
	const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`);
	const start = lines.findIndex((line) => heading.test(line));
	if (start === -1) return undefined;
	let end = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
	if (end === -1) end = lines.length;
	return lines.slice(start + 1, end).join("\n").trim();
}

function describe(source: VersionSource): string {
	return `${source.file} (${source.label})`;
}

/** Checks every rule and reports each failure as one line naming the file and both versions; never throws. */
export function checkRelease(root: string, options: { tag?: string } = {}): ReleaseReport {
	const sources = collectVersions(root);
	const authority = sources[0];
	const version = authority?.version;
	const problems: string[] = [];

	if (version === undefined) {
		problems.push(`${AUTHORITY_FILE}: no version found, so nothing can be compared`);
	} else if (!SEMVER.test(version)) {
		problems.push(`${AUTHORITY_FILE}: version "${version}" is not a semantic version (expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-prerelease)`);
	}

	if (version !== undefined) {
		for (const source of sources.slice(1)) {
			if (source.version === undefined) {
				problems.push(`${describe(source)}: no version found, but ${AUTHORITY_FILE} is ${version}`);
			} else if (source.version !== version) {
				problems.push(`${describe(source)}: version ${source.version} but ${AUTHORITY_FILE} is ${version}`);
			}
		}

		const changelog = readText(join(root, CHANGELOG_FILE));
		if (changelog === undefined) {
			problems.push(`${CHANGELOG_FILE}: file not found, expected a "## [${version}] - YYYY-MM-DD" section`);
		} else {
			if (changelogSection(root, version) === undefined) {
				problems.push(`${CHANGELOG_FILE}: no "## [${version}] - YYYY-MM-DD" heading for ${AUTHORITY_FILE} version ${version}`);
			}
			if (!/^## \[Unreleased\][ \t]*\r?$/m.test(changelog)) {
				problems.push(`${CHANGELOG_FILE}: no "## [Unreleased]" heading`);
			}
		}

		if (options.tag !== undefined && options.tag !== `v${version}`) {
			problems.push(`tag ${options.tag}: expected v${version} to match ${AUTHORITY_FILE} version ${version}`);
		}
	}

	return { ok: problems.length === 0, version, sources, problems };
}

type CliArgs = { tag: string | undefined; notes: boolean; root: string | undefined };

function parseArgs(argv: readonly string[]): CliArgs | undefined {
	const args: CliArgs = { tag: undefined, notes: false, root: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--notes") {
			args.notes = true;
		} else if (arg === "--tag" || arg === "--root") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) return undefined;
			if (arg === "--tag") args.tag = value;
			else args.root = value;
			index++;
		} else {
			return undefined;
		}
	}
	return args;
}

/** Runs the CLI and returns its exit code: 0 consistent, 1 problems or no changelog section, 2 bad arguments. */
export function main(argv: readonly string[], io: CliIo): number {
	const args = parseArgs(argv);
	if (!args) {
		io.err(USAGE);
		return 2;
	}
	const root = args.root === undefined ? io.root : resolve(args.root);

	if (args.notes) {
		const version = collectVersions(root)[0]?.version;
		if (version === undefined) {
			io.err(`release-check: no version in ${join(root, AUTHORITY_FILE)}`);
			return 1;
		}
		const body = changelogSection(root, version);
		if (body === undefined) {
			io.err(`release-check: ${CHANGELOG_FILE} has no "## [${version}] - YYYY-MM-DD" section`);
			return 1;
		}
		io.out(body);
		return 0;
	}

	const report = checkRelease(root, args.tag === undefined ? {} : { tag: args.tag });
	for (const source of report.sources) {
		const status = source.version !== undefined && source.version === report.version ? "ok      " : "MISMATCH";
		io.out(`${status} ${describe(source)} ${source.version ?? "missing"}`);
	}
	if (report.ok) {
		io.out(`release-check: ok (${report.version})`);
		return 0;
	}
	for (const problem of report.problems) io.err(`release-check: ${problem}`);
	io.err(`release-check: failed (${report.problems.length} ${report.problems.length === 1 ? "problem" : "problems"})`);
	return 1;
}

if (import.meta.main) {
	process.exitCode = main(Bun.argv.slice(2), {
		out: (line) => console.log(line),
		err: (line) => console.error(line),
		root: resolve(fileURLToPath(import.meta.url), "..", ".."),
	});
}
