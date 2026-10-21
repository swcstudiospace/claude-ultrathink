// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

export interface Metrics {
	inc(name: string, labels?: Record<string, string>, by?: number): void;
	/** Histogram observation in the default buckets (seconds). */
	observe(name: string, value: number, labels?: Record<string, string>): void;
	gauge(name: string, value: number, labels?: Record<string, string>): void;
	/** Sum of series values in family `name` whose labels contain every `match` pair; 0 for an unknown family. */
	sum(name: string, match?: Record<string, string>): number;
	/** Prometheus text exposition format 0.0.4. */
	render(): string;
}

export interface MetricsOptions {
	maxSeriesPerMetric?: number;
}

export const DROPPED_METRIC = "ultrathink_metrics_dropped_total";
export const DEFAULT_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
const DEFAULT_MAX_SERIES = 200;

type Kind = "counter" | "gauge" | "histogram";

interface Series {
	labels: Array<[string, string]>;
	value: number;
	// Histogram only: per-bucket (non-cumulative) counts, then the overflow slot.
	buckets?: number[];
	sum?: number;
}

interface Family {
	kind: Kind;
	series: Map<string, Series>;
}

function metricName(raw: string): string {
	const cleaned = String(raw).replace(/[^a-zA-Z0-9_:]/g, "_");
	return /^[a-zA-Z_:]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

function labelName(raw: string): string {
	const cleaned = String(raw).replace(/[^a-zA-Z0-9_]/g, "_");
	return /^[a-zA-Z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

export function escapeLabelValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labels: ReadonlyArray<readonly [string, string]>): string {
	if (labels.length === 0) return "";
	return `{${labels.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",")}}`;
}

export function createMetrics(opts: MetricsOptions = {}): Metrics {
	const maxSeries = Math.max(1, Math.floor(opts.maxSeriesPerMetric ?? DEFAULT_MAX_SERIES));
	const families = new Map<string, Family>();

	function normalizeLabels(labels: Record<string, string> | undefined, reserved?: string): Array<[string, string]> {
		const merged = new Map<string, string>();
		for (const key of Object.keys(labels ?? {})) {
			const name = labelName(key);
			if (name === reserved || name.startsWith("__")) continue;
			merged.set(name, String(labels?.[key]));
		}
		return [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	}

	function countDropped(metric: string): void {
		let family = families.get(DROPPED_METRIC);
		if (!family) {
			family = { kind: "counter", series: new Map() };
			families.set(DROPPED_METRIC, family);
		}
		// Bounded by the number of metric names code defines; exempt from the series cap.
		const labels: Array<[string, string]> = [["metric", metric]];
		const key = JSON.stringify(labels);
		const existing = family.series.get(key);
		if (existing) existing.value += 1;
		else family.series.set(key, { labels, value: 1 });
	}

	/** Returns the series to mutate, or null when the call is rejected (counted as dropped). */
	function seriesFor(
		rawName: string,
		kind: Kind,
		labels: Array<[string, string]>,
		init: () => Series,
	): Series | null {
		const name = metricName(rawName);
		let family = families.get(name);
		if (!family) {
			family = { kind, series: new Map() };
			families.set(name, family);
		} else if (family.kind !== kind) {
			countDropped(name);
			return null;
		}
		const key = JSON.stringify(labels);
		const existing = family.series.get(key);
		if (existing) return existing;
		if (family.series.size >= maxSeries) {
			countDropped(name);
			return null;
		}
		const created = init();
		family.series.set(key, created);
		return created;
	}

	return {
		inc(name, labels, by = 1) {
			if (!Number.isFinite(by) || by < 0) return;
			const norm = normalizeLabels(labels);
			const series = seriesFor(name, "counter", norm, () => ({ labels: norm, value: 0 }));
			if (series) series.value += by;
		},
		observe(name, value, labels) {
			if (!Number.isFinite(value)) return;
			const norm = normalizeLabels(labels, "le");
			const series = seriesFor(name, "histogram", norm, () => ({
				labels: norm,
				value: 0,
				buckets: new Array<number>(DEFAULT_BUCKETS.length + 1).fill(0),
				sum: 0,
			}));
			if (!series?.buckets) return;
			let slot = DEFAULT_BUCKETS.findIndex((bound) => value <= bound);
			if (slot < 0) slot = DEFAULT_BUCKETS.length;
			series.buckets[slot] = (series.buckets[slot] ?? 0) + 1;
			series.sum = (series.sum ?? 0) + value;
			series.value += 1;
		},
		gauge(name, value, labels) {
			if (!Number.isFinite(value)) return;
			const norm = normalizeLabels(labels);
			const series = seriesFor(name, "gauge", norm, () => ({ labels: norm, value: 0 }));
			if (series) series.value = value;
		},
		sum(name, match) {
			const family = families.get(metricName(name));
			if (!family) return 0;
			const pairs = Object.entries(match ?? {}).map(([k, v]) => [labelName(k), String(v)] as const);
			let total = 0;
			for (const series of family.series.values()) {
				if (pairs.every(([k, v]) => series.labels.some(([lk, lv]) => lk === k && lv === v))) total += series.value;
			}
			return total;
		},
		render() {
			const lines: string[] = [];
			for (const name of [...families.keys()].sort()) {
				const family = families.get(name);
				if (!family) continue;
				lines.push(`# TYPE ${name} ${family.kind}`);
				const keys = [...family.series.keys()].sort();
				for (const key of keys) {
					const series = family.series.get(key);
					if (!series) continue;
					if (family.kind !== "histogram" || !series.buckets) {
						lines.push(`${name}${formatLabels(series.labels)} ${series.value}`);
						continue;
					}
					let cumulative = 0;
					DEFAULT_BUCKETS.forEach((bound, i) => {
						cumulative += series.buckets?.[i] ?? 0;
						lines.push(`${name}_bucket${formatLabels([...series.labels, ["le", String(bound)]])} ${cumulative}`);
					});
					lines.push(`${name}_bucket${formatLabels([...series.labels, ["le", "+Inf"]])} ${series.value}`);
					lines.push(`${name}_sum${formatLabels(series.labels)} ${series.sum ?? 0}`);
					lines.push(`${name}_count${formatLabels(series.labels)} ${series.value}`);
				}
			}
			return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
		},
	};
}
