// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CONFIG_PATH = join(REPO_ROOT, ".github", "dependabot.yml");
const SKIPPED_DIRS: Record<string, true> = { node_modules: true, ".git": true };

interface DependabotUpdate {
	"package-ecosystem"?: string;
	directory?: string;
}

interface DependabotConfig {
	updates?: DependabotUpdate[];
}

interface RepoScan {
	/** Absolute directories that contain a bun.lock file. */
	lockDirs: string[];
	/** Absolute directories that contain .github/workflows. */
	workflowDirs: string[];
}

function scanRepo(root: string): RepoScan {
	const scan: RepoScan = { lockDirs: [], workflowDirs: [] };
	const visit = (dir: string): void => {
		const entries = readdirSync(dir, { withFileTypes: true });
		if (entries.some((entry) => entry.isFile() && entry.name === "bun.lock")) {
			scan.lockDirs.push(dir);
		}
		if (existsSync(join(dir, ".github", "workflows"))) {
			scan.workflowDirs.push(dir);
		}
		for (const entry of entries) {
			if (entry.isDirectory() && SKIPPED_DIRS[entry.name] === undefined) {
				visit(join(dir, entry.name));
			}
		}
	};
	visit(root);
	return scan;
}

/** Dependabot directory for an absolute path: "/" for the root, otherwise "/<posix relative path>". */
function toDependabotDirectory(root: string, dir: string): string {
	const rel = relative(root, dir).split(sep).join(posix.sep);
	return rel === "" ? "/" : `/${rel}`;
}

/** Lockfile and workflow directories with no Dependabot entry at their exact directory. */
function coverageGaps(root: string, config: DependabotConfig): string[] {
	const covered = new Set<string>();
	for (const update of config.updates ?? []) {
		covered.add(`${update["package-ecosystem"]} ${update.directory}`);
	}

	const scan = scanRepo(root);
	const gaps: string[] = [];
	for (const dir of scan.lockDirs) {
		const key = `bun ${toDependabotDirectory(root, dir)}`;
		if (!covered.has(key)) gaps.push(key);
	}
	for (const dir of scan.workflowDirs) {
		const key = `github-actions ${toDependabotDirectory(root, dir)}`;
		if (!covered.has(key)) gaps.push(key);
	}
	return gaps.sort();
}

// Bun.YAML arrived after Bun 1.2.x, which the CI matrix still runs. The coverage
// check runs wherever the parser exists (the CI latest leg and local Bun 1.4+).
describe.skipIf(typeof Bun.YAML === "undefined")("dependabot coverage", () => {
	const tempRoots: string[] = [];

	afterEach(() => {
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function makeTempRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "dependabot-coverage-"));
		tempRoots.push(root);
		return root;
	}

	function writeFile(root: string, rel: string, content: string): void {
		const path = join(root, rel);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}

	function loadRealConfig(): DependabotConfig {
		return Bun.YAML.parse(readFileSync(CONFIG_PATH, "utf8")) as DependabotConfig;
	}

	test("the repository scan finds the plugin lockfile and every entry covers its directory", () => {
		const scan = scanRepo(REPO_ROOT);
		expect(scan.lockDirs.map((dir) => toDependabotDirectory(REPO_ROOT, dir))).toContain("/plugins/omp-token-opt");

		expect(coverageGaps(REPO_ROOT, loadRealConfig())).toEqual([]);
	});

	test("fails when the plugin bun entry is removed", () => {
		const config = loadRealConfig();
		const withoutPlugin: DependabotConfig = {
			updates: (config.updates ?? []).filter((update) => update.directory !== "/plugins/omp-token-opt"),
		};
		expect(coverageGaps(REPO_ROOT, withoutPlugin)).toEqual(["bun /plugins/omp-token-opt"]);
	});

	test("fails when a new lockfile or workflow directory has no entry", () => {
		const root = makeTempRoot();
		writeFile(root, "bun.lock", "{}");
		writeFile(root, ".github/workflows/ci.yml", "name: ci\n");
		writeFile(root, "services/covered/bun.lock", "{}");
		writeFile(root, "services/new-thing/bun.lock", "{}");
		writeFile(root, "tools/x/.github/workflows/ci.yml", "name: ci\n");

		const config: DependabotConfig = {
			updates: [
				{ "package-ecosystem": "github-actions", directory: "/" },
				{ "package-ecosystem": "bun", directory: "/" },
				{ "package-ecosystem": "bun", directory: "/services/covered" },
			],
		};
		expect(coverageGaps(root, config)).toEqual(["bun /services/new-thing", "github-actions /tools/x"]);
	});

	test("ignores lockfiles under node_modules", () => {
		const root = makeTempRoot();
		writeFile(root, "bun.lock", "{}");
		writeFile(root, "services/app/node_modules/dep/bun.lock", "{}");

		const config: DependabotConfig = { updates: [{ "package-ecosystem": "bun", directory: "/" }] };
		expect(coverageGaps(root, config)).toEqual([]);
	});
});
