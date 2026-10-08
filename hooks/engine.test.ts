// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, mergeConfig } from "../src/config.ts";
import { type EngineSelectionContext, selectEngine } from "../src/host/engine.ts";
import { isHostId } from "../src/host/types.ts";
import { requestFrom } from "./engine.ts";

describe("requestFrom", () => {
	test("forwards the session model for per-model engine routing", () => {
		expect(requestFrom({ host: "omp", model: "muse-code/muse-spark-1.3-contributor" }).model).toBe(
			"muse-code/muse-spark-1.3-contributor",
		);
		expect(requestFrom({ host: "hermes", model: "xai-oauth/grok-4.7" }).model).toBe("xai-oauth/grok-4.7");
	});

	test("omits the model when absent or not a string", () => {
		expect(requestFrom({ host: "omp" }).model).toBeUndefined();
		expect(requestFrom({ host: "omp", model: 42 }).model).toBeUndefined();
		expect(requestFrom({ host: "omp", model: null }).model).toBeUndefined();
	});

	test("a blank model means unknown, never a model id", () => {
		expect(requestFrom({ host: "omp", model: "" }).model).toBeUndefined();
		expect(requestFrom({ host: "hermes", model: "   " }).model).toBeUndefined();
	});

	test("keeps the existing field aliases", () => {
		expect(
			requestFrom({
				host: "claude-code",
				sessionId: "s1",
				userPrompt: "hi",
				workspaceRoot: "/repo",
				transcriptPath: "/tmp/t.jsonl",
				parentSessionId: "p1",
				platform: "cron",
			}),
		).toEqual({
			host: "claude-code",
			session_id: "s1",
			prompt: "hi",
			cwd: "/repo",
			transcript_path: "/tmp/t.jsonl",
			parent_session_id: "p1",
			platform: "cron",
			model: undefined,
		});
	});

	test("non-objects become an empty request", () => {
		for (const value of [null, undefined, "model", 42, true, [], [{ host: "omp", prompt: "hi" }]]) expect(requestFrom(value)).toEqual({});
	});

	test("the Prime Agent kernel skill's request is a supported host with the session and platform it sends", () => {
		expect(isHostId("prime-agent")).toBe(true);
		const request = requestFrom({ host: "prime-agent", session_id: "01a1-session", prompt: "plan this", cwd: "/repo", platform: "prime-agent" });
		expect(request).toMatchObject({ host: "prime-agent", session_id: "01a1-session", prompt: "plan this", cwd: "/repo", platform: "prime-agent" });
		expect(request.invalidHost).toBeUndefined();
		expect(request.model).toBeUndefined();
	});

	test("an unknown host is omitted and flagged; the rest of the request still parses", () => {
		expect(requestFrom({ host: "wat", model: "muse-spark" })).toEqual({
			host: undefined,
			invalidHost: true,
			session_id: undefined,
			prompt: undefined,
			cwd: undefined,
			transcript_path: undefined,
			parent_session_id: undefined,
			platform: undefined,
			model: "muse-spark",
		});
	});

	test("bot hosts are not a HostId: grok-bot and gpt-dot are omitted, never a fail-closed request (§7.2)", () => {
		for (const host of ["grok-bot", "gpt-dot"]) {
			expect(isHostId(host)).toBe(false);
			const request = requestFrom({ host, session_id: "s1", prompt: "plan this", cwd: "/repo", model: "Opaque-Model/X" });
			expect(request.host).toBeUndefined();
			expect(request.invalidHost).toBe(true);
			expect(request).toMatchObject({ session_id: "s1", prompt: "plan this", cwd: "/repo", model: "Opaque-Model/X" });
		}
	});

	test("invalidHost is parser-generated: a supplied non-HostId sets it, JSON cannot, and absent, null or blank hosts keep detection", () => {
		for (const host of ["OMP", " omp ", "claude", 42, false, ["omp"], { id: "omp" }]) {
			const request = requestFrom({ host, prompt: "hi" });
			expect(request.host).toBeUndefined();
			expect(request.invalidHost).toBe(true);
		}
		for (const value of [{ prompt: "hi" }, { host: null, prompt: "hi" }, { host: "", prompt: "hi" }, { host: "  ", prompt: "hi" }]) {
			expect(requestFrom(value)).not.toHaveProperty("invalidHost");
		}
		expect(requestFrom({ host: "omp", invalidHost: true })).not.toHaveProperty("invalidHost");
		expect(requestFrom({ invalidHost: true })).not.toHaveProperty("invalidHost");
		for (const host of ["claude-code", "grok-build", "hermes", "muse", "omp"]) {
			expect(requestFrom({ host })).toMatchObject({ host });
			expect(requestFrom({ host })).not.toHaveProperty("invalidHost");
		}
	});

	test("an optional provider is an opaque legacy declaration: trimmed, case kept, blank or non-string omitted", () => {
		expect(requestFrom({ host: "hermes", provider: "xai-oauth" }).provider).toBe("xai-oauth");
		expect(requestFrom({ host: "hermes", provider: "  Custom-Gateway/Team_A " }).provider).toBe("Custom-Gateway/Team_A");
		for (const provider of [undefined, null, "", "   ", 7, { id: "anthropic" }, ["anthropic"]]) {
			expect(requestFrom({ host: "hermes", provider }).provider).toBeUndefined();
		}
	});

	test("accepts no Model, auth, resolver or registry object from the JSON", () => {
		// Built in pieces so no scanner reads a credential-like literal out of this fixture.
		const sentinel = ["sentinel", "credential", "value"].join("-");
		const request = requestFrom({
			host: "hermes",
			prompt: "add a widget",
			model: { id: "m", provider: "p", baseUrl: "https://gateway.example/v1", headers: { authorization: sentinel } },
			provider: { apiKey: sentinel },
			auth: { token: sentinel },
			apiKey: sentinel,
			resolver: sentinel,
			registry: { models: [{ id: "m", apiKey: sentinel }] },
			modelResolution: { state: "detected", label: sentinel },
		});
		expect(request).toEqual({ host: "hermes", prompt: "add a widget" });
		expect(Object.keys(request).sort()).toEqual(
			["cwd", "host", "model", "parent_session_id", "platform", "prompt", "provider", "session_id", "transcript_path"].sort(),
		);
		expect(JSON.stringify(request)).not.toContain(sentinel);
		expect(JSON.stringify(request)).not.toContain("gateway.example");
	});
});

describe("Claude Code transport under the hook entries' selection context (D-10, COMPAT-01)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	/** A claude binary that records its argv (one per line) and stdin, then answers like `claude -p --output-format json`. */
	function recordingClaude(): { bin: string; cwd: string; argv: () => string[]; stdin: () => string } {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-hook-transport-"));
		dirs.push(dir);
		const bin = join(dir, "claude.sh");
		writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(dir, "argv")}'\ncat > '${join(dir, "stdin")}'\nprintf '{"result":"ok"}'\n`);
		chmodSync(bin, 0o755);
		return {
			bin,
			cwd: dir,
			argv: () => readFileSync(join(dir, "argv"), "utf8").split("\n").slice(0, -1),
			stdin: () => readFileSync(join(dir, "stdin"), "utf8"),
		};
	}

	const BASE_ARGV = [
		"-p",
		"--tools",
		"",
		"--setting-sources",
		"",
		"--no-session-persistence",
		"--strict-mcp-config",
		"--exclude-dynamic-system-prompt-sections",
		"--output-format",
		"json",
		"--system-prompt",
		"SYS",
	];

	/** Plans one call on the Claude Code route with the given context and returns what the child received. */
	async function transport(claudeModel: string | undefined, context: EngineSelectionContext): Promise<{ argv: string[]; stdin: string }> {
		const claude = recordingClaude();
		const config = mergeConfig({ claude: { bin: claude.bin, ...(claudeModel === undefined ? {} : { model: claudeModel }) } }, defaultConfig());
		const engine = await selectEngine(config, {}, claude.cwd, { host: "claude-code", purpose: "planning", ...context });
		if ("skipped" in engine) throw new Error(`expected the Claude route, got the skip ${engine.skipped}`);
		expect(await engine.complete("SYS", "USER payload")).toBe("ok");
		return { argv: claude.argv(), stdin: claude.stdin() };
	}

	test("route default, explicit pin and explicit blank keep today's argv and stdin, whatever envelope evidence is passed", async () => {
		const evidence: EngineSelectionContext = { sessionModel: "claude-opus-x", provider: "anthropic" };
		for (const [model, tail] of [
			[undefined, ["--model", "sonnet"]],
			["opus", ["--model", "opus"]],
			["", []],
		] as const) {
			const plain = await transport(model, {});
			expect(plain.argv).toEqual([...BASE_ARGV, ...tail]);
			expect(plain.stdin).toBe("USER payload");
			expect(await transport(model, evidence)).toEqual(plain);
		}
	});
});

describe("emit", () => {
	test("a response larger than the 128 KiB pipe buffer reaches the caller intact before the process exits", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-emit-"));
		try {
			const script = join(dir, "big.ts");
			// The entry's own exit pattern: emit, then process.exit in finally. The caller must get one complete JSON line.
			writeFileSync(
				script,
				`import { emit } from ${JSON.stringify(join(import.meta.dir, "engine.ts"))};\n` +
					`emit({ context: "x".repeat(300_000) }).finally(() => process.exit(0));\n`,
			);
			const proc = Bun.spawn(["bun", "--no-env-file", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ULTRATHINK_HOST: "prime-agent" } });
			const out = await new Response(proc.stdout).text();
			expect(await proc.exited).toBe(0);
			expect(out.endsWith("\n")).toBe(true);
			expect((JSON.parse(out) as { context: string }).context).toHaveLength(300_000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
