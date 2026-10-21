// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
//
// Tests for deploy/drift-check.sh. Each test builds a release-shaped tree under a temp directory (deploy/ as the unit
// directory, a separate installed/ directory standing in for /etc/systemd/system) and runs the real script through
// Bun.spawn. Nothing here touches /etc, systemd or a production host. The live cases copy the script into the temp tree
// beside a stub policy/check.sh, so no network and no OPA binary are involved.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "drift-check.sh");
const UNIT_BODY = "[Unit]\nDescription=test unit\n\n[Service]\nType=oneshot\n";
const STUB_CHECK = ["#!/usr/bin/env bash", "printf 'stub check %s\\n' \"$*\"", "exit \"${STUB_EXIT:-0}\"", ""].join("\n");
const LIVE_URL = "http://127.0.0.1:9/";

type UnitEntry = {
	name: string;
	status: string;
	source_sha256: string;
	installed_sha256: string | null;
};

type Report = {
	tool: string;
	hash: string;
	units: UnitEntry[];
	drift_count: number;
	missing_count: number;
	live: { url: string; exit_code: number; status: string } | null;
	status: string;
};

type Fixture = { root: string; unitDir: string; installDir: string; report: string };

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): Fixture {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "drift-check-"));
	temps.push(root);
	const unitDir = join(root, "deploy");
	const installDir = join(root, "installed");
	mkdirSync(unitDir);
	mkdirSync(installDir);
	return { root, unitDir, installDir, report: join(root, "report.json") };
}

// Same length, one bit flipped in the first byte.
function oneByteEdited(): Buffer {
	const bytes = Buffer.from(UNIT_BODY);
	bytes[0] = (bytes[0] ?? 0) ^ 0x01;
	return bytes;
}

function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

// Digest of every name and byte in a directory, so a test can prove a directory was not written.
function dirDigest(dir: string): string {
	const hash = createHash("sha256");
	for (const name of readdirSync(dir).sort()) {
		hash.update(name);
		hash.update("\0");
		hash.update(readFileSync(join(dir, name)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function baseArgs(f: Fixture): string[] {
	return ["--unit-dir", f.unitDir, "--install-dir", f.installDir, "--report", f.report];
}

async function runScript(
	args: string[],
	env: Record<string, string> = {},
	script = SCRIPT,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ["bash", script, ...args],
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

function readReport(path: string): Report {
	return JSON.parse(readFileSync(path, "utf8")) as Report;
}

function entry(report: Report, name: string): UnitEntry {
	const found = report.units.find((unit) => unit.name === name);
	if (!found) throw new Error(`no unit ${name} in report`);
	return found;
}

// Copies the script into the temp tree beside a stub policy/check.sh, so --live resolves to the stub.
function liveFixture(f: Fixture): string {
	const script = join(f.root, "deploy", "drift-check.sh");
	copyFileSync(SCRIPT, script);
	mkdirSync(join(f.root, "policy"));
	writeFileSync(join(f.root, "policy", "check.sh"), STUB_CHECK);
	return script;
}

test("reports ok, drift and missing per unit and exits 1", async () => {
	const f = fixture();
	writeFileSync(join(f.unitDir, "ultrathink-a.service"), UNIT_BODY);
	writeFileSync(join(f.unitDir, "ultrathink-b.service"), UNIT_BODY);
	writeFileSync(join(f.unitDir, "ultrathink-c.timer"), UNIT_BODY);
	writeFileSync(join(f.installDir, "ultrathink-a.service"), UNIT_BODY);
	writeFileSync(join(f.installDir, "ultrathink-b.service"), oneByteEdited());

	const result = await runScript(baseArgs(f));

	expect(result.exitCode).toBe(1);
	const report = readReport(f.report);
	expect(report.tool).toBe("drift-check.sh");
	expect(report.status).toBe("fail");
	expect(report.drift_count).toBe(1);
	expect(report.missing_count).toBe(1);
	expect(report.live).toBeNull();
	expect(report.units.map((unit) => unit.name)).toEqual([
		"ultrathink-a.service",
		"ultrathink-b.service",
		"ultrathink-c.timer",
	]);
	expect(entry(report, "ultrathink-a.service").status).toBe("ok");
	expect(entry(report, "ultrathink-b.service").status).toBe("drift");
	expect(entry(report, "ultrathink-c.timer").status).toBe("missing");
	expect(entry(report, "ultrathink-c.timer").installed_sha256).toBeNull();

	const drifted = entry(report, "ultrathink-b.service");
	expect(drifted.source_sha256).toBe(sha256Hex(UNIT_BODY));
	expect(drifted.installed_sha256).toBe(sha256Hex(oneByteEdited()));
	expect(result.stdout).toBe("");
});

test("remediation plan prints the install command for the drifted unit and leaves the install dir byte-identical", async () => {
	const f = fixture();
	writeFileSync(join(f.unitDir, "ultrathink-a.service"), UNIT_BODY);
	writeFileSync(join(f.unitDir, "ultrathink-b.service"), UNIT_BODY);
	writeFileSync(join(f.installDir, "ultrathink-a.service"), UNIT_BODY);
	writeFileSync(join(f.installDir, "ultrathink-b.service"), oneByteEdited());
	const before = dirDigest(f.installDir);

	const result = await runScript([...baseArgs(f), "--remediation-plan"]);

	expect(result.exitCode).toBe(1);
	const unitPath = join(f.unitDir, "ultrathink-b.service");
	expect(result.stdout).toContain(`install -m 0644 ${unitPath} ${f.installDir}/\n`);
	expect(result.stdout).toContain("systemctl daemon-reload\n");
	expect(result.stdout).not.toContain("ultrathink-a.service");
	expect(dirDigest(f.installDir)).toBe(before);
	expect(readReport(f.report).drift_count).toBe(1);
});

test("all identical units exit 0 with no drift or missing entries", async () => {
	const f = fixture();
	writeFileSync(join(f.unitDir, "ultrathink-a.service"), UNIT_BODY);
	writeFileSync(join(f.unitDir, "ultrathink-b.timer"), UNIT_BODY);
	writeFileSync(join(f.installDir, "ultrathink-a.service"), UNIT_BODY);
	writeFileSync(join(f.installDir, "ultrathink-b.timer"), UNIT_BODY);

	const result = await runScript([...baseArgs(f), "--remediation-plan"]);

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe("");
	const report = readReport(f.report);
	expect(report.status).toBe("ok");
	expect(report.drift_count).toBe(0);
	expect(report.missing_count).toBe(0);
	expect(report.units.map((unit) => unit.status)).toEqual(["ok", "ok"]);
	expect(entry(report, "ultrathink-a.service").installed_sha256).toBe(entry(report, "ultrathink-a.service").source_sha256);
});

test("a failing live check is recorded in the report and fails the run", async () => {
	const f = fixture();
	writeFileSync(join(f.unitDir, "ultrathink-a.service"), UNIT_BODY);
	writeFileSync(join(f.installDir, "ultrathink-a.service"), UNIT_BODY);
	const script = liveFixture(f);

	const result = await runScript([...baseArgs(f), "--live", LIVE_URL], { STUB_EXIT: "3" }, script);

	expect(result.exitCode).toBe(1);
	const report = readReport(f.report);
	expect(report.drift_count).toBe(0);
	expect(report.live).toEqual({ url: LIVE_URL, exit_code: 3, status: "fail" });
	expect(report.status).toBe("fail");
});

test("a passing live check is recorded and the run exits 0 when units are identical", async () => {
	const f = fixture();
	writeFileSync(join(f.unitDir, "ultrathink-a.service"), UNIT_BODY);
	writeFileSync(join(f.installDir, "ultrathink-a.service"), UNIT_BODY);
	const script = liveFixture(f);

	const result = await runScript([...baseArgs(f), "--live", LIVE_URL], { STUB_EXIT: "0" }, script);

	expect(result.exitCode).toBe(0);
	const report = readReport(f.report);
	expect(report.live).toEqual({ url: LIVE_URL, exit_code: 0, status: "pass" });
	expect(report.status).toBe("ok");
});

test("a nonexistent unit dir exits 2 and writes no report", async () => {
	const f = fixture();
	const missingUnits = join(f.root, "absent");

	const result = await runScript(["--unit-dir", missingUnits, "--install-dir", f.installDir, "--report", f.report]);

	expect(result.exitCode).toBe(2);
	expect(result.stderr).toContain("unit dir is not a directory");
	expect(existsSync(f.report)).toBe(false);
});

test("an unknown argument exits 2 and writes no report", async () => {
	const f = fixture();
	writeFileSync(join(f.unitDir, "ultrathink-a.service"), UNIT_BODY);

	const result = await runScript([...baseArgs(f), "--no-such-flag"]);

	expect(result.exitCode).toBe(2);
	expect(result.stderr).toContain("usage: drift-check.sh");
	expect(existsSync(f.report)).toBe(false);
});
