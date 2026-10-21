// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { Server } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Auth, createAuth } from "../services/ultrathink/auth/auth.ts";
import type { UltrathinkConfig } from "../services/ultrathink/config/config.ts";
import { createHandler, SECURITY_HEADERS } from "../services/ultrathink/routes/router.ts";
import { createLogger } from "../services/ultrathink/obs/log.ts";
import { type Store, openStore } from "../services/ultrathink/store/store.ts";
import { collect, type PolicyInput, parseUnitFile, parseWorkflow } from "./collect.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const COLLECT = join(REPO_ROOT, "policy", "collect.ts");
const PUBLIC_ORIGIN = "https://ultrathink.test";
const PEER_IP = "127.0.0.1";
const SHA_PIN = /@[0-9a-f]{40}$/;
const silent = createLogger({ write: () => undefined });

/** The four workflows that existed before the policy job; the real repo now also carries policy.yml. */
const ORIGINAL_WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/codeql.yml", ".github/workflows/release.yml", ".github/workflows/security-scan.yml"];

const tempRoots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "ultrathink-collect-"));
	tempRoots.push(root);
	return root;
}

function writeRepoFile(root: string, file: string, text: string): void {
	const path = join(root, file);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

function findWorkflow(input: PolicyInput, file: string) {
	const workflow = input.workflows.find((candidate) => candidate.file === file);
	if (workflow === undefined) throw new Error(`no workflow ${file} in the collected input`);
	return workflow;
}

function findUnit(input: PolicyInput, file: string) {
	const unit = input.units.find((candidate) => candidate.file === file);
	if (unit === undefined) throw new Error(`no unit ${file} in the collected input`);
	return unit;
}

afterAll(() => {
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("static collection of the real repository", () => {
	let input: PolicyInput;

	beforeAll(async () => {
		input = await collect({ root: REPO_ROOT });
	});

	test("reads the four original workflows and their pinned uses", () => {
		for (const file of ORIGINAL_WORKFLOWS) expect(findWorkflow(input, file).file).toBe(file);
		const uses = ORIGINAL_WORKFLOWS.flatMap((file) => Object.values(findWorkflow(input, file).jobs).flatMap((job) => job.uses));
		expect(uses).toHaveLength(16);
		for (const use of uses) expect(use).toMatch(SHA_PIN);
	});

	test("codeql triggers on pull_request and not on pull_request_target, though its comment names it", () => {
		const codeql = findWorkflow(input, ".github/workflows/codeql.yml");
		expect(codeql.on).toContain("pull_request");
		expect(codeql.on).not.toContain("pull_request_target");
		expect(codeql.on).toEqual(["push", "pull_request", "schedule"]);
	});

	test("no workflow lists pull_request_target as a trigger", () => {
		for (const workflow of input.workflows) expect(workflow.on).not.toContain("pull_request_target");
	});

	test("release.yml keeps its job-level write scope and the top-level read scope", () => {
		const release = findWorkflow(input, ".github/workflows/release.yml");
		expect(release.permissions).toEqual({ contents: "read" });
		expect(release.jobs.release?.permissions).toEqual({ contents: "write", checks: "read" });
	});

	test("the web unit keeps repeated directives, splits list values and reads an empty value as one empty entry", () => {
		const service = findUnit(input, "deploy/ultrathink-web.service").sections.Service;
		expect(service?.SystemCallFilter).toEqual(["@system-service", "~@privileged"]);
		expect(service?.CapabilityBoundingSet).toEqual([""]);
		expect(service?.AmbientCapabilities).toEqual([""]);
		expect(service?.RestrictAddressFamilies).toEqual(["AF_INET", "AF_INET6", "AF_UNIX"]);
		expect(service?.User).toEqual(["ultrathink"]);
		expect(service?.ProtectHome).toEqual(["true"]);
	});

	test("expected is the SECURITY_HEADERS export, and static headers are that export lowercased", () => {
		expect(input.source).toBe("static");
		expect(input.expected).toEqual({ ...SECURITY_HEADERS });
		const lowered: Record<string, string> = {};
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) lowered[name.toLowerCase()] = value;
		expect(input.headers).toEqual(lowered);
	});
});

describe("parseUnitFile", () => {
	test("keeps repeated keys in file order and skips comments and blank lines", () => {
		const sections = parseUnitFile(
			["# leading comment", "", "[Service]", "SystemCallFilter=@system-service", "; another comment", "SystemCallFilter=~@privileged", ""].join("\n"),
			"x.service",
		);
		expect(sections.Service?.SystemCallFilter).toEqual(["@system-service", "~@privileged"]);
	});

	test("an empty value is one empty entry, and a bare key with spaces around = is trimmed", () => {
		const sections = parseUnitFile("[Service]\nCapabilityBoundingSet=\nUMask =  0077  \n", "x.service");
		expect(sections.Service?.CapabilityBoundingSet).toEqual([""]);
		expect(sections.Service?.UMask).toEqual(["0077"]);
	});

	test("a trailing backslash joins the next physical line", () => {
		const sections = parseUnitFile("[Service]\nRestrictAddressFamilies=AF_INET \\\n  AF_UNIX\n", "x.service");
		expect(sections.Service?.RestrictAddressFamilies).toEqual(["AF_INET", "AF_UNIX"]);
	});

	test("merges a section that appears twice", () => {
		const sections = parseUnitFile("[Service]\nUser=a\n[Unit]\nDescription=x\n[Service]\nGroup=a\n", "x.service");
		expect(sections.Service).toEqual({ User: ["a"], Group: ["a"] });
		expect(sections.Unit).toEqual({ Description: ["x"] });
	});

	test("a setting before any section is an error, not a silent skip", () => {
		expect(() => parseUnitFile("User=ultrathink\n[Service]\n", "x.service")).toThrow("x.service:1");
	});

	test("a line that is neither a section nor a setting is an error", () => {
		expect(() => parseUnitFile("[Service]\nthis is not a setting\n", "x.service")).toThrow("x.service:2");
	});
});

describe("parseWorkflow", () => {
	test("event names come from the parsed on key, not from comments that mention an event", () => {
		const workflow = parseWorkflow(
			["# pull_request_target would be dangerous here", "on:", "  push:", "    branches: [main]", "  pull_request:", ""].join("\n"),
			"w.yml",
		);
		expect(workflow.on).toEqual(["push", "pull_request"]);
	});

	test("on as a single event name or as a list both parse", () => {
		expect(parseWorkflow("on: push\njobs: {}\n", "a.yml").on).toEqual(["push"]);
		expect(parseWorkflow("on: [push, workflow_dispatch]\njobs: {}\n", "b.yml").on).toEqual(["push", "workflow_dispatch"]);
	});

	test("a missing permissions key is null; a shorthand string is kept as written", () => {
		const workflow = parseWorkflow("on: push\njobs:\n  a:\n    runs-on: x\n    steps: []\n", "w.yml");
		expect(workflow.permissions).toBeNull();
		expect(workflow.jobs.a?.permissions).toBeNull();
		expect(parseWorkflow("on: push\npermissions: write-all\njobs: {}\n", "w.yml").permissions).toBe("write-all");
	});

	test("job uses include a reusable-workflow ref and every step's uses, in file order", () => {
		const workflow = parseWorkflow(
			[
				"on: push",
				"jobs:",
				"  build:",
				"    steps:",
				"      - run: echo hi",
				"      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567",
				"      - uses: actions/setup-node@89abcdef0123456789abcdef0123456789abcdef",
				"  call:",
				"    uses: org/repo/.github/workflows/x.yml@fedcba9876543210fedcba9876543210fedcba98",
				"",
			].join("\n"),
			"w.yml",
		);
		expect(workflow.jobs.build?.uses).toEqual([
			"actions/checkout@0123456789abcdef0123456789abcdef01234567",
			"actions/setup-node@89abcdef0123456789abcdef0123456789abcdef",
		]);
		expect(workflow.jobs.call?.uses).toEqual(["org/repo/.github/workflows/x.yml@fedcba9876543210fedcba9876543210fedcba98"]);
	});

	test("malformed YAML is an error that names the file", () => {
		expect(() => parseWorkflow("on: [push\n", "broken.yml")).toThrow("broken.yml");
	});

	test("a duplicate key is an error, so a second on block cannot shadow the first", () => {
		expect(() => parseWorkflow("on: push\non: pull_request_target\njobs: {}\n", "dup.yml")).toThrow();
	});
});

describe("static collection of a fixture repository", () => {
	test("collects only ultrathink-* units and every workflow under .github/workflows", async () => {
		const root = tempRoot();
		writeRepoFile(root, ".github/workflows/ci.yml", "on: push\njobs:\n  t:\n    steps:\n      - uses: actions/checkout@v4\n");
		writeRepoFile(root, "deploy/ultrathink-x.service", "[Service]\nUser=ultrathink\n");
		writeRepoFile(root, "deploy/ultrathink-x.timer", "[Timer]\nPersistent=true\n");
		writeRepoFile(root, "deploy/other.service", "[Service]\nUser=root\n");

		const input = await collect({ root });
		expect(input.workflows.map((workflow) => workflow.file)).toEqual([".github/workflows/ci.yml"]);
		expect(input.workflows[0]?.jobs.t?.uses).toEqual(["actions/checkout@v4"]);
		expect(input.units.map((unit) => unit.file)).toEqual(["deploy/ultrathink-x.service", "deploy/ultrathink-x.timer"]);
	});

	test("collects workflows ending in .yml and .yaml, and ignores other files there", async () => {
		const root = tempRoot();
		writeRepoFile(root, ".github/workflows/ci.yml", "on: push\njobs:\n  t:\n    steps:\n      - uses: actions/checkout@v4\n");
		writeRepoFile(root, ".github/workflows/release.yaml", "on: push\njobs:\n  r:\n    steps:\n      - uses: actions/checkout@v4\n");
		writeRepoFile(root, ".github/workflows/notes.txt", "not a workflow\n");
		writeRepoFile(root, "deploy/ultrathink-x.service", "[Service]\nUser=ultrathink\n");

		const input = await collect({ root });
		expect(input.workflows.map((workflow) => workflow.file)).toEqual([".github/workflows/ci.yml", ".github/workflows/release.yaml"]);
		expect(input.workflows[1]?.jobs.r?.uses).toEqual(["actions/checkout@v4"]);
	});

	test("a root without a workflows directory is an error, never an empty input", async () => {
		const root = tempRoot();
		writeRepoFile(root, "deploy/ultrathink-x.service", "[Service]\nUser=ultrathink\n");
		await expect(collect({ root })).rejects.toThrow();
	});

	test("a root that is not a directory is an error", async () => {
		await expect(collect({ root: join(tempRoot(), "does-not-exist") })).rejects.toThrow("not a directory");
	});
});

describe("live mode against the real router", () => {
	let dir: string;
	let store: Store;
	let server: Server<undefined>;
	let baseUrl: string;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "ultrathink-collect-router-"));
		tempRoots.push(dir);
		const password = randomBytes(24).toString("base64url");
		const ownerPasswordHash = await Bun.password.hash(password);
		const sessionSecret = randomBytes(32).toString("hex");

		const config: UltrathinkConfig = {
			publicOrigin: PUBLIC_ORIGIN,
			ownerPasswordHash,
			sessionSecret,
			stateDir: dir,
			dbPath: join(dir, "ultrathink.db"),
			port: 0,
			maxInputChars: 200,
			maxAnswerChars: 20000,
			maxBodyBytes: 1024,
			runTokenCeiling: 150000,
			dailyTokenCeiling: 1000000,
			planningModel: undefined,
			connectorKey: undefined,
			allowedOrigins: [],
			oauthRedirectOrigins: [],
			openRouterApiKey: undefined,
			openRouterBaseUrl: "https://openrouter.ai/api/v1",
			serverPlanning: false,
			maxConcurrentPlans: 2,
			fairQueueDepth: 16,
			fairQueueWaitMs: 1500,
			modelTimeoutMs: 120000,
			planTimeoutMs: 600000,
			modelMaxOutputTokens: 8000,
			sessionSecretPrevious: [],
			breakerFailures: 5,
			breakerWindowMs: 60000,
			breakerOpenMs: 30000,
			maxInflight: 256,
			drainMs: 5000,
			retentionDays: 30,
			auditLog: true,
			auditAnchorEvery: 1000,
			auditSegmentBytes: 67108864,
			auditRetentionDays: 365,
			auditWatchMs: 1000,
			auditSinkQueue: 10000,
			priorityReservePct: 25,
			adaptiveQuotaMinPct: 50,
			lagTargetMs: 100,
			replicaCapacityRps: 20,
			abuseFailuresPerMinute: 20,
			penaltyBaseSec: 60,
			penaltyMaxSec: 3600,
			tls: undefined,
			spiffeTrustDomain: "ultrathink.internal",
			plaintextLoopback: true,
			chaosEnabled: false,
		};
		const auth: Auth = createAuth({ ownerPasswordHash, sessionSecret, cookieSecure: true });
		store = openStore(config.dbPath);
		const handler = createHandler({ config, store, auth, logger: silent });
		server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => handler(req, PEER_IP) });
		baseUrl = `http://127.0.0.1:${server.port}`;
	});

	afterAll(() => {
		server?.stop(true);
		store?.close();
	});

	test("the headers of a real /healthz response equal the expected values for every security header", async () => {
		const input = await collect({ root: REPO_ROOT, live: `${baseUrl}/healthz` });
		expect(input.source).toBe("live");
		expect(input.expected).toEqual({ ...SECURITY_HEADERS });
		for (const [name, value] of Object.entries(input.expected)) {
			expect({ header: name, value: input.headers[name.toLowerCase()] }).toEqual({ header: name, value });
		}
	});

	test("live mode still collects the repository inputs", async () => {
		const input = await collect({ root: REPO_ROOT, live: `${baseUrl}/healthz` });
		expect(input.workflows.map((workflow) => workflow.file)).toEqual(expect.arrayContaining(ORIGINAL_WORKFLOWS));
		expect(findUnit(input, "deploy/ultrathink-web.service").sections.Service?.User).toEqual(["ultrathink"]);
	});
});

describe("live mode against a server that omits HSTS", () => {
	let server: Server<undefined>;

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("ok", { headers: { "Content-Type": "text/plain", "X-Frame-Options": "DENY" } }),
		});
	});

	afterAll(() => {
		server?.stop(true);
	});

	test("reports Strict-Transport-Security as absent and does not fill in the expected value", async () => {
		const input = await collect({ root: REPO_ROOT, live: `http://127.0.0.1:${server.port}/` });
		expect(input.headers).not.toHaveProperty("strict-transport-security");
		expect(input.headers["x-frame-options"]).toBe("DENY");
		expect(input.expected["Strict-Transport-Security"]).toBe(SECURITY_HEADERS["Strict-Transport-Security"] ?? "");
	});

	test("a live URL that is not http or https is rejected", async () => {
		await expect(collect({ root: REPO_ROOT, live: "ftp://127.0.0.1/" })).rejects.toThrow("http or https");
	});

	test("TLS files are refused for an http live URL, where they would be ignored", async () => {
		await expect(collect({ root: REPO_ROOT, live: "http://127.0.0.1:1/", liveTls: { ca: "/no/such/ca.pem" } })).rejects.toThrow(
			"need an https",
		);
	});

	test("a client certificate without its key is refused before any connection is made", async () => {
		await expect(collect({ root: REPO_ROOT, live: "https://127.0.0.1:1/", liveTls: { cert: "/no/such/cert.pem" } })).rejects.toThrow(
			"given together",
		);
	});
});

describe("command line", () => {
	test("an unknown --root exits non-zero and writes nothing to stdout", async () => {
		const missing = join(tempRoot(), "no-such-dir");
		const proc = Bun.spawn([process.execPath, COLLECT, "--root", missing], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode).not.toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toContain("not a directory");
	});

	test("a valid --root prints the shared input contract as JSON and exits 0", async () => {
		const root = tempRoot();
		writeRepoFile(root, ".github/workflows/ci.yml", "on: push\njobs: {}\n");
		writeRepoFile(root, "deploy/ultrathink-x.service", "[Service]\nUser=ultrathink\n");
		const proc = Bun.spawn([process.execPath, COLLECT, "--root", root], { stdout: "pipe", stderr: "pipe" });
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as PolicyInput;
		expect(parsed.source).toBe("static");
		expect(parsed.units.map((unit) => unit.file)).toEqual(["deploy/ultrathink-x.service"]);
		expect(parsed.workflows.map((workflow) => workflow.file)).toEqual([".github/workflows/ci.yml"]);
	});

	test("an unknown flag is a usage error with nothing on stdout", async () => {
		const proc = Bun.spawn([process.execPath, COLLECT, "--nope"], { stdout: "pipe", stderr: "pipe" });
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exitCode).toBe(2);
		expect(stdout).toBe("");
	});
});
