// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	type Advisory,
	type CliIo,
	type InstalledPackage,
	type Policy,
	type Severity,
	collectLicenses,
	evaluateAudit,
	evaluateChecks,
	evaluateLicenses,
	latestChecks,
	loadPolicy,
	main,
	parseAuditOutput,
	parsePolicy,
	runBunAudit,
	spdxAllowed,
} from "./security-gate.ts";

const REPO = resolve(import.meta.dir, "..");
const SHIPPED_POLICY = join(REPO, ".github", "security-policy.json");
const FIXTURES = join(REPO, "scripts", "fixtures");
const REAL_EMPTY_FIXTURE = join(FIXTURES, "bun-audit.json");
const SYNTHETIC_FIXTURE = join(FIXTURES, "bun-audit.synthetic-high.json");
const SYNTHETIC_URL = "https://github.com/advisories/GHSA-synthetic-high-0001";
const TODAY = "2026-10-21";
const LICENSE_ALLOW = ["MIT", "Apache-2.0", "ISC", "BSD-3-Clause"];
const PLAN_CHECKS = [
	"Dependency audit",
	"License policy",
	"Semgrep",
	"Analyze (javascript-typescript)",
	"Analyze (python)",
	"Check and test (Bun latest)",
];
/** One real advisory object, copied verbatim from `bun audit --json` run against a probe project with lodash@4.17.15. */
const CAPTURED_NONEMPTY =
	'{"lodash":[{"id":1106913,"url":"https://github.com/advisories/GHSA-35jh-r3h4-6jhm","title":"Command Injection in lodash","severity":"high","vulnerable_versions":"<4.17.21","cwe":["CWE-77","CWE-94"],"cvss":{"score":7.2,"vectorString":"CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H"}}]}';

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "security-gate-"));
	dirs.push(dir);
	return dir;
}

function write(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

function policyJson(patch: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		audit: { level: "high", allow: [] },
		licenses: { allow: LICENSE_ALLOW, exceptions: [] },
		requiredChecks: ["Semgrep"],
		...patch,
	};
}

function policyOf(patch: Record<string, unknown> = {}): Policy {
	return parsePolicy(policyJson(patch));
}

function writePolicy(dir: string, json: Record<string, unknown>): string {
	const file = join(dir, "policy.json");
	write(file, JSON.stringify(json));
	return file;
}

type Run = { code: number; out: string[]; err: string[] };

function run(argv: string[], runAudit?: CliIo["runAudit"], root = REPO): Run {
	const out: string[] = [];
	const err: string[] = [];
	const code = main(argv, { out: (line) => out.push(line), err: (line) => err.push(line), root, runAudit });
	return { code, out, err };
}

function evidence(file: string): Record<string, unknown> {
	return JSON.parse(readFileSync(file, "utf8"));
}

const advisory = (severity: Severity, id = 1, url = `https://example.test/advisory/${id}`): Advisory => ({
	package: "pkg",
	id,
	url,
	title: "test advisory",
	severity,
	vulnerableVersions: "*",
});

const pkg = (name: string, license: unknown, version = "1.0.0"): InstalledPackage => ({
	file: `node_modules/${name}/package.json`,
	name,
	version,
	license,
});

function installPackage(root: string, dir: string, manifest: unknown): void {
	write(join(root, "node_modules", dir, "package.json"), JSON.stringify(manifest));
}

function checkLine(id: number, name: string, status: string, conclusion: string | null): string {
	return JSON.stringify({ id, name, status, conclusion });
}

describe("shipped policy", () => {
	test("parses and carries the plan's audit level, license allow list and required checks", () => {
		const { policy } = loadPolicy(SHIPPED_POLICY);
		expect(policy.audit).toEqual({ level: "high", allow: [] });
		expect(policy.licenses.allow).toEqual([
			"0BSD",
			"Apache-2.0",
			"BlueOak-1.0.0",
			"BSD-2-Clause",
			"BSD-3-Clause",
			"CC0-1.0",
			"ISC",
			"MIT",
			"MIT-0",
			"Unlicense",
		]);
		expect(policy.licenses.exceptions).toEqual([]);
		expect(policy.requiredChecks).toEqual(PLAN_CHECKS);
	});

	test("the policy digest reported by loadPolicy is the sha256 of the file bytes", () => {
		const bytes = readFileSync(SHIPPED_POLICY, "utf8");
		expect(loadPolicy(SHIPPED_POLICY).sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
	});
});

describe("parsePolicy", () => {
	test("rejects an unknown audit level", () => {
		expect(() => parsePolicy(policyJson({ audit: { level: "medium", allow: [] } }))).toThrow();
	});

	test("rejects an allow entry without a reason", () => {
		const allow = [{ advisory: SYNTHETIC_URL, reason: "", expires: "2026-12-31" }];
		expect(() => parsePolicy(policyJson({ audit: { level: "high", allow } }))).toThrow();
	});

	test("rejects an expiry that is not a real calendar day", () => {
		const allow = [{ advisory: SYNTHETIC_URL, reason: "r", expires: "2026-02-30" }];
		expect(() => parsePolicy(policyJson({ audit: { level: "high", allow } }))).toThrow();
	});

	test("rejects an empty requiredChecks list, which would pass every run vacuously", () => {
		expect(() => parsePolicy(policyJson({ requiredChecks: [] }))).toThrow();
	});

	test("rejects a non-object root", () => {
		expect(() => parsePolicy([])).toThrow();
	});
});

describe("audit parsing", () => {
	test("the captured empty report parses to no advisories", () => {
		expect(parseAuditOutput(readFileSync(REAL_EMPTY_FIXTURE, "utf8"))).toEqual([]);
	});

	test("a captured non-empty report parses to its advisory fields", () => {
		expect(parseAuditOutput(CAPTURED_NONEMPTY)).toEqual([
			{
				package: "lodash",
				id: 1106913,
				url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
				title: "Command Injection in lodash",
				severity: "high",
				vulnerableVersions: "<4.17.21",
			},
		]);
	});

	test("the synthetic high fixture parses to one high advisory", () => {
		const advisories = parseAuditOutput(readFileSync(SYNTHETIC_FIXTURE, "utf8"));
		expect(advisories.map((item) => [item.severity, item.url])).toEqual([["high", SYNTHETIC_URL]]);
	});

	test("unknown shapes throw rather than parse to an empty list", () => {
		const shapes = [
			"[]",
			"not json",
			'{"lodash":{}}',
			'{"lodash":[{"id":"1","url":"u","title":"t","severity":"high","vulnerable_versions":"*"}]}',
			'{"lodash":[{"id":1,"url":"u","title":"t","severity":"medium","vulnerable_versions":"*"}]}',
			'{"lodash":[{"id":1,"url":"u","title":"t","severity":"high"}]}',
		];
		for (const shape of shapes) expect(() => parseAuditOutput(shape)).toThrow();
	});
});

describe("audit evaluation", () => {
	test("the captured empty report passes the shipped policy", () => {
		const { policy } = loadPolicy(SHIPPED_POLICY);
		expect(evaluateAudit(parseAuditOutput(readFileSync(REAL_EMPTY_FIXTURE, "utf8")), policy, TODAY).status).toBe("pass");
	});

	test("moderate advisories do not block at the high threshold", () => {
		const result = evaluateAudit([advisory("moderate")], policyOf(), TODAY);
		expect(result.status).toBe("pass");
		expect(result.atOrAboveLevel).toBe(0);
	});

	test("high and critical advisories without an allow entry block", () => {
		const result = evaluateAudit([advisory("high", 1), advisory("critical", 2)], policyOf(), TODAY);
		expect(result.status).toBe("fail");
		expect(result.blocking.map((item) => item.reason)).toEqual(["no allow entry", "no allow entry"]);
	});

	test("an allow entry naming the URL waives the advisory", () => {
		const allow = [{ advisory: "https://example.test/advisory/1", reason: "accepted", expires: "2026-12-31" }];
		const result = evaluateAudit([advisory("high", 1)], policyOf({ audit: { level: "high", allow } }), TODAY);
		expect(result.status).toBe("pass");
		expect(result.waived).toHaveLength(1);
	});

	test("an allow entry naming the numeric id waives the advisory", () => {
		const allow = [{ advisory: "1", reason: "accepted", expires: "2026-12-31" }];
		const result = evaluateAudit([advisory("high", 1)], policyOf({ audit: { level: "high", allow } }), TODAY);
		expect(result.status).toBe("pass");
	});

	test("an allow entry expiring on today still waives; one expiring yesterday fails", () => {
		const entry = (expires: string) => ({ advisory: "1", reason: "accepted", expires });
		const onToday = evaluateAudit([advisory("high", 1)], policyOf({ audit: { level: "high", allow: [entry(TODAY)] } }), TODAY);
		expect(onToday.status).toBe("pass");
		const expiredYesterday = evaluateAudit(
			[advisory("high", 1)],
			policyOf({ audit: { level: "high", allow: [entry("2026-10-20")] } }),
			TODAY,
		);
		expect(expiredYesterday.status).toBe("fail");
		expect(expiredYesterday.blocking.map((item) => item.reason)).toEqual(["allow entry expired"]);
	});

	test("an expired allow entry fails the gate even when no advisory matches it", () => {
		const allow = [{ advisory: SYNTHETIC_URL, reason: "stale", expires: "2026-10-20" }];
		const result = evaluateAudit([], policyOf({ audit: { level: "high", allow } }), TODAY);
		expect(result.status).toBe("fail");
		expect(result.expiredAllow).toHaveLength(1);
	});
});

describe("audit CLI", () => {
	test("the synthetic high advisory fails, writes evidence, and an allow entry passes it", () => {
		const dir = tempDir();
		const out = join(dir, "ev");
		const failing = run(["audit", "--root", dir, "--input", SYNTHETIC_FIXTURE, "--policy", SHIPPED_POLICY, "--today", TODAY, "--out", out]);
		expect(failing.code).toBe(1);
		expect(evidence(join(out, "audit.json")).status).toBe("fail");

		const allow = [{ advisory: SYNTHETIC_URL, reason: "fixture waiver", expires: "2026-12-31" }];
		const policy = writePolicy(dir, policyJson({ audit: { level: "high", allow } }));
		const passing = run(["audit", "--root", dir, "--input", SYNTHETIC_FIXTURE, "--policy", policy, "--today", TODAY, "--out", out]);
		expect(passing.code).toBe(0);
		expect(evidence(join(out, "audit.json")).status).toBe("pass");
	});

	test("the captured empty report passes through the CLI", () => {
		const dir = tempDir();
		const code = run(["audit", "--root", dir, "--input", REAL_EMPTY_FIXTURE, "--policy", SHIPPED_POLICY, "--today", TODAY, "--out", join(dir, "ev")]).code;
		expect(code).toBe(0);
	});

	test("without --policy the policy comes from the first root's .github directory", () => {
		const dir = tempDir();
		const allow = [{ advisory: SYNTHETIC_URL, reason: "fixture waiver", expires: "2026-12-31" }];
		write(join(dir, ".github", "security-policy.json"), JSON.stringify(policyJson({ audit: { level: "high", allow } })));
		const code = run(["audit", "--root", dir, "--input", SYNTHETIC_FIXTURE, "--today", TODAY, "--out", join(dir, "ev")]).code;
		expect(code).toBe(0);
	});

	test("unknown output shapes exit 2 and write no evidence", () => {
		const shapes = ["[]", "not json", '{"lodash":{}}', '{"lodash":[{"id":1,"url":"u","title":"t","severity":"medium","vulnerable_versions":"*"}]}', ""];
		for (const shape of shapes) {
			const dir = tempDir();
			const input = join(dir, "raw.json");
			write(input, shape);
			const out = join(dir, "ev");
			expect(run(["audit", "--root", dir, "--input", input, "--policy", SHIPPED_POLICY, "--today", TODAY, "--out", out]).code).toBe(2);
			expect(existsSync(join(out, "audit.json"))).toBe(false);
		}
	});

	test("a stale audit.json from an earlier pass is removed before a failing run", () => {
		const dir = tempDir();
		const out = join(dir, "ev");
		write(join(out, "audit.json"), JSON.stringify({ gate: "audit", status: "pass" }));
		const input = join(dir, "raw.json");
		write(input, "not json");
		expect(run(["audit", "--root", dir, "--input", input, "--policy", SHIPPED_POLICY, "--today", TODAY, "--out", out]).code).toBe(2);
		expect(existsSync(join(out, "audit.json"))).toBe(false);
	});

	test("a bun audit tool error exits 2 and does not evaluate its stdout", () => {
		const dir = tempDir();
		const out = join(dir, "ev");
		const code = run(
			["audit", "--root", dir, "--policy", SHIPPED_POLICY, "--today", TODAY, "--out", out],
			() => ({ exitCode: 2, stdout: "{}", stderr: "registry unreachable" }),
		).code;
		expect(code).toBe(2);
		expect(existsSync(join(out, "audit.json"))).toBe(false);
	});

	test("bun audit exit 1 is read as advisories found and evaluated from its stdout", () => {
		const dir = tempDir();
		const out = join(dir, "ev");
		let seenLevel: string | undefined;
		const code = run(
			["audit", "--root", dir, "--policy", SHIPPED_POLICY, "--today", TODAY, "--out", out],
			(_root, level) => {
				seenLevel = level;
				return { exitCode: 1, stdout: readFileSync(SYNTHETIC_FIXTURE, "utf8"), stderr: "" };
			},
		).code;
		expect(code).toBe(1);
		expect(seenLevel).toBe("high");
		expect(evidence(join(out, "audit.json")).status).toBe("fail");
	});

	test("--input needs exactly one --root", () => {
		const dir = tempDir();
		const code = run(["audit", "--root", dir, "--root", dir, "--input", SYNTHETIC_FIXTURE, "--out", join(dir, "ev")]).code;
		expect(code).toBe(2);
	});
});

describe("SPDX expressions", () => {
	const cases: Array<[string, string[], boolean]> = [
		["(MIT OR GPL-3.0-only)", ["MIT"], true],
		["(MIT AND GPL-3.0-only)", ["MIT"], false],
		["(MIT OR Apache-2.0)", ["Apache-2.0"], true],
		["(MIT AND Apache-2.0)", ["MIT"], false],
		["GPL-3.0-only WITH classpath-exception-2.0", ["MIT"], false],
		["MIT WITH classpath-exception-2.0", ["MIT"], true],
		["mit", ["MIT"], true],
		["MIT AND (ISC OR GPL-2.0)", ["MIT", "ISC"], true],
		["MIT OR GPL-3.0-only AND ISC", ["MIT"], true],
		["MIT OR GPL-3.0-only AND ISC", ["ISC"], false],
	];

	for (const [expression, allow, expected] of cases) {
		test(`${expression} with allow ${allow.join(",")} is ${expected}`, () => {
			expect(spdxAllowed(expression, allow)).toBe(expected);
		});
	}

	test("malformed expressions throw so they can never pass", () => {
		for (const bad of ["", "(MIT", "MIT)", "MIT OR", "SEE LICENSE IN LICENSE", "AND MIT", "MIT WITH", "MIT AND WITH x"]) {
			expect(() => spdxAllowed(bad, ["MIT"])).toThrow();
		}
	});
});

describe("license evaluation", () => {
	const policy = policyOf();

	test("a missing license field fails", () => {
		expect(evaluateLicenses([pkg("nolicense", undefined)], policy, TODAY).status).toBe("fail");
	});

	test("the object form, the one-element array form and a plain string are accepted", () => {
		for (const license of [{ type: "MIT" }, ["MIT"], "MIT"]) {
			expect(evaluateLicenses([pkg("ok", license)], policy, TODAY).status).toBe("pass");
		}
	});

	test("a multi-element array, an empty string and a number are rejected", () => {
		for (const license of [["MIT", "ISC"], "", 42]) {
			expect(evaluateLicenses([pkg("bad", license)], policy, TODAY).status).toBe("fail");
		}
	});

	test("a package whose manifest lacks a version fails rather than passing", () => {
		const unversioned: InstalledPackage = { file: "node_modules/x/package.json", name: "x", license: "MIT", problem: "package.json has no name or version" };
		expect(evaluateLicenses([unversioned], policy, TODAY).status).toBe("fail");
	});

	test("an exact exception (name, version and license expression) waives a failing package before its expiry", () => {
		const exception = {
			name: "gpl-thing",
			version: "1.0.0",
			license: "GPL-3.0-only WITH classpath-exception-2.0",
			reason: "linked under the classpath exception",
			expires: "2026-12-31",
		};
		const result = evaluateLicenses(
			[pkg("gpl-thing", "GPL-3.0-only WITH classpath-exception-2.0")],
			policyOf({ licenses: { allow: LICENSE_ALLOW, exceptions: [exception] } }),
			TODAY,
		);
		expect(result.status).toBe("pass");
		expect(result.excepted).toHaveLength(1);
	});

	test("an exception is not matched by name alone: a version bump keeps no waiver", () => {
		const exception = {
			name: "gpl-thing",
			version: "1.0.0",
			license: "GPL-3.0-only WITH classpath-exception-2.0",
			reason: "linked under the classpath exception",
			expires: "2026-12-31",
		};
		const withException = policyOf({ licenses: { allow: LICENSE_ALLOW, exceptions: [exception] } });
		expect(evaluateLicenses([pkg("gpl-thing", "GPL-3.0-only WITH classpath-exception-2.0", "1.0.1")], withException, TODAY).status).toBe("fail");
		expect(evaluateLicenses([pkg("other-thing", "GPL-3.0-only WITH classpath-exception-2.0")], withException, TODAY).status).toBe("fail");
	});

	test("an exception does not waive a different license expression for the same package", () => {
		const exception = { name: "gpl-thing", version: "1.0.0", license: "GPL-3.0-only", reason: "r", expires: "2026-12-31" };
		const result = evaluateLicenses(
			[pkg("gpl-thing", "GPL-3.0-only WITH classpath-exception-2.0")],
			policyOf({ licenses: { allow: LICENSE_ALLOW, exceptions: [exception] } }),
			TODAY,
		);
		expect(result.status).toBe("fail");
	});

	test("an exception expiring on today still waives; one expiring yesterday fails and is reported", () => {
		const entry = (expires: string) => ({ name: "gpl-thing", version: "1.0.0", license: "GPL-3.0-only", reason: "r", expires });
		const onToday = evaluateLicenses([pkg("gpl-thing", "GPL-3.0-only")], policyOf({ licenses: { allow: LICENSE_ALLOW, exceptions: [entry(TODAY)] } }), TODAY);
		expect(onToday.status).toBe("pass");
		const expired = evaluateLicenses(
			[pkg("gpl-thing", "GPL-3.0-only")],
			policyOf({ licenses: { allow: LICENSE_ALLOW, exceptions: [entry("2026-10-20")] } }),
			TODAY,
		);
		expect(expired.status).toBe("fail");
		expect(expired.expiredExceptions).toHaveLength(1);
	});
});

describe("license tree collection", () => {
	test("collects installed packages, dedupes by name@version, and ignores non-package JSON", () => {
		const root = tempDir();
		installPackage(root, "alpha", { name: "alpha", version: "1.0.0", license: "MIT" });
		installPackage(root, "@scope/beta", { name: "@scope/beta", version: "2.0.0", license: "(MIT OR GPL-3.0-only)" });
		installPackage(root, "alpha/node_modules/gamma", { name: "gamma", version: "1.0.0", license: { type: "ISC" } });
		installPackage(root, ".bun/alpha@1.0.0/node_modules/alpha", { name: "alpha", version: "1.0.0", license: "MIT" });
		write(join(root, "node_modules", "alpha", "test", "package.json"), JSON.stringify({ private: true, license: "GPL-3.0-only" }));

		const packages = collectLicenses([root]);
		expect(packages.map((item) => `${item.name}@${item.version}`).sort()).toEqual(["@scope/beta@2.0.0", "alpha@1.0.0", "gamma@1.0.0"]);
		const result = evaluateLicenses(packages, policyOf(), TODAY);
		expect(result.status).toBe("pass");
		expect(result.packageCount).toBe(3);
	});

	test("a package only present in Bun's dot store is still evaluated", () => {
		const root = tempDir();
		installPackage(root, "alpha", { name: "alpha", version: "1.0.0", license: "MIT" });
		installPackage(root, ".bun/delta@1.0.0/node_modules/delta", { name: "delta", version: "1.0.0", license: "GPL-3.0-only" });
		const result = evaluateLicenses(collectLicenses([root]), policyOf(), TODAY);
		expect(result.status).toBe("fail");
		expect(result.failures.map((item) => item.name)).toEqual(["delta"]);
	});

	test("a missing node_modules throws rather than reporting an empty pass", () => {
		expect(() => collectLicenses([tempDir()])).toThrow("bun install --frozen-lockfile");
	});

	test("the licenses CLI writes evidence for a passing tree, a failing tree, and exits 2 without node_modules", () => {
		const root = tempDir();
		const out = join(root, "ev");
		installPackage(root, "alpha", { name: "alpha", version: "1.0.0", license: "MIT" });
		expect(run(["licenses", "--root", root, "--out", out, "--policy", SHIPPED_POLICY, "--today", TODAY]).code).toBe(0);
		expect(evidence(join(out, "licenses.json")).status).toBe("pass");

		installPackage(root, "gpl", { name: "gpl", version: "1.0.0", license: "GPL-3.0-only" });
		const failing = run(["licenses", "--root", root, "--out", out, "--policy", SHIPPED_POLICY, "--today", TODAY]);
		expect(failing.code).toBe(1);
		expect(evidence(join(out, "licenses.json")).status).toBe("fail");
		expect(failing.err.join("\n")).toContain("gpl@1.0.0");

		expect(run(["licenses", "--root", tempDir(), "--out", join(root, "other"), "--policy", SHIPPED_POLICY, "--today", TODAY]).code).toBe(2);
	});
});

describe("check evaluation", () => {
	test("a rerun with a higher id replaces an earlier failure, in either line order", () => {
		const failedThenPassed = [checkLine(5, "Semgrep", "completed", "failure"), checkLine(9, "Semgrep", "completed", "success")].join("\n");
		const passedThenFailed = [checkLine(9, "Semgrep", "completed", "success"), checkLine(5, "Semgrep", "completed", "failure")].join("\n");
		for (const ndjson of [failedThenPassed, passedThenFailed]) {
			expect(evaluateChecks(latestChecks(ndjson), policyOf({ requiredChecks: ["Semgrep"] })).status).toBe("pass");
		}
	});

	const notSuccessful: Array<[string, string, string | null]> = [
		["completed", "skipped", "skipped"],
		["completed", "neutral", "neutral"],
		["completed", "failure", "failure"],
		["completed", "cancelled", "cancelled"],
		["in_progress", "in_progress", null],
		["queued", "queued", null],
	];
	for (const [label, status, conclusion] of notSuccessful) {
		test(`a required check that is ${label} with conclusion ${conclusion ?? "null"} fails`, () => {
			const latest = latestChecks(checkLine(1, "Semgrep", status, conclusion));
			expect(evaluateChecks(latest, policyOf({ requiredChecks: ["Semgrep"] })).status).toBe("fail");
		});
	}

	test("a required check with no run at all fails", () => {
		const result = evaluateChecks(latestChecks(checkLine(1, "Other", "completed", "success")), policyOf({ requiredChecks: ["Semgrep"] }));
		expect(result.status).toBe("fail");
		expect(result.checks[0]?.reason).toBe("no check run with this name");
	});

	test("checks that are not required do not affect the verdict", () => {
		const ndjson = [checkLine(1, "Semgrep", "completed", "success"), checkLine(2, "Experimental", "completed", "failure")].join("\n");
		expect(evaluateChecks(latestChecks(ndjson), policyOf({ requiredChecks: ["Semgrep"] })).status).toBe("pass");
	});

	test("a malformed NDJSON line throws", () => {
		expect(() => latestChecks('{"id":1,"name":"Semgrep","status":"completed","conclusion":"success"}\nnot json')).toThrow();
	});

	test("the checks CLI passes every shipped required check and writes evidence", () => {
		const dir = tempDir();
		const input = join(dir, "checks.ndjson");
		write(input, PLAN_CHECKS.map((name, index) => checkLine(index + 1, name, "completed", "success")).join("\n"));
		const out = join(dir, "ev");
		expect(run(["checks", "--input", input, "--policy", SHIPPED_POLICY, "--out", out]).code).toBe(0);
		expect(evidence(join(out, "checks.json")).status).toBe("pass");
	});

	test("a missing checks input exits 2 and removes a stale checks.json", () => {
		const dir = tempDir();
		const out = join(dir, "ev");
		write(join(out, "checks.json"), JSON.stringify({ gate: "checks", status: "pass" }));
		expect(run(["checks", "--input", join(dir, "absent.ndjson"), "--policy", SHIPPED_POLICY, "--out", out]).code).toBe(2);
		expect(existsSync(join(out, "checks.json"))).toBe(false);
	});
});

describe("report", () => {
	const gateFile = (dir: string, gate: string, status: string, gateName = gate) => {
		write(join(dir, `${gate}.json`), JSON.stringify({ schema: 1, gate: gateName, status }));
	};

	test("all three passing gates produce a passing manifest with sha, tag and policy digest", () => {
		const dir = tempDir();
		for (const gate of ["audit", "licenses", "checks"]) gateFile(dir, gate, "pass");
		const code = run(["report", "--out", dir, "--policy", SHIPPED_POLICY, "--sha", "abc123", "--tag", "v1.2.3"]).code;
		expect(code).toBe(0);
		const manifest = evidence(join(dir, "manifest.json"));
		expect(manifest.status).toBe("pass");
		expect(manifest.sha).toBe("abc123");
		expect(manifest.tag).toBe("v1.2.3");
		expect(manifest.policy).toEqual({ file: SHIPPED_POLICY, sha256: loadPolicy(SHIPPED_POLICY).sha256 });
	});

	test("a missing audit.json is a failure: exit 1, manifest still written, and the gap named", () => {
		const dir = tempDir();
		gateFile(dir, "licenses", "pass");
		gateFile(dir, "checks", "pass");
		expect(run(["report", "--out", dir, "--policy", SHIPPED_POLICY]).code).toBe(1);
		const manifest = evidence(join(dir, "manifest.json"));
		expect(manifest.status).toBe("fail");
		expect(manifest.failures).toEqual(["audit: audit.json missing"]);
	});

	test("a failing gate exits 1 and is named in the manifest", () => {
		const dir = tempDir();
		gateFile(dir, "audit", "pass");
		gateFile(dir, "licenses", "pass");
		gateFile(dir, "checks", "fail");
		expect(run(["report", "--out", dir, "--policy", SHIPPED_POLICY]).code).toBe(1);
		expect(evidence(join(dir, "manifest.json")).failures).toEqual(["checks: status fail"]);
	});

	test("evidence that is not the named gate's file exits 2 and removes any stale manifest", () => {
		const dir = tempDir();
		gateFile(dir, "audit", "pass");
		gateFile(dir, "licenses", "pass");
		gateFile(dir, "checks", "pass", "audit");
		write(join(dir, "manifest.json"), JSON.stringify({ status: "pass" }));
		expect(run(["report", "--out", dir, "--policy", SHIPPED_POLICY]).code).toBe(2);
		expect(existsSync(join(dir, "manifest.json"))).toBe(false);
	});
});

describe("bun subprocess", () => {
	test("the audit subprocess runs process.execPath, not a bare bun found on PATH", () => {
		const calls: Array<{ cmd: string[]; cwd: string }> = [];
		const result = runBunAudit("/some/root", "high", (cmd, options) => {
			calls.push({ cmd, cwd: options.cwd });
			return { exitCode: 0, stdout: new TextEncoder().encode("{}"), stderr: new Uint8Array() };
		});
		expect(calls).toEqual([
			{ cmd: [process.execPath, "audit", "--audit-level=high", "--json"], cwd: "/some/root" },
		]);
		expect(result).toEqual({ exitCode: 0, stdout: "{}", stderr: "" });
	});
});

describe("ancestry", () => {
	const gitIdentity = ["-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false"];

	function git(dir: string, ...args: string[]): string {
		const result = Bun.spawnSync(["git", ...gitIdentity, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
		return new TextDecoder().decode(result.stdout).trim();
	}

	/** A repo whose origin/main is its first commit, the way the release job's fetch leaves it. */
	function repoWithMain(): { dir: string; onMain: string } {
		const dir = tempDir();
		git(dir, "init", "-q");
		git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
		git(dir, "commit", "-q", "--allow-empty", "-m", "on main");
		const onMain = git(dir, "rev-parse", "HEAD");
		git(dir, "update-ref", "refs/remotes/origin/main", onMain);
		return { dir, onMain };
	}

	test("a tagged commit on origin/main passes", () => {
		const { dir, onMain } = repoWithMain();
		expect(run(["ancestry", "--sha", onMain], undefined, dir).code).toBe(0);
	});

	test("a tagged commit that is not on origin/main is refused with exit 1", () => {
		const { dir } = repoWithMain();
		git(dir, "checkout", "-q", "-b", "feature");
		git(dir, "commit", "-q", "--allow-empty", "-m", "off main");
		const offMain = git(dir, "rev-parse", "HEAD");
		const result = run(["ancestry", "--sha", offMain], undefined, dir);
		expect(result.code).toBe(1);
		expect(result.err.join("\n")).toContain("is not an ancestor of origin/main");
	});

	test("a commit on origin/main with passing scan evidence proceeds through ancestry and report", () => {
		const { dir, onMain } = repoWithMain();
		const out = tempDir();
		for (const gate of ["audit", "licenses", "checks"]) {
			write(join(out, `${gate}.json`), JSON.stringify({ schema: 1, gate, status: "pass" }));
		}
		expect(run(["ancestry", "--sha", onMain], undefined, dir).code).toBe(0);
		expect(run(["report", "--out", out, "--policy", SHIPPED_POLICY, "--sha", onMain], undefined, dir).code).toBe(0);
		expect(evidence(join(out, "manifest.json")).status).toBe("pass");
	});

	test("a missing origin/main ref fails closed with exit 2, never a pass", () => {
		const dir = tempDir();
		git(dir, "init", "-q");
		git(dir, "commit", "-q", "--allow-empty", "-m", "no remote");
		const sha = git(dir, "rev-parse", "HEAD");
		expect(run(["ancestry", "--sha", sha], undefined, dir).code).toBe(2);
	});
});

describe("usage errors", () => {
	const cases: string[][] = [
		[],
		["deploy"],
		["audit", "--root", REPO],
		["audit", "--root", REPO, "--out", "x", "--bogus", "1"],
		["audit", "--root", REPO, "--out", "x", "--out", "y"],
		["audit", "--root", REPO, "--out", "--today"],
		["audit", "--root", REPO, "--out", "x", "--today", "2026-02-30"],
		["checks", "--input", "x", "--out", "y", "--root", REPO],
		["report"],
		["licenses", "--out", "x"],
		["ancestry"],
		["ancestry", "--sha", "HEAD"],
		["ancestry", "--sha", "abc", "--out", "x"],
	];
	for (const argv of cases) {
		test(`rejects ${JSON.stringify(argv)} with exit 2`, () => {
			expect(run(argv).code).toBe(2);
		});
	}
});
