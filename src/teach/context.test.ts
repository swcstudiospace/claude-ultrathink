// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HINDSIGHT_CONFIG, type HindsightClient } from "../hindsight/types.ts";
import { hindsightFor, teachContext, teachEnabled, tryStore } from "./context.ts";
import { DEFAULT_TEACH_CONFIG } from "./types.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-teach-ctx-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A sandbox whose config, credential and state locations are all inside one temp directory. */
function sandbox(extraEnv: NodeJS.ProcessEnv = {}) {
	const root = tempDir();
	const cwd = join(root, "project");
	mkdirSync(cwd);
	const env: NodeJS.ProcessEnv = {
		HOME: join(root, "home"),
		XDG_CONFIG_HOME: join(root, "xdg"),
		CLAUDE_CONFIG_DIR: join(root, "claude"),
		ULTRATHINK_MCP_STORE: join(root, "credentials.json"),
		...extraEnv,
	};
	const writeJson = (path: string, value: unknown) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify(value));
	};
	return { root, cwd, env, writeJson };
}

describe("teachContext defaults", () => {
	test("a user config gateway section is loaded with the rest of Teachable Moments config", () => {
		const { cwd, env, writeJson } = sandbox();
		writeJson(join(env.XDG_CONFIG_HOME!, "ultrathink", "config.json"), {
			gateway: { url: "https://gateway.example/desk", seat: "lead", timeoutMs: 4000 },
			hindsight: { enabled: true, backend: "gateway" },
		});
		const ctx = teachContext({ cwd, env });
		expect(ctx.config.gateway).toMatchObject({ url: "https://gateway.example/desk", seat: "lead", timeoutMs: 4000 });
		expect(ctx.config.hindsight.backend).toBe("gateway");
	});

	test("with no config files Teachable Moments is on, Hindsight is off, and the state lives in the host's directory", () => {
		const { root, cwd, env } = sandbox();
		const ctx = teachContext({ cwd, env });
		expect(ctx.host).toBe("claude-code");
		expect(ctx.cwd).toBe(cwd);
		expect(ctx.config.teach).toEqual(DEFAULT_TEACH_CONFIG);
		expect(ctx.config.hindsight).toEqual(DEFAULT_HINDSIGHT_CONFIG);
		expect(ctx.config.gateway).toEqual({ url: "", seat: "lead", timeoutMs: 8000 });
		expect(ctx.stateDir).toBe(join(root, "claude", "ultrathink"));
		expect(ctx.storePath).toBe(join(root, "credentials.json"));
		expect(teachEnabled(ctx)).toBe(true);
		expect(ctx.now).toBeUndefined();
		expect(ctx.hindsight).toBeUndefined();
	});

	test("ULTRATHINK_HOST picks the host and its state directory", () => {
		const { root, cwd, env } = sandbox({ ULTRATHINK_HOST: "hermes", HERMES_HOME: "" });
		env.HERMES_HOME = join(root, "hermes-home");
		const ctx = teachContext({ cwd, env });
		expect(ctx.host).toBe("hermes");
		expect(ctx.stateDir).toBe(join(root, "hermes-home", "ultrathink"));
	});

	test("ULTRATHINK_STATE_DIR is honored unless it points into a .planning tree", () => {
		const { root, cwd, env } = sandbox({ ULTRATHINK_STATE_DIR: "" });
		env.ULTRATHINK_STATE_DIR = join(root, "elsewhere");
		expect(teachContext({ cwd, env }).stateDir).toBe(join(root, "elsewhere"));
		env.ULTRATHINK_STATE_DIR = join(cwd, ".planning", "state");
		const ctx = teachContext({ cwd, env });
		expect(ctx.stateDir).toBe(join(root, "claude", "ultrathink"));
		expect(ctx.stateDir).not.toContain(".planning");
	});

	test("explicit options win and unset seams stay absent", () => {
		const { cwd, env } = sandbox();
		const config = { teach: { ...DEFAULT_TEACH_CONFIG, enabled: true }, hindsight: { ...DEFAULT_HINDSIGHT_CONFIG } };
		const now = () => 42;
		const ctx = teachContext({ cwd, env, host: "omp", stateDir: "/tmp/state-x", storePath: "/tmp/creds-x", sessionId: "s1", config, now });
		expect(ctx).toMatchObject({ host: "omp", stateDir: "/tmp/state-x", storePath: "/tmp/creds-x", sessionId: "s1" });
		expect(ctx.config).toBe(config);
		expect(ctx.now?.()).toBe(42);
		expect(ctx.fetch).toBeUndefined();
		expect(ctx.signal).toBeUndefined();
		expect(ctx.log).toBeUndefined();
	});
});

describe("teachEnabled and config layers", () => {
	test("a user config turns it on; ULTRATHINK_TEACH=0 turns it off for the process", () => {
		const { cwd, env, writeJson } = sandbox();
		writeJson(join(env.XDG_CONFIG_HOME ?? "", "ultrathink", "config.json"), { teach: { enabled: true, recallLimit: 3 } });
		const ctx = teachContext({ cwd, env });
		expect(teachEnabled(ctx)).toBe(true);
		expect(ctx.config.teach.recallLimit).toBe(3);
		expect(teachEnabled(teachContext({ cwd, env: { ...env, ULTRATHINK_TEACH: "0" } }))).toBe(false);
		expect(teachEnabled(teachContext({ cwd, env: { ...env, ULTRATHINK_TEACH: "1" } }))).toBe(true);
	});

	test("a project file can switch it off but cannot override an explicit off", () => {
		const { cwd, env, writeJson } = sandbox();
		writeJson(join(env.XDG_CONFIG_HOME ?? "", "ultrathink", "config.json"), { teach: { enabled: false } });
		writeJson(join(cwd, ".claude", "ultrathink.json"), { teach: { enabled: true } });
		expect(teachEnabled(teachContext({ cwd, env }))).toBe(false);

		writeJson(join(env.XDG_CONFIG_HOME ?? "", "ultrathink", "config.json"), { teach: { enabled: true } });
		expect(teachEnabled(teachContext({ cwd, env }))).toBe(true);
		writeJson(join(cwd, ".claude", "ultrathink.json"), { teach: { enabled: false } });
		expect(teachEnabled(teachContext({ cwd, env }))).toBe(false);
	});
});

describe("hindsightFor", () => {
	function configured(overrides: Partial<typeof DEFAULT_HINDSIGHT_CONFIG> = {}) {
		const box = sandbox();
		const config = { teach: { ...DEFAULT_TEACH_CONFIG, enabled: true }, hindsight: { ...DEFAULT_HINDSIGHT_CONFIG, ...overrides } };
		return { ...box, ctx: teachContext({ cwd: box.cwd, env: box.env, config }) };
	}

	test("an injected client wins over any config", () => {
		const client = { bank: "injected" } as HindsightClient;
		const { cwd, env } = sandbox();
		const ctx = teachContext({ cwd, env, hindsight: client });
		expect(hindsightFor(ctx)).toEqual({ client });
	});

	test("off, not ready and ready are told apart, with a one-line reason when there is no client", () => {
		const off = configured();
		expect(hindsightFor(off.ctx).client).toBeUndefined();
		expect(hindsightFor(off.ctx).reason).toBe("hindsight is off (disabled)");

		const noUrl = configured({ enabled: true });
		expect(hindsightFor(noUrl.ctx).reason).toBe("hindsight is not ready (no-url)");

		const noKey = configured({ enabled: true, url: "https://hindsight.example.com" });
		expect(hindsightFor(noKey.ctx).reason).toBe("hindsight is not ready (no-key)");

		const ready = configured({ enabled: true, url: "https://hindsight.example.com", bank: "lessons" });
		ready.ctx.env.HINDSIGHT_API_KEY = "test-key";
		const resolved = hindsightFor(ready.ctx);
		expect(resolved.client?.bank).toBe("lessons");
		expect(resolved.reason).toBeUndefined();
	});

	test("the kill switch turns a ready configuration off", () => {
		const { ctx } = configured({ enabled: true, url: "https://hindsight.example.com" });
		ctx.env.HINDSIGHT_API_KEY = "test-key";
		ctx.env.ULTRATHINK_HINDSIGHT = "0";
		expect(hindsightFor(ctx).reason).toBe("hindsight is off (killed)");
	});
});

describe("tryStore", () => {
	test("opens the store under the state directory and refuses a .planning directory", () => {
		const { root, cwd, env } = sandbox();
		const ctx = teachContext({ cwd, env, stateDir: join(root, "state") });
		expect(tryStore(ctx)?.dir).toBe(join(root, "state", "teach"));
		const planning = teachContext({ cwd, env, stateDir: join(cwd, ".planning", "state") });
		expect(tryStore(planning)).toBeUndefined();
	});
});

describe("decisions config layers", () => {
	test("teachContext loads decisions from the user config file", () => {
		const { cwd, env, writeJson } = sandbox();
		writeJson(join(env.XDG_CONFIG_HOME ?? "", "ultrathink", "config.json"), {
			decisions: { enabled: true, points: ["plan", "skillworthy"], teachableBelow: 0.4, skillworthyAt: 0.7 },
		});
		const ctx = teachContext({ cwd, env });
		expect(ctx.config.decisions).toMatchObject({
			enabled: true,
			points: ["plan", "skillworthy"],
			teachableBelow: 0.4,
			skillworthyAt: 0.7,
		});
	});

	test("decisions.enabled is always on; a project file cannot add teachable or skillworthy beyond the user layer", () => {
		const { cwd, env, writeJson } = sandbox();
		const project = join(cwd, ".claude", "ultrathink.json");
		// A project file alone: enabled:false is ignored (always on), points narrow from the defaults.
		writeJson(project, { decisions: { enabled: false, points: ["teachable", "skillworthy"] } });
		const alone = teachContext({ cwd, env }).config.decisions;
		expect(alone?.enabled).toBe(true);
		expect(alone?.points).toEqual(["teachable", "skillworthy"]);

		// With a user layer, the project file can only narrow it, never widen it.
		writeJson(join(env.XDG_CONFIG_HOME ?? "", "ultrathink", "config.json"), {
			decisions: { enabled: false, points: ["plan"] },
		});
		writeJson(project, { decisions: { enabled: true, points: ["plan", "teachable", "skillworthy"] } });
		const loaded = teachContext({ cwd, env }).config.decisions;
		expect(loaded?.enabled).toBe(true);
		expect(loaded?.points).toEqual(["plan"]);
	});
});
