import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationFromJsonl, recentConversationFromTranscript } from "./transcript.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function line(type: string, content: unknown, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ type, message: { role: type, content }, ...extra });
}

describe("conversationFromJsonl", () => {
	test("returns oldest-first User/Assistant text, skipping tool results and meta", () => {
		const jsonl = [
			line("user", "build a login page"),
			line("assistant", [{ type: "text", text: "Sure, using the existing form kit." }]),
			line("user", [{ type: "tool_result", tool_use_id: "x", content: "ok" }]),
			line("user", "ignored meta", { isMeta: true }),
			JSON.stringify({ type: "summary", summary: "irrelevant" }),
			"not json",
			line("user", "add remember-me"),
		].join("\n");
		expect(conversationFromJsonl(jsonl)).toBe(
			"User: build a login page\n\nAssistant: Sure, using the existing form kit.\n\nUser: add remember-me",
		);
	});

	test("skips injected uplift blocks and system reminders", () => {
		const jsonl = [
			line("user", "<BUILD_PROMPT><ORIGINAL>x</ORIGINAL></BUILD_PROMPT>"),
			line("user", "<system-reminder>noise</system-reminder>"),
			line("user", "real question"),
		].join("\n");
		expect(conversationFromJsonl(jsonl)).toBe("User: real question");
	});

	test("clips long messages and honours maxChars from the tail", () => {
		const long = "a".repeat(700);
		const out = conversationFromJsonl(line("user", long), 100);
		expect(out.length).toBe(100);
		expect(out.endsWith("…")).toBe(true);
	});

	test("empty input yields empty string", () => {
		expect(conversationFromJsonl("")).toBe("");
	});
});

describe("recentConversationFromTranscript", () => {
	test("reads a file and is fail-open on missing path", () => {
		const dir = mkdtempSync(join(tmpdir(), "aio-transcript-"));
		dirs.push(dir);
		const path = join(dir, "t.jsonl");
		writeFileSync(path, `${line("user", "hello")}\n`);
		expect(recentConversationFromTranscript(path)).toBe("User: hello");
		expect(recentConversationFromTranscript(join(dir, "missing.jsonl"))).toBe("");
		expect(recentConversationFromTranscript(undefined)).toBe("");
	});
});
