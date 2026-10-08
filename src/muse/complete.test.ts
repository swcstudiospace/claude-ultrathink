// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_ENV } from "../claude/complete.ts";
import { CHILD_PROMPT_SENTINEL, planningTarget } from "../uplift/skill.ts";
import { ROUTE_DEFAULT_MODELS } from "../route-defaults.ts";
import { buildMuseArgs, buildMusePrompt, museComplete, parseMuseJsonl } from "./complete.ts";
import { DEFAULT_MUSE_CONFIG, MUSE_MODEL_DEFAULT } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function terminalLine(text: string, terminal = "completed", reason: string | null = null): string {
	return JSON.stringify({ payload_type: "run.terminal.completed", payload: { terminal, reason, text } });
}

function noiseLine(): string {
	return JSON.stringify({ payload_type: "task.lifecycle.started", payload: { kind: "started" } });
}

describe("buildMuseArgs", () => {
	test("neuters tools, asks for json, passes model/effort/prompt file", () => {
		expect(buildMuseArgs("/tmp/p.txt", { model: "muse-spark-1.3-contributor", reasoningEffort: "low" })).toEqual([
			"exec",
			"--json",
			"--disable-shell",
			"--disable-write",
			"--disable-web-tools",
			"--max-model-steps",
			"1",
			"--model",
			"muse-spark-1.3-contributor",
			"--reasoning-effort",
			"low",
			"--prompt-file",
			"/tmp/p.txt",
		]);
	});

	test("the unpinned default sends the Muse route default from the central map (muse-spark-1.3-contributor)", () => {
		expect(MUSE_MODEL_DEFAULT).toBe(ROUTE_DEFAULT_MODELS.muse);
		const args = buildMuseArgs("/tmp/p.txt", { model: DEFAULT_MUSE_CONFIG.model, reasoningEffort: DEFAULT_MUSE_CONFIG.reasoningEffort });
		expect(args[args.indexOf("--model") + 1]).toBe(ROUTE_DEFAULT_MODELS.muse);
		expect(args[args.indexOf("--model") + 1]).toBe("muse-spark-1.3-contributor");
	});

	test("blank model omits --model (CLI session default answers)", () => {
		for (const model of [undefined, "", "   "]) {
			const args = buildMuseArgs("/tmp/p.txt", { model });
			expect(args).not.toContain("--model");
			expect(args).toContain("--reasoning-effort");
		}
	});

	test("echo provider omits model/effort (the echo provider rejects both)", () => {
		const args = buildMuseArgs("/tmp/p.txt", { provider: "echo", model: "muse-spark-1.3-contributor", reasoningEffort: "low" });
		expect(args).toContain("--provider");
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--reasoning-effort");
	});
});

describe("buildMusePrompt", () => {
	test("system block above the user payload", () => {
		expect(buildMusePrompt("SYS", "USER")).toBe(
			`${CHILD_PROMPT_SENTINEL}\n<system>\nSYS\n</system>\n\n<user_request>\nUSER\n</user_request>`,
		);
	});
	test("the nesting sentinel rides first so nested hooks skip without the child env", () => {
		expect(buildMusePrompt("SYS", "USER").startsWith(`${CHILD_PROMPT_SENTINEL}\n`)).toBe(true);
	});
	test("a built child prompt plans to a nested-child skip", () => {
		expect(planningTarget(buildMusePrompt("SYS", "USER"), { cwd: "/nonexistent" })).toEqual({ skip: "nested-child" });
	});
});

describe("parseMuseJsonl", () => {
	test("returns the last terminal text", () => {
		const stdout = [noiseLine(), terminalLine("first"), noiseLine(), terminalLine("<X/>")].join("\n");
		expect(parseMuseJsonl(stdout, "", 0)).toBe("<X/>");
	});

	test("failed terminal throws with the reason", () => {
		const stdout = terminalLine("", "failed", "bad config");
		expect(() => parseMuseJsonl(stdout, "", 1)).toThrow("bad config");
	});

	test("missing terminal throws with the stderr excerpt", () => {
		expect(() => parseMuseJsonl(`${noiseLine()}\n`, "muse: something broke", 1)).toThrow("muse: something broke");
	});

	test("empty output falls back to the exit code", () => {
		expect(() => parseMuseJsonl("", "", 2)).toThrow("muse exited 2");
	});

	test("skips blank and non-JSON lines", () => {
		expect(parseMuseJsonl(`\nnot json\n${terminalLine("ok")}\n{broken`, "", 0)).toBe("ok");
	});

	test("empty text throws", () => {
		expect(() => parseMuseJsonl(terminalLine(""), "", 0)).toThrow("no text");
	});
});

describe("museComplete (fake bin)", () => {
	/** Writes a fake `muse` binary that records argv/prompt/child-env and prints `stdout` lines. */
	function fakeMuse(stdout: string, exitCode = 0): { bin: string; seenPath: string } {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-muse-cli-"));
		dirs.push(dir);
		const bin = join(dir, "muse");
		const seenPath = join(dir, "seen.json");
		writeFileSync(
			bin,
			`#!${process.execPath}\nconst args = process.argv.slice(2);\nconst prompt = await Bun.file(args[args.indexOf("--prompt-file") + 1]).text();\nawait Bun.write(${JSON.stringify(seenPath)}, JSON.stringify({ args, prompt, child: process.env.${CHILD_ENV} }));\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.exit(${exitCode});\n`,
			{ mode: 0o755 },
		);
		return { bin, seenPath };
	}

	async function seen(seenPath: string): Promise<{ args: string[]; prompt: string; child?: string }> {
		return (await Bun.file(seenPath).json()) as { args: string[]; prompt: string; child?: string };
	}

	test("spawns tool-free, sends the system block via prompt file, marks the child", async () => {
		const { bin, seenPath } = fakeMuse(`${noiseLine()}\n${terminalLine("<X/>")}\n`);
		const text = await museComplete("SYS", "USER", { bin, model: "m1", reasoningEffort: "low" });
		expect(text).toBe("<X/>");
		const got = await seen(seenPath);
		expect(got.prompt).toBe(buildMusePrompt("SYS", "USER"));
		expect(got.child).toBe("1");
		expect(got.args.slice(0, 7)).toEqual(["exec", "--json", "--disable-shell", "--disable-write", "--disable-web-tools", "--max-model-steps", "1"]);
		expect(got.args).toContain("--model");
		expect(got.args).toContain("m1");
	});

	test("removes the prompt directory afterwards", async () => {
		const { bin, seenPath } = fakeMuse(`${terminalLine("ok")}\n`);
		await museComplete("SYS", "USER", { bin });
		const got = await seen(seenPath);
		const promptFile = got.args[got.args.indexOf("--prompt-file") + 1] as string;
		expect(promptFile.startsWith(`${tmpdir()}/`)).toBe(true);
		await expect(Bun.file(promptFile).exists()).resolves.toBe(false);
	});

	test("non-zero exit without output throws the exit code", async () => {
		const { bin } = fakeMuse("", 2);
		const error = await museComplete("SYS", "USER", { bin }).then(
			() => new Error("should have thrown"),
			(error: Error) => error,
		);
		expect(error.message).toContain("muse exited 2");
	});

	test("timeout surfaces as a timed-out error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-muse-cli-"));
		dirs.push(dir);
		const bin = join(dir, "muse");
		writeFileSync(bin, `#!${process.execPath}\nawait Bun.sleep(5000);\n`, { mode: 0o755 });
		const error = await museComplete("SYS", "USER", { bin, timeoutMs: 20 }).then(
			() => new Error("should have thrown"),
			(error: Error) => error,
		);
		expect(error.message).toBe("muse timed out after 20ms");
	});

	test("abort rejects with AbortError", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-muse-cli-"));
		dirs.push(dir);
		const bin = join(dir, "muse");
		writeFileSync(bin, `#!${process.execPath}\nawait Bun.sleep(5000);\n`, { mode: 0o755 });
		const controller = new AbortController();
		const pending = museComplete("SYS", "USER", { bin, signal: controller.signal }).then(
			() => "resolved",
			(error: Error) => error.name,
		);
		controller.abort();
		expect(await pending).toBe("AbortError");
	});
});
