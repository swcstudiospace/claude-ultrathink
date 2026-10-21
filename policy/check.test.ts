// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
//
// Tests for policy/check.sh. Nothing here touches the network or a production host. Download tests use a file:// URL
// and a fixture that would record its own execution. Eval-parsing tests use a stub OPA script in a temp directory, so
// they run without the real binary. Tests that need the real OPA on PATH are skipped when it is absent. Scratch
// directories live under the OS temp dir and are removed in afterAll.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = resolve(import.meta.dir, "check.sh");
const REAL_OPA = Bun.which("opa");

let scratch = "";

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "policy-check-"));
});

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

type RunResult = { exitCode: number; stdout: string; stderr: string };

// The inherited OPA settings are dropped so a developer's shell cannot change what a test exercises.
function scrubbedEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key !== "OPA_BIN" && key !== "OPA_DOWNLOAD_URL") env[key] = value;
	}
	return { ...env, ...extra };
}

async function run(cmd: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
	const proc = Bun.spawn({ cmd, env, cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

function runCheck(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
	return run(["bash", SCRIPT, ...args], scrubbedEnv(extraEnv), REPO);
}

// A stub OPA: `check` and `test` succeed, and `eval` prints the given JSON, as the real CLI would on stdout.
function writeStubOpa(evalOutput: string): string {
	const dir = mkdtempSync(join(scratch, "stub-"));
	const evalFile = join(dir, "eval.json");
	writeFileSync(evalFile, evalOutput);
	const stub = join(dir, "opa");
	writeFileSync(
		stub,
		`#!/bin/sh\ncase "$1" in\ncheck|test) exit 0 ;;\neval) cat '${evalFile}' ;;\n*) exit 2 ;;\nesac\n`,
	);
	chmodSync(stub, 0o755);
	return stub;
}

function evalResult(value: unknown[]): string {
	return JSON.stringify({ result: [{ expressions: [{ value, text: "data.ultrathink.policy.violations" }] }] });
}

test("a checksum mismatch aborts before any OPA step and leaves no binary behind", async () => {
	const dir = join(scratch, "mismatch");
	const policy = join(dir, "policy");
	const tmp = join(dir, "tmp");
	mkdirSync(policy, { recursive: true });
	mkdirSync(tmp);
	copyFileSync(SCRIPT, join(policy, "check.sh"));

	// The fixture would leave a marker if it were ever executed.
	const fixture = join(dir, "fixture-opa");
	writeFileSync(fixture, '#!/bin/sh\ntouch "$0.ran"\n');
	chmodSync(fixture, 0o755);

	// The pinned sha256 is all zeros, so the fixture cannot match. The pinned url is unreachable on purpose.
	writeFileSync(
		join(policy, "opa-pin.json"),
		JSON.stringify({
			version: "v0.0.0",
			asset: "opa_linux_amd64_static",
			sha256: "0".repeat(64),
			url: "https://example.invalid/opa",
		}),
	);

	const result = await run(
		["bash", join(policy, "check.sh")],
		scrubbedEnv({ OPA_DOWNLOAD_URL: pathToFileURL(fixture).href, TMPDIR: tmp }),
		dir,
	);

	expect(result.exitCode).not.toBe(0);
	expect(result.stderr).toContain("checksum mismatch");
	expect(result.stdout).not.toContain("opa check");
	expect(existsSync(`${fixture}.ran`)).toBe(false);
	expect(readdirSync(tmp)).toEqual([]);
});

test("a null pin field aborts before any download, even when a download url is supplied", async () => {
	const dir = join(scratch, "null-pin");
	const policy = join(dir, "policy");
	const tmp = join(dir, "tmp");
	mkdirSync(policy, { recursive: true });
	mkdirSync(tmp);
	copyFileSync(SCRIPT, join(policy, "check.sh"));

	const fixture = join(dir, "fixture-opa");
	writeFileSync(fixture, '#!/bin/sh\ntouch "$0.ran"\n');
	chmodSync(fixture, 0o755);

	// The shape of policy/opa-pin.json while no OPA digest is verified.
	writeFileSync(
		join(policy, "opa-pin.json"),
		JSON.stringify({ version: null, asset: "opa_linux_amd64_static", sha256: null, url: null }),
	);

	const result = await run(
		["bash", join(policy, "check.sh")],
		scrubbedEnv({ OPA_DOWNLOAD_URL: pathToFileURL(fixture).href, TMPDIR: tmp }),
		dir,
	);

	expect(result.exitCode).not.toBe(0);
	expect(result.stderr).toContain("is null or empty");
	expect(result.stdout).not.toContain("download");
	expect(existsSync(`${fixture}.ran`)).toBe(false);
	expect(readdirSync(tmp)).toEqual([]);
});

test("an OPA_BIN that is not an executable file fails before collection runs", async () => {
	const result = await runCheck([], { OPA_BIN: join(scratch, "no-such-opa") });

	expect(result.exitCode).toBe(2);
	expect(result.stderr).toContain("OPA_BIN");
	expect(result.stdout).not.toContain("==> collect");
});

test("an unknown --root writes nothing to stdout and exits non-zero", async () => {
	const result = await runCheck(["--root", join(scratch, "does-not-exist")], {
		OPA_BIN: writeStubOpa(evalResult([])),
	});

	expect(result.exitCode).toBe(2);
	expect(result.stdout).toBe("");
});

test("a non-empty violations set fails the run and names each violation", async () => {
	const violation = {
		rule: "W-R1",
		file: ".github/workflows/ci.yml",
		detail: "uses ref actions/checkout@v4 is not pinned to a 40-hex SHA",
	};
	const result = await runCheck([], { OPA_BIN: writeStubOpa(evalResult([violation])) });

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toContain("W-R1 .github/workflows/ci.yml");
	expect(result.stderr).toContain("policy violations found");
});

test("an empty violations set passes the run", async () => {
	const result = await runCheck([], { OPA_BIN: writeStubOpa(evalResult([])) });

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("no violations");
});

test("an undefined violations set fails closed rather than reading as no violations", async () => {
	const result = await runCheck([], { OPA_BIN: writeStubOpa(JSON.stringify({ result: [] })) });

	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("no violations set");
});

test.skipIf(!REAL_OPA)("the baseline repository passes with the real OPA binary", async () => {
	const result = await runCheck([], { OPA_BIN: REAL_OPA ?? "" });

	expect(result.exitCode).toBe(0);
});

test.skipIf(!REAL_OPA)("a seeded unpinned uses ref in a copied workflow tree fails W-R1", async () => {
	const dir = join(scratch, "seeded");
	cpSync(join(REPO, ".github", "workflows"), join(dir, ".github", "workflows"), { recursive: true });
	const ci = join(dir, ".github", "workflows", "ci.yml");
	const original = readFileSync(ci, "utf8");
	const seeded = original.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v4");
	expect(seeded).not.toBe(original);
	writeFileSync(ci, seeded);

	const result = await runCheck(["--root", dir], { OPA_BIN: REAL_OPA ?? "" });

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toContain("W-R1");
});
