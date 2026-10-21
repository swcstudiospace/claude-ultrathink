// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, describe, expect, test } from "bun:test";
import { createSyslogTransport, encodeSyslogFrame } from "./syslog.ts";
import type { SinkEnvelope } from "./types.ts";

interface Listener {
	readonly port: number;
	opens: number;
	waitForBytes(count: number): Promise<void>;
	received(): Uint8Array;
	stop(): void;
}

const stops: Array<() => void> = [];

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

function envelope(seq: number, kind: SinkEnvelope["kind"] = "audit", body: Record<string, unknown> = {}): SinkEnvelope {
	return { kind, at: "2026-01-01T00:00:00.000Z", body: { seq, ...body } };
}

function startListener(port: number): Listener {
	const chunks: Uint8Array[] = [];
	let total = 0;
	let waiters: Array<{ count: number; resolve: () => void }> = [];
	const server = Bun.listen<null>({
		hostname: "127.0.0.1",
		port,
		socket: {
			open() {
				listener.opens += 1;
			},
			data(_socket, data) {
				chunks.push(new Uint8Array(data));
				total += data.byteLength;
				for (const waiter of waiters) if (total >= waiter.count) waiter.resolve();
				waiters = waiters.filter((waiter) => total < waiter.count);
			},
		},
	});
	const listener: Listener = {
		port: server.port,
		opens: 0,
		waitForBytes(count) {
			if (total >= count) return Promise.resolve();
			return new Promise<void>((resolve) => waiters.push({ count, resolve }));
		},
		received() {
			const out = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				out.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return out;
		},
		stop() {
			server.stop(true);
		},
	};
	stops.push(() => listener.stop());
	return listener;
}

function freePort(): number {
	const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const port = probe.port;
	probe.stop(true);
	return port;
}

interface ParsedFrame {
	readonly pri: number;
	readonly timestamp: string;
	readonly hostname: string;
	readonly appName: string;
	readonly body: unknown;
}

/** Splits an RFC 6587 octet-counted stream into messages, failing loudly on any framing error. */
function parseFrames(bytes: Uint8Array): string[] {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const messages: string[] = [];
	let offset = 0;
	while (offset < bytes.byteLength) {
		const space = bytes.indexOf(0x20, offset);
		if (space < 0) throw new Error("octet-count delimiter missing");
		const digits = decoder.decode(bytes.subarray(offset, space));
		if (!/^[1-9]\d*$/.test(digits)) throw new Error(`invalid octet count: ${digits}`);
		const end = space + 1 + Number(digits);
		if (end > bytes.byteLength) throw new Error("frame extends past the received bytes");
		messages.push(decoder.decode(bytes.subarray(space + 1, end)));
		offset = end;
	}
	return messages;
}

function parseMessage(message: string): ParsedFrame {
	const match = /^<(\d+)>1 (\S+) (\S+) (\S+) - - - (.*)$/s.exec(message);
	if (match === null) throw new Error(`not an RFC 5424 message: ${message}`);
	return {
		pri: Number(match[1]),
		timestamp: match[2] ?? "",
		hostname: match[3] ?? "",
		appName: match[4] ?? "",
		body: JSON.parse(match[5] ?? ""),
	};
}

function frameLength(env: SinkEnvelope): number {
	return encodeSyslogFrame(env, "host.test", "ultrathink").byteLength;
}

describe("encodeSyslogFrame", () => {
	test("the octet count is the UTF-8 byte length, not the character length", () => {
		const env = envelope(1, "audit", { note: "café 🎉 é" });
		const frame = encodeSyslogFrame(env, "host.test", "ultrathink");
		const space = frame.indexOf(0x20);
		const declared = Number(new TextDecoder().decode(frame.subarray(0, space)));
		const message = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(space + 1));

		expect(declared).toBe(frame.byteLength - space - 1);
		expect(declared).toBe(Buffer.byteLength(message, "utf8"));
		expect(declared).toBeGreaterThan(message.length);
	});

	test("the severity maps audit to 134, security to 132 and alert to 130", () => {
		const pri = (kind: SinkEnvelope["kind"]): number =>
			parseMessage(parseFrames(encodeSyslogFrame(envelope(1, kind), "host.test", "ultrathink"))[0] ?? "").pri;

		expect(pri("audit")).toBe(134);
		expect(pri("security")).toBe(132);
		expect(pri("alert")).toBe(130);
	});

	test("the JSON after the header parses back to the same envelope", () => {
		const env = envelope(9, "security", { ip: "203.0.113.7", tags: ["a", "b"], quote: 'say "hi"\\' });
		const [message] = parseFrames(encodeSyslogFrame(env, "host.test", "ultrathink"));
		const parsed = parseMessage(message ?? "");

		expect(parsed.body).toEqual(env);
		expect(parsed.hostname).toBe("host.test");
		expect(parsed.appName).toBe("ultrathink");
		expect(parsed.timestamp).toBe("2026-01-01T00:00:00.000Z");
	});

	test("a timestamp that is not RFC 3339 is written as the NILVALUE", () => {
		const env: SinkEnvelope = { kind: "alert", at: "yesterday", body: {} };
		const [message] = parseFrames(encodeSyslogFrame(env, "host.test", "ultrathink"));

		expect(parseMessage(message ?? "").timestamp).toBe("-");
	});

	test("a hostname or app name with spaces or excess length is rejected", () => {
		const env = envelope(1);
		expect(() => encodeSyslogFrame(env, "bad host", "ultrathink")).toThrow(RangeError);
		expect(() => encodeSyslogFrame(env, "host.test", "x".repeat(49))).toThrow(RangeError);
	});
});

describe("createSyslogTransport", () => {
	test("a batch is delivered in order over one connection and parses back to the envelopes", async () => {
		const listener = startListener(0);
		const transport = createSyslogTransport({
			host: "127.0.0.1",
			port: listener.port,
			hostname: "host.test",
			appName: "ultrathink",
		});
		const batch = [envelope(1), envelope(2, "alert", { note: "é 🎉" }), envelope(3, "security")];
		const expected = batch.reduce((sum, env) => sum + frameLength(env), 0);

		expect(await transport.send(batch.slice(0, 2), new AbortController().signal)).toEqual({ ok: true });
		expect(await transport.send(batch.slice(2), new AbortController().signal)).toEqual({ ok: true });
		await listener.waitForBytes(expected);

		const messages = parseFrames(listener.received()).map(parseMessage);
		expect(messages.map((msg) => msg.body)).toEqual(batch);
		expect(messages.map((msg) => msg.pri)).toEqual([134, 130, 132]);
		expect(listener.opens).toBe(1);
	});

	test("a closed port is retryable, and the next send succeeds once a listener is up", async () => {
		const port = freePort();
		const transport = createSyslogTransport({ host: "127.0.0.1", port, hostname: "host.test", appName: "ultrathink" });
		const env = envelope(5, "alert");

		const first = await transport.send([env], new AbortController().signal);
		expect(first.ok).toBe(false);
		if (first.ok) throw new Error("closed port reported ok");
		expect(first.retryable).toBe(true);
		expect(first.reason).toMatch(/^network error: /);

		const listener = startListener(port);
		expect(await transport.send([env], new AbortController().signal)).toEqual({ ok: true });
		await listener.waitForBytes(frameLength(env));
		expect(parseFrames(listener.received()).map(parseMessage).map((msg) => msg.body)).toEqual([env]);
	});

	test("an already-aborted signal is retryable and opens no connection", async () => {
		const listener = startListener(0);
		const transport = createSyslogTransport({
			host: "127.0.0.1",
			port: listener.port,
			hostname: "host.test",
			appName: "ultrathink",
		});
		const controller = new AbortController();
		controller.abort();

		expect(await transport.send([envelope(1)], controller.signal)).toEqual({
			ok: false,
			retryable: true,
			reason: "aborted",
		});
		expect(listener.opens).toBe(0);
	});

	test("an empty batch is ok and sends nothing", async () => {
		const listener = startListener(0);
		const transport = createSyslogTransport({
			host: "127.0.0.1",
			port: listener.port,
			hostname: "host.test",
			appName: "ultrathink",
		});

		expect(await transport.send([], new AbortController().signal)).toEqual({ ok: true });
		expect(listener.opens).toBe(0);
	});

	test("invalid host, port, hostname or app name are rejected at construction", () => {
		const base = { host: "127.0.0.1", port: 514, hostname: "host.test", appName: "ultrathink" };
		expect(() => createSyslogTransport({ ...base, host: "" })).toThrow(TypeError);
		expect(() => createSyslogTransport({ ...base, port: 0 })).toThrow(RangeError);
		expect(() => createSyslogTransport({ ...base, port: 65536 })).toThrow(RangeError);
		expect(() => createSyslogTransport({ ...base, port: 1.5 })).toThrow(RangeError);
		expect(() => createSyslogTransport({ ...base, hostname: "bad host" })).toThrow(RangeError);
		expect(() => createSyslogTransport({ ...base, appName: "x".repeat(49) })).toThrow(RangeError);
	});
});
