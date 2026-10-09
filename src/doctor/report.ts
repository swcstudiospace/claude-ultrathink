// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Turns findings into the report doctor prints, as text or as one JSON object. Every string that leaves this module passes
 * through `redactSecrets`, so a bearer token or JWT that reached a finding by accident is masked rather than printed.
 */
import { redactSecrets } from "../grok/auth.ts";
import { DOCTOR_SECTIONS, type DoctorLevel, type DoctorReport, type Finding } from "./types.ts";

const MARKERS: Record<DoctorLevel, string> = { ok: "✓", info: "i", warn: "!", error: "✗" };

/** Findings in section order (stable within a section), the level counts, and `ok` = no error finding. */
export function buildReport(findings: readonly Finding[]): DoctorReport {
	const ordered = DOCTOR_SECTIONS.flatMap((section) => findings.filter((finding) => finding.section === section));
	const summary: DoctorReport["summary"] = { error: 0, warn: 0, info: 0, ok: 0 };
	for (const finding of ordered) summary[finding.level]++;
	return { ok: summary.error === 0, summary, findings: ordered };
}

function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function formatReport(report: DoctorReport): string {
	const lines = ["ultrathink doctor"];
	for (const section of DOCTOR_SECTIONS) {
		lines.push(section);
		for (const finding of report.findings.filter((candidate) => candidate.section === section)) {
			lines.push(`  ${MARKERS[finding.level]} ${finding.title}`);
			if (finding.detail) lines.push(...finding.detail.split("\n").map((line) => `      ${line}`));
			if (finding.fix) lines.push(`      fix: ${finding.fix}`);
		}
	}
	lines.push(`${count(report.summary.error, "error")}, ${count(report.summary.warn, "warning")}`);
	return lines.map(redactSecrets).join("\n");
}

/** One compact JSON object with a fixed key order: `ok`, `summary`, then `findings` (each `id`, `section`, `level`, `title`, `detail`, `fix`). */
export function reportJson(report: DoctorReport): string {
	return JSON.stringify({
		ok: report.ok,
		summary: { error: report.summary.error, warn: report.summary.warn, info: report.summary.info, ok: report.summary.ok },
		findings: report.findings.map((finding) => ({
			id: redactSecrets(finding.id),
			section: finding.section,
			level: finding.level,
			title: redactSecrets(finding.title),
			...(finding.detail ? { detail: redactSecrets(finding.detail) } : {}),
			...(finding.fix ? { fix: redactSecrets(finding.fix) } : {}),
		})),
	});
}
