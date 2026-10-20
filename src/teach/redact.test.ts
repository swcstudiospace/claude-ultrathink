// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { redactLine, redactText } from "./redact.ts";

// Fake credentials are assembled at runtime so no scanner mistakes this file for a leak.
const OPENAI = `sk-${"a1B2".repeat(6)}`;
const ANTHROPIC = `sk-ant-api03-${"Zx9_".repeat(6)}`;
const GITHUB = `ghp_${"a1".repeat(18)}`;
const GITHUB_PAT = `github_pat_${"A1b2".repeat(6)}`;
const SLACK = `xoxb-${"1234567890"}-${"abcdefghij"}`;
const AWS = `AKIA${"IOSFODNN7EXAMPLE"}`;
const GOOGLE = `AIza${"Sy".concat("A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6")}`;
const JWT = `eyJ${"h".repeat(30)}.eyJ${"p".repeat(30)}.${"s".repeat(20)}`;

describe("redactText: secrets", () => {
	test.each([
		["OpenAI key", OPENAI],
		["Anthropic key", ANTHROPIC],
		["GitHub token", GITHUB],
		["GitHub fine-grained token", GITHUB_PAT],
		["Slack token", SLACK],
		["AWS access key id", AWS],
		["Google API key", GOOGLE],
		["JWT", JWT],
	])("%s is replaced", (_label, secret) => {
		const out = redactText(`before ${secret} after`);
		expect(out).toBe("before [redacted] after");
	});

	test("every GitHub token prefix is covered", () => {
		for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
			expect(redactText(`${prefix}${"x9".repeat(15)}`)).toBe("[redacted]");
		}
	});

	test("Bearer tokens and Authorization header values go, in plain and JSON form", () => {
		expect(redactText("curl -H 'Authorization: Bearer abc.def-ghi' https://x")).not.toContain("abc.def");
		expect(redactText("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [redacted]");
		expect(redactText('{"Authorization": "Token s3cr3tvalue"}')).toBe('{"Authorization": "[redacted]"}');
		expect(redactText("sent Bearer abcdef123456 to the proxy")).toBe("sent [redacted] to the proxy");
	});

	test("Bearer followed by an ordinary word is prose; only credential-shaped values are redacted", () => {
		for (const prose of ["send it with the Bearer key as the health probe", "Bearer token rotation matters", "the Bearer header"]) {
			expect(redactText(prose)).toBe(prose);
		}
		expect(redactText("Bearer abcdef1234567890abcdef")).toBe("[redacted]");
		expect(redactText("use bearer abcdefghijklmnopq now")).toBe("use [redacted] now");
		expect(redactText("Bearer abc12345")).toBe("[redacted]");
		expect(redactText("Bearer abc123")).toBe("[redacted]");
		expect(redactText("Bearer abcdefgh")).toBe("Bearer abcdefgh");
		expect(redactText("Authorization: Bearer sk-live_1234567890")).toBe("Authorization: [redacted]");
		expect(redactText("it sent Bearer abcdef1234567890abcdef.")).toBe("it sent [redacted].");
		for (const text of ["the Bearer key", "Bearer abc12345", "Authorization: Bearer sk-live_1234567890"]) {
			const once = redactText(text);
			expect(redactText(once)).toBe(once);
		}
	});

	test("a PEM private key block is replaced whole, and a block cut by a length cap loses everything after BEGIN", () => {
		const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdef\n-----END RSA PRIVATE KEY-----";
		expect(redactText(`key:\n${block}\nend`)).toBe("key:\n[redacted]\nend");
		expect(redactText("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq")).toBe("[redacted]");
	});

	test("userinfo in a URL is replaced and the host stays", () => {
		expect(redactText("postgres://admin:s3cr3t@db.internal:5432/app")).toBe("postgres://[redacted]@db.internal:5432/app");
		expect(redactText("see http://localhost:3000/a@b for details")).toBe("see http://localhost:3000/a@b for details");
	});

	test("NAME=value and quoted JSON assignments keep the name and lose the value", () => {
		expect(redactText("export OPENAI_API_KEY=hunter2")).toBe("export OPENAI_API_KEY=[redacted]");
		expect(redactText('{"password": "hunter2", "user": "bob"}')).toBe('{"password": "[redacted]", "user": "bob"}');
		expect(redactText("DB_PASSWD='two words'")).toBe("DB_PASSWD='[redacted]'");
		expect(redactText("client_secret = topsecret")).toBe("client_secret = [redacted]");
		expect(redactText("--api-key=abc123 --verbose")).toBe("--api-key=[redacted] --verbose");
		expect(redactText("githubToken=abc")).toBe("githubToken=[redacted]");
	});

	test("names that only contain a secret word inside another word, references and prose are left alone", () => {
		expect(redactText("keyboard=qwerty")).toBe("keyboard=qwerty");
		expect(redactText("<li key={id}>")).toBe("<li key={id}>");
		expect(redactText("TOKEN=$TOKEN")).toBe("TOKEN=$TOKEN");
		expect(redactText("Key: use import type for type-only imports")).toBe("Key: use import type for type-only imports");
	});

	test("API key, auth token and cookie headers lose their value, in any case and in JSON form", () => {
		expect(redactText("X-API-Key: sk_live_1234567890abcdef")).toBe("X-API-Key: [redacted]");
		expect(redactText("x-api-key=sk_live_1234567890abcdef")).toBe("x-api-key=[redacted]");
		expect(redactText("Api-Key: abc")).toBe("Api-Key: [redacted]");
		expect(redactText("X-Auth-Token: t0k3n")).toBe("X-Auth-Token: [redacted]");
		expect(redactText("Proxy-Authorization: Basic dXNlcjpwYXNz")).toBe("Proxy-Authorization: [redacted]");
		expect(redactText("Cookie: session=abcdef0123456789")).toBe("Cookie: [redacted]");
		expect(redactText("Set-Cookie: auth=abcdef0123456789; Path=/; HttpOnly")).toBe("Set-Cookie: [redacted]");
		expect(redactText("Cookie: theme=dark; sid=abc123456789xyz")).toBe("Cookie: [redacted]");
		expect(redactText('{"cookie": "session=abcdef0123456789"}')).toBe('{"cookie": "[redacted]"}');
		for (const text of ["X-API-Key: sk_live_1234567890abcdef", "Cookie: session=abcdef0123456789"]) {
			const once = redactText(text);
			expect(redactText(once)).toBe(once);
		}
	});

	test("YAML, header and .env style `name: value` lines are redacted; sentences with a colon are prose", () => {
		expect(redactText("password: hunter2")).toBe("password: [redacted]");
		expect(redactText("db:\n  password: hunter2\n  user: bob")).toBe("db:\n  password: [redacted]\n  user: bob");
		expect(redactText('password: "hunter2"')).toBe('password: "[redacted]"');
		expect(redactText("API_KEY=abcdef")).toBe("API_KEY=[redacted]");
		expect(redactText("API_KEY: abc")).toBe("API_KEY: [redacted]");
		expect(redactText("api_key: abc and more")).toBe("api_key: [redacted] and more");
		expect(redactText("client-secret: abc")).toBe("client-secret: [redacted]");
		expect(redactText("db.password: abc")).toBe("db.password: [redacted]");
		expect(redactText("the password: abcdef123 is set")).toBe("the password: [redacted] is set");
		for (const prose of ["Note: the password field is required", "the password: is required", "token: rotate it weekly"]) {
			expect(redactText(prose)).toBe(prose);
		}
	});
});

describe("redactText: paths", () => {
	const home = "/home/dev";

	test("paths under home but outside the repo shrink to ~/<last two segments>", () => {
		const repoRoot = "/home/dev/src/proj";
		const text = "read /home/dev/.ssh/id_rsa then /home/dev/src/other/deep/file.ts, done";
		expect(redactText(text, { home, repoRoot })).toBe("read ~/.ssh/id_rsa then ~/.../deep/file.ts, done");
	});

	test("a repo root inside home keeps its own paths readable and only those", () => {
		const repoRoot = "/home/dev/src/proj";
		const out = redactText("/home/dev/src/proj/a.ts /home/dev/src/proj /home/dev/src/proj-two/x.ts /home/dev/src", { home, repoRoot });
		expect(out).toBe("/home/dev/src/proj/a.ts /home/dev/src/proj ~/.../proj-two/x.ts ~/src");
	});

	test("the home directory itself becomes ~ and sentence punctuation survives", () => {
		expect(redactText("cd /home/dev and open /home/dev/.bashrc.", { home })).toBe("cd ~ and open ~/.bashrc.");
	});

	test("a different directory that merely starts with the home path is not touched", () => {
		expect(redactText("/home/devops/x and /mnt/home/dev/y", { home })).toBe("/home/devops/x and /mnt/home/dev/y");
	});

	test("a repo root that is the home directory or above it exempts nothing", () => {
		expect(redactText("/home/dev/.ssh/id_rsa", { home, repoRoot: home })).toBe("~/.ssh/id_rsa");
		expect(redactText("/home/dev/.ssh/id_rsa", { home, repoRoot: "/home/" })).toBe("~/.ssh/id_rsa");
	});

	test("home defaults to HOME and an empty or root home hides nothing", () => {
		const saved = process.env.HOME;
		process.env.HOME = "/home/dev";
		try {
			expect(redactText("/home/dev/a/b/c.ts")).toBe("~/.../b/c.ts");
		} finally {
			if (saved === undefined) delete process.env.HOME;
			else process.env.HOME = saved;
		}
		expect(redactText("/etc/passwd", { home: "/" })).toBe("/etc/passwd");
		expect(redactText("/etc/passwd", { home: "" })).toBe("/etc/passwd");
	});
});

describe("redactText: invariants", () => {
	const mixed = [
		`OPENAI_API_KEY=${OPENAI}`,
		`Authorization: Bearer ${JWT}`,
		"postgres://u:p4ss@h/db",
		'{"api_key": "abc", "token": "def"}',
		"-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----",
		"/home/dev/.aws/credentials and /home/dev/src/proj/x.ts",
		`${GITHUB} ${SLACK} ${AWS} ${GOOGLE}`,
	].join("\n");

	test("it is idempotent", () => {
		const options = { home: "/home/dev", repoRoot: "/home/dev/src/proj" };
		const once = redactText(mixed, options);
		expect(redactText(once, options)).toBe(once);
		expect(once).not.toContain(OPENAI);
		expect(once).not.toContain("p4ss");
		expect(once).toContain("/home/dev/src/proj/x.ts");
		expect(once).toContain("~/.aws/credentials");
	});

	test("it never throws and returns nothing for non-text", () => {
		expect(redactText(undefined as unknown as string)).toBe("");
		expect(redactText(42 as unknown as string)).toBe("");
		expect(redactText("")).toBe("");
		expect(redactText("plain text with nothing to hide")).toBe("plain text with nothing to hide");
	});
});

describe("redactLine", () => {
	test("redacts, collapses whitespace and caps the length", () => {
		expect(redactLine(`failed with Bearer abc123\n  retry   later`)).toBe("failed with [redacted] retry later");
		expect(redactLine("x".repeat(500)).length).toBe(200);
		expect(redactLine("x".repeat(500), 10)).toBe("xxxxxxxxxx");
	});
});
