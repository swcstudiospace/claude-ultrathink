// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
//
// Tests for deploy/ultrathink-pki.sh. Each check runs the script as a child process against a mkdtemp directory; the
// root and intermediate are created once in beforeAll. Assertions use exit codes, the lines the script prints, the
// bytes of the files it writes, and what openssl reports about the certificates. Nothing touches /etc or the repo.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "ultrathink-pki.sh");
const SPIFFE_APP = "spiffe://ultrathink.internal/app";
const SPIFFE_EDGE = "spiffe://ultrathink.internal/edge";
const SPIFFE_OPS = "spiffe://ultrathink.internal/ops";
const SETUP_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 30_000;
const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;

interface Result {
	exitCode: number;
	stdout: string;
	stderr: string;
}

let work = "";
let root = "";
let tls = "";

async function run(cmd: string[], env?: Record<string, string>): Promise<Result> {
	const proc = Bun.spawn({ cmd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

function pki(args: string[], env?: Record<string, string>): Promise<Result> {
	return run(["/bin/sh", SCRIPT, ...args], env);
}

function ok(result: Result): Result {
	if (result.exitCode !== 0) throw new Error(`pki exited ${result.exitCode}: ${result.stderr.trim()}`);
	return result;
}

// checkend exits 1 when the certificate expires within the given seconds, 0 when it is still valid after them.
async function checkendExit(cert: string, seconds: number): Promise<number> {
	return (await run(["openssl", "x509", "-noout", "-checkend", String(seconds), "-in", cert])).exitCode;
}

function modeOf(path: string): number {
	return statSync(path).mode & 0o777;
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), "ultrathink-pki-test-"));
	root = join(work, "root");
	tls = join(work, "tls");
	ok(await pki(["init-root", root]));
	ok(await pki(["init-intermediate", tls]));
	ok(
		await pki([
			"sign-intermediate",
			root,
			join(tls, "intermediate", "intermediate.csr"),
			join(tls, "intermediate", "intermediate.pem"),
		]),
	);
}, SETUP_TIMEOUT_MS);

afterAll(() => {
	if (work !== "") rmSync(work, { recursive: true, force: true });
});

test(
	"root and intermediate carry the path length limits, and no ca.pem exists before the first issue",
	async () => {
		const rootInfo = await run(["openssl", "x509", "-noout", "-ext", "basicConstraints", "-in", join(root, "root.pem")]);
		expect(rootInfo.stdout).toContain("CA:TRUE, pathlen:1");
		const intermediateInfo = await run([
			"openssl", "x509", "-noout", "-ext", "basicConstraints", "-in", join(tls, "intermediate", "intermediate.pem"),
		]);
		expect(intermediateInfo.stdout).toContain("CA:TRUE, pathlen:0");
		expect(existsSync(join(tls, "ca.pem"))).toBe(false);
	},
	TEST_TIMEOUT_MS,
);

test(
	"issue writes a leaf that verifies against ca.pem, carries the SPIFFE URI and IP SAN, and lasts at most 24 h",
	async () => {
		ok(await pki(["issue", tls, "app", SPIFFE_APP, "--ip", "127.0.0.1"]));
		const cert = join(tls, "app", "cert.pem");
		expect((await run(["openssl", "verify", "-CAfile", join(tls, "ca.pem"), cert])).exitCode).toBe(0);
		const san = await run(["openssl", "x509", "-noout", "-ext", "subjectAltName", "-in", cert]);
		expect(san.stdout).toContain(`URI:${SPIFFE_APP}`);
		expect(san.stdout).toContain("IP Address:127.0.0.1");
		// notAfter lies before now + 24 h + 60 s slack, and after now + 23 h.
		expect(await checkendExit(cert, DAY_SECONDS + 60)).toBe(1);
		expect(await checkendExit(cert, 23 * HOUR_SECONDS)).toBe(0);
	},
	TEST_TIMEOUT_MS,
);

test(
	"renew-if-due renews a leaf inside the 12 h window and keeps a fresh one byte-for-byte",
	async () => {
		ok(await pki(["issue", tls, "fresh", SPIFFE_APP]));
		const freshCert = join(tls, "fresh", "cert.pem");
		const freshBefore = readFileSync(freshCert);
		expect(ok(await pki(["renew-if-due", tls, "fresh"])).stdout.trim()).toBe("kept fresh");
		expect(readFileSync(freshCert).equals(freshBefore)).toBe(true);

		ok(await pki(["issue", tls, "edge", SPIFFE_EDGE, "--hours", "6"]));
		const cert = join(tls, "edge", "cert.pem");
		const oldSerial = (await run(["openssl", "x509", "-noout", "-serial", "-in", cert])).stdout.trim();
		expect(ok(await pki(["renew-if-due", tls, "edge"])).stdout.trim()).toBe("renewed edge");
		const newSerial = (await run(["openssl", "x509", "-noout", "-serial", "-in", cert])).stdout.trim();
		expect(newSerial).not.toBe(oldSerial);
		expect((await run(["openssl", "verify", "-CAfile", join(tls, "ca.pem"), cert])).exitCode).toBe(0);
		const san = await run(["openssl", "x509", "-noout", "-ext", "subjectAltName", "-in", cert]);
		expect(san.stdout).toContain(`URI:${SPIFFE_EDGE}`);
		// The renewed leaf has the full default lifetime, so it is still valid at now + 23 h.
		expect(await checkendExit(cert, 23 * HOUR_SECONDS)).toBe(0);

		const renewedBefore = readFileSync(cert);
		expect(ok(await pki(["renew-if-due", tls, "edge"])).stdout.trim()).toBe("kept edge");
		expect(readFileSync(cert).equals(renewedBefore)).toBe(true);
	},
	TEST_TIMEOUT_MS,
);

test(
	"key files are 0400 by default and 0440 with --group, and renewal keeps the group",
	async () => {
		const group = (await run(["id", "-gn"])).stdout.trim();
		ok(await pki(["issue", tls, "plain", SPIFFE_APP]));
		expect(modeOf(join(tls, "plain", "key.pem"))).toBe(0o400);

		ok(await pki(["issue", tls, "ops", SPIFFE_OPS, "--hours", "6", "--group", group]));
		const opsKey = join(tls, "ops", "key.pem");
		expect(modeOf(opsKey)).toBe(0o440);
		expect(statSync(opsKey).gid).toBe(process.getgid());

		ok(await pki(["renew-if-due", tls, "ops"]));
		expect(modeOf(opsKey)).toBe(0o440);
		expect(statSync(opsKey).gid).toBe(process.getgid());
	},
	TEST_TIMEOUT_MS,
);

test(
	"a failed renewal exits non-zero and leaves the old cert and key byte-identical",
	async () => {
		const copy = join(work, "copy");
		cpSync(tls, copy, { recursive: true });
		ok(await pki(["issue", copy, "edge", SPIFFE_EDGE, "--hours", "6"]));
		rmSync(join(copy, "intermediate", "intermediate.key"));
		const cert = join(copy, "edge", "cert.pem");
		const key = join(copy, "edge", "key.pem");
		const certBefore = readFileSync(cert);
		const keyBefore = readFileSync(key);

		const result = await pki(["renew-if-due", copy, "edge"]);
		expect(result.exitCode).not.toBe(0);
		expect(readFileSync(cert).equals(certBefore)).toBe(true);
		expect(readFileSync(key).equals(keyBefore)).toBe(true);
	},
	TEST_TIMEOUT_MS,
);

test(
	"init-root and init-intermediate refuse to overwrite an existing CA key without --force",
	async () => {
		const rootKey = join(root, "root.key");
		const intermediateKey = join(tls, "intermediate", "intermediate.key");
		const rootKeyBefore = readFileSync(rootKey);
		const intermediateKeyBefore = readFileSync(intermediateKey);

		expect((await pki(["init-root", root])).exitCode).not.toBe(0);
		expect((await pki(["init-intermediate", tls])).exitCode).not.toBe(0);
		expect(readFileSync(rootKey).equals(rootKeyBefore)).toBe(true);
		expect(readFileSync(intermediateKey).equals(intermediateKeyBefore)).toBe(true);
	},
	TEST_TIMEOUT_MS,
);

test(
	"init-root --force replaces an existing root key",
	async () => {
		const dir = join(work, "forced-root");
		ok(await pki(["init-root", dir]));
		const before = readFileSync(join(dir, "root.key"));
		ok(await pki(["init-root", dir, "--force"]));
		expect(readFileSync(join(dir, "root.key")).equals(before)).toBe(false);
	},
	TEST_TIMEOUT_MS,
);

test(
	"an invalid SPIFFE ID or an out-of-range lifetime is refused and writes nothing",
	async () => {
		const cases: Array<{ args: string[]; name: string }> = [
			{ args: ["issue", tls, "bad-td", "spiffe://Ultrathink.internal/app"], name: "bad-td" },
			{ args: ["issue", tls, "bad-query", "spiffe://ultrathink.internal/app?x=1"], name: "bad-query" },
			{ args: ["issue", tls, "bad-hours", SPIFFE_APP, "--hours", "25"], name: "bad-hours" },
		];
		for (const { args, name } of cases) {
			expect((await pki(args)).exitCode).not.toBe(0);
			expect(existsSync(join(tls, name, "cert.pem"))).toBe(false);
			expect(existsSync(join(tls, name))).toBe(false);
		}
	},
	TEST_TIMEOUT_MS,
);

test(
	"a missing dependency exits non-zero and names it",
	async () => {
		const emptyPath = mkdtempSync(join(work, "no-tools-"));
		const result = await pki(["issue", tls, "nodeps", SPIFFE_APP], { PATH: emptyPath });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("openssl");
		expect(existsSync(join(tls, "nodeps"))).toBe(false);
	},
	TEST_TIMEOUT_MS,
);
