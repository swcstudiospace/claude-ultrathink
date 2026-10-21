// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// RFC 5424 syslog over TCP with RFC 6587 octet-counting framing (AUDIT-02). One connection is kept
// and reopened on demand. A send is ok once its frames are handed to the socket; the transport does
// not wait for a server acknowledgement, because syslog over TCP has none.

import type { Socket } from "bun";
import { networkFailure } from "./http.ts";
import type { SendResult, SinkEnvelope, SinkKind, SinkTransport } from "./types.ts";

export interface SyslogTransportOptions {
	readonly host: string;
	readonly port: number;
	readonly hostname: string;
	readonly appName: string;
}

interface Link {
	alive: boolean;
}

// local0 facility. audit is info (134), security is warning (132), alert is critical (130).
const PRI: Readonly<Record<SinkKind, number>> = { audit: 134, security: 132, alert: 130 };
const HOSTNAME_PATTERN = /^[\x21-\x7e]{1,255}$/;
const APP_NAME_PATTERN = /^[\x21-\x7e]{1,48}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const NIL = "-";
const encoder = new TextEncoder();

function assertHeaderField(value: string, pattern: RegExp, label: string): void {
	if (!pattern.test(value)) {
		throw new RangeError(`${label} must be printable ASCII without spaces, within RFC 5424 length limits`);
	}
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

/**
 * One RFC 5424 message wrapped in an RFC 6587 octet-counting frame: `<byteLength> <message>`.
 * The length counts UTF-8 bytes, not characters. The message body is the envelope as JSON.
 */
export function encodeSyslogFrame(env: SinkEnvelope, hostname: string, appName: string): Uint8Array {
	assertHeaderField(hostname, HOSTNAME_PATTERN, "hostname");
	assertHeaderField(appName, APP_NAME_PATTERN, "appName");
	const timestamp = RFC3339_PATTERN.test(env.at) ? env.at : NIL;
	const message = encoder.encode(
		`<${PRI[env.kind]}>1 ${timestamp} ${hostname} ${appName} ${NIL} ${NIL} ${NIL} ${JSON.stringify(env)}`,
	);
	const prefix = encoder.encode(`${message.byteLength} `);
	return concatBytes([prefix, message]);
}

/** Opens a TCP connection. An abort rejects at once; a connection that completes after the abort is closed. */
function connectLink(host: string, port: number, signal: AbortSignal): Promise<Socket<Link>> {
	return new Promise<Socket<Link>>((resolve, reject) => {
		let settled = false;
		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			reject(new DOMException("syslog connect aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		Bun.connect<Link>({
			hostname: host,
			port,
			data: { alive: true },
			socket: {
				// Syslog receivers do not reply, so inbound bytes are ignored. Bun requires a data callback.
				data() {},
				close(socket) {
					socket.data.alive = false;
				},
				error(socket) {
					socket.data.alive = false;
				},
			},
		}).then(
			(socket) => {
				signal.removeEventListener("abort", onAbort);
				if (settled) {
					socket.end();
					return;
				}
				settled = true;
				resolve(socket);
			},
			(err: unknown) => {
				signal.removeEventListener("abort", onAbort);
				if (settled) return;
				settled = true;
				reject(err);
			},
		);
	});
}

export function createSyslogTransport(opts: SyslogTransportOptions): SinkTransport {
	if (opts.host.length === 0) throw new TypeError("host must not be empty");
	if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
		throw new RangeError("port must be an integer from 1 to 65535");
	}
	assertHeaderField(opts.hostname, HOSTNAME_PATTERN, "hostname");
	assertHeaderField(opts.appName, APP_NAME_PATTERN, "appName");
	const { host, port, hostname, appName } = opts;
	let live: Socket<Link> | undefined;

	function dropLink(): void {
		live?.end();
		live = undefined;
	}

	async function socketFor(signal: AbortSignal): Promise<Socket<Link>> {
		if (live?.data.alive) return live;
		const fresh = await connectLink(host, port, signal);
		// A concurrent send may have reconnected while this one was connecting; keep that link.
		if (live?.data.alive) {
			fresh.end();
			return live;
		}
		dropLink();
		live = fresh;
		return fresh;
	}

	return {
		name: "syslog",
		async send(batch: readonly SinkEnvelope[], signal: AbortSignal): Promise<SendResult> {
			if (batch.length === 0) return { ok: true };
			if (signal.aborted) return { ok: false, retryable: true, reason: "aborted" };
			let payload: Uint8Array;
			try {
				payload = concatBytes(batch.map((env) => encodeSyslogFrame(env, hostname, appName)));
			} catch {
				return { ok: false, retryable: false, reason: "encode failed" };
			}
			let socket: Socket<Link>;
			try {
				socket = await socketFor(signal);
			} catch (err) {
				return networkFailure(err, signal);
			}
			try {
				const written = socket.write(payload);
				if (written < 0 || !socket.data.alive) {
					dropLink();
					return { ok: false, retryable: true, reason: "network error: write" };
				}
			} catch (err) {
				dropLink();
				return networkFailure(err, signal);
			}
			return { ok: true };
		},
	};
}
