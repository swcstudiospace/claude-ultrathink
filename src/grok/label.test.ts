// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { ROUTE_DEFAULT_MODELS } from "../route-defaults.ts";
import { grokEngineLabel } from "./label.ts";
import { DEFAULT_GROK_CONFIG } from "./types.ts";

describe("grokEngineLabel", () => {
	test("default config yields the Grok route default (grok-4.7) at xhigh", () => {
		expect(grokEngineLabel(DEFAULT_GROK_CONFIG)).toBe(`${ROUTE_DEFAULT_MODELS.grok}@xhigh`);
		expect(grokEngineLabel(DEFAULT_GROK_CONFIG)).toBe("grok-4.7@xhigh");
	});

	test("cli transport uses model@effort too", () => {
		expect(grokEngineLabel({ ...DEFAULT_GROK_CONFIG, transport: "cli", reasoningEffort: "high" })).toBe(`${ROUTE_DEFAULT_MODELS.grok}@high`);
	});

	test("shunt transport yields <shuntModel>@shunt", () => {
		expect(grokEngineLabel({ ...DEFAULT_GROK_CONFIG, transport: "shunt", shuntModel: "grok-shunt-route" })).toBe("grok-shunt-route@shunt");
		expect(grokEngineLabel({ ...DEFAULT_GROK_CONFIG, transport: "shunt", model: "grok-4.6", shuntModel: "grok-4.7" })).toBe("grok-4.7@shunt");
	});

	test("shunt transport with no shuntModel falls back to model", () => {
		expect(grokEngineLabel({ ...DEFAULT_GROK_CONFIG, transport: "shunt" })).toBe(`${ROUTE_DEFAULT_MODELS.grok}@shunt`);
		expect(grokEngineLabel({ ...DEFAULT_GROK_CONFIG, transport: "shunt", model: "grok-4.6", shuntModel: "  " })).toBe("grok-4.6@shunt");
	});
});
