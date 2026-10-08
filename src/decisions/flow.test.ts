// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFlowScore, evaluateFlowOutput, FLOW_OUTPUT_MAX, isGsdFlowCommand, lookupFlowScore } from "./flow.ts";

const usage = { input_tokens: 3, output_tokens: 2 };
function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function ok(choice: string, confidence?: number, id = "req_1") {
	return json({ id, model: "~typesafe/jev-latest", answers: { verdict: { type: "choice", choice, ...(confidence === undefined ? {} : { confidence }) } }, usage });
}

describe("evaluateFlowOutput", () => {
	test("a choice with in-range confidence is success on OpenRouter", async () => {
		const record = await evaluateFlowOutput({
			subject: "phase:discuss",
			output: "CONTEXT.md written",
			apiKey: "sk-test",
			fetch: (async () => ok("approve", 0.82)) as unknown as typeof fetch,
		});
		expect(record.state).toBe("success");
		expect(record.decision).toBe("approve");
		expect(record.confidence).toBe(0.82);
		expect(record.provider).toBe("OpenRouter");
		expect(record.requestId).toBe("req_1");
		expect(record.clearsHumanPause).toBe(false);
	});

	test("missing confidence fails after one repair", async () => {
		let calls = 0;
		const record = await evaluateFlowOutput({
			subject: "phase:plan",
			output: "plan body",
			apiKey: "sk-test",
			fetch: (async () => {
				calls += 1;
				return ok("approve");
			}) as unknown as typeof fetch,
		});
		expect(calls).toBe(2);
		expect(record.state).toBe("error");
		expect(record.errorClass).toBe("invalid-response");
		expect(record.confidence).toBeNull();
	});

	test("out-of-range confidence fails after repair", async () => {
		const record = await evaluateFlowOutput({
			subject: "phase:execute",
			output: "done",
			apiKey: "sk-test",
			fetch: (async () => ok("approve", 1.4)) as unknown as typeof fetch,
		});
		expect(record.state).toBe("error");
		expect(record.confidence).toBeNull();
	});

	test("401 is terminal auth and does not invent a score", async () => {
		let calls = 0;
		const record = await evaluateFlowOutput({
			subject: "audit",
			output: "audit text",
			apiKey: "sk-test",
			fetch: (async () => {
				calls += 1;
				return json({ error: { message: "unauthorized" } }, 401);
			}) as unknown as typeof fetch,
		});
		expect(calls).toBe(1);
		expect(record.state).toBe("error");
		expect(record.errorClass).toBe("auth");
		expect(record.confidence).toBeNull();
	});

	test("empty output is an explicit skip", async () => {
		const record = await evaluateFlowOutput({ subject: "cleanup", output: "  \n", apiKey: "sk-test", fetch: (async () => { throw new Error("no"); }) as unknown as typeof fetch });
		expect(record.state).toBe("empty");
		expect(record.confidence).toBeNull();
	});

	test("oversized output is not scored", async () => {
		const record = await evaluateFlowOutput({ subject: "summary", output: "x".repeat(FLOW_OUTPUT_MAX + 1), apiKey: "sk-test", fetch: (async () => ok("approve", 1)) as unknown as typeof fetch });
		expect(record.state).toBe("error");
		expect(record.errorClass).toBe("truncated");
		expect(record.confidence).toBeNull();
	});

	test("identical success bytes are reused", () => {
		const dir = mkdtempSync(join(tmpdir(), "flow-"));
		const path = join(dir, "flow-decisions.jsonl");
		const record = { version: 1 as const, subject: "s", hash: "abc", decision: "approve" as const, confidence: 0.5, rationale: "choice.confidence", model: "m", provider: "OpenRouter" as const, state: "success" as const, retryCount: 0, at: 1, latencyMs: 1, clearsHumanPause: false as const };
		appendFlowScore(path, record);
		expect(lookupFlowScore(path, "abc")?.confidence).toBe(0.5);
		expect(lookupFlowScore(path, "nope")).toBeUndefined();
	});
});

describe("isGsdFlowCommand", () => {
	test("matches gsd skill and phase commands and skips unrelated tools", () => {
		expect(isGsdFlowCommand("Skill", "gsd-discuss-phase 15")).toBe(true);
		expect(isGsdFlowCommand("Bash", "echo hi && gsd-audit-milestone")).toBe(true);
		expect(isGsdFlowCommand("Bash", "bun test")).toBe(false);
		expect(isGsdFlowCommand("Read", "src/decisions/flow.ts")).toBe(false);
	});
});
