// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	isRemoteSession,
	mountTailscale,
	parseSshConnection,
	planRedirect,
	readTailscaleDns,
	unmountTailscale,
} from "./redirect.ts";
import type { Run } from "./redirect.ts";

const DNS = "vps.example.ts.net";
const SSH = "198.51.100.4 51234 203.0.113.7 22";
const MOUNT = { https: 443, path: "/ultrathink-oauth", target: "http://127.0.0.1:8765" };

function fakeRun(result: { exitCode: number; stdout: string }): { run: Run; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		run: (argv) => {
			calls.push(argv);
			return result;
		},
	};
}

function tailscaleStatus(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ BackendState: "Running", Self: { DNSName: `${DNS}.` }, CertDomains: [DNS], ...overrides });
}

function unreachable(): string | undefined {
	throw new Error("tailscaleDns must not be called");
}

describe("parseSshConnection", () => {
	test("parses IPv4 and IPv6", () => {
		expect(parseSshConnection(SSH)).toEqual({ clientIp: "198.51.100.4", serverIp: "203.0.113.7", serverPort: 22 });
		expect(parseSshConnection("2001:db8::2 40000 2001:db8::1 2222")).toEqual({
			clientIp: "2001:db8::2",
			serverIp: "2001:db8::1",
			serverPort: 2222,
		});
	});

	test("rejects missing, malformed and hostile values", () => {
		for (const value of [
			undefined,
			"",
			"198.51.100.4 51234 203.0.113.7",
			"198.51.100.4 51234 203.0.113.7 22 extra",
			"198.51.100.4 51234 203.0.113.256 22",
			"198.51.100.4 51234 203.0.113 22",
			"198.51.100.4 51234 203.0.113.7 70000",
			"198.51.100.4 51234 203.0.113.7 0",
			"198.51.100.4 port 203.0.113.7 22",
			"198.51.100.4 51234 1.2.3.4;rm -rf 22",
			"198.51.100.4 51234 1.2.3.4; rm -rf",
			"198.51.100.4 51234 $(id) 22",
			"198.51.100.4 51234 example.com 22",
		]) {
			expect(parseSshConnection(value)).toBeUndefined();
		}
	});
});

describe("isRemoteSession", () => {
	test("detects each SSH variable", () => {
		expect(isRemoteSession({ SSH_CONNECTION: SSH })).toBe(true);
		expect(isRemoteSession({ SSH_CLIENT: "198.51.100.4 51234 22" })).toBe(true);
		expect(isRemoteSession({ SSH_TTY: "/dev/pts/0" })).toBe(true);
	});

	test("is local without SSH variables or with only an invalid SSH_CONNECTION", () => {
		expect(isRemoteSession({})).toBe(false);
		expect(isRemoteSession({ SSH_CLIENT: "", SSH_TTY: "" })).toBe(false);
		expect(isRemoteSession({ SSH_CONNECTION: "garbage" })).toBe(false);
	});
});

describe("readTailscaleDns", () => {
	test("returns the DNS name without the trailing dot when running and certifiable", () => {
		const { run, calls } = fakeRun({ exitCode: 0, stdout: tailscaleStatus() });
		expect(readTailscaleDns(run)).toBe(DNS);
		expect(calls).toEqual([["tailscale", "status", "--json"]]);
	});

	test("fails closed", () => {
		for (const result of [
			{ exitCode: 0, stdout: tailscaleStatus({ BackendState: "Stopped" }) },
			{ exitCode: 0, stdout: tailscaleStatus({ CertDomains: ["other.example.ts.net"] }) },
			{ exitCode: 0, stdout: tailscaleStatus({ CertDomains: undefined }) },
			{ exitCode: 0, stdout: tailscaleStatus({ Self: null }) },
			{ exitCode: 0, stdout: "{not json" },
			{ exitCode: 0, stdout: "null" },
			{ exitCode: 1, stdout: tailscaleStatus() },
			{ exitCode: 127, stdout: "" },
		]) {
			expect(readTailscaleDns(fakeRun(result).run)).toBeUndefined();
		}
	});

	test("never throws when the runner throws", () => {
		expect(
			readTailscaleDns(() => {
				throw new Error("spawn failed");
			}),
		).toBeUndefined();
	});
});

describe("planRedirect", () => {
	const remoteEnv = { SSH_CONNECTION: SSH, USER: "alice" };

	test("the --redirect flag beats the environment override", () => {
		const plan = planRedirect({
			env: { ...remoteEnv, ULTRATHINK_OAUTH_REDIRECT: "https://env.example.com/cb" },
			port: 8765,
			redirect: "https://flag.example.com/oauth/cb",
			tailscaleDns: unreachable,
		});
		expect(plan.mode).toBe("override");
		expect(plan.redirectUri).toBe("https://flag.example.com/oauth/cb");
		expect(plan.callbackPaths).toEqual(["/oauth/cb"]);
		expect(plan.mount).toBeUndefined();
		expect(plan.hint.join("\n")).toContain("127.0.0.1:8765");
	});

	test("the environment override beats Tailscale", () => {
		const plan = planRedirect({
			env: { ...remoteEnv, ULTRATHINK_OAUTH_REDIRECT: "http://localhost:9000/cb" },
			port: 9000,
			tailscaleDns: unreachable,
		});
		expect(plan).toMatchObject({ mode: "override", redirectUri: "http://localhost:9000/cb", port: 9000 });
	});

	test("accepts http only for loopback hosts", () => {
		for (const redirect of ["http://127.0.0.1:8765/cb", "http://[::1]:8765/cb", "https://auth.example.com/cb"]) {
			expect(planRedirect({ env: {}, port: 8765, redirect, tailscaleDns: unreachable }).mode).toBe("override");
		}
		for (const redirect of ["http://auth.example.com/cb", "http://constructor/cb", "ftp://127.0.0.1/cb", "not a url"]) {
			expect(() => planRedirect({ env: {}, port: 8765, redirect, tailscaleDns: unreachable })).toThrow(
				"invalid redirect URL",
			);
		}
	});

	test("remote with Tailscale routes the callback through a serve path handler", () => {
		const plan = planRedirect({ env: remoteEnv, port: 8765, tailscaleDns: () => DNS });
		expect(plan).toEqual({
			mode: "tailscale",
			redirectUri: `https://${DNS}/ultrathink-oauth/callback`,
			port: 8765,
			callbackPaths: ["/callback", "/ultrathink-oauth/callback"],
			remote: true,
			mount: MOUNT,
			hint: expect.any(Array),
		});
		expect(plan.hint.join("\n")).toContain(`https://${DNS}/ultrathink-oauth/callback`);
	});

	test("remote without Tailscale explains port forwarding", () => {
		const plan = planRedirect({ env: remoteEnv, port: 9123, tailscaleDns: () => undefined });
		expect(plan).toMatchObject({
			mode: "loopback",
			redirectUri: "http://127.0.0.1:9123/callback",
			callbackPaths: ["/callback"],
			remote: true,
		});
		expect(plan.mount).toBeUndefined();
		const hint = plan.hint.join("\n");
		expect(hint).toContain("Termius");
		expect(hint).toContain("127.0.0.1:9123");
		expect(hint).toContain("ssh -L 9123:127.0.0.1:9123 alice@203.0.113.7");
		expect(hint).toContain("pasting the redirected URL");
	});

	test("remote with a malformed SSH_CONNECTION omits the ssh line", () => {
		const plan = planRedirect({
			env: { SSH_CONNECTION: "198.51.100.4 51234 1.2.3.4;rm -rf 22", SSH_TTY: "/dev/pts/0" },
			port: 8765,
			tailscaleDns: () => undefined,
		});
		expect(plan).toMatchObject({ mode: "loopback", remote: true });
		const hint = plan.hint.join("\n");
		expect(hint).toContain("Termius");
		expect(hint).not.toContain("ssh -L");
		expect(hint).not.toContain("rm -rf");
	});

	test("local sessions keep the plain loopback login without probing Tailscale", () => {
		const plan = planRedirect({ env: {}, port: 8765, tailscaleDns: unreachable });
		expect(plan).toMatchObject({
			mode: "loopback",
			redirectUri: "http://127.0.0.1:8765/callback",
			callbackPaths: ["/callback"],
			remote: false,
		});
		expect(plan.hint).toHaveLength(1);
	});
});

describe("tailscale serve mount", () => {
	test("mount adds the path handler in the background", () => {
		const { run, calls } = fakeRun({ exitCode: 0, stdout: "" });
		expect(mountTailscale(MOUNT, run)).toBe(true);
		expect(calls).toEqual([
			["tailscale", "serve", "--bg", "--https=443", "--set-path=/ultrathink-oauth", "http://127.0.0.1:8765"],
		]);
	});

	test("mount reports failure on a non-zero exit", () => {
		expect(mountTailscale(MOUNT, fakeRun({ exitCode: 1, stdout: "" }).run)).toBe(false);
	});

	test("unmount removes only its path handler and swallows errors", () => {
		const { run, calls } = fakeRun({ exitCode: 1, stdout: "" });
		unmountTailscale(MOUNT, run);
		expect(calls).toEqual([["tailscale", "serve", "--https=443", "--set-path=/ultrathink-oauth", "off"]]);
		expect(() =>
			unmountTailscale(MOUNT, () => {
				throw new Error("spawn failed");
			}),
		).not.toThrow();
	});
});
