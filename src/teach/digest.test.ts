// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestFromAgentMessages, digestFromClaudeTranscript, parseDigest } from "./digest.ts";
import { DIGEST_MAX_CHARS, DIGEST_MAX_TURNS, DIGEST_TURN_CHARS } from "./types.ts";

const META = { host: "claude-code", sessionId: "s1", cwd: "/work/repo", now: () => Date.parse("2026-10-02T10:00:00Z") };

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		host: "omp",
		sessionId: "s1",
		cwd: "/work/repo",
		at: "2026-10-02T09:00:00Z",
		turns: [
			{ role: "user", text: "fix it" },
			{ role: "assistant", text: "ok" },
		],
		toolCalls: 2,
		...overrides,
	};
}

describe("parseDigest", () => {
	test("accepts a well-formed digest and normalizes the timestamp", () => {
		const digest = parseDigest(valid({ outcome: "failed" }));
		expect(digest?.host).toBe("omp");
		expect(digest?.at).toBe("2026-10-02T09:00:00.000Z");
		expect(digest?.outcome).toBe("failed");
		expect(digest?.turns).toHaveLength(2);
	});

	test("an unparseable or missing `at` becomes the current time", () => {
		const before = Date.now();
		for (const at of ["yesterday-ish", undefined, 42]) {
			const digest = parseDigest(valid({ at }));
			expect(Date.parse(digest?.at ?? "")).toBeGreaterThanOrEqual(before);
		}
	});

	test.each([
		["not an object", "text"],
		["an array", []],
		["null", null],
		["empty host", valid({ host: "  " })],
		["missing sessionId", valid({ sessionId: undefined })],
		["non-string cwd", valid({ cwd: 3 })],
		["turns not an array", valid({ turns: "x" })],
		["unknown role", valid({ turns: [{ role: "system", text: "x" }] })],
		["non-string turn text", valid({ turns: [{ role: "user", text: 5 }] })],
		["non-object turn", valid({ turns: ["x"] })],
		["fractional toolCalls", valid({ toolCalls: 1.5 })],
		["negative toolCalls", valid({ toolCalls: -1 })],
		["string toolCalls", valid({ toolCalls: "2" })],
		["unknown outcome", valid({ outcome: "exploded" })],
	])("rejects %s", (_name, raw) => {
		expect(parseDigest(raw)).toBeUndefined();
	});

	test("keeps only the newest turns and clips each one", () => {
		const turns = Array.from({ length: DIGEST_MAX_TURNS + 20 }, (_v, i) => ({ role: "user", text: `turn-${i}` }));
		const digest = parseDigest(valid({ turns }));
		expect(digest?.turns).toHaveLength(DIGEST_MAX_TURNS);
		expect(digest?.turns[0]?.text).toBe("turn-20");
		expect(digest?.turns.at(-1)?.text).toBe(`turn-${DIGEST_MAX_TURNS + 19}`);

		const long = parseDigest(valid({ turns: [{ role: "user", text: "x".repeat(DIGEST_TURN_CHARS * 3) }] }));
		expect(long?.turns[0]?.text.length).toBe(DIGEST_TURN_CHARS);
	});

	test("the total size stays within the character budget, dropping the oldest turns first", () => {
		const turns = Array.from({ length: 40 }, (_v, i) => ({ role: "assistant", text: `${i}`.padEnd(DIGEST_TURN_CHARS, "y") }));
		const digest = parseDigest(valid({ turns }));
		const total = digest?.turns.reduce((sum, turn) => sum + turn.text.length, 0) ?? 0;
		expect(total).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
		expect(digest?.turns.at(-1)?.text.startsWith("39")).toBe(true);
		expect(digest?.turns.length).toBeLessThan(40);
	});

	test("keeps tool name and error flag, and drops other fields", () => {
		const digest = parseDigest(valid({ extra: "x", turns: [{ role: "tool", text: "boom", tool: "Bash", isError: true, secret: "s" }] }));
		expect(digest?.turns[0]).toEqual({ role: "tool", text: "boom", tool: "Bash", isError: true });
		expect(digest).not.toHaveProperty("extra");
	});
});

describe("digestFromClaudeTranscript", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "teach-digest-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
	const assistant = (content: unknown) => ({ type: "assistant", message: { role: "assistant", content } });
	function write(entries: unknown[], name = "t.jsonl"): string {
		const path = join(dir, name);
		writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		return path;
	}

	test("reduces text, tool calls and tool results; an error then a success is visible", () => {
		const path = write([
			user("make the tests pass"),
			assistant([
				{ type: "text", text: "Running the suite." },
				{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun   test\n--bail", description: "ignored" } },
			]),
			user([{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "error: cannot find module" }]),
			assistant([{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/a.ts", old_string: "x" } }]),
			user([{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "edited" }] }]),
			assistant([{ type: "text", text: "Done." }]),
		]);
		const digest = digestFromClaudeTranscript(path, META);
		expect(digest).toMatchObject({ host: "claude-code", sessionId: "s1", cwd: "/work/repo", at: "2026-10-02T10:00:00.000Z", toolCalls: 2 });
		expect(digest?.outcome).toBeUndefined();
		expect(digest?.turns).toEqual([
			{ role: "user", text: "make the tests pass" },
			{ role: "assistant", text: "Running the suite." },
			{ role: "assistant", tool: "Bash", text: "Bash: bun test --bail" },
			{ role: "tool", tool: "Bash", text: "error: cannot find module", isError: true },
			{ role: "assistant", tool: "Edit", text: "Edit: src/a.ts" },
			{ role: "tool", tool: "Edit", text: "edited" },
			{ role: "assistant", text: "Done." },
		]);
	});

	test("skips meta entries, injected context, unknown entry types and bad lines", () => {
		const path = write([
			user("<system-reminder>be careful</system-reminder>"),
			user("meta caveat", { isMeta: true }),
			{ type: "summary", summary: "x" },
			user("<local-command-stdout>ok</local-command-stdout>"),
			user("real prompt"),
			assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }]),
		]);
		writeFileSync(path, `not json\n${JSON.stringify(user("later prompt"))}\n`, { flag: "a" });
		const digest = digestFromClaudeTranscript(path, META);
		expect(digest?.turns.map((t) => t.text)).toEqual(["real prompt", "answer", "later prompt"]);
	});

	test("an interrupt marker sets the outcome unless the host states one", () => {
		const entries = [user("go"), assistant([{ type: "text", text: "working" }]), user([{ type: "text", text: "[Request interrupted by user]" }])];
		expect(digestFromClaudeTranscript(write(entries), META)?.outcome).toBe("interrupted");
		expect(digestFromClaudeTranscript(write(entries, "b.jsonl"), { ...META, outcome: "completed" })?.outcome).toBe("completed");
		expect(digestFromClaudeTranscript(write(entries, "c.jsonl"), META)?.turns.map((t) => t.text)).toEqual(["go", "working"]);
	});

	test("undefined for a missing file, an empty file, and conversations lacking either side", () => {
		expect(digestFromClaudeTranscript(join(dir, "missing.jsonl"), META)).toBeUndefined();
		writeFileSync(join(dir, "empty.jsonl"), "");
		expect(digestFromClaudeTranscript(join(dir, "empty.jsonl"), META)).toBeUndefined();
		expect(digestFromClaudeTranscript(write([user("only me")], "u.jsonl"), META)).toBeUndefined();
		expect(digestFromClaudeTranscript(write([assistant([{ type: "text", text: "only me" }])], "a.jsonl"), META)).toBeUndefined();
	});

	test("reads only the tail of a large transcript", () => {
		const path = write([
			user("EARLY prompt"),
			assistant([{ type: "text", text: "EARLY answer" }]),
			user("x".repeat(700 * 1024)),
			user("recent prompt"),
			assistant([{ type: "text", text: "recent answer" }]),
		]);
		const digest = digestFromClaudeTranscript(path, META);
		expect(digest?.turns.map((t) => t.text)).toEqual(["recent prompt", "recent answer"]);
	});

	test("clips long tool summaries and turn text to the digest caps", () => {
		const path = write([
			user("y".repeat(DIGEST_TURN_CHARS * 2)),
			assistant([{ type: "tool_use", id: "t", name: "Bash", input: { command: "z".repeat(1000) } }]),
		]);
		const digest = digestFromClaudeTranscript(path, META);
		expect(digest?.turns[0]?.text.length).toBe(DIGEST_TURN_CHARS);
		expect(digest?.turns[1]?.text.length).toBeLessThan(300);
	});
});

describe("digestFromAgentMessages", () => {
	test("reduces user, assistant (text + toolCall) and toolResult messages", () => {
		const digest = digestFromAgentMessages(
			[
				{ role: "user", content: "deploy it" },
				{ role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "Checking." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" },
				{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "permission denied" }], isError: true },
				{ role: "assistant", content: [{ type: "text", text: "Retrying." }, { type: "toolCall", id: "c2", name: "bash", arguments: { command: "sudo ls" } }], stopReason: "toolUse" },
				{ role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false },
				{ role: "assistant", content: [{ type: "text", text: "Deployed." }], stopReason: "stop" },
			],
			META,
		);
		expect(digest?.toolCalls).toBe(2);
		expect(digest?.outcome).toBeUndefined();
		expect(digest?.turns).toEqual([
			{ role: "user", text: "deploy it" },
			{ role: "assistant", text: "Checking." },
			{ role: "assistant", tool: "bash", text: "bash: ls" },
			{ role: "tool", tool: "bash", text: "permission denied", isError: true },
			{ role: "assistant", text: "Retrying." },
			{ role: "assistant", tool: "bash", text: "bash: sudo ls" },
			{ role: "tool", tool: "bash", text: "ok" },
			{ role: "assistant", text: "Deployed." },
		]);
	});

	test("an aborted final assistant message means interrupted; an error means failed; the host can override", () => {
		const base = [{ role: "user", content: "go" }];
		const aborted = [...base, { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" }];
		const errored = [...base, { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error" }];
		expect(digestFromAgentMessages(aborted, META)?.outcome).toBe("interrupted");
		expect(digestFromAgentMessages(errored, META)?.outcome).toBe("failed");
		expect(digestFromAgentMessages(aborted, { ...META, outcome: "completed" })?.outcome).toBe("completed");
	});

	test("skips unknown shapes, synthetic and developer messages; undefined when a side is missing", () => {
		const digest = digestFromAgentMessages(
			[null, 7, "x", { role: "developer", content: "rules" }, { role: "user", content: "auto-continue", synthetic: true }, { role: "mystery" }, { role: "user", content: [{ type: "image" }, { type: "text", text: "hi" }] }, { role: "assistant", content: "plain string reply" }],
			META,
		);
		expect(digest?.turns.map((t) => t.text)).toEqual(["hi", "plain string reply"]);
		expect(digestFromAgentMessages([{ role: "user", content: "x" }], META)).toBeUndefined();
		expect(digestFromAgentMessages([], META)).toBeUndefined();
	});
});
