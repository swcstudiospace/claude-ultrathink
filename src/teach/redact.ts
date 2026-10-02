// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Redaction for everything Teachable Moments stores or sends. A lesson is distilled from agent transcripts, so it can
 * carry API keys, auth headers, connection strings and absolute paths from the operator's home directory. `redactText`
 * runs before a moment is hashed, written to disk or retained in Hindsight, so none of those ever leaves the process.
 *
 * Idempotent (the replacement `[redacted]` matches no pattern) and never throws: a failure yields `[redacted]` rather
 * than the unredacted text.
 *
 * Paths: an absolute path under `options.home` that is not under `options.repoRoot` becomes `~/.../<last two segments>`
 * (`~/<segments>` when it has at most two, `~` for the home directory itself). A `repoRoot` that is the home directory
 * or one of its ancestors exempts nothing, so a session started in `~` still hides `~/.ssh/...`.
 */

export const REDACTED = "[redacted]";

export interface RedactOptions {
	/** Home directory whose absolute paths are hidden; default `process.env.HOME`. */
	home?: string;
	/** Paths under this directory stay readable (the project the lesson is about). */
	repoRoot?: string;
}

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/** A block cut off by a length cap has no END line: everything after BEGIN goes. */
const PEM_OPEN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g;
const URL_USERINFO = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/]+@/g;
const AUTH_HEADER = /(authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token|Digest)\s+)?[^\s"',;]+/gi;
const BEARER = /\bBearer(\s+)([A-Za-z0-9._~+/-]+=*)/gi;
const JWT = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g;
const TOKEN_PATTERNS: RegExp[] = [
	/\bsk-ant-[A-Za-z0-9_-]{8,}/g,
	/\bsk-[A-Za-z0-9_-]{16,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}/g,
];
const ASSIGNMENT = /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*[:=]\s*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"',;&|]+))/g;
const SECRET_WORDS = ["key", "token", "secret", "password", "passwd"];

/** Name tokens (split on non-alphanumerics and camelCase) that end in a secret word: API_KEY, apiKey, client-secret. "keyboard" is not. */
function isSecretName(name: string): boolean {
	const tokens = name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/);
	return tokens.some((token) => SECRET_WORDS.some((word) => token.endsWith(word) || token.endsWith(`${word}s`)));
}

/** `Bearer <word>` is a credential only when the word looks like one; "the Bearer key" and "Bearer token rotation" are prose. */
function redactBearer(text: string): string {
	return text.replace(BEARER, (match, _space: string, value: string) => {
		const dots = /\.+$/.exec(value)?.[0] ?? "";
		const core = dots ? value.slice(0, -dots.length) : value;
		const credential = core.length >= 16 || (core.length >= 6 && /\d/.test(core));
		if (!credential) return match;
		return `${REDACTED}${dots}`;
	});
}

function redactAssignments(text: string): string {
	return text.replace(ASSIGNMENT, (match, quote: string, name: string, sep: string, dq?: string, sq?: string, bare?: string) => {
		if (!isSecretName(name)) return match;
		// `key: value` is prose or YAML-ish prose; only the quoted JSON form `"key": "value"` is taken as an assignment.
		if (sep.includes(":") && quote === "") return match;
		const head = `${quote}${name}${quote}${sep}`;
		if (dq !== undefined) return `${head}"${REDACTED}"`;
		if (sq !== undefined) return `${head}'${REDACTED}'`;
		// Template references and JSX props (`key={id}`, `TOKEN=$TOKEN`) hold no secret.
		if (bare !== undefined && /^[$({<%]/.test(bare)) return match;
		return `${head}${REDACTED}`;
	});
}

function redactPaths(text: string, home: string, repoRoot: string | undefined): string {
	const base = home.replace(/\/+$/, "");
	if (!base.startsWith("/") || base === "") return text;
	// An exemption that covers the whole home directory would keep `~/.ssh` readable.
	const keep = repoRoot?.replace(/\/+$/, "");
	const exempt = keep?.startsWith("/") && base !== keep && !base.startsWith(`${keep}/`) ? keep : undefined;
	const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`(?<![\\w.~-])${escaped}(?:/[^\\s"'\`<>()\\[\\]{},;|\\\\]*)?(?![\\w-])`, "g");
	return text.replace(pattern, (match) => {
		const trailing = /[.:]+$/.exec(match)?.[0] ?? "";
		const path = trailing ? match.slice(0, -trailing.length) : match;
		if (exempt && (path === exempt || path.startsWith(`${exempt}/`))) return match;
		const segments = path.slice(base.length).split("/").filter(Boolean);
		const shown = segments.length <= 2 ? segments.join("/") : `.../${segments.slice(-2).join("/")}`;
		return `${shown ? `~/${shown}` : "~"}${trailing}`;
	});
}

export function redactText(text: string, options: RedactOptions = {}): string {
	try {
		if (typeof text !== "string" || text === "") return "";
		let out = text.replace(PEM_BLOCK, REDACTED).replace(PEM_OPEN, REDACTED);
		out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
		out = out.replace(AUTH_HEADER, `$1${REDACTED}`);
		out = redactBearer(out).replace(JWT, REDACTED);
		for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
		out = redactAssignments(out);
		const home = options.home ?? process.env.HOME;
		if (home) out = redactPaths(out, home, options.repoRoot);
		return out;
	} catch {
		return REDACTED;
	}
}

/** Redacted, whitespace collapsed to single spaces, at most `max` characters: for error text that ends up in a result, a log line or a file. */
export function redactLine(text: string, max = 200): string {
	return redactText(text).replace(/\s+/g, " ").trim().slice(0, max);
}
