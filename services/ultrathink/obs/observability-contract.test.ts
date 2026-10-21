// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { METRIC_FAMILIES } from "./metric-families.ts";

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
});
