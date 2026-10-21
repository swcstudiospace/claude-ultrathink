// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Compliance evidence report (Phase 75 POL-05). Reads the controls (policy/controls.json beside this script unless
// --controls is given), checks that each control's evidence paths exist under --root, records the sha256 of every
// present file, and writes Markdown. This is an engineering mapping, not an attestation: see
// docs/ops/compliance-mapping.md.
//
//   bun policy/compliance-report.ts [--root <dir>] [--controls <file>] [--out <file>]
//
// Status per control: FAIL when any evidence path is missing or is not a regular file; PENDING when the control has a
// `pending` reason and no evidence is missing; PASS otherwise. The whole controls file is validated before anything is
// evaluated, so a schema error never yields a partial report.
//
// Exit: 0 no control FAILs; 1 at least one FAIL (the report is still written); 2 usage, configuration or schema error
// (no report is written).

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_CONTROLS = join(import.meta.dir, "controls.json");
const USAGE = "usage: bun policy/compliance-report.ts [--root <dir>] [--controls <file>] [--out <file>]";
const FRAMEWORKS = ["soc2", "iso27001", "gdpr"] as const;
const FRAMEWORK_LABEL: Record<Framework, string> = { soc2: "SOC 2", iso27001: "ISO 27001", gdpr: "GDPR" };

type Framework = (typeof FRAMEWORKS)[number];
export type Status = "PASS" | "FAIL" | "PENDING";

export interface Finding {
	id: string;
	summary: string;
}

export interface Control {
	id: string;
	title: string;
	refs_status: string | undefined;
	refs: Record<Framework, string[]>;
	/** Repo-relative paths. Empty only when `pending` is set. */
	evidence: string[];
	pending: string | undefined;
	findings: Finding[];
}

export interface EvidenceResult {
	path: string;
	present: boolean;
	/** Set for present files only. */
	sha256: string | null;
}

export interface ControlResult {
	control: Control;
	status: Status;
	evidence: EvidenceResult[];
}

export interface Report {
	root: string;
	controlsSha256: string;
	controls: ControlResult[];
}

/** The controls file does not match the schema. Reported as exit 2 with no report. */
export class SchemaError extends Error {}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Obj, key: string, where: string): string {
	const value = obj[key];
	if (typeof value !== "string" || value.trim() === "") {
		throw new SchemaError(`${where}.${key}: expected a non-empty string`);
	}
	return value;
}

function stringArray(value: unknown, where: string): string[] {
	if (!Array.isArray(value)) throw new SchemaError(`${where}: expected an array of strings`);
	for (const item of value as unknown[]) {
		if (typeof item !== "string" || item.trim() === "") {
			throw new SchemaError(`${where}: every entry must be a non-empty string`);
		}
	}
	return value as string[];
}

/** Evidence is repo-relative: no absolute paths and no parent-directory segments. */
function checkEvidencePath(path: string, where: string): void {
	if (isAbsolute(path) || path.split("/").includes("..")) {
		throw new SchemaError(`${where}: evidence path must be repo-relative with no parent segment: ${path}`);
	}
}

function parseFindings(value: unknown, where: string): Finding[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new SchemaError(`${where}: expected an array`);
	return value.map((item, index) => {
		const at = `${where}[${index}]`;
		if (!isObject(item)) throw new SchemaError(`${at}: expected an object`);
		return { id: requireString(item, "id", at), summary: requireString(item, "summary", at) };
	});
}

function parseControl(value: unknown, where: string): Control {
	if (!isObject(value)) throw new SchemaError(`${where}: expected an object`);
	const id = requireString(value, "id", where);
	const at = `${where} (${id})`;
	const title = requireString(value, "title", at);
	const refsValue = value.refs;
	if (!isObject(refsValue)) throw new SchemaError(`${at}.refs: expected an object`);
	const refs: Record<Framework, string[]> = {
		soc2: stringArray(refsValue.soc2, `${at}.refs.soc2`),
		iso27001: stringArray(refsValue.iso27001, `${at}.refs.iso27001`),
		gdpr: stringArray(refsValue.gdpr, `${at}.refs.gdpr`),
	};
	const evidence = stringArray(value.evidence, `${at}.evidence`);
	for (const path of evidence) checkEvidencePath(path, `${at}.evidence`);
	const pending = value.pending === undefined ? undefined : requireString(value, "pending", at);
	if (evidence.length === 0 && pending === undefined) {
		throw new SchemaError(`${at}: no evidence and no pending reason`);
	}
	return {
		id,
		title,
		refs_status: value.refs_status === undefined ? undefined : requireString(value, "refs_status", at),
		refs,
		evidence,
		pending,
		findings: parseFindings(value.findings, `${at}.findings`),
	};
}

/** Parse and validate the whole controls file. Throws SchemaError on the first violation. */
export function parseControls(text: string): Control[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new SchemaError(`controls file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed)) throw new SchemaError("controls file must be a JSON array");
	const controls = parsed.map((value, index) => parseControl(value, `controls[${index}]`));
	const seen = new Set<string>();
	for (const control of controls) {
		if (seen.has(control.id)) throw new SchemaError(`duplicate control id: ${control.id}`);
		seen.add(control.id);
	}
	return controls;
}

function isRegularFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function evaluate(control: Control, root: string): ControlResult {
	const evidence = control.evidence.map((path): EvidenceResult => {
		const absolute = join(root, path);
		if (!isRegularFile(absolute)) return { path, present: false, sha256: null };
		const sha256 = createHash("sha256").update(readFileSync(absolute)).digest("hex");
		return { path, present: true, sha256 };
	});
	let status: Status = "PASS";
	if (evidence.some((item) => !item.present)) status = "FAIL";
	else if (control.pending !== undefined) status = "PENDING";
	return { control, status, evidence };
}

/** Pure given the controls text and the tree under root. */
export function buildReport(controlsText: string, root: string): Report {
	const controls = parseControls(controlsText);
	return {
		root,
		controlsSha256: createHash("sha256").update(controlsText).digest("hex"),
		controls: controls.map((control) => evaluate(control, root)),
	};
}

function cell(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderRefs(refs: Record<Framework, string[]>): string {
	return FRAMEWORKS.map((framework) => {
		const items = refs[framework];
		return `${FRAMEWORK_LABEL[framework]} ${items.length > 0 ? items.join(", ") : "none listed"}`;
	}).join("; ");
}

function countByStatus(report: Report, status: Status): number {
	return report.controls.filter((item) => item.status === status).length;
}

export function renderMarkdown(report: Report): string {
	const lines: string[] = [];
	lines.push("# Compliance evidence report", "");
	lines.push(
		"This is an engineering mapping, not an audit attestation. Clause references are marked for control-owner validation. See `docs/ops/compliance-mapping.md`.",
		"",
	);
	lines.push(`- Tree: \`${report.root}\``);
	lines.push(`- Controls file sha256: \`${report.controlsSha256}\``);
	lines.push(
		`- Result: ${countByStatus(report, "PASS")} PASS, ${countByStatus(report, "PENDING")} PENDING, ${countByStatus(report, "FAIL")} FAIL`,
		"",
	);
	lines.push("| Control | Title | Status | Evidence present | Findings |", "|---|---|---|---|---|");
	for (const { control, status, evidence } of report.controls) {
		const present = evidence.filter((item) => item.present).length;
		lines.push(
			`| \`${control.id}\` | ${cell(control.title)} | ${status} | ${present}/${evidence.length} | ${control.findings.length} |`,
		);
	}
	for (const { control, status, evidence } of report.controls) {
		lines.push("", `## ${control.id}: ${control.title}`, "");
		lines.push(`- Status: **${status}**`);
		lines.push(`- Clause references (${control.refs_status ?? "status not stated"}): ${renderRefs(control.refs)}`);
		if (evidence.length === 0) {
			lines.push("- Evidence: none (pending)");
		} else {
			lines.push("- Evidence:");
			for (const item of evidence) {
				lines.push(
					item.present
						? `  - \`${item.path}\` sha256 \`${item.sha256}\``
						: `  - \`${item.path}\` **MISSING** (not a regular file under the tree)`,
				);
			}
		}
		if (control.pending !== undefined) lines.push(`- Pending: ${control.pending}`);
		if (control.findings.length > 0) {
			lines.push("- Findings:");
			for (const finding of control.findings) lines.push(`  - **${finding.id}**: ${finding.summary}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

export function hasFail(report: Report): boolean {
	return report.controls.some((item) => item.status === "FAIL");
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function main(argv: readonly string[]): number {
	let values: { root?: string; controls?: string; out?: string; help?: boolean };
	try {
		({ values } = parseArgs({
			args: [...argv],
			options: {
				root: { type: "string" },
				controls: { type: "string" },
				out: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
			strict: true,
			allowPositionals: false,
		}));
	} catch (error) {
		process.stderr.write(`compliance-report: ${errorMessage(error)}\n${USAGE}\n`);
		return 2;
	}
	if (values.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	const root = resolve(values.root ?? DEFAULT_ROOT);
	if (!isDirectory(root)) {
		process.stderr.write(`compliance-report: --root is not a directory: ${root}\n`);
		return 2;
	}
	const controlsPath = resolve(values.controls ?? DEFAULT_CONTROLS);
	let report: Report;
	try {
		report = buildReport(readFileSync(controlsPath, "utf8"), root);
	} catch (error) {
		process.stderr.write(`compliance-report: ${controlsPath}: ${errorMessage(error)}\n`);
		return 2;
	}
	const markdown = renderMarkdown(report);
	try {
		if (values.out !== undefined) writeFileSync(resolve(values.out), markdown);
		else process.stdout.write(markdown);
	} catch (error) {
		process.stderr.write(`compliance-report: cannot write report: ${errorMessage(error)}\n`);
		return 2;
	}
	return hasFail(report) ? 1 : 0;
}

if (import.meta.main) {
	process.exitCode = main(process.argv.slice(2));
}
