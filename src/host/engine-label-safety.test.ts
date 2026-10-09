// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { UltrathinkConfig } from "../config.ts";
import type { LegacyRoute } from "../route-defaults.ts";
import type { SelectedEngine } from "./engine.ts";
import { runPromptSubmit } from "../claude/hook.ts";
import { sessionPath } from "../claude/state.ts";
import { defaultConfig, mergeConfig } from "../config.ts";
import { engineLabel, selectEngine } from "./engine.ts";
import { MAX_ENGINE_ERROR_CHARS } from "./display-limits.ts";
import { configWith, createEngineFixtures, engineOf, shunt, skipOf } from "./engine-test.helpers.ts";
import { createFdProgressSink, parseProgressLine } from "./progress.ts";

const { tempDir, emptyHome, grokLogin, cleanup } = createEngineFixtures();
afterEach(cleanup);

describe("legacy diagnostic label safety", () => {
	const sentinel = "EXAMPLE_SENTINEL";
	const models = [
		["endpoint", `https://model.invalid/path?token=${sentinel}`],
		["credential", `sk-${sentinel}_0123456789abcdef`],
		["user-info", `user:${sentinel}@model.invalid`],
		["markup", `<model>${sentinel}</model>`],
		["oversized", `${sentinel}${"x".repeat(600)}`],
	] as const;
	const xml = "<BUILD_PROMPT><ORIGINAL>add a widget</ORIGINAL></BUILD_PROMPT>";

	function cliFixture(route: LegacyRoute): { cwd: string; bin: string; args: () => string[]; childCwd: () => string } {
		const cwd = tempDir("ultrathink-safe-label-cli-");
		const bin = join(cwd, route);
		const argvPath = join(cwd, "argv.json");
		const cwdPath = join(cwd, "cwd.txt");
		const reply = route === "claude"
			? { is_error: false, result: xml }
			: route === "muse"
				? { payload_type: "run.terminal.completed", payload: { terminal: "completed", text: xml } }
				: { text: xml, stopReason: "end_turn" };
		writeFileSync(
			bin,
			`#!${process.execPath}\nawait Bun.write(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));\nawait Bun.write(${JSON.stringify(cwdPath)}, process.cwd());\nprocess.stdout.write(${JSON.stringify(JSON.stringify(reply))});\n`,
			{ mode: 0o755 },
		);
		return {
			cwd, bin,
			args: () => JSON.parse(readFileSync(argvPath, "utf8")) as string[],
			childCwd: () => readFileSync(cwdPath, "utf8"),
		};
	}

	/** Exercise the actual selected completer, hook record, persisted JSON and FD progress, not just the resolution. */
	async function expectSafePlan(selected: SelectedEngine, config: UltrathinkConfig, cwd: string): Promise<void> {
		const stateDir = tempDir("ultrathink-safe-label-state-");
		const eventsPath = join(stateDir, "events.jsonl");
		const fd = openSync(eventsPath, "w");
		config.teach.enabled = false;
		config.ragflow.enabled = false;
		try {
			const result = await runPromptSubmit({ session_id: "safe-label", cwd, prompt: "add a widget" }, {
				config,
				control: { thinkEnabled: false, hitlEnabled: false },
				complete: selected.complete,
				engine: selected.label,
				modelResolution: selected.resolution,
				stateDir,
				trackingOff: true,
				git: () => ({}),
				brief: async () => "",
				now: () => 1,
				decisionsDeps: { env: { ULTRATHINK_DECISIONS: "0" } },
				progress: createFdProgressSink({ ULTRATHINK_PROGRESS_FD: String(fd) }),
			});
			expect(result.record?.result.source).toBe("llm");
			expect(result.record?.engine).toBe(selected.label);
			const events = readFileSync(eventsPath, "utf8");
			expect(events.split("\n").map(parseProgressLine).find((event) => event?.type === "begin")).toMatchObject({ engine: selected.label });
			for (const output of [
				JSON.stringify(selected),
				JSON.stringify(result),
				readFileSync(sessionPath(stateDir, "safe-label"), "utf8"),
				readFileSync(join(stateDir, "last.json"), "utf8"),
				events,
			]) {
				expect(output).not.toContain(sentinel);
				expect(output).not.toContain("model.invalid");
			}
			expect(selected.label.length).toBeLessThanOrEqual(MAX_ENGINE_ERROR_CHARS);
			expect(selected.label).toContain("<opaque-model>");
		} finally {
			closeSync(fd);
		}
	}

	test.each(["claude", "muse"] as const)("%s projects every public sink without changing host-override or engine-model argv", async (route) => {
		const cli = cliFixture(route);
		const host = route === "claude" ? "claude-code" : "muse";
		for (const [, model] of models) {
			for (const source of ["host-override", "engine-model"] as const) {
				const config = defaultConfig();
				config[route].bin = cli.bin;
				if (source === "host-override") config.models.hosts[host] = { provider: "", model };
				else config[route].model = model;
				const selected = engineOf(await selectEngine(config, {}, cli.cwd, { host }));
				expect(selected.resolution).toMatchObject({ source, modelId: "<opaque-model>" });
				expect(selected.label).toBe(`${route}:<opaque-model>`);
				await expectSafePlan(selected, config, cli.cwd);
				const args = cli.args();
				expect(args).toContain("--model");
				expect(args[args.indexOf("--model") + 1]).toBe(model);
			}
		}
	});

	test("Grok shunt projects every public sink while sending exact host overrides, engine pins and shunt aliases", async () => {
		const realFetch = globalThis.fetch;
		const sent: Array<{ url: string; model: string }> = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const body: unknown = JSON.parse(String(init?.body));
			if (!body || typeof body !== "object" || !("model" in body) || typeof body.model !== "string") throw new Error("expected a wire model");
			sent.push({ url: String(input), model: body.model });
			return Response.json({ content: [{ type: "text", text: xml }] });
		}) as unknown as typeof fetch;
		try {
			for (const [, model] of models) {
				for (const source of ["host-override", "engine-model", "shunt-model"] as const) {
					const config = shunt();
					if (source === "host-override") config.models.hosts["grok-build"] = { provider: "", model };
					else if (source === "engine-model") config.grok.model = model;
					else {
						config.models.hosts["grok-build"] = { provider: "", model: "ignored-host-model" };
						config.grok.shuntModel = model;
					}
					const selected = engineOf(await selectEngine(config, {}, "/repo", { host: "grok-build" }));
					expect(selected.label).toBe("<opaque-model>@shunt");
					expect(selected.resolution).toMatchObject({ source, transport: "grok-shunt", modelId: "<opaque-model>" });
					await expectSafePlan(selected, config, "/repo");
					expect(sent.at(-1)).toEqual({ url: "http://127.0.0.1:3001/v1/messages", model });
				}
			}
			expect(sent).toHaveLength(models.length * 3);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("Grok HTTP and CLI labels keep effort but never expose an unsafe model", async () => {
		for (const transport of ["http", "cli"] as const) {
			for (const [, model] of models) {
				const config = configWith({ grok: { ...defaultConfig().grok, transport, model, home: grokLogin() } });
				const selected = engineOf(await selectEngine(config, {}, "/repo", { host: "grok-build" }));
				expect(selected.label).toBe("<opaque-model>@xhigh");
				expect(JSON.stringify(selected)).not.toContain(sentinel);
			}
		}
	});

	test.each(["claude", "muse", "grok"] as const)("%s keeps a shell-metacharacter model in one argv field with no marker/path effect (POL-COV-020)", async (route) => {
		const cli = cliFixture(route);
		const marker = join(cli.cwd, "shell-canary-ran");
		const model = `${sentinel};touch ${marker};$(touch ${marker});\`touch ${marker}\`;#`;
		const before = readdirSync(cli.cwd).sort();
		const realTmp = realpathSync(tmpdir());
		const host = route === "claude" ? "claude-code" : route === "muse" ? "muse" : "grok-build";
		const argvLengths: Record<LegacyRoute, number> = { claude: 14, muse: 13, grok: 28 };
		const lower = defaultConfig();
		lower[route].bin = cli.bin;
		if (route === "grok") {
			lower.grok.transport = "cli";
			lower.grok.home = grokLogin();
		}
		for (const source of ["host-override", "engine-model"] as const) {
			const config = mergeConfig(source === "host-override"
				? { models: { hosts: { [host]: { model } } } }
				: { [route]: { model } }, lower);
			const selected = engineOf(await selectEngine(config, {}, cli.cwd, { host }));
			expect(selected.resolution).toMatchObject({ state: "override", source, reason: "explicit-model", modelKnown: true, modelId: "<opaque-model>" });
			await expectSafePlan(selected, config, cli.cwd);
			const args = cli.args();
			const flag = route === "grok" ? "-m" : "--model";
			expect(args).toHaveLength(argvLengths[route]);
			expect(args.filter((arg) => arg === flag)).toEqual([flag]);
			expect(args[args.indexOf(flag) + 1]).toBe(model);
			expect(args.filter((arg) => arg.includes(marker))).toEqual([model]);
			expect(existsSync(marker)).toBe(false);
			expect(readdirSync(cli.cwd).sort()).toEqual([...before, "argv.json", "cwd.txt"].sort());
			const childCwd = cli.childCwd();
			expect(childCwd).not.toContain(sentinel);
			expect(existsSync(join(childCwd, model))).toBe(false);
			if (route === "grok") {
				expect(realpathSync(childCwd)).not.toBe(realpathSync(cli.cwd));
				// macOS getcwd resolves /var to /private/var; compare the canonical directory.
				expect(realpathSync(dirname(childCwd))).toBe(realTmp);
				expect(basename(childCwd)).toStartWith("ultrathink-grok-");
			} else expect(realpathSync(childCwd)).toBe(realpathSync(cli.cwd));
			if (route !== "claude") {
				const promptFile = args[args.indexOf("--prompt-file") + 1];
				if (!promptFile) throw new Error("expected a CLI prompt file");
				expect(basename(promptFile)).toBe(route === "muse" ? "prompt.txt" : "prompt.md");
				expect(realpathSync(dirname(dirname(promptFile)))).toBe(realTmp);
				expect(basename(dirname(promptFile))).toStartWith(`ultrathink-${route}-`);
				expect(promptFile).not.toContain(sentinel);
				expect(existsSync(promptFile)).toBe(false);
			}
		}
	});

	test("Grok HTTP/shunt keep shell-metacharacter models in one exact body field and fixed request paths (POL-COV-020)", async () => {
		const cwd = tempDir("ultrathink-safe-model-body-");
		const marker = join(cwd, "shell-canary-ran");
		const model = `${sentinel};touch ${marker};$(touch ${marker});\`touch ${marker}\`;#`;
		const sent: Array<{ url: string; body: unknown; modelHeader: string | null }> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				sent.push({ url: request.url, body: await request.json(), modelHeader: request.headers.get("x-grok-model-override") });
				return Response.json(new URL(request.url).pathname.endsWith("/responses")
					? { output_text: xml }
					: { content: [{ type: "text", text: xml }] });
			},
		});
		const origin = `http://127.0.0.1:${server.port}`;
		try {
			for (const transport of ["http", "shunt"] as const) {
				const lower = mergeConfig({ grok: {
					transport, home: grokLogin(), baseUrl: `${origin}/proxy/v1`, shuntBaseUrl: `${origin}/gateway`,
				} }, defaultConfig());
				const sources = transport === "shunt" ? ["host-override", "engine-model", "shunt-model"] as const : ["host-override", "engine-model"] as const;
				for (const source of sources) {
					const config = mergeConfig(source === "host-override"
						? { models: { hosts: { "grok-build": { model } } } }
						: { grok: { [source === "shunt-model" ? "shuntModel" : "model"]: model } }, lower);
					const selected = engineOf(await selectEngine(config, {}, cwd, { host: "grok-build" }));
					expect(selected.resolution).toMatchObject({ state: "override", source, reason: "explicit-model", modelKnown: true, modelId: "<opaque-model>" });
					const before = sent.length;
					expect(await selected.complete("system", "user")).toBe(xml);
					expect(sent).toHaveLength(before + 1);
					expect(sent.at(-1)).toEqual(transport === "http"
						? {
							url: `${origin}/proxy/v1/responses`, modelHeader: model,
							body: { model, instructions: "system", input: "user", reasoning: { effort: lower.grok.reasoningEffort }, stream: false },
						}
						: {
							url: `${origin}/gateway/v1/messages`, modelHeader: null,
							body: { model, max_tokens: lower.grok.shuntMaxTokens, system: "system", messages: [{ role: "user", content: "user" }] },
						});
					expect(existsSync(marker)).toBe(false);
					expect(existsSync(join(cwd, model))).toBe(false);
					expect(readdirSync(cwd)).toEqual([]);
				}
			}
			expect(sent).toHaveLength(5);
		} finally {
			server.stop(true);
		}
	});

	test("control-bearing selectors are rejected consistently by selection and static status", async () => {
		for (const model of [`${sentinel}\u001b[31m\nmodel`, `${sentinel}\u0000model`, `${sentinel}\tmodel`]) {
			for (const [host, route] of [["claude-code", "claude"], ["muse", "muse"], ["grok-build", "grok"]] as const) {
				for (const source of ["host-override", "engine-model", ...(route === "grok" ? ["shunt-model"] : [])]) {
					const config = shunt();
					if (source === "host-override") config.models.hosts[host] = { provider: "", model };
					else if (source === "shunt-model") config.grok.shuntModel = model;
					else config[route].model = model;
					const skipped = skipOf(await selectEngine(config, {}, "/repo", { host }));
					expect(skipped.resolution).toMatchObject({ source, state: "unresolved", reason: "selector-invalid" });
					expect(engineLabel(config, {}, host)).toBe(skipped.resolution.label);
					expect(JSON.stringify(skipped)).not.toContain(sentinel);
					expect("complete" in skipped).toBe(false);
				}
			}
		}
	});

	test.each(["claude", "muse"] as const)("%s still omits --model for an explicit blank", async (route) => {
		const cli = cliFixture(route);
		const config = defaultConfig();
		config[route].bin = cli.bin;
		config[route].model = "";
		const selected = engineOf(await selectEngine(config, { engine: route }, cli.cwd, { host: "claude-code" }));
		expect(selected.label).toBe(`${route}:session default`);
		expect(await selected.complete("system", "user")).toBe(xml);
		expect(cli.args()).not.toContain("--model");
	});

	test("both configured Grok fallbacks project Claude labels and keep Claude's wire target", async () => {
		const cli = cliFixture("claude");
		const model = models[0][1];
		for (const enabled of [false, true]) {
			const config = configWith({
				claude: { ...defaultConfig().claude, bin: cli.bin, model },
				grok: { ...defaultConfig().grok, home: emptyHome(), enabled, fallbackToClaude: true },
			});
			const selected = engineOf(await selectEngine(config, {}, cli.cwd, { host: "grok-build" }));
			expect(selected.label).toBe(`claude:<opaque-model>${enabled ? " (grok fallback)" : ""}`);
			expect(selected.resolution).toMatchObject({ source: "configured-fallback", reason: "grok-unavailable", transport: "claude-cli" });
			await expectSafePlan(selected, config, cli.cwd);
			const args = cli.args();
			expect(args[args.indexOf("--model") + 1]).toBe(model);
		}
	});
});
