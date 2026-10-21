// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
//
// Tests for deploy/ultrathink-cert-renew.sh. The PKI script (ULTRATHINK_PKI), systemctl and nginx are stubs, so nothing
// here touches /etc, a service or a real certificate.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "ultrathink-cert-renew.sh");

// renew-if-due <tls-dir> <leaf>: a leaf listed in $DUE_FILE is renewed once, then it is no longer due.
const PKI_STUB = `#!/usr/bin/env bash
leaf="$3"
if grep -qx "$leaf" "$DUE_FILE" 2>/dev/null; then
	grep -vx "$leaf" "$DUE_FILE" >"$DUE_FILE.next" || true
	mv -- "$DUE_FILE.next" "$DUE_FILE"
	echo "renewed $leaf"
else
	echo "kept $leaf"
fi
`;

// The reload fails while $FAIL_RELOAD exists.
const SYSTEMCTL_STUB = `#!/usr/bin/env bash
echo "systemctl $*" >>"$CALLS"
if [ "$*" = "reload nginx" ] && [ -e "$FAIL_RELOAD" ]; then exit 1; fi
exit 0
`;

const NGINX_STUB = `#!/usr/bin/env bash
echo "nginx $*" >>"$CALLS"
exit 0
`;

const bases: string[] = [];

afterAll(() => {
	for (const dir of bases) rmSync(dir, { recursive: true, force: true });
});

function executable(path: string, body: string): void {
	writeFileSync(path, body);
	chmodSync(path, 0o755);
}

function setup(due: string[], failReload: boolean) {
	const base = mkdtempSync(join(tmpdir(), "cert-renew-"));
	bases.push(base);
	const bin = join(base, "bin");
	const tls = join(base, "tls");
	mkdirSync(bin);
	mkdirSync(tls);
	executable(join(bin, "systemctl"), SYSTEMCTL_STUB);
	executable(join(bin, "nginx"), NGINX_STUB);
	const pki = join(base, "pki-stub.sh");
	executable(pki, PKI_STUB);
	const dueFile = join(base, "due");
	writeFileSync(dueFile, due.map((name) => `${name}\n`).join(""));
	const calls = join(base, "calls");
	writeFileSync(calls, "");
	const failFile = join(base, "fail-reload");
	if (failReload) writeFileSync(failFile, "");
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		ULTRATHINK_TLS_DIR: tls,
		ULTRATHINK_PKI: pki,
		DUE_FILE: dueFile,
		CALLS: calls,
		FAIL_RELOAD: failFile,
	};
	return { tls, calls, failFile, env, marker: join(tls, ".reload-pending-edge") };
}

async function run(env: Record<string, string>): Promise<number> {
	const proc = Bun.spawn({ cmd: ["bash", SCRIPT], env, stdout: "pipe", stderr: "pipe" });
	await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return proc.exited;
}

function reloadCount(calls: string): number {
	return readFileSync(calls, "utf8")
		.split("\n")
		.filter((line) => line === "systemctl reload nginx").length;
}

// The hook runs under the host's bash, and its set -u behaviour on an empty array is bash-version specific. The stubs
// are /usr/bin/env bash scripts that assume the Linux userland, so this suite runs on Linux only, as the other host suites.
describe.skipIf(process.platform !== "linux")("ultrathink-cert-renew.sh", () => {
	test("a failed nginx reload after an edge renewal exits 1, and a later run retries the reload until it succeeds", async () => {
		const t = setup(["edge"], true);
		expect(await run(t.env)).toBe(1);
		expect(existsSync(t.marker)).toBe(true);
		// The leaf is no longer due, so only the pending marker brings the reload back.
		rmSync(t.failFile);
		expect(await run(t.env)).toBe(0);
		expect(existsSync(t.marker)).toBe(false);
		expect(reloadCount(t.calls)).toBe(2);
	});

	test("a successful edge reload leaves no marker, and a later run with nothing due reloads nothing", async () => {
		const t = setup(["edge"], false);
		expect(await run(t.env)).toBe(0);
		expect(existsSync(t.marker)).toBe(false);
		expect(await run(t.env)).toBe(0);
		expect(reloadCount(t.calls)).toBe(1);
	});
});
