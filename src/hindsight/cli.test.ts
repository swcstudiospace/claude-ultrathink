// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandDeps, runHindsightCommand } from "./cli.ts";
import { DEFAULT_HINDSIGHT_CONFIG, type HindsightConfig } from "./types.ts";

const KEY = "hs-cli-secret-key-0123456789";
const CONFIGURED_BANK = "ultrathink-prod";
const CONFIG: HindsightConfig = { ...DEFAULT_HINDSIGHT_CONFIG, enabled: true, url: "https://hs.example.test", bank: CONFIGURED_BANK };
const SMOKE_BANK = /^ultrathink-smoke-[0-9a-f]{8}$/;

const root = mkdtempSync(join(tmpdir(), "ut-hindsight-cli-"));
const emptyStore = join(root, "mcp-credentials.json");

afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Doc {
	content: string;
	tags: string[];
}

interface Bank {
	mode: string;
	docs: Map<string, Doc>;
}

interface Seen {
	method: string;
	path: string;
	auth?: string;
	body: unknown;
}

/** An in-memory Hindsight: banks with documents, the API-key check on /v1/**, and a recall that matches by substring. */
function server(options: { recall?: "match" | "empty" | "error" } = {}) {
	const banks = new Map<string, Bank>([[CONFIGURED_BANK, { mode: "concise", docs: new Map() }]]);
	const calls: Seen[] = [];
	const retained: { bank: string; mode: string }[] = [];
	const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const headers = init?.headers as Record<string, string>;
		const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path: url.pathname, auth: headers.Authorization, body });
		if (url.pathname === "/health") return reply(200, { status: "healthy", database: "connected" });
		if (url.pathname === "/version") return reply(200, { api_version: "0.9.1", features: { observations: false, worker: false } });
		const match = /^\/v1\/default\/banks\/([^/]+)(\/.*)?$/.exec(url.pathname);
		if (!match) return reply(404, { detail: "no such route" });
		if (headers.Authorization !== `Bearer ${KEY}`) return reply(401, { detail: "Invalid API key" });
		const name = decodeURIComponent(match[1] ?? "");
		const rest = match[2] ?? "";
		const bank = banks.get(name);
		if (rest === "") {
			if (method === "PUT") {
				if (!bank) banks.set(name, { mode: "concise", docs: new Map() });
				return reply(200, { bank_id: name });
			}
			if (method === "DELETE") {
				if (!bank) return reply(404, { detail: "bank not found" });
				banks.delete(name);
				return reply(200, { success: true });
			}
		}
		if (rest === "/config") {
			if (!bank) return reply(404, { detail: "bank not found" });
			if (method === "GET") return reply(200, { bank_id: name, config: { retain_extraction_mode: bank.mode }, overrides: {} });
			if (method === "PATCH") {
				const updates = body as { updates: { retain_extraction_mode: string } };
				bank.mode = updates.updates.retain_extraction_mode;
				return reply(200, { bank_id: name });
			}
		}
		if (rest === "/memories" && method === "POST") {
			const target = bank ?? { mode: "concise", docs: new Map<string, Doc>() };
			banks.set(name, target);
			retained.push({ bank: name, mode: target.mode });
			const sent = body as { items: { document_id: string; content: string; tags: string[] }[] };
			for (const item of sent.items) target.docs.set(item.document_id, { content: item.content, tags: item.tags });
			return reply(200, { success: true, bank_id: name, items_count: sent.items.length, async: false });
		}
		if (rest === "/memories/recall" && method === "POST") {
			if (options.recall === "error") return reply(500, { detail: "recall exploded" });
			const query = (body as { query: string }).query;
			const results =
				options.recall === "empty" || !bank
					? []
					: [...bank.docs.entries()]
							.filter(([, doc]) => doc.content.includes(query))
							.map(([id, doc]) => ({ id: `mem-${id}`, text: doc.content, document_id: id, tags: doc.tags }));
			return reply(200, { results });
		}
		if (rest.startsWith("/documents/") && method === "DELETE") {
			const id = decodeURIComponent(rest.slice("/documents/".length));
			if (!bank?.docs.delete(id)) return reply(404, { detail: "document not found" });
			return reply(200, { success: true, document_id: id, memory_units_deleted: 1 });
		}
		return reply(404, { detail: "no such route" });
	}) as unknown as typeof fetch;
	return { fetch: fetchFn, calls, banks, retained };
}

function deps(fake: { fetch: typeof fetch }, overrides: Partial<CommandDeps> = {}): CommandDeps {
	let clock = 0;
	return {
		cwd: root,
		env: { HINDSIGHT_API_KEY: KEY },
		storePath: emptyStore,
		fetch: fake.fetch,
		config: CONFIG,
		now: () => (clock += 7),
		...overrides,
	};
}

const trace = (fake: { calls: Seen[] }) => fake.calls.map((call) => `${call.method} ${call.path}`);

describe("hindsight check", () => {
	test("ok: health and version without a key, one summary line and a features line", async () => {
		const fake = server();
		const result = await runHindsightCommand(["check"], deps(fake));
		expect(result.code).toBe(0);
		expect(result.text.split("\n")).toEqual([
			"Hindsight check: ok · Hindsight 0.9.1 · database connected · bank ultrathink-prod · 7 ms",
			"Features: observations off · worker off",
		]);
		expect(trace(fake)).toEqual(["GET /health", "GET /version"]);
		expect(fake.calls.every((call) => call.auth === undefined)).toBe(true);
		expect(result.text).not.toContain(KEY);
	});

	test("--json prints one object with the same facts and no key", async () => {
		const result = await runHindsightCommand(["check", "--json"], deps(server()));
		expect(result.code).toBe(0);
		expect(JSON.parse(result.text)).toEqual({
			ok: true,
			state: "ready",
			origin: "https://hs.example.test",
			bank: CONFIGURED_BANK,
			apiVersion: "0.9.1",
			databaseConnected: true,
			features: { observations: false, worker: false },
			ms: 7,
		});
		expect(result.text).not.toContain(KEY);
	});

	test("not ready prints the status-line reason, exits 1 and sends nothing", async () => {
		const cases: [Partial<CommandDeps>, string][] = [
			[{ config: DEFAULT_HINDSIGHT_CONFIG }, "Hindsight check: off (opt-in: set hindsight.enabled)"],
			[{ env: { HINDSIGHT_API_KEY: KEY, ULTRATHINK_HINDSIGHT: "0" } }, "Hindsight check: off (ULTRATHINK_HINDSIGHT=0)"],
			[{ config: { ...CONFIG, url: "" } }, "Hindsight check: on · no URL (set hindsight.url or HINDSIGHT_API_URL)"],
			[{ config: { ...CONFIG, url: "http://example.com" } }, "Hindsight check: on · bad URL (http is allowed only for localhost, *.ts.net and 100.64.0.0/10; use https)"],
			[{ env: {} }, "Hindsight check: on · no key (run bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY)"],
		];
		for (const [override, text] of cases) {
			const fake = server();
			expect(await runHindsightCommand(["check"], deps(fake, override))).toEqual({ code: 1, text });
			expect(fake.calls).toEqual([]);
		}
		const json = await runHindsightCommand(["check", "--json"], deps(server(), { env: {} }));
		expect(json.code).toBe(1);
		expect(JSON.parse(json.text)).toMatchObject({ ok: false, state: "unready" });
	});

	test("a server that answers 401 everywhere is an auth error with the redacted message, exit 1", async () => {
		const denied = (async () => new Response(JSON.stringify({ detail: `bad key ${KEY}` }), { status: 401 })) as unknown as typeof fetch;
		const result = await runHindsightCommand(["check"], deps({ fetch: denied }));
		expect(result.code).toBe(1);
		expect(result.text).toBe("Hindsight check: error (auth) · hindsight auth: HTTP 401: bad key [redacted]");
		expect(result.text).not.toContain(KEY);
	});

	test("a /health failure with a working /version reports the failure, exit 1", async () => {
		const mixed = (async (input: string | URL | Request) =>
			new URL(String(input)).pathname === "/health"
				? new Response("{}", { status: 503 })
				: new Response(JSON.stringify({ api_version: "0.9.1" }))) as unknown as typeof fetch;
		const result = await runHindsightCommand(["check"], deps({ fetch: mixed }));
		expect(result.code).toBe(1);
		expect(result.text).toBe("Hindsight check: error (server) · hindsight server: /health did not report healthy (Hindsight 0.9.1, database not connected)");
	});

	test("an unreachable server is a network error, exit 1", async () => {
		const down = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;
		const result = await runHindsightCommand(["check"], deps({ fetch: down }));
		expect(result).toEqual({ code: 1, text: "Hindsight check: error (network) · hindsight network: connect ECONNREFUSED" });
	});

	test("usage errors exit 2 and send nothing", async () => {
		for (const argv of [[], ["status"], ["check", "--bogus"], ["check", "extra"], ["check", "--json", "--nope"]]) {
			const fake = server();
			const result = await runHindsightCommand(argv, deps(fake));
			expect(result.code).toBe(2);
			expect(result.text).toBe("Usage: ultrathink hindsight check [--roundtrip] [--json]");
			expect(fake.calls).toEqual([]);
		}
	});
});

describe("hindsight check --roundtrip", () => {
	test("proves the authenticated path in a throwaway bank and removes it", async () => {
		const fake = server();
		const result = await runHindsightCommand(["check", "--roundtrip"], deps(fake));
		expect(result.code).toBe(0);
		const lines = result.text.split("\n");
		expect(lines[0]).toMatch(/^Hindsight check: ok · Hindsight 0\.9\.1 · database connected · bank ultrathink-prod · \d+ ms$/);
		const bank = /throwaway bank (\S+)$/.exec(lines[2] ?? "")?.[1] ?? "";
		expect(bank).toMatch(SMOKE_BANK);
		expect(lines[2]).toBe(`Hindsight roundtrip: ok · throwaway bank ${bank}`);
		expect(lines.slice(3).map((line) => line.replace(/\d+ ms/, "N ms"))).toEqual([
			"  ensure bank: ok · N ms",
			"  retain: ok · N ms",
			"  recall: ok · N ms",
			"  delete document: ok · N ms",
			"  delete bank: ok · N ms",
		]);

		const nonce = bank.slice("ultrathink-smoke-".length);
		const prefix = `/v1/default/banks/${bank}`;
		expect(trace(fake)).toEqual([
			"GET /health",
			"GET /version",
			`GET ${prefix}/config`,
			`PUT ${prefix}`,
			`PATCH ${prefix}/config`,
			`POST ${prefix}/memories`,
			`POST ${prefix}/memories/recall`,
			`DELETE ${prefix}/documents/smoke%3A${nonce}`,
			`DELETE ${prefix}`,
		]);
		const retain = fake.calls.find((call) => call.path === `${prefix}/memories`)?.body as { items: { content: string; document_id: string; tags: string[]; update_mode: string }[]; async: boolean };
		expect(retain.async).toBe(false);
		expect(retain.items[0]).toMatchObject({ document_id: `smoke:${nonce}`, tags: ["ultrathink-smoke"], update_mode: "replace" });
		expect(retain.items[0]?.content).toContain(nonce);
		expect(fake.retained).toEqual([{ bank, mode: "chunks" }]);
		expect([...fake.banks.keys()]).toEqual([CONFIGURED_BANK]);
		expect(fake.calls.filter((call) => call.path.startsWith("/v1/")).every((call) => call.auth === `Bearer ${KEY}`)).toBe(true);
		expect(result.text).not.toContain(KEY);
	});

	test("never touches the configured bank", async () => {
		const fake = server();
		await runHindsightCommand(["check", "--roundtrip"], deps(fake));
		expect(fake.calls.filter((call) => call.path.includes(`/banks/${CONFIGURED_BANK}`))).toEqual([]);
		expect(fake.banks.get(CONFIGURED_BANK)).toEqual({ mode: "concise", docs: new Map() });
	});

	test("each run uses its own throwaway bank", async () => {
		const names = new Set<string>();
		for (let i = 0; i < 3; i++) {
			const fake = server();
			await runHindsightCommand(["check", "--roundtrip"], deps(fake));
			for (const call of fake.calls) {
				const name = /\/banks\/(ultrathink-smoke-[0-9a-f]{8})/.exec(call.path)?.[1];
				if (name) names.add(name);
			}
		}
		expect(names.size).toBe(3);
	});

	test("a recall that finds nothing fails the run but still deletes the document and the bank", async () => {
		const fake = server({ recall: "empty" });
		const result = await runHindsightCommand(["check", "--roundtrip"], deps(fake));
		expect(result.code).toBe(1);
		const lines = result.text.split("\n");
		expect(lines[2]).toMatch(/^Hindsight roundtrip: failed · throwaway bank ultrathink-smoke-[0-9a-f]{8}$/);
		expect(lines.find((line) => line.startsWith("  recall"))).toMatch(/^ {2}recall: failed · no hit contains the nonce \(0 hits\) · \d+ ms$/);
		expect(lines.find((line) => line.startsWith("  delete document"))).toMatch(/: ok/);
		expect(lines.find((line) => line.startsWith("  delete bank"))).toMatch(/: ok/);
		expect(trace(fake).slice(-2).map((entry) => entry.split(" ")[0])).toEqual(["DELETE", "DELETE"]);
		expect([...fake.banks.keys()]).toEqual([CONFIGURED_BANK]);
	});

	test("a recall that errors is reported with its kind and the cleanup still runs", async () => {
		const fake = server({ recall: "error" });
		const result = await runHindsightCommand(["check", "--roundtrip"], deps(fake));
		expect(result.code).toBe(1);
		expect(result.text).toContain("  recall: failed (server) · hindsight server: HTTP 500: recall exploded");
		expect([...fake.banks.keys()]).toEqual([CONFIGURED_BANK]);
	});

	test("a rejected key fails at the first authenticated step, skips retain and recall, and still attempts the cleanup", async () => {
		const fake = server();
		const result = await runHindsightCommand(["check", "--roundtrip"], deps(fake, { env: { HINDSIGHT_API_KEY: "some-other-key" } }));
		expect(result.code).toBe(1);
		const lines = result.text.split("\n");
		expect(lines.find((line) => line.startsWith("  ensure bank"))).toMatch(/^ {2}ensure bank: failed \(auth\) · hindsight auth: HTTP 401: Invalid API key · \d+ ms$/);
		expect(lines).toContain("  retain: skipped");
		expect(lines).toContain("  recall: skipped");
		const methods = trace(fake).map((entry) => entry.split(" ")[0]);
		expect(methods.slice(-2)).toEqual(["DELETE", "DELETE"]);
		expect(trace(fake).some((entry) => entry.includes("/memories"))).toBe(false);
		expect(result.text).not.toContain("some-other-key");
		expect(fake.calls.filter((call) => call.path.includes(`/banks/${CONFIGURED_BANK}`))).toEqual([]);
	});

	test("--json adds the roundtrip steps and no key", async () => {
		const result = await runHindsightCommand(["check", "--roundtrip", "--json"], deps(server()));
		expect(result.code).toBe(0);
		const payload = JSON.parse(result.text);
		expect(payload.ok).toBe(true);
		expect(payload.roundtrip.bank).toMatch(SMOKE_BANK);
		expect(payload.roundtrip.ok).toBe(true);
		expect(payload.roundtrip.steps.map((step: { name: string; ok: boolean }) => [step.name, step.ok])).toEqual([
			["ensure bank", true],
			["retain", true],
			["recall", true],
			["delete document", true],
			["delete bank", true],
		]);
		expect(result.text).not.toContain(KEY);
	});

	test("the roundtrip does not start when health is not ok", async () => {
		const down = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;
		const result = await runHindsightCommand(["check", "--roundtrip"], deps({ fetch: down }));
		expect(result.code).toBe(1);
		expect(result.text).not.toContain("roundtrip");
	});
});
