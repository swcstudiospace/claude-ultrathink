// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { changelogSection, checkRelease, collectVersions } from "./release-check.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(import.meta.dir, "release-check.ts");
const VERSION = "1.2.3";

const CHANGELOG = [
	"# Changelog",
	"",
	"## [Unreleased]",
	"",
	"### Added",
	"",
	"- Something not released yet.",
	"",
	"## [1.2.3] - 2026-01-02",
	"",
	"### Fixed",
	"",
	"- The release body.",
	"",
	"## [1.2.2] - 2025-12-01",
	"",
	"- An older release.",
	"",
].join("\n");

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, file: string, text: string): void {
	const path = join(root, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function marketplace(version: string): string {
	return JSON.stringify({ name: "fx", metadata: { version }, plugins: [{ name: "fx", source: "./", version }] }, null, "\t");
}

/** A minimal repository whose every source says `version` and whose changelog documents it. */
function fixture(version = VERSION): string {
	const root = mkdtempSync(join(tmpdir(), "release-check-"));
	roots.push(root);
	put(root, "package.json", JSON.stringify({ name: "fx", version }, null, "\t"));
	put(root, ".claude-plugin/plugin.json", JSON.stringify({ name: "fx", version }, null, "\t"));
	put(root, ".claude-plugin/marketplace.json", marketplace(version));
	put(root, ".omp-plugin/marketplace.json", marketplace(version));
	put(root, ".muse-plugin/plugin.json", JSON.stringify({ name: "fx", version }, null, "\t"));
	put(root, "hosts/hermes/plugin.yaml", `name: fx\nversion: ${version}\ndescription: "version: 9.9.9 appears in prose"\n`);
	put(
		root,
		"hosts/prime-agent/pyproject.toml",
		`[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "fx"\nversion = "${version}"\n\n[tool.other]\nversion = "0.0.1"\n`,
	);
	put(root, "CHANGELOG.md", CHANGELOG.replaceAll("1.2.3", version));
	return root;
}

function rewrite(root: string, file: string, change: (text: string) => string): void {
	const path = join(root, file);
	writeFileSync(path, change(readFileSync(path, "utf8")));
}

/** Replaces the first or the last `"version": "<VERSION>"` of a JSON file with 9.9.9. */
function bumpJson(root: string, file: string, which: "first" | "last"): void {
	rewrite(root, file, (text) => {
		const needle = `"version": "${VERSION}"`;
		const at = which === "first" ? text.indexOf(needle) : text.lastIndexOf(needle);
		return `${text.slice(0, at)}"version": "9.9.9"${text.slice(at + needle.length)}`;
	});
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, SCRIPT, ...args], { env: {}, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

describe("this repository", () => {
	test("every manifest agrees with package.json and the changelog documents the version", () => {
		const report = checkRelease(REPO_ROOT);
		expect(report.problems).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(report.sources.map((source) => source.file)).toContain("hosts/prime-agent/pyproject.toml");
	});
});

describe("collectVersions", () => {
	test("reads every source, including each plugin entry of both marketplaces", () => {
		const sources = collectVersions(fixture());
		expect(sources.map((source) => `${source.file} ${source.label}`)).toEqual([
			"package.json version",
			".claude-plugin/plugin.json version",
			".claude-plugin/marketplace.json metadata.version",
			".claude-plugin/marketplace.json plugins[fx].version",
			".omp-plugin/marketplace.json metadata.version",
			".omp-plugin/marketplace.json plugins[fx].version",
			".muse-plugin/plugin.json version",
			"hosts/hermes/plugin.yaml version",
			"hosts/prime-agent/pyproject.toml [project] version",
		]);
		expect(sources.every((source) => source.version === VERSION)).toBe(true);
	});

	test("reads a version from the Hermes and Prime Agent files only where it is declared", () => {
		const root = fixture();
		rewrite(root, "hosts/hermes/plugin.yaml", (text) => text.replace(`version: ${VERSION}\n`, `version: "${VERSION}" # released\n`));
		rewrite(root, "hosts/prime-agent/pyproject.toml", (text) => text.replace(`version = "${VERSION}"\n`, "").replace("[project]\n", `[project]\nversion = "7.7.7"\n`));
		const byFile = Object.fromEntries(collectVersions(root).map((source) => [source.file, source.version]));
		expect(byFile["hosts/hermes/plugin.yaml"]).toBe(VERSION);
		expect(byFile["hosts/prime-agent/pyproject.toml"]).toBe("7.7.7");
	});
});

describe("checkRelease", () => {
	test("a consistent fixture is ok", () => {
		const report = checkRelease(fixture());
		expect(report).toMatchObject({ ok: true, version: VERSION, problems: [] });
	});

	const mismatches: [string, (root: string) => void][] = [
		[".claude-plugin/plugin.json", (root) => bumpJson(root, ".claude-plugin/plugin.json", "first")],
		[".claude-plugin/marketplace.json (metadata)", (root) => bumpJson(root, ".claude-plugin/marketplace.json", "first")],
		[".claude-plugin/marketplace.json (plugin entry)", (root) => bumpJson(root, ".claude-plugin/marketplace.json", "last")],
		[".omp-plugin/marketplace.json (metadata)", (root) => bumpJson(root, ".omp-plugin/marketplace.json", "first")],
		[".omp-plugin/marketplace.json (plugin entry)", (root) => bumpJson(root, ".omp-plugin/marketplace.json", "last")],
		[".muse-plugin/plugin.json", (root) => bumpJson(root, ".muse-plugin/plugin.json", "first")],
		["hosts/hermes/plugin.yaml", (root) => rewrite(root, "hosts/hermes/plugin.yaml", (text) => text.replace(`version: ${VERSION}\n`, "version: 9.9.9\n"))],
		[
			"hosts/prime-agent/pyproject.toml",
			(root) => rewrite(root, "hosts/prime-agent/pyproject.toml", (text) => text.replace(`version = "${VERSION}"`, 'version = "9.9.9"')),
		],
	];

	for (const [name, mismatch] of mismatches) {
		test(`a mismatched ${name} fails and names the file with both versions`, () => {
			const root = fixture();
			mismatch(root);
			const report = checkRelease(root);
			const file = name.split(" ")[0] ?? name;
			expect(report.ok).toBe(false);
			expect(report.problems).toHaveLength(1);
			expect(report.problems[0]).toContain(file);
			expect(report.problems[0]).toContain("9.9.9");
			expect(report.problems[0]).toContain(VERSION);
		});
	}

	test("a package.json bump without the other manifests names every other source", () => {
		const root = fixture();
		rewrite(root, "package.json", (text) => text.replace(VERSION, "1.2.4"));
		const report = checkRelease(root);
		expect(report.version).toBe("1.2.4");
		expect(report.problems.some((line) => line.startsWith(".claude-plugin/plugin.json"))).toBe(true);
		expect(report.problems.some((line) => line.startsWith("hosts/hermes/plugin.yaml"))).toBe(true);
		expect(report.problems.some((line) => line.startsWith("CHANGELOG.md"))).toBe(true);
	});

	test("a missing manifest is a problem naming the file", () => {
		const root = fixture();
		rmSync(join(root, ".muse-plugin/plugin.json"));
		const report = checkRelease(root);
		expect(report.ok).toBe(false);
		expect(report.problems).toHaveLength(1);
		expect(report.problems[0]).toContain(".muse-plugin/plugin.json");
		expect(report.problems[0]).toContain(VERSION);
	});

	test("a manifest without a version field is a problem naming the file", () => {
		const root = fixture();
		put(root, ".claude-plugin/plugin.json", JSON.stringify({ name: "fx" }));
		const report = checkRelease(root);
		expect(report.problems).toHaveLength(1);
		expect(report.problems[0]).toContain(".claude-plugin/plugin.json");
	});

	test("a missing package.json fails without throwing", () => {
		const root = fixture();
		rmSync(join(root, "package.json"));
		const report = checkRelease(root);
		expect(report.ok).toBe(false);
		expect(report.version).toBeUndefined();
		expect(report.problems[0]).toContain("package.json");
	});

	test("a version that is not a semver fails", () => {
		const root = fixture("1.2");
		const report = checkRelease(root);
		expect(report.ok).toBe(false);
		expect(report.problems.some((line) => line.includes("package.json") && line.includes('"1.2"'))).toBe(true);
	});

	test("a prerelease version is a valid semver", () => {
		expect(checkRelease(fixture("2.0.0-rc.1"))).toMatchObject({ ok: true, version: "2.0.0-rc.1" });
	});

	test("a changelog without a dated section for the version fails", () => {
		const root = fixture();
		rewrite(root, "CHANGELOG.md", (text) => text.replace("## [1.2.3] - 2026-01-02", "## [1.2.3]"));
		const report = checkRelease(root);
		expect(report.ok).toBe(false);
		expect(report.problems).toHaveLength(1);
		expect(report.problems[0]).toContain("CHANGELOG.md");
		expect(report.problems[0]).toContain(VERSION);
	});

	test("a changelog without an [Unreleased] heading fails", () => {
		const root = fixture();
		rewrite(root, "CHANGELOG.md", (text) => text.replace("## [Unreleased]\n", ""));
		const report = checkRelease(root);
		expect(report.problems).toHaveLength(1);
		expect(report.problems[0]).toContain("[Unreleased]");
	});

	test("a missing changelog fails", () => {
		const root = fixture();
		rmSync(join(root, "CHANGELOG.md"));
		const report = checkRelease(root);
		expect(report.ok).toBe(false);
		expect(report.problems[0]).toContain("CHANGELOG.md");
	});

	test("the tag must be v<version>", () => {
		const root = fixture();
		expect(checkRelease(root, { tag: `v${VERSION}` })).toMatchObject({ ok: true, problems: [] });
		const wrong = checkRelease(root, { tag: "v1.2.4" });
		expect(wrong.ok).toBe(false);
		expect(wrong.problems).toHaveLength(1);
		expect(wrong.problems[0]).toContain("v1.2.4");
		expect(wrong.problems[0]).toContain(VERSION);
		expect(checkRelease(root, { tag: VERSION }).ok).toBe(false);
	});
});

describe("changelogSection", () => {
	test("returns exactly the body between the version heading and the next heading", () => {
		expect(changelogSection(fixture(), VERSION)).toBe("### Fixed\n\n- The release body.");
	});

	test("returns the last section to the end of the file", () => {
		expect(changelogSection(fixture(), "1.2.2")).toBe("- An older release.");
	});

	test("is undefined for an unknown version, an undated heading and a missing changelog", () => {
		const root = fixture();
		expect(changelogSection(root, "9.9.9")).toBeUndefined();
		expect(changelogSection(root, "Unreleased")).toBeUndefined();
		rewrite(root, "CHANGELOG.md", (text) => text.replace("## [1.2.3] - 2026-01-02", "## [1.2.3]"));
		expect(changelogSection(root, VERSION)).toBeUndefined();
		rmSync(join(root, "CHANGELOG.md"));
		expect(changelogSection(root, VERSION)).toBeUndefined();
	});

	test("does not treat the dots of a version as wildcards", () => {
		const root = fixture();
		expect(changelogSection(root, "1x2x3")).toBeUndefined();
	});
});

describe("command line", () => {
	test("exits 0 and prints one line per source then the verdict", async () => {
		const root = fixture();
		const result = await runCli(["--root", root, "--tag", `v${VERSION}`]);
		expect(result.code).toBe(0);
		const lines = result.stdout.trim().split("\n");
		expect(lines.at(-1)).toBe(`release-check: ok (${VERSION})`);
		expect(lines).toHaveLength(collectVersions(root).length + 1);
		expect(lines[0]).toContain("package.json");
		expect(lines.every((line) => !line.includes("MISMATCH"))).toBe(true);
	});

	test("exits 1 and names the file and both versions on a mismatch", async () => {
		const root = fixture();
		bumpJson(root, ".muse-plugin/plugin.json", "first");
		const result = await runCli(["--root", root]);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("MISMATCH");
		expect(result.stderr).toContain(".muse-plugin/plugin.json");
		expect(result.stderr).toContain("9.9.9");
		expect(result.stderr).toContain(VERSION);
		expect(result.stdout).not.toContain("release-check: ok");
	});

	test("exits 1 for a tag that does not match", async () => {
		const result = await runCli(["--root", fixture(), "--tag", "v0.0.1"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("v0.0.1");
	});

	test("exits 2 with a usage line for unknown or incomplete arguments", async () => {
		for (const args of [["--nope"], ["extra"], ["--tag"], ["--root"], ["--tag", "--notes"]]) {
			const result = await runCli(args);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("usage:");
			expect(result.stdout).toBe("");
		}
	});

	test("--notes prints only the changelog section body", async () => {
		const result = await runCli(["--root", fixture(), "--notes"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("### Fixed\n\n- The release body.\n");
		expect(result.stderr).toBe("");
	});

	test("--notes exits 1 with a message on stderr when the section is missing", async () => {
		const root = fixture();
		rewrite(root, "CHANGELOG.md", (text) => text.replace("## [1.2.3] - 2026-01-02", "## [1.2.4] - 2026-01-02"));
		const result = await runCli(["--root", root, "--notes"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(VERSION);
	});

	test("with no arguments it checks the repository this script lives in", async () => {
		const result = await runCli([]);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("release-check: ok (");
	});
});
