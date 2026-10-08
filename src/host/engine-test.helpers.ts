// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeCompleter } from "../claude/complete.ts";
import type { ControlState } from "../claude/state.ts";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";
import {
	type EngineSelection,
	type EngineSelectionContext,
	type EngineSkip,
	type ModelIntent,
	type ModelResolution,
	type NativeModelIdentity,
	type NativeModelQuery,
	type SelectedEngine,
	selectEngine,
} from "./engine.ts";
import type { HostId } from "./types.ts";

/** Each test file owns its directories and registers its own afterEach cleanup. */
export function createEngineFixtures() {
	const dirs: string[] = [];
	function cleanup(): void {
		while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
	}

	function tempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		dirs.push(dir);
		return dir;
	}

	function emptyHome(): string {
		return tempDir("ultrathink-engine-test-");
	}

	/** A Grok home holding a `grok login` session; `expired` dates it in the past with no refresh token, so nothing refreshes it. */
	function grokLogin(expired = false): string {
		const home = tempDir("ultrathink-engine-grok-");
		// Built in pieces so no scanner reads a key-like literal out of this fixture.
		const key = ["fixture", "session", "value"].join("-");
		writeFileSync(join(home, "auth.json"), JSON.stringify({ default: { key, ...(expired ? { expires_at: "2020-01-01T00:00:00.000Z" } : {}) } }));
		return home;
	}

	/** A claude binary that only records that it ran: the Claude-spawn spy. */
	function claudeSpy(): { bin: string; ran: () => boolean } {
		const dir = tempDir("ultrathink-engine-spy-");
		const marker = join(dir, "ran");
		const bin = join(dir, "claude.sh");
		writeFileSync(bin, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
		chmodSync(bin, 0o755);
		return { bin, ran: () => existsSync(marker) };
	}

	return { cleanup, tempDir, emptyHome, grokLogin, claudeSpy };
}

export function configWith(overrides: Partial<UltrathinkConfig>): UltrathinkConfig {
	return { ...defaultConfig(), ...overrides };
}

export const shunt = () => configWith({ grok: { ...defaultConfig().grok, transport: "shunt", shuntBaseUrl: "http://127.0.0.1:3001" } });

export async function labelOf(config: UltrathinkConfig, state: ControlState, host: HostId, sessionModel?: unknown): Promise<string> {
	const selected = await selectEngine(config, state, "/repo", { host, sessionModel });
	return "skipped" in selected ? `skipped:${selected.skipped}` : selected.label;
}

export async function resolutionOf(config: UltrathinkConfig, state: ControlState, host: HostId, context: EngineSelectionContext = {}): Promise<ModelResolution> {
	return (await selectEngine(config, state, "/repo", { host, ...context })).resolution;
}

export function engineOf(selection: EngineSelection): SelectedEngine {
	if ("skipped" in selection) throw new Error(`expected an engine, got the skip ${selection.skipped}`);
	return selection;
}

export function skipOf(selection: EngineSelection): EngineSkip {
	if (!("skipped" in selection)) throw new Error(`expected a skip, got ${selection.label}`);
	return selection;
}

export const AUTO = { engine: "auto", source: "config", nativeOptOut: false } as const;

interface FakeModel extends NativeModelIdentity {
	usable: "usable" | "unavailable" | "unsupported";
}

export function fakeModel(provider: string, id: string, usable: FakeModel["usable"] = "usable"): FakeModel {
	return { provider, id, api: "openai-responses", providerType: `${provider}-type`, usable };
}

/** An injected host query: `models` answers resolve by selector, `catalog` stands in for DEFAULT_MODEL_PER_PROVIDER. */
export function fakeQuery(options: {
	live?: NativeModelQuery<FakeModel>["live"];
	models?: Record<string, FakeModel>;
	catalog?: Record<string, string>;
}): { query: NativeModelQuery<FakeModel>; resolved: string[] } {
	const resolved: string[] = [];
	return {
		resolved,
		query: {
			live: options.live,
			check: (model) => model.usable,
			resolve: async (selector, provider) => {
				resolved.push(`${provider ?? ""}|${selector}`);
				return options.models?.[selector];
			},
			catalogDefault: (provider) => options.catalog?.[provider],
		},
	};
}

export function binder(): { bind: (model: FakeModel) => ClaudeCompleter; bound: FakeModel[] } {
	const bound: FakeModel[] = [];
	return {
		bound,
		bind: (model) => {
			bound.push(model);
			return async () => `answer from ${model.provider}/${model.id}`;
		},
	};
}

export function intentWith(override: Partial<ModelIntent["override"]> = {}, providerDefaults: Record<string, string> = {}): ModelIntent {
	return { host: "omp", override: { provider: "", model: "", ...override }, providerDefaults, engineSelection: { ...AUTO } };
}
