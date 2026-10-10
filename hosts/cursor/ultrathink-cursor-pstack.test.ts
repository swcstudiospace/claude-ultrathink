// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAPPING } from "../../src/cursor/pstack.ts";

const HOOK = join(import.meta.dir, "ultrathink-cursor-pstack.js");

const SKILLS = ["how", "architect", "arena", "tdd", "interrogate", "no-comments"];

// Detection-table semantics transcribed from the phase-23 proof
// (.planning/phases/23-cursor-bridge-design-and-detection-proof/23-proof.mjs).
// The hook's embedded COMMAND_STAGE must stay deep-equal to these.
const SPEC_COMMAND_STAGE = [
	{ source: "^gsd-discuss-phase$", stage: "discuss" },
	{ source: "^gsd-(plan-phase|ultraplan-phase|spec-phase)$", stage: "plan" },
	{ source: "^gsd-(execute-phase|fast|quick|quick-batch)$", stage: "execute" },
	{ source: "^gsd-(verify-work|code-review|ui-review|audit-uat|audit-fix|audit-milestone)$", stage: "review" },
	{ source: "^gsd-ship$", stage: "review" },
	{ source: "^gsd-autonomous$", stage: "orchestrate" },
];

interface HookRun {
	status: number | null;
	stdout: string;
}

interface Harness {
	home: string;
	cursorDir: string;
	skillRoot: string;
	run(payload: string, env?: Record<string, string>): HookRun;
}

// Builds a temp HOME with the given JSON config files (default: an enabling
// $HOME/.config/ultrathink/config.json), a temp cursor dir holding a synthetic
// completed pstack 1.2.3 cache with all six default skills, and a runner that
// spawns the real hook with `node`. Both temp dirs are removed afterwards.
const withHarness = (
	fn: (h: Harness) => void,
	configFiles: Array<[relative: string, value: unknown]> = [[join(".config", "ultrathink", "config.json"), { pstack: { enabled: true } }]],
) => {
	const home = mkdtempSync(join(tmpdir(), "pstack-hook-home-"));
	const cursorDir = mkdtempSync(join(tmpdir(), "pstack-hook-cursor-"));
	for (const [relative, value] of configFiles) {
		const file = join(home, relative);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, JSON.stringify(value));
	}
	const skillRoot = join(cursorDir, "plugins", "cache", "cursor-public", "pstack", "synth-1.2.3");
	mkdirSync(join(skillRoot, ".cursor-plugin"), { recursive: true });
	writeFileSync(join(skillRoot, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "pstack", version: "1.2.3" }));
	writeFileSync(join(skillRoot, ".cache-complete"), "");
	for (const name of SKILLS) {
		mkdirSync(join(skillRoot, "skills", name), { recursive: true });
		writeFileSync(join(skillRoot, "skills", name, "SKILL.md"), `# pstack ${name}\n`);
	}
	const run = (payload: string, env: Record<string, string> = {}): HookRun => {
		const proc = spawnSync("node", [HOOK], {
			input: payload,
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", HOME: home, ULTRATHINK_PSTACK_CURSOR_DIR: cursorDir, ...env },
		});
		return { status: proc.status, stdout: proc.stdout ?? "" };
	};
	try {
		fn({ home, cursorDir, skillRoot, run });
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(cursorDir, { recursive: true, force: true });
	}
};

const walk = (dir: string, base = dir, acc: string[] = []): string[] => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		acc.push(`${join(dir, entry.name).slice(base.length)}${entry.isDirectory() ? "/" : ""}`);
		if (entry.isDirectory()) walk(join(dir, entry.name), base, acc);
	}
	return acc.sort();
};

describe("ultrathink-cursor-pstack hook (spawned with node)", () => {
	test("enabled config + /gsd-plan-phase injects the block with absolute architect/arena skill paths", () => {
		withHarness(({ run, skillRoot, home, cursorDir }) => {
			const before = { home: walk(home), cursorDir: walk(cursorDir) };
			const { status, stdout } = run(JSON.stringify({ prompt: "/gsd-plan-phase 24" }));
			expect(status).toBe(0);
			const parsed = JSON.parse(stdout) as { continue?: boolean; additional_context?: string };
			expect(parsed.continue).toBe(true);
			expect(typeof parsed.additional_context).toBe("string");
			expect(parsed.additional_context).toContain(join(skillRoot, "skills", "architect", "SKILL.md"));
			expect(parsed.additional_context).toContain(join(skillRoot, "skills", "arena", "SKILL.md"));
			// The hook writes nothing to disk.
			expect(walk(home)).toEqual(before.home);
			expect(walk(cursorDir)).toEqual(before.cursorDir);
		});
	});

	test("pstack disabled in the user config prints {}", () => {
		withHarness(
			({ run }) => {
				const { status, stdout } = run(JSON.stringify({ prompt: "/gsd-plan-phase 24" }));
				expect(status).toBe(0);
				expect(JSON.parse(stdout)).toEqual({});
			},
			[[join(".config", "ultrathink", "config.json"), { pstack: { enabled: false } }]],
		);
	});

	test("a question that only mentions a slash command prints {}", () => {
		withHarness(({ run }) => {
			for (const prompt of [
				"What does `/gsd-ship` do?",
				"What does /gsd-ship do?",
				'"/gsd-plan-phase"',
				"`/gsd-ship`",
				'"\n/gsd-ship\n"',
				"'\n/gsd-plan-phase 23\n'",
				"```\n/gsd-ship\n```",
			]) {
				const { status, stdout } = run(JSON.stringify({ prompt }));
				expect(status).toBe(0);
				expect(JSON.parse(stdout)).toEqual({});
			}
		});
	});

	test("a command at the start of a later line still injects", () => {
		withHarness(({ run, skillRoot }) => {
			const { status, stdout } = run(JSON.stringify({ prompt: "notes\n/gsd-plan-phase 24" }));
			expect(status).toBe(0);
			const parsed = JSON.parse(stdout) as { additional_context?: string };
			expect(parsed.additional_context).toContain(join(skillRoot, "skills", "architect", "SKILL.md"));
		});
	});

	test("a pstack command (/architect this) is not a gsd command: prints {}", () => {
		withHarness(({ run }) => {
			const { status, stdout } = run(JSON.stringify({ prompt: "/architect this" }));
			expect(status).toBe(0);
			expect(JSON.parse(stdout)).toEqual({});
		});
	});

	test("malformed stdin (not JSON) prints {}", () => {
		withHarness(({ run }) => {
			const { status, stdout } = run("this is not json {");
			expect(status).toBe(0);
			expect(JSON.parse(stdout)).toEqual({});
		});
	});

	test("ULTRATHINK_PSTACK=0 is a hard off switch: prints {}", () => {
		withHarness(({ run }) => {
			const { status, stdout } = run(JSON.stringify({ prompt: "/gsd-plan-phase 24" }), { ULTRATHINK_PSTACK: "0" });
			expect(status).toBe(0);
			expect(JSON.parse(stdout)).toEqual({});
		});
	});

	test("a config cap too small for one skill fails open to {}", () => {
		withHarness(
			({ run }) => {
				const { status, stdout } = run(JSON.stringify({ prompt: "/gsd-plan-phase 24" }));
				expect(status).toBe(0);
				expect(JSON.parse(stdout)).toEqual({});
			},
			[[join(".config", "ultrathink", "config.json"), { pstack: { enabled: true, contextCapChars: 50 } }]],
		);
	});

	test("ULTRATHINK_CONFIG_DIR takes precedence over $HOME/.config", () => {
		withHarness(
			({ run }) => {
				const configDir = mkdtempSync(join(tmpdir(), "pstack-hook-configdir-"));
				try {
					writeFileSync(join(configDir, "config.json"), JSON.stringify({ pstack: { enabled: false } }));
					const { status, stdout } = run(JSON.stringify({ prompt: "/gsd-plan-phase 24" }), { ULTRATHINK_CONFIG_DIR: configDir });
					expect(status).toBe(0);
					expect(JSON.parse(stdout)).toEqual({});
				} finally {
					rmSync(configDir, { recursive: true, force: true });
				}
			},
			// An enabling HOME config must lose to the disabling override dir.
			[[join(".config", "ultrathink", "config.json"), { pstack: { enabled: true } }]],
		);
	});

	test("a user mapping replaces the plan-stage skills", () => {
		withHarness(
			({ run, skillRoot }) => {
				const { status, stdout } = run(JSON.stringify({ prompt: "/gsd-plan-phase 24" }));
				expect(status).toBe(0);
				const parsed = JSON.parse(stdout) as { additional_context?: string };
				expect(parsed.additional_context).toContain(join(skillRoot, "skills", "how", "SKILL.md"));
				expect(parsed.additional_context).not.toContain("architect");
			},
			[[join(".config", "ultrathink", "config.json"), { pstack: { enabled: true, mapping: { plan: ["how"] } } }]],
		);
	});

	test("XDG_CONFIG_HOME/ultrathink/config.json enables the bridge when ~/.config has no file", () => {
		withHarness(({ run, skillRoot }) => {
			const xdg = mkdtempSync(join(tmpdir(), "pstack-hook-xdg-"));
			try {
				mkdirSync(join(xdg, "ultrathink"), { recursive: true });
				writeFileSync(join(xdg, "ultrathink", "config.json"), JSON.stringify({ pstack: { enabled: true } }));
				const { status, stdout } = run(JSON.stringify({ prompt: "/gsd-plan-phase 24" }), { XDG_CONFIG_HOME: xdg });
				expect(status).toBe(0);
				const parsed = JSON.parse(stdout) as { additional_context?: string };
				expect(parsed.additional_context).toContain(join(skillRoot, "skills", "architect", "SKILL.md"));
			} finally {
				rmSync(xdg, { recursive: true, force: true });
			}
		}, []);
	});

	test("$HOME/.claude/ultrathink.json is the fallback config location", () => {
		withHarness(
			({ run, skillRoot }) => {
				const { status, stdout } = run(JSON.stringify({ prompt: "/gsd-plan-phase 24" }));
				expect(status).toBe(0);
				const parsed = JSON.parse(stdout) as { continue?: boolean; additional_context?: string };
				expect(parsed.continue).toBe(true);
				expect(parsed.additional_context).toContain(join(skillRoot, "skills", "architect", "SKILL.md"));
			},
			[[join(".claude", "ultrathink.json"), { pstack: { enabled: true } }]],
		);
	});
});

describe("hook parity with src/cursor/pstack.ts", () => {
	test("embedded COMMAND_STAGE equals the phase-23 spec table semantics", () => {
		const src = readFileSync(HOOK, "utf8");
		const table = extractConstLiteral(src, "COMMAND_STAGE");
		const entries = [...table.matchAll(/\[\/(\^.*?\$)\/,\s*"([a-z]+)"\]/g)].map((m) => ({
			source: m[1] ?? "",
			stage: m[2] ?? "",
		}));
		expect(entries).toEqual(SPEC_COMMAND_STAGE);
	});

	test("embedded DEFAULT_MAPPING equals DEFAULT_MAPPING from src/cursor/pstack.ts", () => {
		const src = readFileSync(HOOK, "utf8");
		expect(JSON.parse(extractConstLiteral(src, "DEFAULT_MAPPING"))).toEqual(DEFAULT_MAPPING);
	});

	test("embedded ALL_STAGES equals the spec stage order", () => {
		const src = readFileSync(HOOK, "utf8");
		expect(JSON.parse(extractConstLiteral(src, "ALL_STAGES"))).toEqual(["discuss", "plan", "execute", "review"]);
	});
});

// Extracts a top-level `const NAME = <literal>` value from hook source text by
// balanced-bracket scanning (quote-aware), without evaluating any code.
const extractConstLiteral = (src: string, name: string): string => {
	const marker = `const ${name} = `;
	const at = src.indexOf(marker);
	if (at === -1) throw new Error(`hook source: const ${name} not found`);
	const open = at + marker.length;
	const pairs: Record<string, string> = { "[": "]", "{": "}", "(": ")" };
	const closers: Record<string, true> = { "]": true, "}": true, ")": true };
	const stack: string[] = [];
	for (let i = open; i < src.length; i++) {
		const ch = src[i] ?? "";
		if (ch === '"' || ch === "'") {
			const quote = ch;
			i++;
			while (i < src.length && src[i] !== quote) {
				if (src[i] === "\\") i++;
				i++;
			}
			continue;
		}
		if (pairs[ch]) stack.push(ch);
		else if (closers[ch]) {
			const opener = stack.pop();
			if (!opener || pairs[opener] !== ch) throw new Error(`hook source: unbalanced literal for ${name}`);
			if (stack.length === 0) return src.slice(open, i + 1);
		}
	}
	throw new Error(`hook source: unterminated literal for ${name}`);
};
