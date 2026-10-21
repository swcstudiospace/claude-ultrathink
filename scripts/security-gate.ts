#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * scripts/security-gate.ts — the security gate for CI and releases.
 *
 * Five modes. Each of the first three writes one evidence file, and `report` reads all three. `ancestry` writes none:
 *   audit     bun audit JSON against the policy threshold and allow list  -> audit.json
 *   licenses  installed package licenses against the SPDX allow list       -> licenses.json
 *   checks    gh api check-run NDJSON against requiredChecks               -> checks.json
 *   report    reads the three files and writes the release manifest        -> manifest.json
 *   ancestry  the tagged commit is an ancestor of origin/main    -> nothing; exit 1 when it is not
 *
 * Exit codes: 0 pass; 1 policy failure (evidence is still written); 2 usage error, unknown
 * tool output shape, or tool error. Fails closed: each run deletes its own evidence file first,
 * and `report` counts a missing evidence file as a failure, so a stale pass cannot survive.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isPlainObject } from "../src/decisions/client.ts";

export const SEVERITIES = ["low", "moderate", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type AuditAllow = { advisory: string; reason: string; expires: string };
export type LicenseException = { name: string; version: string; license: string; reason: string; expires: string };
export type Policy = {
	audit: { level: Severity; allow: AuditAllow[] };
	licenses: { allow: string[]; exceptions: LicenseException[] };
	requiredChecks: string[];
};

export type Advisory = {
	package: string;
	id: number;
	url: string;
	title: string;
	severity: Severity;
	vulnerableVersions: string;
};

export type AuditResult = {
	status: "pass" | "fail";
	level: Severity;
	advisoryCount: number;
	atOrAboveLevel: number;
	blocking: Array<Advisory & { reason: string }>;
	waived: Array<Advisory & { allow: AuditAllow }>;
	expiredAllow: AuditAllow[];
};

export type AuditRun = { exitCode: number; stdout: string; stderr: string };

export type InstalledPackage = { file: string; name?: string; version?: string; license?: unknown; problem?: string };
export type LicenseFailure = { file: string; name?: string; version?: string; license?: string; reason: string };
export type LicenseWaiver = { name: string; version: string; license: string; reason: string };
export type LicenseResult = {
	status: "pass" | "fail";
	packageCount: number;
	failures: LicenseFailure[];
	excepted: LicenseWaiver[];
	expiredExceptions: LicenseException[];
};

export type CheckRun = { id: number; name: string; status: string; conclusion: string | null };
export type CheckOutcome = {
	name: string;
	status: "pass" | "fail";
	reason: string;
	id: number | null;
	runStatus: string | null;
	conclusion: string | null;
};
export type ChecksResult = { status: "pass" | "fail"; checks: CheckOutcome[] };

export type Gate = "audit" | "licenses" | "checks";
const GATES: readonly Gate[] = ["audit", "licenses", "checks"];
export type EvidenceInput = { gate: Gate; file: string; present: boolean; status: "pass" | "fail" };
export type Manifest = {
	schema: number;
	status: "pass" | "fail";
	sha: string | null;
	tag: string | null;
	policy: { file: string; sha256: string };
	inputs: EvidenceInput[];
	failures: string[];
};

export type CliIo = {
	out: (line: string) => void;
	err: (line: string) => void;
	/** The repository root; checks and report read `.github/security-policy.json` under it by default. */
	root: string;
	/** Runs `bun audit` in one root. Tests inject a fixed result; the default spawns bun. */
	runAudit?: (root: string, level: Severity) => AuditRun;
};

const SCHEMA = 1;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const USAGE = [
	"usage: bun scripts/security-gate.ts audit --root <dir>... --out <dir> [--policy <file>] [--today YYYY-MM-DD] [--input <file>]",
	"       bun scripts/security-gate.ts licenses --root <dir>... --out <dir> [--policy <file>] [--today YYYY-MM-DD]",
	"       bun scripts/security-gate.ts checks --input <ndjson> --out <dir> [--policy <file>]",
	"       bun scripts/security-gate.ts report --out <dir> [--sha <sha>] [--tag <tag>] [--policy <file>]",
	"       bun scripts/security-gate.ts ancestry --sha <sha>",
].join("\n");

// ---------- shared helpers ----------


function isSeverity(value: unknown): value is Severity {
	return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A YYYY-MM-DD string that names a real calendar day. */
export function isIsoDate(value: unknown): value is string {
	if (typeof value !== "string" || !DATE.test(value)) return false;
	const time = Date.parse(`${value}T00:00:00Z`);
	return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** An entry is valid through its `expires` day and expired after it. Both dates are validated YYYY-MM-DD. */
function expired(expires: string, today: string): boolean {
	return expires < today;
}

function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

function defaultPolicy(root: string): string {
	return join(root, ".github", "security-policy.json");
}

// ---------- policy ----------

function record(value: unknown, path: string): Record<string, unknown> {
	if (!isPlainObject(value)) throw new Error(`policy: ${path} must be an object`);
	return value;
}

function list(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`policy: ${path} must be an array`);
	return value;
}

function text(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`policy: ${path} must be a non-empty string`);
	return value;
}

function date(value: unknown, path: string): string {
	if (!isIsoDate(value)) throw new Error(`policy: ${path} must be a YYYY-MM-DD date`);
	return value;
}

/** Validates the whole policy shape and throws on any deviation, so a bad policy never gates anything. */
export function parsePolicy(value: unknown): Policy {
	const root = record(value, "root");
	const audit = record(root.audit, "audit");
	const licenses = record(root.licenses, "licenses");
	if (!isSeverity(audit.level)) throw new Error(`policy: audit.level must be one of ${SEVERITIES.join(", ")}`);
	const requiredChecks = list(root.requiredChecks, "requiredChecks").map((name, index) =>
		text(name, `requiredChecks[${index}]`),
	);
	if (requiredChecks.length === 0) throw new Error("policy: requiredChecks must not be empty");
	return {
		audit: {
			level: audit.level,
			allow: list(audit.allow, "audit.allow").map((entry, index) => {
				const item = record(entry, `audit.allow[${index}]`);
				return {
					advisory: text(item.advisory, `audit.allow[${index}].advisory`),
					reason: text(item.reason, `audit.allow[${index}].reason`),
					expires: date(item.expires, `audit.allow[${index}].expires`),
				};
			}),
		},
		licenses: {
			allow: list(licenses.allow, "licenses.allow").map((id, index) => text(id, `licenses.allow[${index}]`)),
			exceptions: list(licenses.exceptions, "licenses.exceptions").map((entry, index) => {
				const item = record(entry, `licenses.exceptions[${index}]`);
				return {
					name: text(item.name, `licenses.exceptions[${index}].name`),
					version: text(item.version, `licenses.exceptions[${index}].version`),
					license: text(item.license, `licenses.exceptions[${index}].license`),
					reason: text(item.reason, `licenses.exceptions[${index}].reason`),
					expires: date(item.expires, `licenses.exceptions[${index}].expires`),
				};
			}),
		},
		requiredChecks,
	};
}

export function loadPolicy(file: string): { policy: Policy; sha256: string } {
	const bytes = readFileSync(file, "utf8");
	return {
		policy: parsePolicy(JSON.parse(bytes)),
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

// ---------- audit ----------

/** Strict parse of `bun audit --json`: `{ "<package>": [advisory, ...] }`. Any other shape throws. */
export function parseAuditOutput(raw: string): Advisory[] {
	const value: unknown = JSON.parse(raw);
	if (!isPlainObject(value)) throw new Error("bun audit output is not a JSON object");
	const advisories: Advisory[] = [];
	for (const [pkg, items] of Object.entries(value)) {
		if (!Array.isArray(items)) throw new Error(`bun audit output: "${pkg}" is not an array of advisories`);
		for (const item of items) advisories.push(parseAdvisory(pkg, item));
	}
	return advisories;
}

function parseAdvisory(pkg: string, value: unknown): Advisory {
	const shape = (reason: string): Error => new Error(`bun audit output: advisory for "${pkg}" ${reason}`);
	if (!isPlainObject(value)) throw shape("is not an object");
	const { id, url, title, severity, vulnerable_versions: vulnerable } = value;
	if (typeof id !== "number" || !Number.isInteger(id)) throw shape("has no integer id");
	if (typeof url !== "string" || url === "") throw shape("has no url");
	if (typeof title !== "string") throw shape("has no title");
	if (!isSeverity(severity)) throw shape(`has unknown severity ${JSON.stringify(severity)}`);
	if (typeof vulnerable !== "string") throw shape("has no vulnerable_versions");
	return { package: pkg, id, url, title, severity, vulnerableVersions: vulnerable };
}

/** Every advisory at or above the policy level blocks unless an unexpired allow entry names its URL or numeric id. */
export function evaluateAudit(advisories: readonly Advisory[], policy: Policy, today: string): AuditResult {
	const level = policy.audit.level;
	const threshold = SEVERITIES.indexOf(level);
	const blocking: AuditResult["blocking"] = [];
	const waived: AuditResult["waived"] = [];
	let atOrAboveLevel = 0;
	for (const advisory of advisories) {
		if (SEVERITIES.indexOf(advisory.severity) < threshold) continue;
		atOrAboveLevel++;
		const matches = policy.audit.allow.filter((entry) => entry.advisory === advisory.url || entry.advisory === String(advisory.id));
		const live = matches.find((entry) => !expired(entry.expires, today));
		if (live !== undefined) waived.push({ ...advisory, allow: live });
		else blocking.push({ ...advisory, reason: matches.length === 0 ? "no allow entry" : "allow entry expired" });
	}
	// A stale exception fails the gate even when no current advisory matches it, so it gets removed.
	const expiredAllow = policy.audit.allow.filter((entry) => expired(entry.expires, today));
	return {
		status: blocking.length === 0 && expiredAllow.length === 0 ? "pass" : "fail",
		level,
		advisoryCount: advisories.length,
		atOrAboveLevel,
		blocking,
		waived,
		expiredAllow,
	};
}

/** The subprocess seam: tests inject a fake so the spawned command can be observed without running bun. */
export type SpawnSync = (
	cmd: string[],
	options: { cwd: string; stdout: "pipe"; stderr: "pipe" },
) => { exitCode: number | null; stdout: Uint8Array; stderr: Uint8Array };

/** Spawns the running bun by absolute path: a release runs under a minimal PATH where bun is not found by name. */
export function runBunAudit(
	root: string,
	level: Severity,
	spawn: SpawnSync = (cmd, options) => Bun.spawnSync(cmd, options),
): AuditRun {
	const proc = spawn([process.execPath, "audit", `--audit-level=${level}`, "--json"], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: proc.exitCode ?? -1,
		stdout: new TextDecoder().decode(proc.stdout),
		stderr: new TextDecoder().decode(proc.stderr),
	};
}

// ---------- licenses ----------

type SpdxNode = { op: "id"; id: string } | { op: "and" | "or"; left: SpdxNode; right: SpdxNode };

const OPERATORS = ["AND", "OR", "WITH"];

function isOperator(token: string): boolean {
	return OPERATORS.includes(token.toUpperCase());
}

/**
 * Parses an SPDX expression. AND binds tighter than OR; `WITH <exception>` keeps only the base id.
 * Throws on any syntax it does not recognize, so an unparseable expression never passes.
 */
export function parseSpdx(expression: string): SpdxNode {
	const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
	let pos = 0;
	const peek = (): string | undefined => tokens[pos];
	const keyword = (): string | undefined => peek()?.toUpperCase();

	function atom(): SpdxNode {
		const token = peek();
		if (token === undefined) throw new Error("unexpected end of license expression");
		if (token === "(") {
			pos++;
			const inner = orExpr();
			if (peek() !== ")") throw new Error("missing ) in license expression");
			pos++;
			return inner;
		}
		if (token === ")" || isOperator(token)) throw new Error(`unexpected "${token}" in license expression`);
		pos++;
		return { op: "id", id: token };
	}

	function withExpr(): SpdxNode {
		const node = atom();
		if (keyword() !== "WITH") return node;
		if (node.op !== "id") throw new Error("WITH must follow a single license identifier");
		pos++;
		const exception = peek();
		if (exception === undefined || exception === "(" || exception === ")" || isOperator(exception)) {
			throw new Error("WITH needs an exception identifier");
		}
		pos++;
		return node;
	}

	function andExpr(): SpdxNode {
		let left = withExpr();
		while (keyword() === "AND") {
			pos++;
			left = { op: "and", left, right: withExpr() };
		}
		return left;
	}

	function orExpr(): SpdxNode {
		let left = andExpr();
		while (keyword() === "OR") {
			pos++;
			left = { op: "or", left, right: andExpr() };
		}
		return left;
	}

	const tree = orExpr();
	if (pos !== tokens.length) throw new Error(`unexpected "${tokens[pos] ?? ""}" in license expression`);
	return tree;
}

function allowedTree(node: SpdxNode, allowed: ReadonlySet<string>): boolean {
	switch (node.op) {
		case "id":
			return allowed.has(node.id.toLowerCase());
		case "and":
			return allowedTree(node.left, allowed) && allowedTree(node.right, allowed);
		case "or":
			return allowedTree(node.left, allowed) || allowedTree(node.right, allowed);
	}
}

/** True when the expression is satisfied by the allow list: OR needs one side, AND needs both. Throws if unparseable. */
export function spdxAllowed(expression: string, allowList: readonly string[]): boolean {
	const allowed = new Set(allowList.map((id) => id.trim().toLowerCase()));
	return allowedTree(parseSpdx(expression), allowed);
}

function normalizeExpression(expression: string): string {
	return expression.trim().split(/\s+/).join(" ").toLowerCase();
}

/** The declared license as one expression: a string, `{ "type": ... }`, or a one-element array of either. */
export function licenseExpression(value: unknown): string {
	if (value === undefined) throw new Error("license field is missing");
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	if (isPlainObject(value)) {
		const type = value.type;
		if (typeof type === "string" && type.trim() !== "") return type.trim();
	}
	if (Array.isArray(value) && value.length === 1) return licenseExpression(value[0]);
	throw new Error("license field is not a string, a {type} object or a one-element array");
}

function readPackage(file: string): InstalledPackage {
	let manifest: unknown;
	try {
		manifest = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { file, problem: `unreadable package.json: ${messageOf(error)}` };
	}
	if (!isPlainObject(manifest)) return { file, problem: "package.json is not an object" };
	const name = typeof manifest.name === "string" ? manifest.name : undefined;
	const version = typeof manifest.version === "string" ? manifest.version : undefined;
	const problem = name === undefined || version === undefined ? "package.json has no name or version" : undefined;
	return { file, name, version, license: manifest.license, problem };
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function visitNodeModules(dir: string, found: InstalledPackage[], seen: Set<string>): void {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (!isDirectory(path)) continue;
		// Scope directories and dot-directories (such as Bun's `.bun` store) hold packages one level down.
		if (entry.startsWith("@") || entry.startsWith(".")) {
			for (const child of readdirSync(path)) visitCandidate(join(path, child), found, seen);
		} else {
			visitCandidate(path, found, seen);
		}
	}
}

function visitCandidate(dir: string, found: InstalledPackage[], seen: Set<string>): void {
	if (!isDirectory(dir)) return;
	const real = realpathSync(dir);
	if (seen.has(real)) return;
	seen.add(real);
	const manifest = join(dir, "package.json");
	if (existsSync(manifest)) found.push(readPackage(manifest));
	const nested = join(dir, "node_modules");
	if (isDirectory(nested)) visitNodeModules(nested, found, seen);
}

/**
 * Every installed package under each root's `node_modules`, deduped by name@version. Requires a prior
 * frozen install: a missing `node_modules` throws, because an empty tree would pass by default.
 */
export function collectLicenses(roots: readonly string[]): InstalledPackage[] {
	const found: InstalledPackage[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		const nodeModules = join(root, "node_modules");
		if (!isDirectory(nodeModules)) {
			throw new Error(`${nodeModules} not found; run bun install --frozen-lockfile in ${root} first`);
		}
		visitNodeModules(nodeModules, found, seen);
	}
	const byKey = new Map<string, InstalledPackage>();
	for (const pkg of found) {
		const key = pkg.name !== undefined && pkg.version !== undefined ? `${pkg.name}@${pkg.version}` : pkg.file;
		if (!byKey.has(key)) byKey.set(key, pkg);
	}
	return [...byKey.values()];
}

/**
 * Each package's license must satisfy the allow list. A failing one is waived only by an exception that matches its
 * exact name, exact version and exact license expression, and only through its expiry day. Expired exceptions fail the gate.
 */
export function evaluateLicenses(packages: readonly InstalledPackage[], policy: Policy, today: string): LicenseResult {
	const failures: LicenseFailure[] = [];
	const excepted: LicenseWaiver[] = [];
	for (const pkg of packages) {
		const place = { file: pkg.file, name: pkg.name, version: pkg.version };
		if (pkg.problem !== undefined) {
			failures.push({ ...place, reason: pkg.problem });
			continue;
		}
		let expression: string;
		try {
			expression = licenseExpression(pkg.license);
		} catch (error) {
			failures.push({ ...place, reason: messageOf(error) });
			continue;
		}
		let allowed: boolean;
		try {
			allowed = spdxAllowed(expression, policy.licenses.allow);
		} catch (error) {
			failures.push({ ...place, license: expression, reason: `unparseable license expression: ${messageOf(error)}` });
			continue;
		}
		if (allowed) continue;
		const waiver = policy.licenses.exceptions.find(
			(entry) =>
				entry.name === pkg.name &&
				entry.version === pkg.version &&
				normalizeExpression(entry.license) === normalizeExpression(expression) &&
				!expired(entry.expires, today),
		);
		if (waiver !== undefined) {
			excepted.push({ name: waiver.name, version: waiver.version, license: expression, reason: waiver.reason });
		} else {
			failures.push({ ...place, license: expression, reason: "license is not on the allow list" });
		}
	}
	const expiredExceptions = policy.licenses.exceptions.filter((entry) => expired(entry.expires, today));
	return {
		status: failures.length === 0 && expiredExceptions.length === 0 ? "pass" : "fail",
		packageCount: packages.length,
		failures,
		excepted,
		expiredExceptions,
	};
}

// ---------- checks ----------

function parseCheckRun(line: string, lineNumber: number): CheckRun {
	const shape = (reason: string): Error => new Error(`checks input line ${lineNumber}: ${reason}`);
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw shape("is not JSON");
	}
	if (!isPlainObject(value)) throw shape("is not an object");
	const { id, name, status, conclusion } = value;
	if (typeof id !== "number" || !Number.isInteger(id)) throw shape("has no integer id");
	if (typeof name !== "string") throw shape("has no name");
	if (typeof status !== "string") throw shape("has no status");
	if (conclusion !== undefined && conclusion !== null && typeof conclusion !== "string") throw shape("has a non-string conclusion");
	return { id, name, status, conclusion: typeof conclusion === "string" ? conclusion : null };
}

/** One check run per name; a rerun has a higher id and replaces the earlier run, whatever order the lines arrive in. */
export function latestChecks(ndjson: string): Map<string, CheckRun> {
	const latest = new Map<string, CheckRun>();
	ndjson.split("\n").forEach((line, index) => {
		if (line.trim() === "") return;
		const run = parseCheckRun(line, index + 1);
		const prior = latest.get(run.name);
		if (prior === undefined || run.id > prior.id) latest.set(run.name, run);
	});
	return latest;
}

/** Every required check name must have a completed run with conclusion success. Absent or in-flight runs fail. */
export function evaluateChecks(latest: ReadonlyMap<string, CheckRun>, policy: Policy): ChecksResult {
	const checks = policy.requiredChecks.map((name): CheckOutcome => {
		const run = latest.get(name);
		let problem: string | undefined;
		if (run === undefined) problem = "no check run with this name";
		else if (run.status !== "completed") problem = `status is ${run.status}, not completed`;
		else if (run.conclusion !== "success") problem = `conclusion is ${run.conclusion ?? "null"}, not success`;
		return {
			name,
			status: problem === undefined ? "pass" : "fail",
			reason: problem ?? "completed with conclusion success",
			id: run?.id ?? null,
			runStatus: run?.status ?? null,
			conclusion: run?.conclusion ?? null,
		};
	});
	return { status: checks.every((check) => check.status === "pass") ? "pass" : "fail", checks };
}

// ---------- ancestry ----------

/** The ref a release commit must already be on. The release workflow fetches it before the gate runs. */
export const MAIN_REF = "origin/main";
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * True when `sha` is an ancestor of origin/main. `git merge-base --is-ancestor` exits 0 for yes and 1 for no. Any other
 * exit (missing ref, unknown commit, git not installed) throws, so an error can never read as "on main".
 */
export function isOnMain(
	root: string,
	sha: string,
	spawn: SpawnSync = (cmd, options) => Bun.spawnSync(cmd, options),
): boolean {
	if (!FULL_SHA.test(sha)) throw new Error(`--sha must be a full lowercase 40-hex commit id, got "${sha}"`);
	const result = spawn(["git", "merge-base", "--is-ancestor", sha, MAIN_REF], { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode === 0) return true;
	if (result.exitCode === 1) return false;
	const detail = new TextDecoder().decode(result.stderr).trim();
	throw new Error(`git merge-base exited ${result.exitCode ?? "without a code"}${detail === "" ? "" : `: ${detail}`}`);
}

// ---------- report ----------

/** A missing evidence file is a failure; a present file that is not this gate's evidence is a shape error. */
export function readEvidence(out: string, gate: Gate): EvidenceInput {
	const file = `${gate}.json`;
	const path = join(out, file);
	if (!existsSync(path)) return { gate, file, present: false, status: "fail" };
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	const status = isPlainObject(parsed) && parsed.gate === gate ? parsed.status : undefined;
	if (status !== "pass" && status !== "fail") throw new Error(`${file}: not a ${gate} evidence file with status pass or fail`);
	return { gate, file, present: true, status };
}

export function buildManifest(
	inputs: readonly EvidenceInput[],
	meta: { sha: string | null; tag: string | null; policy: { file: string; sha256: string } },
): Manifest {
	const failures = inputs
		.filter((input) => input.status !== "pass")
		.map((input) => `${input.gate}: ${input.present ? `status ${input.status}` : `${input.file} missing`}`);
	return {
		schema: SCHEMA,
		status: failures.length === 0 ? "pass" : "fail",
		sha: meta.sha,
		tag: meta.tag,
		policy: meta.policy,
		inputs: [...inputs],
		failures,
	};
}

// ---------- CLI ----------

type Mode = "audit" | "licenses" | "checks" | "report" | "ancestry";
const MODES: readonly Mode[] = ["audit", "licenses", "checks", "report", "ancestry"];

type Options = {
	roots: string[];
	policy: string | undefined;
	today: string | undefined;
	out: string | undefined;
	input: string | undefined;
	sha: string | undefined;
	tag: string | undefined;
};

const ALLOWED_FLAGS: Record<Mode, readonly string[]> = {
	audit: ["--root", "--policy", "--today", "--out", "--input"],
	licenses: ["--root", "--policy", "--today", "--out"],
	checks: ["--input", "--policy", "--out"],
	report: ["--out", "--sha", "--tag", "--policy"],
	ancestry: ["--sha"],
};

const REQUIRED_FLAGS: Record<Mode, readonly string[]> = {
	audit: ["--root", "--out"],
	licenses: ["--root", "--out"],
	checks: ["--input", "--out"],
	report: ["--out"],
	ancestry: ["--sha"],
};

export function parseArgs(argv: readonly string[]): { mode: Mode; options: Options } {
	const [modeArg, ...rest] = argv;
	if (modeArg === undefined || !(MODES as readonly string[]).includes(modeArg)) {
		throw new Error(`unknown or missing mode${modeArg === undefined ? "" : ` "${modeArg}"`}`);
	}
	const mode = modeArg as Mode;
	const values = new Map<string, string[]>();
	let index = 0;
	while (index < rest.length) {
		const flag = rest[index] ?? "";
		const value = rest[index + 1];
		if (!ALLOWED_FLAGS[mode].includes(flag)) throw new Error(`unknown option "${flag}" for ${mode}`);
		if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
		if (flag !== "--root" && values.has(flag)) throw new Error(`${flag} given more than once`);
		values.set(flag, [...(values.get(flag) ?? []), value]);
		index += 2;
	}
	for (const flag of REQUIRED_FLAGS[mode]) {
		if (!values.has(flag)) throw new Error(`${mode} needs ${flag}`);
	}
	const first = (flag: string): string | undefined => values.get(flag)?.[0];
	const today = first("--today");
	if (today !== undefined && !isIsoDate(today)) throw new Error(`--today must be a real YYYY-MM-DD date, got "${today}"`);
	const roots = values.get("--root") ?? [];
	if (first("--input") !== undefined && mode === "audit" && roots.length !== 1) {
		throw new Error("--input needs exactly one --root");
	}
	return {
		mode,
		options: {
			roots,
			policy: first("--policy"),
			today,
			out: first("--out"),
			input: first("--input"),
			sha: first("--sha"),
			tag: first("--tag"),
		},
	};
}

function need(value: string | undefined, flag: string): string {
	if (value === undefined) throw new Error(`${flag} is required`);
	return value;
}

/** Deletes this gate's previous evidence before running, so a failed run can never leave a stale pass behind. */
function clearEvidence(out: string, file: string): void {
	rmSync(join(out, file), { force: true });
}

function writeEvidence(out: string, file: string, value: unknown): string {
	mkdirSync(out, { recursive: true });
	const path = join(out, file);
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
	return path;
}

function runAudit(options: Options, io: CliIo): number {
	const out = need(options.out, "--out");
	const roots = options.roots;
	const policyFile = options.policy ?? defaultPolicy(resolve(need(roots[0], "--root")));
	clearEvidence(out, "audit.json");
	const { policy } = loadPolicy(policyFile);
	const today = options.today ?? todayUtc();
	const results: Array<AuditResult & { root: string; source: string; exitCode: number }> = [];
	for (const root of roots) {
		let run: AuditRun;
		if (options.input === undefined) {
			run = (io.runAudit ?? runBunAudit)(root, policy.audit.level);
			if (run.exitCode !== 0 && run.exitCode !== 1) {
				throw new Error(`bun audit exited ${run.exitCode} in ${root}: ${run.stderr.trim()}`);
			}
		} else {
			run = { exitCode: 0, stdout: readFileSync(options.input, "utf8"), stderr: "" };
		}
		const result = evaluateAudit(parseAuditOutput(run.stdout), policy, today);
		results.push({ ...result, root, source: options.input === undefined ? "bun audit" : "input", exitCode: run.exitCode });
	}
	const status = results.every((result) => result.status === "pass") ? "pass" : "fail";
	const file = writeEvidence(out, "audit.json", {
		schema: SCHEMA,
		gate: "audit",
		status,
		level: policy.audit.level,
		today,
		policy: policyFile,
		roots: results,
	});
	for (const result of results) {
		for (const item of result.blocking) {
			io.err(`audit: ${result.root}: ${item.package} ${item.id} ${item.severity} ${item.url}: ${item.reason}`);
		}
		for (const entry of result.expiredAllow) io.err(`audit: ${result.root}: allow entry for ${entry.advisory} expired ${entry.expires}`);
	}
	io.out(`security-gate audit: ${status} (${results.length} root${results.length === 1 ? "" : "s"}) -> ${file}`);
	return status === "pass" ? 0 : 1;
}

function runLicenses(options: Options, io: CliIo): number {
	const out = need(options.out, "--out");
	const roots = options.roots;
	const policyFile = options.policy ?? defaultPolicy(resolve(need(roots[0], "--root")));
	clearEvidence(out, "licenses.json");
	const { policy } = loadPolicy(policyFile);
	const today = options.today ?? todayUtc();
	const result = evaluateLicenses(collectLicenses(roots), policy, today);
	const file = writeEvidence(out, "licenses.json", {
		schema: SCHEMA,
		gate: "licenses",
		today,
		policy: policyFile,
		roots,
		...result,
	});
	for (const failure of result.failures) {
		const label = failure.name === undefined ? failure.file : `${failure.name}@${failure.version ?? "?"}`;
		io.err(`licenses: ${label}${failure.license === undefined ? "" : ` (${failure.license})`}: ${failure.reason}`);
	}
	for (const entry of result.expiredExceptions) {
		io.err(`licenses: exception for ${entry.name}@${entry.version} expired ${entry.expires}`);
	}
	io.out(`security-gate licenses: ${result.status} (${result.packageCount} packages, ${result.excepted.length} excepted) -> ${file}`);
	return result.status === "pass" ? 0 : 1;
}

function runChecks(options: Options, io: CliIo): number {
	const out = need(options.out, "--out");
	const input = need(options.input, "--input");
	const policyFile = options.policy ?? defaultPolicy(io.root);
	clearEvidence(out, "checks.json");
	const { policy } = loadPolicy(policyFile);
	const result = evaluateChecks(latestChecks(readFileSync(input, "utf8")), policy);
	const file = writeEvidence(out, "checks.json", {
		schema: SCHEMA,
		gate: "checks",
		status: result.status,
		input,
		policy: policyFile,
		checks: result.checks,
	});
	for (const check of result.checks) {
		if (check.status === "fail") io.err(`checks: ${check.name}: ${check.reason}`);
	}
	const passed = result.checks.filter((check) => check.status === "pass").length;
	io.out(`security-gate checks: ${result.status} (${passed}/${result.checks.length} required checks) -> ${file}`);
	return result.status === "pass" ? 0 : 1;
}

function runReport(options: Options, io: CliIo): number {
	const out = need(options.out, "--out");
	const policyFile = options.policy ?? defaultPolicy(io.root);
	clearEvidence(out, "manifest.json");
	const { sha256 } = loadPolicy(policyFile);
	const inputs = GATES.map((gate) => readEvidence(out, gate));
	const manifest = buildManifest(inputs, {
		sha: options.sha ?? null,
		tag: options.tag ?? null,
		policy: { file: policyFile, sha256 },
	});
	const file = writeEvidence(out, "manifest.json", manifest);
	for (const failure of manifest.failures) io.err(`report: ${failure}`);
	io.out(`security-gate report: ${manifest.status} -> ${file}`);
	return manifest.status === "pass" ? 0 : 1;
}

function runAncestry(options: Options, io: CliIo): number {
	const sha = need(options.sha, "--sha");
	if (!isOnMain(io.root, sha)) {
		io.err(`ancestry: ${sha} is not an ancestor of ${MAIN_REF}; the release is refused`);
		return 1;
	}
	io.out(`security-gate ancestry: ${sha} is an ancestor of ${MAIN_REF}`);
	return 0;
}

/** Runs the CLI and returns its exit code: 0 pass, 1 policy failure, 2 usage error, unknown shape, or tool error. */
export function main(argv: readonly string[], io: CliIo): number {
	let parsed: { mode: Mode; options: Options };
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		io.err(`security-gate: ${messageOf(error)}`);
		io.err(USAGE);
		return 2;
	}
	try {
		switch (parsed.mode) {
			case "audit":
				return runAudit(parsed.options, io);
			case "licenses":
				return runLicenses(parsed.options, io);
			case "checks":
				return runChecks(parsed.options, io);
			case "report":
				return runReport(parsed.options, io);
			case "ancestry":
				return runAncestry(parsed.options, io);
		}
	} catch (error) {
		io.err(`security-gate ${parsed.mode}: ${messageOf(error)}`);
		return 2;
	}
}

if (import.meta.main) {
	process.exitCode = main(Bun.argv.slice(2), {
		out: (line) => console.log(line),
		err: (line) => console.error(line),
		root: resolve(import.meta.dir, ".."),
	});
}
