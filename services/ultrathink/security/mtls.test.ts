// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { identityFromUriSans, type IdentityResult } from "./identity.ts";
import { MAX_CONNECTIONS, type MtlsPeer, type MtlsServer, peerIdentity, startMtlsServer } from "./mtls.ts";

const TRUST_DOMAIN = "ultrathink.test";
const EDGE_URI = "spiffe://ultrathink.test/edge/nginx";
const MAX_BODY_BYTES = 1024;
const EXT_LEAF = "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth,clientAuth\n";

interface Credentials {
	cert: string;
	key: string;
}

type TlsFetchInit = RequestInit & { tls: { ca: string; cert?: string; key?: string } };

let dir = "";
let ca = "";
let serverCreds: Credentials;
let edgeCreds: Credentials;
let edgeNewCreds: Credentials;
let foreignCreds: Credentials;
let expiredCreds: Credentials;
let server: MtlsServer;
let calls = 0;
let lastPeer: MtlsPeer | undefined;

function openssl(args: string[]): void {
	execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}

/** Writes a key and a CSR for `name`, then signs it with the given CA. The leaf gets `sanLine` as its SAN. */
function issueLeaf(name: string, sanLine: string, signerCert: string, signerKey: string): Credentials {
	writeFileSync(join(dir, `${name}.ext`), `${EXT_LEAF}subjectAltName=${sanLine}\n`);
	openssl(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
	openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", signerCert, "-CAkey", signerKey, "-CAcreateserial", "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`]);
	return credentialsOf(name);
}

function credentialsOf(name: string): Credentials {
	return { cert: readFileSync(join(dir, `${name}.pem`), "utf8"), key: readFileSync(join(dir, `${name}.key`), "utf8") };
}

/** Issues a leaf whose validity window lies in the past, through `openssl ca` with explicit dates. */
function issueExpiredLeaf(name: string, sanLine: string): Credentials {
	mkdirSync(join(dir, "newcerts"), { recursive: true });
	writeFileSync(join(dir, "index.txt"), "");
	writeFileSync(join(dir, "serial"), "01\n");
	writeFileSync(
		join(dir, "ca.cnf"),
		[
			"[ ca ]",
			"default_ca = test_ca",
			"[ test_ca ]",
			`dir = ${dir}`,
			`certificate = ${join(dir, "ca.pem")}`,
			`private_key = ${join(dir, "ca.key")}`,
			`database = ${join(dir, "index.txt")}`,
			`new_certs_dir = ${join(dir, "newcerts")}`,
			`serial = ${join(dir, "serial")}`,
			"default_md = sha256",
			"unique_subject = no",
			"copy_extensions = none",
			"policy = policy_any",
			"[ policy_any ]",
			"commonName = supplied",
			"",
		].join("\n"),
	);
	writeFileSync(join(dir, `${name}.ext`), `${EXT_LEAF}subjectAltName=${sanLine}\n`);
	openssl(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
	openssl([
		"ca", "-batch", "-config", join(dir, "ca.cnf"), "-in", `${name}.csr`, "-out", `${name}.pem`,
		"-extfile", `${name}.ext`, "-startdate", "20200101000000Z", "-enddate", "20200102000000Z", "-notext",
	]);
	return credentialsOf(name);
}

function fetchWith(port: number, init: Partial<TlsFetchInit>): Promise<Response> {
	return fetch(`https://127.0.0.1:${port}/`, { method: "POST", tls: { ca }, ...init } as TlsFetchInit);
}

function serverOptions(idleTimeoutSec: number) {
	return {
		port: 0,
		certFile: join(dir, "srv.pem"),
		keyFile: join(dir, "srv.key"),
		clientCaFile: join(dir, "ca.pem"),
		idleTimeoutSec,
		maxBodyBytes: MAX_BODY_BYTES,
	};
}

/** The TCP port a listener bound to, failing the test if it is not a TCP listener. */
function boundPort(listener: net.Server): number {
	const address = listener.address();
	if (address === null || typeof address === "string") throw new Error("not a TCP listener");
	return address.port;
}

/** Opens a TLS client with the edge certificate, so the test controls the bytes written after the handshake. */
function edgeClient(port: number): tls.TLSSocket {
	const client = tls.connect({ port, host: "127.0.0.1", ca, cert: edgeCreds.cert, key: edgeCreds.key });
	client.on("error", () => {});
	return client;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "mtls-test-"));
	openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=ultrathink-test-ca", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
	openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca2.key", "-out", "ca2.pem", "-days", "2", "-subj", "/CN=other-test-ca", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
	ca = readFileSync(join(dir, "ca.pem"), "utf8");
	serverCreds = issueLeaf("srv", "IP:127.0.0.1", join(dir, "ca.pem"), join(dir, "ca.key"));
	writeFileSync(join(dir, "srv.key"), serverCreds.key);
	writeFileSync(join(dir, "srv.pem"), serverCreds.cert);
	edgeCreds = issueLeaf("edge", `URI:${EDGE_URI},DNS:edge.test`, join(dir, "ca.pem"), join(dir, "ca.key"));
	edgeNewCreds = issueLeaf("edge-new", `URI:${EDGE_URI}`, join(dir, "ca.pem"), join(dir, "ca.key"));
	foreignCreds = issueLeaf("foreign", `URI:${EDGE_URI}`, join(dir, "ca2.pem"), join(dir, "ca2.key"));
	expiredCreds = issueExpiredLeaf("expired", `URI:${EDGE_URI}`);
	server = await startMtlsServer(serverOptions(30), async (req, peer) => {
		calls++;
		lastPeer = peer;
		return new Response(await req.text());
	});
});

afterAll(async () => {
	await server.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("mTLS server adapter", () => {
	test("admits a verified edge client and reports its SPIFFE identity", async () => {
		calls = 0;
		const response = await fetchWith(server.port, { body: "hi", tls: { ca, cert: edgeCreds.cert, key: edgeCreds.key } });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("hi");
		expect(calls).toBe(1);
		expect(lastPeer?.uriSans).toEqual([EDGE_URI]);
		expect(lastPeer?.ip).toBe("127.0.0.1");
		const identity: IdentityResult = identityFromUriSans(lastPeer?.uriSans ?? [], TRUST_DOMAIN);
		expect(identity).toEqual({ ok: true, spiffeId: EDGE_URI, path: "/edge/nginx" });
	});

	test("refuses a client without a certificate before the handler runs", async () => {
		calls = 0;
		await expect(fetchWith(server.port, {})).rejects.toThrow();
		expect(calls).toBe(0);
	});

	test("refuses a client certificate issued by another CA", async () => {
		calls = 0;
		await expect(fetchWith(server.port, { tls: { ca, cert: foreignCreds.cert, key: foreignCreds.key } })).rejects.toThrow();
		expect(calls).toBe(0);
	});

	test("refuses an expired leaf from the client CA", async () => {
		calls = 0;
		await expect(fetchWith(server.port, { tls: { ca, cert: expiredCreds.cert, key: expiredCreds.key } })).rejects.toThrow();
		expect(calls).toBe(0);
	});

	test("admits the current and the rotation-overlap leaf from the same CA", async () => {
		for (const creds of [edgeCreds, edgeNewCreds]) {
			const response = await fetchWith(server.port, { body: "x", tls: { ca, cert: creds.cert, key: creds.key } });
			expect(response.status).toBe(200);
			await response.text();
		}
	});

	test("answers 413 to a body over maxBodyBytes and never calls the handler", async () => {
		calls = 0;
		const client = { ca, cert: edgeCreds.cert, key: edgeCreds.key };
		const sized = await fetchWith(server.port, { body: new Uint8Array(MAX_BODY_BYTES * 2), tls: client });
		expect(sized.status).toBe(413);
		await sized.text();
		const chunked = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_BODY_BYTES * 2));
				controller.close();
			},
		});
		const streamed = await fetchWith(server.port, { body: chunked, duplex: "half", tls: client } as Partial<TlsFetchInit>);
		expect(streamed.status).toBe(413);
		await streamed.text();
		expect(calls).toBe(0);
	});

	test("passes a body of exactly maxBodyBytes to the handler", async () => {
		calls = 0;
		const body = new Uint8Array(MAX_BODY_BYTES).fill(0x61);
		const response = await fetchWith(server.port, { body, tls: { ca, cert: edgeCreds.cert, key: edgeCreds.key } });
		expect(response.status).toBe(200);
		expect((await response.arrayBuffer()).byteLength).toBe(MAX_BODY_BYTES);
		expect(calls).toBe(1);
	});

	test("reads the verified identity from the TLS socket through peerIdentity", async () => {
		const identity = await new Promise<IdentityResult>((resolve, reject) => {
			const probe = tls.createServer({ cert: serverCreds.cert, key: serverCreds.key, ca, requestCert: true, rejectUnauthorized: true }, (socket) => {
				resolve(peerIdentity(socket, TRUST_DOMAIN));
				socket.end();
			});
			probe.once("error", reject);
			probe.listen(0, "127.0.0.1", () => {
				const client = tls.connect({ port: boundPort(probe), host: "127.0.0.1", ca, cert: edgeCreds.cert, key: edgeCreds.key });
				client.on("error", reject);
				client.on("close", () => probe.close());
			});
		});
		expect(identity).toEqual({ ok: true, spiffeId: EDGE_URI, path: "/edge/nginx" });
	});

	// Timing tests: socket timeouts run on the platform clock inside the server, so they cannot be faked from the
	// client. Each awaits the close event with a short configured window, never an elapsed-time assertion.
	test("closes a connection that stays idle past idleTimeoutSec", async () => {
		const idle = await startMtlsServer(serverOptions(0.2), async () => new Response("unused"));
		try {
			await new Promise<void>((resolve) => {
				const client = edgeClient(idle.port);
				client.on("close", () => resolve());
			});
		} finally {
			await idle.stop();
		}
	});

	test("closes a request that trickles past the per-request deadline", async () => {
		// Bytes keep arriving every 20 ms, well inside the 300 ms window, so only the absolute deadline can close it.
		const slow = await startMtlsServer(serverOptions(0.3), async () => new Response("unused"));
		try {
			await new Promise<void>((resolve) => {
				const client = edgeClient(slow.port);
				let trickle: NodeJS.Timeout | undefined;
				client.on("close", () => {
					clearInterval(trickle);
					resolve();
				});
				client.write("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: ");
				trickle = setInterval(() => client.write("a"), 20);
			});
		} finally {
			await slow.stop();
		}
	});

	test("closes a connection that never completes the TLS handshake", async () => {
		const stalled = await startMtlsServer(serverOptions(0.2), async () => new Response("unused"));
		try {
			await new Promise<void>((resolve) => {
				const raw = net.connect(stalled.port, "127.0.0.1");
				raw.on("error", () => {});
				raw.on("close", () => resolve());
			});
		} finally {
			await stalled.stop();
		}
	});

	test("closes the connection beyond MAX_CONNECTIONS at accept", async () => {
		const full = await startMtlsServer(serverOptions(30), async () => new Response("unused"));
		const held: net.Socket[] = [];
		try {
			const firstClose = new Promise<void>((resolve) => {
				for (let i = 0; i <= MAX_CONNECTIONS; i++) {
					const raw = net.connect(full.port, "127.0.0.1");
					raw.on("error", () => {});
					raw.on("close", () => resolve());
					held.push(raw);
				}
			});
			await firstClose;
		} finally {
			for (const raw of held) raw.destroy();
			await full.stop();
		}
	});

	test("survives a client that aborts mid-body and still serves the next request", async () => {
		calls = 0;
		const aborted = new Promise<void>((resolve) => {
			const client = edgeClient(server.port);
			client.on("secureConnect", () => {
				// Declares 100 body bytes, sends 3, and drops the connection once those bytes are flushed.
				client.write("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\nabc", () => client.destroy());
			});
			client.on("close", () => resolve());
		});
		await aborted;
		const response = await fetchWith(server.port, { body: "ok", tls: { ca, cert: edgeCreds.cert, key: edgeCreds.key } });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(calls).toBe(1);
	});

	test("reports a bind failure as a rejection", async () => {
		const holder = net.createServer();
		await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", () => resolve()));
		try {
			await expect(startMtlsServer({ ...serverOptions(30), port: boundPort(holder) }, async () => new Response())).rejects.toThrow();
		} finally {
			await new Promise<void>((resolve) => holder.close(() => resolve()));
		}
	});

	test("refuses to bind any address other than 127.0.0.1", async () => {
		await expect(startMtlsServer({ ...serverOptions(30), hostname: "0.0.0.0" }, async () => new Response())).rejects.toThrow(RangeError);
	});
});
