// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("the Muse manifest parses and lists every skill, including ultrathink-teach, at a file that exists", () => {
	const manifest = JSON.parse(readFileSync(join(ROOT, ".muse-plugin/plugin.json"), "utf8")) as {
		capabilities: { skills: { id: string; path: string }[] };
	};
	const skills = manifest.capabilities.skills;
	expect(skills.map((skill) => skill.id)).toContain("ultrathink-teach");
	expect(skills.find((skill) => skill.id === "ultrathink-teach")?.path).toBe("skills/ultrathink-teach/SKILL.md");
	for (const skill of skills) expect(existsSync(join(ROOT, skill.path))).toBe(true);
});
