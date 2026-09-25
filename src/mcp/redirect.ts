// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { isIP } from "node:net";

export type RedirectMode = "loopback" | "tailscale" | "override";

export interface RedirectPlan {
	mode: RedirectMode;
	/** Registered with the OAuth server and sent on authorize/token. */
	redirectUri: string;
	/** Local listener port, always bound on 127.0.0.1. */
	port: number;
	/** Pathnames the listener accepts. */
	callbackPaths: string[];
	/** SSH session detected. */
	remote: boolean;
	/** `tailscale serve` handler to add for the login and remove afterwards. */
	mount?: { https: number; path: string; target: string };
	/** Lines printed before waiting: how the browser gets back here. */
	hint: string[];
}

export type Run = (argv: string[], timeoutMs: number) => { exitCode: number; stdout: string };

const TAILSCALE_PATH = "/ultrathink-oauth";
const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true };
const DNS_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export const defaultRun: Run = (argv, timeoutMs) => {
	try {
		const result = Bun.spawnSync({ cmd: argv, timeout: timeoutMs, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		return { exitCode: result.success ? 0 : result.exitCode || 1, stdout: result.stdout.toString() };
	} catch {
		return { exitCode: 127, stdout: "" };
	}
};

export function parseSshConnection(
	value: string | undefined,
): { clientIp: string; serverIp: string; serverPort: number } | undefined {
	const fields = value?.trim().split(/\s+/);
	if (!fields || fields.length !== 4) return undefined;
	const [clientIp = "", clientPort = "", serverIp = "", serverPortText = ""] = fields;
	if (!isIP(clientIp) || !isIP(serverIp)) return undefined;
	if (!/^\d{1,5}$/.test(clientPort) || !/^\d{1,5}$/.test(serverPortText)) return undefined;
	const serverPort = Number(serverPortText);
	if (serverPort < 1 || serverPort > 65535 || Number(clientPort) > 65535) return undefined;
	return { clientIp, serverIp, serverPort };
}

export function isRemoteSession(env: Record<string, string | undefined>): boolean {
	return parseSshConnection(env.SSH_CONNECTION) !== undefined || Boolean(env.SSH_CLIENT) || Boolean(env.SSH_TTY);
}

export function readTailscaleDns(run: Run): string | undefined {
	try {
		const { exitCode, stdout } = run(["tailscale", "status", "--json"], 3000);
		if (exitCode !== 0) return undefined;
		const status = JSON.parse(stdout) as
			| { BackendState?: unknown; Self?: { DNSName?: unknown } | null; CertDomains?: unknown }
			| null;
		if (status?.BackendState !== "Running") return undefined;
		const raw = status.Self?.DNSName;
		if (typeof raw !== "string") return undefined;
		const dns = raw.replace(/\.$/, "");
		if (!DNS_NAME.test(dns)) return undefined;
		return Array.isArray(status.CertDomains) && status.CertDomains.includes(dns) ? dns : undefined;
	} catch {
		return undefined;
	}
}

function overridePlan(raw: string, port: number, remote: boolean): RedirectPlan {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`invalid redirect URL: ${raw}`);
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS[url.hostname] === true)) {
		throw new Error(`invalid redirect URL: ${raw} (use https, or http only for 127.0.0.1, localhost or [::1])`);
	}
	return {
		mode: "override",
		redirectUri: url.href,
		port,
		callbackPaths: [url.pathname],
		remote,
		hint: [
			`The callback listener is on 127.0.0.1:${port}; ${url.href} must reach it (path ${url.pathname}).`,
		],
	};
}

function loopbackPlan(
	env: Record<string, string | undefined>,
	port: number,
	remote: boolean,
	suggestTailscale: boolean,
): RedirectPlan {
	const redirectUri = `http://127.0.0.1:${port}/callback`;
	const plan: RedirectPlan = { mode: "loopback", redirectUri, port, callbackPaths: ["/callback"], remote, hint: [] };
	if (!remote) {
		plan.hint.push(
			"If this machine has no browser: open it elsewhere, approve, then copy the full URL of the page you are redirected to (it may fail to load) and paste it here.",
		);
		return plan;
	}
	plan.hint.push(
		`Remote session detected: the browser sends you back to ${redirectUri}, and in the browser 127.0.0.1 is your local computer, not this host. Forward port ${port} first:`,
		`  Termius: Port Forwarding -> Local: bind 127.0.0.1:${port} on this computer -> destination 127.0.0.1:${port} through this SSH host`,
	);
	const serverIp = parseSshConnection(env.SSH_CONNECTION)?.serverIp;
	if (serverIp) {
		const user = env.USER || env.LOGNAME || "<user>";
		plan.hint.push(`  OpenSSH: ssh -L ${port}:127.0.0.1:${port} ${user}@${serverIp}`);
	}
	plan.hint.push("Without forwarding, pasting the redirected URL (the page may fail to load) still works.");
	if (suggestTailscale) {
		plan.hint.push(
			"On a tailnet host you can pass --tailscale (or set ULTRATHINK_OAUTH_TAILSCALE=1) to receive the callback over `tailscale serve`.",
		);
	}
	return plan;
}

/**
 * Picks the OAuth callback route: an explicit override, then the Tailscale route (only when `tailscale` is
 * requested, the session is remote and Tailscale serves HTTPS), then the loopback listener.
 */
export function planRedirect(input: {
	env: Record<string, string | undefined>;
	port: number;
	redirect?: string;
	/** Opt-in (`--tailscale` / `ULTRATHINK_OAUTH_TAILSCALE=1`); without it `tailscale` is never run. */
	tailscale: boolean;
	tailscaleDns: () => string | undefined;
}): RedirectPlan {
	const { env, port } = input;
	const remote = isRemoteSession(env);
	const override = input.redirect || env.ULTRATHINK_OAUTH_REDIRECT;
	if (override) return overridePlan(override, port, remote);
	const dns = remote && input.tailscale ? input.tailscaleDns() : undefined;
	if (!dns) return loopbackPlan(env, port, remote, !input.tailscale);
	const redirectUri = `https://${dns}${TAILSCALE_PATH}/callback`;
	return {
		mode: "tailscale",
		redirectUri,
		port,
		callbackPaths: ["/callback", `${TAILSCALE_PATH}/callback`],
		remote,
		mount: { https: 443, path: TAILSCALE_PATH, target: `http://127.0.0.1:${port}` },
		hint: [
			`Remote session detected: the browser returns through Tailscale to ${redirectUri}.`,
			"Open the URL on a device signed in to the same tailnet and the login finishes by itself.",
		],
	};
}

export function mountTailscale(mount: NonNullable<RedirectPlan["mount"]>, run: Run): boolean {
	try {
		return run(["tailscale", "serve", "--bg", `--https=${mount.https}`, `--set-path=${mount.path}`, mount.target], 10_000)
			.exitCode === 0;
	} catch {
		return false;
	}
}

export function unmountTailscale(mount: NonNullable<RedirectPlan["mount"]>, run: Run): void {
	try {
		run(["tailscale", "serve", `--https=${mount.https}`, `--set-path=${mount.path}`, "off"], 10_000);
	} catch {
		// Best effort: a leftover handler only proxies to a closed local port.
	}
}
