// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { identityFromUriSans, type IdentityResult } from "./identity.ts";
import { type MtlsPeer, type MtlsServer, peerIdentity, startMtlsServer } from "./mtls.ts";

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

beforeAll(() => {
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
	server = startMtlsServer(serverOptions(30), async (req, peer) => {
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
				const address = probe.address();
				if (address === null || typeof address === "string") throw new Error("probe did not bind a TCP address");
				const port = address.port;
				const client = tls.connect({ port, host: "127.0.0.1", ca, cert: edgeCreds.cert, key: edgeCreds.key });
				client.on("error", reject);
				client.on("close", () => probe.close());
			});
		});
		expect(identity).toEqual({ ok: true, spiffeId: EDGE_URI, path: "/edge/nginx" });
	});

	test("closes a connection that stays idle past idleTimeoutSec", async () => {
		const idle = startMtlsServer(serverOptions(0.2), async () => new Response("unused"));
		try {
			await new Promise<void>((resolve) => {
				const client = tls.connect({ port: idle.port, host: "127.0.0.1", ca, cert: edgeCreds.cert, key: edgeCreds.key });
				// A reset after the server destroys the idle socket is part of the same close; the close event is what is asserted.
				client.on("error", () => {});
				client.on("close", () => resolve());
			});
		} finally {
			await idle.stop();
		}
	});

	test("refuses to bind any address other than 127.0.0.1", () => {
		expect(() => startMtlsServer({ ...serverOptions(30), hostname: "0.0.0.0" }, async () => new Response())).toThrow(RangeError);
	});
});
