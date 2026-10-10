// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * End-to-end smoke in a temp HOME and a temp Cursor directory. Installs the real hook beside
 * pre-seeded gsd-managed and substrate-managed entries, feeds beforeSubmitPrompt payloads, and
 * removes the install. It never reads or writes the operator's ~/.cursor/hooks.json.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_FILE, main } from "../../scripts/cursor-hooks.ts";

const HOOK = join(import.meta.dir, "ultrathink-cursor-pstack.js");
const SKILLS = ["how", "architect", "arena", "tdd", "interrogate", "no-comments"] as const;
const LIVE_PSTACK = "/root/.cursor/plugins/cache/cursor-public/pstack/ccb5507cec1546dc88135c1139c811e6c59115ba";

const GSD = { type: "command", command: "/usr/bin/node /cursor/hooks/gsd-cursor-session-start.js", "gsd-managed": true };
const SUBSTRATE = {
	type: "command",
	command: "bun /opt/agent-substrate/packages/cli/src/index.ts brief --surface cursor",
	"substrate-managed": true,
};

function plantCache(cursorDir: string): { root: string; copiedReal: boolean } {
	const root = join(cursorDir, "plugins", "cache", "cursor-public", "pstack", "smoke");
	if (existsSync(join(LIVE_PSTACK, "skills", "architect", "SKILL.md"))) {
		cpSync(LIVE_PSTACK, root, { recursive: true });
		return { root, copiedReal: true };
	}
	mkdirSync(join(root, ".cursor-plugin"), { recursive: true });
	writeFileSync(join(root, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "pstack", version: "0.0.0-smoke" }));
	writeFileSync(join(root, ".cache-complete"), "");
	for (const name of SKILLS) {
		mkdirSync(join(root, "skills", name), { recursive: true });
		writeFileSync(join(root, "skills", name, "SKILL.md"), `# ${name}\n`);
	}
	return { root, copiedReal: false };
}

function entries(cursorDir: string): unknown[] {
	const parsed = JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf8")) as { hooks?: { beforeSubmitPrompt?: unknown[] } };
	return parsed.hooks?.beforeSubmitPrompt ?? [];
}

function payload(prompt: string): string {
	return JSON.stringify({
		prompt,
		conversation_id: "conv-smoke",
		generation_id: "gen-smoke",
		model: "composer",
		hook_event_name: "beforeSubmitPrompt",
		cursor_version: "1.7.0",
		workspace_roots: ["/tmp/smoke-repo"],
		user_email: "operator@example.com",
		transcript_path: "/tmp/smoke-transcript.jsonl",
	});
}

describe("pstack bridge smoke (temp HOME)", () => {
	test("install, per-stage injection of the real skill names, and a byte-stable remove", () => {
		const dir = mkdtempSync(join(tmpdir(), "pstack-smoke-"));
		const home = join(dir, "home");
		const cursorDir = join(dir, "cursor");
		try {
			mkdirSync(join(home, ".config", "ultrathink"), { recursive: true });
			writeFileSync(join(home, ".config", "ultrathink", "config.json"), JSON.stringify({ pstack: { enabled: true } }));
			mkdirSync(join(cursorDir, "hooks"), { recursive: true });
			const seeded = { hooks: { beforeSubmitPrompt: [GSD, SUBSTRATE], sessionStart: [{ ...GSD }] } };
			writeFileSync(join(cursorDir, "hooks.json"), `${JSON.stringify(seeded, null, 2)}\n`);
			const foreignBefore = JSON.stringify([GSD, SUBSTRATE]);
			const { root, copiedReal } = plantCache(cursorDir);
			expect(copiedReal || existsSync(join(root, "skills", "architect", "SKILL.md"))).toBe(true);

			const logs: string[] = [];
			expect(main(["install", "--cursor-dir", cursorDir], { env: { HOME: home }, log: (line) => logs.push(line), nodeCandidates: ["/usr/bin/node"] })).toBe(0);
			const installed = entries(cursorDir);
			expect(installed.filter((entry) => JSON.stringify(entry) === JSON.stringify(GSD) || JSON.stringify(entry) === JSON.stringify(SUBSTRATE))).toHaveLength(2);
			const owned = installed.filter((entry) => JSON.stringify(entry).includes("ultrathink-managed"));
			expect(owned).toHaveLength(1);
			expect(JSON.stringify(installed.filter((entry) => JSON.stringify(entry) === JSON.stringify(GSD) || JSON.stringify(entry) === JSON.stringify(SUBSTRATE)))).toBe(foreignBefore);
			expect(existsSync(join(cursorDir, "hooks", HOOK_FILE))).toBe(true);
			expect(readFileSync(join(cursorDir, "hooks", HOOK_FILE), "utf8")).toBe(readFileSync(HOOK, "utf8"));

			const expectSkills = (prompt: string, names: readonly string[]): void => {
				const proc = spawnSync("node", [HOOK], {
					input: payload(prompt),
					encoding: "utf8",
					env: { PATH: process.env.PATH ?? "", HOME: home, ULTRATHINK_PSTACK_CURSOR_DIR: cursorDir },
				});
				expect(proc.status).toBe(0);
				const parsed = JSON.parse(proc.stdout) as { continue?: boolean; additional_context?: string };
				expect(parsed.continue).toBe(true);
				for (const name of names) {
					expect(parsed.additional_context).toContain(name);
					expect(parsed.additional_context).toContain(join(root, "skills", name, "SKILL.md"));
				}
			};
			expectSkills("/gsd-discuss-phase 23", ["how"]);
			expectSkills("/gsd-plan-phase 24", ["architect", "arena"]);
			expectSkills("/gsd-execute-phase 24", ["tdd"]);
			expectSkills("/gsd-verify-work", ["interrogate", "no-comments"]);
			expectSkills("/gsd-ship", ["interrogate", "no-comments"]);
			expectSkills("/gsd-autonomous", SKILLS);

			const quiet = spawnSync("node", [HOOK], {
				input: payload("/architect review this"),
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "", HOME: home, ULTRATHINK_PSTACK_CURSOR_DIR: cursorDir },
			});
			expect(JSON.parse(quiet.stdout)).toEqual({});

			expect(main(["remove", "--cursor-dir", cursorDir], { env: { HOME: home }, log: (line) => logs.push(line), nodeCandidates: ["/usr/bin/node"] })).toBe(0);
			expect(existsSync(join(cursorDir, "hooks", HOOK_FILE))).toBe(false);
			expect(JSON.stringify(entries(cursorDir))).toBe(foreignBefore);
			const after = JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf8")) as { hooks: { sessionStart: unknown[] } };
			expect(after.hooks.sessionStart).toEqual([{ ...GSD }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
