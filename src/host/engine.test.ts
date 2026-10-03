// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";
import type { ControlState } from "../claude/state.ts";
import type { HostId } from "./types.ts";
import { engineLabel, GROK_LOGIN_REQUIRED, HOST_DEFAULT_ENGINES, selectEngine } from "./engine.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function emptyHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-engine-test-"));
	dirs.push(dir);
	return dir;
}

function configWith(overrides: Partial<UltrathinkConfig>): UltrathinkConfig {
	return { ...defaultConfig(), ...overrides };
}

async function labelOf(config: UltrathinkConfig, state: ControlState, host: HostId): Promise<string> {
	const selected = await selectEngine(config, state, "/repo", host);
	return "skipped" in selected ? `skipped:${selected.skipped}` : selected.label;
}

describe("selectEngine host defaults (think.engine auto)", () => {
	test("muse host inherits the muse engine at muse-spark-1.3-contributor", async () => {
		expect(await labelOf(configWith({}), {}, "muse")).toBe("muse:muse-spark-1.3-contributor");
	});

	test("claude-code, hermes and omp hosts inherit the Muse engine", async () => {
		for (const host of ["claude-code", "hermes", "omp"] as const) {
			expect(await labelOf(configWith({}), {}, host)).toBe("claude:sonnet");
		}
	});

	test("grok-build inherits grok at grok-4.7 when usable (shunt needs no login)", async () => {
		const config = configWith({ grok: { ...defaultConfig().grok, transport: "shunt", shuntBaseUrl: "http://127.0.0.1:3001" } });
		expect(await labelOf(config, {}, "grok-build")).toBe("grok-4.7@shunt");
	});

	test("grok-build without a grok login falls back to Muse, marked unavailable", async () => {
		const config = configWith({ grok: { ...defaultConfig().grok, home: emptyHome(), fallbackToClaude: false } });
		expect(await labelOf(config, {}, "grok-build")).toBe("claude:sonnet (grok unavailable)");
	});

	test("grok-build with grok disabled falls back to Muse silently", async () => {
		const config = configWith({ grok: { ...defaultConfig().grok, enabled: false } });
		expect(await labelOf(config, {}, "grok-build")).toBe("claude:sonnet");
	});
});

describe("selectEngine explicit pins", () => {
	test("explicit think.engine wins over every host default", async () => {
		const config = configWith({ think: { ...defaultConfig().think, engine: "muse" } });
		for (const host of ["claude-code", "grok-build", "hermes", "muse", "omp"] as const) {
			expect(await labelOf(config, {}, host)).toBe("muse:muse-spark-1.3-contributor");
		}
		const claude = configWith({ think: { ...defaultConfig().think, engine: "claude" } });
		expect(await labelOf(claude, {}, "muse")).toBe("claude:sonnet");
	});

	test("explicit model wins over the host default model", async () => {
		const config = configWith({ muse: { ...defaultConfig().muse, model: "other-model" } });
		expect(await labelOf(config, {}, "muse")).toBe("muse:other-model");
	});

	test("control state engine wins over config", async () => {
		const config = configWith({ think: { ...defaultConfig().think, engine: "claude" } });
		expect(await labelOf(config, { engine: "muse" }, "claude-code")).toBe("muse:muse-spark-1.3-contributor");
	});

	test("empty muse model inherits the CLI session default in the label", async () => {
		const config = configWith({ muse: { ...defaultConfig().muse, model: "" } });
		expect(await labelOf(config, {}, "muse")).toBe("muse:session default");
	});
});

describe("selectEngine grok login handling", () => {
	test("explicit grok without login and no fallback is a visible skip", async () => {
		const config = configWith({
			think: { ...defaultConfig().think, engine: "grok" },
			grok: { ...defaultConfig().grok, home: emptyHome(), fallbackToClaude: false },
		});
		for (const host of ["claude-code", "grok-build"] as const) {
			expect(await labelOf(config, {}, host)).toBe(`skipped:${GROK_LOGIN_REQUIRED}`);
		}
	});

	test("explicit grok without login falls back when fallbackToClaude is set", async () => {
		const config = configWith({
			think: { ...defaultConfig().think, engine: "grok" },
			grok: { ...defaultConfig().grok, home: emptyHome(), fallbackToClaude: true },
		});
		expect(await labelOf(config, {}, "claude-code")).toBe("claude:sonnet (grok fallback)");
	});
});

describe("HOST_DEFAULT_ENGINES", () => {
	test("covers every host", () => {
		expect(Object.keys(HOST_DEFAULT_ENGINES).sort()).toEqual(["claude-code", "grok-build", "hermes", "muse", "omp"]);
	});
});

describe("engineLabel", () => {
	test("mirrors selection without auth checks", () => {
		const config = defaultConfig();
		expect(engineLabel(config, {}, "muse")).toBe("muse:muse-spark-1.3-contributor");
		expect(engineLabel(config, {}, "claude-code")).toBe("claude:sonnet");
		expect(engineLabel(config, {}, "grok-build")).toBe("grok-4.7@xhigh");
		expect(engineLabel(config, { engine: "muse" }, "claude-code")).toBe("muse:muse-spark-1.3-contributor");
	});
});
