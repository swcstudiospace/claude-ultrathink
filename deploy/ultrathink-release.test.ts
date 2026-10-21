// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
//
// Tests for the mTLS probe and the TLS preflight in ultrathink-release.sh. The script is sourced (its dispatch is
// guarded), so the real probe() and check_tls_material() run against a local Bun TLS server built in a temp directory.
// Nothing here touches /etc, systemd, a service user or a production host. The probe's retry sleep is replaced by a
// PATH stub that logs calls, so the 30-attempt budget is asserted by count and no wall-clock time is spent.
// The release ancestry gate is tested by running `release` as a subprocess against a temp bare origin and clone. Only
// root-only commands are stubbed on PATH; the gate under test is the real scripts/security-gate.ts, copied into the fixture.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tls from "node:tls";

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

// Serves /healthz and /readyz over TLS from a node:tls listener. The handshake requires a client leaf that chains to
// clientCaFile (requestCert plus rejectUnauthorized), and the socket must still report `authorized` before a request
// is answered, so a refused client never reaches respond(). Bun.serve is not used here: on Bun 1.2.23 it admitted a
// foreign-CA client leaf in some handshakes (3 of 20 runs), while tls.createServer refused every run measured (60).
interface MtlsStub {
	port: number;
	hits: () => number;
	stop: () => void;
}

async function serveMtls(serverCert: string, serverKey: string, clientCaFile: string, readyz: number): Promise<MtlsStub> {
	const counter: Counter = { hits: 0 };
	const sockets = new Set<tls.TLSSocket>();
	const listener = tls.createServer(
		{
			cert: readFileSync(serverCert, "utf8"),
			key: readFileSync(serverKey, "utf8"),
			ca: readFileSync(clientCaFile, "utf8"),
			requestCert: true,
			rejectUnauthorized: true,
		},
		(socket) => {
			if (!socket.authorized) {
				socket.destroy();
				return;
			}
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			let head = "";
			let answered = false;
			socket.on("data", (chunk: Buffer) => {
				head += chunk.toString("latin1");
				if (answered || !head.includes("\r\n\r\n")) return;
				answered = true;
				const target = head.split(" ")[1] ?? "/";
				const response = respond(new Request(`https://127.0.0.1${target}`), readyz, counter);
				void response.text().then((body) => {
					socket.end(`HTTP/1.1 ${response.status} ${response.statusText}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
				});
			});
		},
	);
	// A refused handshake is the expected outcome here; Bun 1.2.23 emits its error on the raw TCP socket, not the TLS one.
	listener.on("connection", (raw) => raw.on("error", () => {}));
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	listener.once("error", reject);
	listener.listen(0, "127.0.0.1", () => {
		const address = listener.address();
		if (address === null || typeof address === "string") reject(new Error("serveMtls did not bind a TCP address"));
		else resolve(address.port);
	});
	const port = await promise;
	return {
		port,
		hits: () => counter.hits,
		stop: () => {
			listener.close();
			for (const socket of sockets) socket.destroy();
		},
	};
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
	const server = await serveMtls(join(tlsReal, "app", "cert.pem"), join(tlsReal, "app", "key.pem"), join(caReal, "ca.pem"), 200);
	try {
		expect(await probe(server.port, tlsReal)).toBe(0);
		expect(server.hits()).toBe(2);
		expect(sleepCalls()).toBe(0);
	} finally {
		server.stop();
	}
}, PROBE_TIMEOUT_MS);

test("probe fails when the ops leaf is from another CA, and the handler never runs", async () => {
	const server = await serveMtls(join(tlsReal, "app", "cert.pem"), join(tlsReal, "app", "key.pem"), join(caReal, "ca.pem"), 200);
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
	const server = await serveMtls(join(tlsReal, "app", "cert.pem"), join(tlsReal, "app", "key.pem"), join(caReal, "ca.pem"), 200);
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
	const server = await serveMtls(join(foreignServer, "cert.pem"), join(foreignServer, "key.pem"), join(caReal, "ca.pem"), 200);
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
	const server = await serveMtls(join(tlsReal, "app", "cert.pem"), join(tlsReal, "app", "key.pem"), join(caReal, "ca.pem"), 503);
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

// ---------- release ancestry gate (do_release) ----------
// The release preflight needs flock, which the macOS runner lacks, and these tests run the real release path that the
// Linux VPS uses. They are skipped off Linux for that reason.
describe.skipIf(process.platform !== "linux")("release ancestry gate (do_release)", () => {
	// `release` runs as a subprocess, so the real entry point and the real gate run. Root-only commands are stubbed on PATH:
	// `id` reports root, `chown` does nothing, `setpriv` runs its command as the current user and `systemctl` does nothing.
	// Every run stops at the ancestry gate, or continues past the archive step for a commit on origin/main.
	const RELEASE_TIMEOUT_MS = 60_000;
	const REPO_ROOT = resolve(import.meta.dir, "..");
	// The real gate and its import closure (Node built-ins only), copied into each fixture checkout so it runs there.
	const GATE_FILES = [
		"scripts/security-gate.ts",
		"src/decisions/client.ts",
		"src/decisions/types.ts",
		"src/grok/auth.ts",
		"src/grok/types.ts",
		"src/mcp/providers.ts",
		"src/route-defaults.ts",
	];
	const RELEASE_STUBS: Record<string, string> = {
		id: "#!/bin/sh\necho 0\n",
		// The release tree is owned by root on the VPS; these tests check ancestry, not ownership, so chown is a no-op here.
		chown: "#!/bin/sh\nexit 0\n",
		setpriv: '#!/bin/sh\nwhile [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done\n[ $# -gt 0 ] && shift\nexec "$@"\n',
		systemctl: "#!/bin/sh\nexit 0\n",
	};

	// Runs git in cwd with a fixed identity, so fixtures never depend on the host's git configuration.
	async function git(cwd: string, args: string[]): Promise<string> {
		const proc = Bun.spawn({
			cmd: ["git", ...args],
			cwd,
			env: scrubbedEnv({
				GIT_AUTHOR_NAME: "ci",
				GIT_AUTHOR_EMAIL: "ci@example.com",
				GIT_COMMITTER_NAME: "ci",
				GIT_COMMITTER_EMAIL: "ci@example.com",
			}),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0) throw new Error(`git ${args[0]} exited ${exitCode}: ${stderr.trim()}`);
		return stdout.trim();
	}

	// Stages everything in dir and commits it, returning the new HEAD.
	async function commitAll(dir: string, message: string): Promise<string> {
		await git(dir, ["add", "--all"]);
		await git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
		return git(dir, ["rev-parse", "HEAD"]);
	}

	// Writes one file and commits it, returning the new HEAD.
	async function commitFile(dir: string, name: string): Promise<string> {
		writeFileSync(join(dir, name), `${name}\n`);
		return commitAll(dir, name);
	}

	// A bare origin whose main is pushed from seed, and a clone of it: the release checkout. `side` is committed in the clone
	// and never pushed, so it is not on origin/main. seed stays available to push later commits to origin.
	async function makeReleaseRepos(dir: string) {
		const origin = join(dir, "origin.git");
		const seed = join(dir, "seed");
		const clone = join(dir, "clone");
		await git(dir, ["init", "-q", "--bare", "-b", "main", origin]);
		await git(dir, ["init", "-q", "-b", "main", seed]);
		for (const rel of GATE_FILES) {
			mkdirSync(join(seed, rel, ".."), { recursive: true });
			cpSync(join(REPO_ROOT, rel), join(seed, rel));
		}
		const mainSha = await commitAll(seed, "base");
		await git(seed, ["push", "-q", origin, "main"]);
		await git(dir, ["clone", "-q", origin, clone]);
		await git(clone, ["checkout", "-q", "-b", "side"]);
		const sideSha = await commitFile(clone, "side");
		await git(clone, ["checkout", "-q", "main"]);
		return { origin, seed, clone, mainSha, sideSha };
	}

	// One release fixture: repos, a bun wrapper, an env file, root-only stubs, and the environment for `release`.
	async function setupRelease(name: string) {
		const dir = join(work, name);
		mkdirSync(dir, { recursive: true });
		const repos = await makeReleaseRepos(dir);
		const root = join(dir, "opt");
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(join(root, "bin", "bun"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
		chmodSync(join(root, "bin", "bun"), 0o755);
		const envFile = join(dir, "ultrathink.env");
		writeFileSync(envFile, "ULTRATHINK_PORT=8795\n");
		const stubs = join(dir, "stubs");
		mkdirSync(stubs);
		for (const [tool, body] of Object.entries(RELEASE_STUBS)) {
			writeFileSync(join(stubs, tool), body);
			chmodSync(join(stubs, tool), 0o755);
		}
		const env = scrubbedEnv({
			ULTRATHINK_ROOT: root,
			ULTRATHINK_ENV_FILE: envFile,
			ULTRATHINK_REPO: repos.clone,
			ULTRATHINK_TLS_DIR: tlsReal,
			ULTRATHINK_SERVICE_USER: "ultrathink",
			PATH: `${stubs}:${process.env.PATH ?? ""}`,
		});
		return { root, repos, env };
	}

	// The prefix of the directory `release` archives a commit into: <short sha>-<utc stamp>.
	function archivePrefix(root: string, sha: string): string {
		return join(root, "releases", `${sha.slice(0, 12)}-`);
	}

	test("release refuses a ref that is not on origin/main before anything is archived", async () => {
		const { root, repos, env } = await setupRelease("refused");
		const result = await run(["bash", SCRIPT, "release", "side"], env);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(`ancestry: ${repos.sideSha} is not an ancestor of origin/main`);
		expect(result.stderr).toContain(`ref side (${repos.sideSha}) is not on origin/main; release refused, nothing was archived`);
		expect(result.stdout).not.toContain("running tests");
		expect(existsSync(join(root, "releases"))).toBe(false);
	}, RELEASE_TIMEOUT_MS);

	test("release passes the ancestry step for a ref on origin/main and goes on to archive it", async () => {
		const { root, repos, env } = await setupRelease("on-main");
		const result = await run(["bash", SCRIPT, "release", "main"], env);
		expect(result.stdout).toContain(`ancestry: ${repos.mainSha} is on origin/main`);
		expect(result.stderr).not.toContain("release refused");
		expect(result.stdout).toContain(`running tests in ${archivePrefix(root, repos.mainSha)}`);
	}, RELEASE_TIMEOUT_MS);

	test("release refuses a local main that is ahead of origin/main, because only origin/main counts", async () => {
		const { root, repos, env } = await setupRelease("local-ahead");
		const aheadSha = await commitFile(repos.clone, "ahead");
		const result = await run(["bash", SCRIPT, "release", "main"], env);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(`ref main (${aheadSha}) is not on origin/main; release refused, nothing was archived`);
		expect(existsSync(join(root, "releases"))).toBe(false);
	}, RELEASE_TIMEOUT_MS);

	test("release fetches origin/main before resolving, so a commit pushed after the clone passes", async () => {
		const { root, repos, env } = await setupRelease("fetch-first");
		const laterSha = await commitFile(repos.seed, "later");
		await git(repos.seed, ["push", "-q", repos.origin, "main"]);
		const result = await run(["bash", SCRIPT, "release", "origin/main"], env);
		expect(result.stdout).toContain(`ancestry: ${laterSha} is on origin/main`);
		expect(result.stdout).toContain(`running tests in ${archivePrefix(root, laterSha)}`);
	}, RELEASE_TIMEOUT_MS);
});
