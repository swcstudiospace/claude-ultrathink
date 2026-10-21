// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { METRIC_FAMILIES } from "./metric-families.ts";
import { createAnomalyDetector } from "./signal-anomaly.ts";

// Repository root, three levels above services/ultrathink/obs/.
const REPO_ROOT = new URL("../../../", import.meta.url);
// prometheus.yml names only the scrape job, so it carries no family references.
const DEPLOY_FILES = [
	"deploy/observability/rules.yml",
	"deploy/observability/prometheus.yml",
	"deploy/observability/dashboards/ultrathink.json",
] as const;
// Files that must reference families; a regex matching nothing there would pass vacuously.
const REFERENCING_FILES = ["deploy/observability/rules.yml", "deploy/observability/dashboards/ultrathink.json"] as const;
const DASHBOARD_ROWS = ["Service health", "Business flows", "SLO and anomaly"] as const;

interface DashboardPanel {
	type: string;
	title?: string;
	panels?: unknown[];
}

interface Dashboard {
	__inputs?: Array<{ name: string }>;
	panels: DashboardPanel[];
}

describe("observability deploy contract", () => {
	test("every ultrathink_* family referenced by the deploy files is in METRIC_FAMILIES", () => {
		const known = new Set(METRIC_FAMILIES);
		const unknown = new Map<string, string[]>();
		for (const file of DEPLOY_FILES) {
			const text = readFileSync(fileURLToPath(new URL(file, REPO_ROOT)), "utf8");
			// Histogram and summary suffixes are stripped; the family is the base name.
			const refs = [...text.matchAll(/ultrathink_[a-z0-9_]+/g)].map((match) => match[0].replace(/_(bucket|sum|count)$/, ""));
			if (REFERENCING_FILES.some((referencing) => referencing === file)) {
				expect(refs.length, `${file} references at least one family`).toBeGreaterThan(0);
			}
			const missing = [...new Set(refs)].filter((name) => !known.has(name));
			if (missing.length > 0) unknown.set(file, missing);
		}
		expect([...unknown]).toEqual([]);
	});

	test("METRIC_FAMILIES has no duplicates and every entry is a base ultrathink_ name", () => {
		expect(new Set(METRIC_FAMILIES).size).toBe(METRIC_FAMILIES.length);
		const malformed = METRIC_FAMILIES.filter((name) => !/^ultrathink_[a-z_]+$/.test(name));
		expect(malformed).toEqual([]);
	});

	test("the dashboard parses as JSON, declares DS_PROMETHEUS, and has a panel in each row", () => {
		const text = readFileSync(fileURLToPath(new URL("deploy/observability/dashboards/ultrathink.json", REPO_ROOT)), "utf8");
		const dashboard = JSON.parse(text) as Dashboard;
		expect(dashboard.__inputs?.map((input) => input.name)).toContain("DS_PROMETHEUS");

		// Panels follow their row in the top-level list; a collapsed row keeps its panels nested.
		const panelsPerRow = new Map<string, number>();
		let currentRow: string | undefined;
		for (const panel of dashboard.panels) {
			if (panel.type === "row") {
				currentRow = panel.title;
				if (currentRow !== undefined) {
					panelsPerRow.set(currentRow, (panelsPerRow.get(currentRow) ?? 0) + (panel.panels?.length ?? 0));
				}
				continue;
			}
			if (currentRow !== undefined) panelsPerRow.set(currentRow, (panelsPerRow.get(currentRow) ?? 0) + 1);
		}
		for (const row of DASHBOARD_ROWS) {
			expect(panelsPerRow.get(row) ?? 0, `row "${row}" has a panel`).toBeGreaterThan(0);
		}
	});

	test("a sustained runtime jump stays active long enough for UltrathinkAnomalyActive to fire", () => {
		// The runtime sampler feeds each detector every 5 s (RUNTIME_SAMPLE_MS in routes/router.ts).
		const SAMPLE_SECONDS = 5;
		const rules = parseYaml(readFileSync(fileURLToPath(new URL("deploy/observability/rules.yml", REPO_ROOT)), "utf8")) as {
			groups: Array<{ rules: Array<{ alert?: string; for?: string }> }>;
		};
		const alert = rules.groups.flatMap((group) => group.rules).find((rule) => rule.alert === "UltrathinkAnomalyActive");
		const waitSeconds = durationSeconds(alert?.for);

		const detector = createAnomalyDetector();
		for (let sample = 0; sample < 40; sample += 1) detector.observe(1);
		let activeSamples = 0;
		let raised = false;
		for (let sample = 0; sample < 1000; sample += 1) {
			const state = detector.observe(2);
			if (state.transition === "raised") raised = true;
			if (state.active) activeSamples += 1;
			if (state.transition === "cleared") break;
		}

		expect(raised).toBe(true);
		// The gauge is 1 for activeSamples samples; the alert fires only if it stays 1 for its whole wait.
		expect(waitSeconds).toBeLessThan(activeSamples * SAMPLE_SECONDS);
	});
});

function durationSeconds(duration: string | undefined): number {
	const match = /^(\d+)([smh])$/.exec(duration ?? "");
	if (match === null) throw new Error(`unsupported duration ${duration ?? "(absent)"}`);
	const unit = { s: 1, m: 60, h: 3600 }[match[2] as "s" | "m" | "h"];
	return Number(match[1]) * unit;
}
