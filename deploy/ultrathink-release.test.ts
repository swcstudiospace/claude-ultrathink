// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
//
// Tests for the mTLS probe and the TLS preflight in ultrathink-release.sh. The script is sourced (its dispatch is
// guarded), so the real probe() and check_tls_material() run against a local Bun TLS server built in a temp directory.
// Nothing here touches /etc, systemd, a service user or a production host. The probe's retry sleep is replaced by a
// PATH stub that logs calls, so the 30-attempt budget is asserted by count and no wall-clock time is spent.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "ultrathink-release.sh");
const OPS_URI = "spiffe://ultrathink.internal/ops/probe";
const APP_SAN = "IP:127.0.0.1";
const OPS_SAN = `URI:${OPS_URI}`;
const PROBE_TIMEOUT_MS = 30_000;
// The probe makes 30 attempts on the first path that fails, so it sleeps 29 times before giving up.
const FAILED_PROBE_SLEEPS = 29;

let work = "";
let caReal = "";
let caForeign = "";
let tlsReal = "";
let tlsForeignOps = "";
let foreignServer = "";
let stubBin = "";
let sleepLog = "";

function scrubbedEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("ULTRATHINK_")) env[key] = value;
	}
	return { ...env, ...extra };
}

async function run(cmd: string[], env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn({ cmd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

async function openssl(args: string[]): Promise<void> {
	const result = await run(["openssl", ...args], scrubbedEnv({}));
	if (result.exitCode !== 0) throw new Error(`openssl ${args[0]} exited ${result.exitCode}: ${result.stderr.trim()}`);
}

async function makeCa(dir: string, commonName: string): Promise<void> {
	mkdirSync(dir, { recursive: true });
	await openssl([
		"req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
		"-keyout", join(dir, "ca-key.pem"), "-out", join(dir, "ca.pem"), "-days", "2",
		"-subj", `/CN=${commonName}`,
		"-addext", "basicConstraints=critical,CA:TRUE",
		"-addext", "keyUsage=critical,keyCertSign,cRLSign",
	]);
}

// Issues a leaf (cert.pem, key.pem) in outDir signed by the CA in caDir.
async function makeLeaf(caDir: string, outDir: string, san: string, eku: string): Promise<void> {
	mkdirSync(outDir, { recursive: true });
	const csr = join(outDir, "req.csr");
	const ext = join(outDir, "ext.cnf");
	await openssl([
		"req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
		"-keyout", join(outDir, "key.pem"), "-out", csr, "-subj", "/CN=ultrathink-test-leaf",
	]);
	writeFileSync(
		ext,
		`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${eku}\nsubjectAltName=${san}\n`,
	);
	await openssl([
		"x509", "-req", "-in", csr,
		"-CA", join(caDir, "ca.pem"), "-CAkey", join(caDir, "ca-key.pem"), "-CAcreateserial",
		"-days", "1", "-extfile", ext, "-out", join(outDir, "cert.pem"),
	]);
	rmSync(csr);
	rmSync(ext);
}

// Lays out a TLS directory the way the release expects: ca.pem, app/ (server leaf) and ops/ (probe client leaf).
// trustCa is copied into ca.pem; appCa and opsCa sign the leaves. opsCa null leaves no ops/ directory.
async function writeTls(dir: string, trustCa: string, appCa: string, opsCa: string | null): Promise<void> {
	mkdirSync(dir, { recursive: true });
	cpSync(join(trustCa, "ca.pem"), join(dir, "ca.pem"));
	await makeLeaf(appCa, join(dir, "app"), APP_SAN, "serverAuth");
	if (opsCa !== null) await makeLeaf(opsCa, join(dir, "ops"), OPS_SAN, "clientAuth");
}

type Counter = { hits: number };

// Serves /healthz and /readyz over TLS. The client must present a leaf signed by clientCaFile (requestCert plus
// rejectUnauthorized), so a handshake that fails never reaches the handler and never increments the counter.
function serveMtls(serverCert: string, serverKey: string, clientCaFile: string, readyz: number) {
	const counter: Counter = { hits: 0 };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		tls: {
			cert: readFileSync(serverCert, "utf8"),
			key: readFileSync(serverKey, "utf8"),
			ca: readFileSync(clientCaFile, "utf8"),
			requestCert: true,
			rejectUnauthorized: true,
		},
		fetch: (req) => respond(req, readyz, counter),
	});
	return { port: server.port, hits: () => counter.hits, stop: () => server.stop(true) };
}

// Plain HTTP, the TLS-less service the probe must refuse.
function servePlain(readyz: number) {
	const counter: Counter = { hits: 0 };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => respond(req, readyz, counter),
	});
	return { port: server.port, hits: () => counter.hits, stop: () => server.stop(true) };
}

function respond(req: Request, readyz: number, counter: Counter): Response {
	counter.hits += 1;
	const path = new URL(req.url).pathname;
	if (path === "/healthz") return new Response("ok", { status: 200 });
	if (path === "/readyz") return new Response("ok", { status: readyz });
	return new Response("not found", { status: 404 });
}

function sleepCalls(): number {
	if (!existsSync(sleepLog)) return 0;
	return readFileSync(sleepLog, "utf8").split("\n").filter((line) => line.length > 0).length;
}

// Runs probe <port> against the TLS directory. The PATH stub records each retry sleep instead of waiting.
async function probe(port: number, tlsDir: string): Promise<number> {
	rmSync(sleepLog, { force: true });
	const result = await run(
		["bash", "-c", 'source "$1"; probe "$2" test', "bash", SCRIPT, String(port)],
		scrubbedEnv({
			ULTRATHINK_TLS_DIR: tlsDir,
			PATH: `${stubBin}:${process.env.PATH ?? ""}`,
			SLEEP_LOG: sleepLog,
		}),
	);
	return result.exitCode;
}

async function checkTlsMaterial(tlsDir: string): Promise<number> {
	const result = await run(
		["bash", "-c", 'source "$1"; check_tls_material', "bash", SCRIPT],
		scrubbedEnv({ ULTRATHINK_TLS_DIR: tlsDir }),
	);
	return result.exitCode;
}

// Bun 1.2 rejects a timeout argument to beforeAll, so the setup budget is this file's default hook timeout.
setDefaultTimeout(PROBE_TIMEOUT_MS);

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), "ultrathink-release-test-"));
	caReal = join(work, "ca-real");
	caForeign = join(work, "ca-foreign");
	await makeCa(caReal, "ultrathink-test-real");
	await makeCa(caForeign, "ultrathink-test-foreign");

	tlsReal = join(work, "tls-real");
	await writeTls(tlsReal, caReal, caReal, caReal);

	// Ops leaf from a CA the server does not trust; the app leaf and the pinned CA are still genuine.
	tlsForeignOps = join(work, "tls-foreign-ops");
	await writeTls(tlsForeignOps, caReal, caReal, caForeign);

	// Server certificate from a CA the probe does not pin.
	foreignServer = join(work, "foreign-server");
	await makeLeaf(caForeign, foreignServer, APP_SAN, "serverAuth");

	stubBin = join(work, "bin");
	mkdirSync(stubBin);
	writeFileSync(join(stubBin, "sleep"), '#!/bin/sh\nprintf "slept\\n" >>"$SLEEP_LOG"\n');
	chmodSync(join(stubBin, "sleep"), 0o755);
	sleepLog = join(work, "sleep.log");
});

afterAll(() => {
	if (work !== "") rmSync(work, { recursive: true, force: true });
});

test("sourcing the release script defines functions without running a subcommand", async () => {
	const result = await run(
		["bash", "-c", 'source "$1"; echo loaded', "bash", SCRIPT],
		scrubbedEnv({}),
	);
	expect(result.exitCode).toBe(0);
	expect(result.stdout.trim()).toBe("loaded");
});

test("probe accepts 200 on /healthz and /readyz from a server that verifies the ops identity", async () => {
	const server = serveMtls(join(tlsReal, "app", "cert.pem"), join(tlsReal, "app", "key.pem"), join(caReal, "ca.pem"), 200);
	try {
		expect(await probe(server.port, tlsReal)).toBe(0);
		expect(server.hits()).toBe(2);
		expect(sleepCalls()).toBe(0);
	} finally {
		server.stop();
	}
}, PROBE_TIMEOUT_MS);

test("probe fails when the ops leaf is from another CA, and the handler never runs", async () => {
	const server = serveMtls(join(tlsReal, "app", "cert.pem"), join(tlsReal, "app", "key.pem"), join(caReal, "ca.pem"), 200);
	try {
		expect(await probe(server.port, tlsForeignOps)).toBe(1);
		expect(server.hits()).toBe(0);
		expect(sleepCalls()).toBe(FAILED_PROBE_SLEEPS);
	} finally {
		server.stop();
	}
}, PROBE_TIMEOUT_MS);

test("probe sends no request when the ops identity is absent", async () => {
	const noOps = join(work, "tls-no-ops");
	cpSync(tlsReal, noOps, { recursive: true });
	rmSync(join(noOps, "ops"), { recursive: true, force: true });
	const server = serveMtls(join(tlsReal, "app", "cert.pem"), join(tlsReal, "app", "key.pem"), join(caReal, "ca.pem"), 200);
	try {
		expect(await probe(server.port, noOps)).toBe(1);
		expect(server.hits()).toBe(0);
		expect(sleepCalls()).toBe(FAILED_PROBE_SLEEPS);
	} finally {
		server.stop();
	}
}, PROBE_TIMEOUT_MS);

test("probe does not accept a server certificate the pinned CA did not sign", async () => {
	// The server still verifies the ops leaf (signed by the real CA), so only the probe's server check can refuse it.
	const server = serveMtls(join(foreignServer, "cert.pem"), join(foreignServer, "key.pem"), join(caReal, "ca.pem"), 200);
	try {
		expect(await probe(server.port, tlsReal)).toBe(1);
		expect(server.hits()).toBe(0);
		expect(sleepCalls()).toBe(FAILED_PROBE_SLEEPS);
	} finally {
		server.stop();
	}
}, PROBE_TIMEOUT_MS);

test("probe fails a TLS-less service", async () => {
	const server = servePlain(200);
	try {
		expect(await probe(server.port, tlsReal)).toBe(1);
		expect(sleepCalls()).toBe(FAILED_PROBE_SLEEPS);
	} finally {
		server.stop();
	}
}, PROBE_TIMEOUT_MS);

test("probe requires /readyz to be 200 after /healthz passes", async () => {
	const server = serveMtls(join(tlsReal, "app", "cert.pem"), join(tlsReal, "app", "key.pem"), join(caReal, "ca.pem"), 503);
	try {
		expect(await probe(server.port, tlsReal)).toBe(1);
		// /healthz passed with no retry; the retry budget was spent on /readyz.
		expect(sleepCalls()).toBe(FAILED_PROBE_SLEEPS);
	} finally {
		server.stop();
	}
}, PROBE_TIMEOUT_MS);

const REQUIRED_TLS_FILES = ["ca.pem", "app/cert.pem", "app/key.pem", "ops/cert.pem", "ops/key.pem"];

for (const omitted of REQUIRED_TLS_FILES) {
	test(`check_tls_material refuses a TLS directory missing ${omitted}`, async () => {
		const dir = join(work, `tls-missing-${omitted.replace("/", "-")}`);
		cpSync(tlsReal, dir, { recursive: true });
		rmSync(join(dir, omitted), { force: true });
		expect(await checkTlsMaterial(dir)).toBe(1);
	}, PROBE_TIMEOUT_MS);
}
