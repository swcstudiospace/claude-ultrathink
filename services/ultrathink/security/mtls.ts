// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * mTLS server adapter: a loopback HTTPS listener that admits only clients whose certificate chains
 * to the configured client CA. Identity comes from the verified leaf's URI SANs (see identity.ts).
 *
 * Step 0 spike (Bun 1.4.0, run in a temp dir before this module was written):
 * - Bun.serve({ tls: { requestCert, rejectUnauthorized, ca } }) refuses a missing client cert and a
 *   foreign-CA cert at the handshake, and the fetch handler never runs for them.
 * - Bun.serve cannot expose the peer certificate: the Request has no socket, the Server has only
 *   requestIP(). Identity cannot be read there.
 * - node:https cannot either: req.socket and the secureConnection socket have no getPeerCertificate.
 * - Approved route (lead decision): tls.createServer(opts, s => httpServer.emit("connection", s)) with
 *   a node:http server. req.socket.getPeerCertificate(true).subjectaltname returns, for example,
 *   "URI:spiffe://ultrathink.test/edge, DNS:edge.test" (entries joined by ", ").
 * - Body cap: a 413 is returned for an over-cap Content-Length and for an over-cap chunked body.
 * - Idle timeout: http.Server.setTimeout does not close manually-emitted sockets; a per-socket
 *   setTimeout with a "timeout" handler that destroys the socket does, and the client sees close.
 */

import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import tls, { type TLSSocket } from "node:tls";
import { identityFromUriSans, type IdentityResult } from "./identity.ts";

const LOOPBACK = "127.0.0.1";
const URI_SAN_LABEL = "URI:";
const SAN_SEPARATOR = ", ";
/** Headers that describe the client's connection or body framing, not the request itself. */
const DROPPED_REQUEST_HEADERS: Record<string, true> = {
	connection: true,
	"content-length": true,
	"keep-alive": true,
	"proxy-connection": true,
	te: true,
	trailer: true,
	"transfer-encoding": true,
	upgrade: true,
};

export interface MtlsServerOptions {
	port: number;
	certFile: string;
	keyFile: string;
	clientCaFile: string;
	/** Seconds a connection may sit with no traffic before the server closes it. */
	idleTimeoutSec: number;
	/** Largest request body handed to the handler; larger bodies get 413 and never reach it. */
	maxBodyBytes: number;
	/** Must be 127.0.0.1 (the default). Any other address is refused. */
	hostname?: string;
}

/** Verified peer of a request. `uriSans` is filled only after the handshake verified the chain. */
export interface MtlsPeer {
	ip: string;
	uriSans: string[];
}

export type MtlsHandler = (req: Request, peer: MtlsPeer) => Promise<Response>;

export interface MtlsServer {
	port: number;
	stop(): Promise<void>;
}

/** URI SAN values of the verified peer certificate on `socket`, without the `URI:` label. */
export function uriSansFromSocket(socket: TLSSocket): string[] {
	const san = socket.getPeerCertificate(true).subjectaltname;
	if (typeof san !== "string" || san.length === 0) return [];
	const uris: string[] = [];
	for (const entry of san.split(SAN_SEPARATOR)) {
		if (entry.startsWith(URI_SAN_LABEL)) uris.push(entry.slice(URI_SAN_LABEL.length));
	}
	return uris;
}

/** Identity of the verified peer on `socket` in `trustDomain`, via identityFromUriSans. */
export function peerIdentity(socket: TLSSocket, trustDomain: string): IdentityResult {
	return identityFromUriSans(uriSansFromSocket(socket), trustDomain);
}

/** Copies the request into a Web Request with the already-read body. Hop-by-hop headers are dropped. */
function toRequest(req: IncomingMessage, body: Uint8Array): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined || DROPPED_REQUEST_HEADERS[name] === true) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else {
			headers.set(name, value);
		}
	}
	const method = req.method ?? "GET";
	const init: RequestInit = { method, headers };
	if (method !== "GET" && method !== "HEAD" && body.byteLength > 0) init.body = body;
	return new Request(`https://${req.headers.host ?? LOOPBACK}${req.url ?? "/"}`, init);
}

/**
 * Reads the whole body up to `limit` bytes. Returns null as soon as the body is known to exceed it,
 * either from Content-Length or while streaming, so the handler is never given an oversized body.
 */
function readCappedBody(req: IncomingMessage, limit: number): Promise<Uint8Array | null> {
	const declared = req.headers["content-length"];
	if (declared !== undefined && Number(declared) > limit) {
		// Discard the body without buffering it, so the client finishes sending and reads the 413.
		req.resume();
		return Promise.resolve(null);
	}
	const { promise, resolve, reject } = Promise.withResolvers<Uint8Array | null>();
	const chunks: Buffer[] = [];
	let total = 0;
	let settled = false;
	const settle = (value: Uint8Array | null) => {
		if (settled) return;
		settled = true;
		resolve(value);
	};
	req.on("data", (chunk: Buffer) => {
		total += chunk.byteLength;
		if (total > limit) {
			// Over the cap: free what was kept and keep discarding the rest of the stream.
			chunks.length = 0;
			settle(null);
			return;
		}
		if (!settled) chunks.push(chunk);
	});
	req.on("end", () => settle(total > limit ? null : Buffer.concat(chunks, total)));
	req.on("error", (error) => {
		if (settled) return;
		settled = true;
		reject(error);
	});
	return promise;
}

/** Writes a Web Response to the Node response, streaming its body and honouring backpressure. */
async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
	response.headers.forEach((value, name) => {
		if (name !== "set-cookie") res.setHeader(name, value);
	});
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) res.setHeader("set-cookie", cookies);
	res.statusCode = response.status;
	if (response.body === null) {
		res.end();
		return;
	}
	const reader = response.body.getReader();
	for (;;) {
		if (res.destroyed) {
			await reader.cancel();
			return;
		}
		const { done, value } = await reader.read();
		if (done) break;
		if (!res.write(value)) {
			await new Promise<void>((resolve) => {
				res.once("drain", () => resolve());
				res.once("close", () => resolve());
			});
		}
	}
	res.end();
}

async function serveRequest(
	req: IncomingMessage,
	res: ServerResponse,
	maxBodyBytes: number,
	handle: MtlsHandler,
): Promise<void> {
	const socket = req.socket as TLSSocket;
	const body = await readCappedBody(req, maxBodyBytes);
	if (body === null) {
		res.writeHead(413, { connection: "close" });
		res.end();
		return;
	}
	let request: Request;
	try {
		request = toRequest(req, body);
	} catch {
		res.writeHead(400, { connection: "close" });
		res.end();
		return;
	}
	const peer: MtlsPeer = { ip: socket.remoteAddress ?? "", uriSans: uriSansFromSocket(socket) };
	let response: Response;
	try {
		response = await handle(request, peer);
	} catch (error) {
		console.error("mtls handler failed", error);
		res.writeHead(500, { connection: "close" });
		res.end();
		return;
	}
	await writeResponse(res, response);
}

/**
 * Starts the mTLS listener on 127.0.0.1. The TLS layer refuses clients without a certificate from
 * `clientCaFile`, so `handle` runs only for verified peers. `port: 0` binds an ephemeral port.
 */
export function startMtlsServer(options: MtlsServerOptions, handle: MtlsHandler): MtlsServer {
	const hostname = options.hostname ?? LOOPBACK;
	if (hostname !== LOOPBACK) throw new RangeError("mTLS listener binds 127.0.0.1 only");
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
		throw new RangeError("port must be an integer in 0..65535");
	}
	if (!Number.isFinite(options.idleTimeoutSec) || options.idleTimeoutSec <= 0) {
		throw new RangeError("idleTimeoutSec must be a positive number");
	}
	if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 0) {
		throw new RangeError("maxBodyBytes must be a non-negative integer");
	}
	const idleMs = options.idleTimeoutSec * 1000;
	const maxBodyBytes = options.maxBodyBytes;

	const httpServer = http.createServer((req, res) => {
		void serveRequest(req, res, maxBodyBytes, handle);
	});
	const openSockets = new Set<TLSSocket>();
	const tlsServer = tls.createServer(
		{
			cert: readFileSync(options.certFile),
			key: readFileSync(options.keyFile),
			ca: readFileSync(options.clientCaFile),
			requestCert: true,
			rejectUnauthorized: true,
		},
		(socket) => {
			// rejectUnauthorized already refuses unverified peers; this is a second check before HTTP.
			if (!socket.authorized) {
				socket.destroy();
				return;
			}
			openSockets.add(socket);
			socket.once("close", () => openSockets.delete(socket));
			socket.setTimeout(idleMs);
			socket.on("timeout", () => socket.destroy());
			httpServer.emit("connection", socket);
		},
	);
	tlsServer.listen(options.port, LOOPBACK);
	const address = tlsServer.address();
	if (address === null || typeof address === "string") {
		tlsServer.close();
		throw new Error("mTLS listener did not bind a TCP address");
	}

	let stopping: Promise<void> | undefined;
	return {
		port: address.port,
		stop(): Promise<void> {
			stopping ??= new Promise<void>((resolve, reject) => {
				tlsServer.close((error) => (error ? reject(error) : resolve()));
				for (const socket of openSockets) socket.destroy();
			});
			return stopping;
		},
	};
}
