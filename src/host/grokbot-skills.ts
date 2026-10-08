// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `ultrathink-grokbot skills status`: read-only drift check between the staged skills (hosts/grok-bot/skills) and the
 * copies Grok Bot loads (default /home/box/agent-data/workflows), the grok-bot analogue of `scripts/setup.ts status`.
 * It never installs or overwrites: installing needs Ming's approval and a backup, done by Desk Lead.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_INSTALLED_SKILLS = "/home/box/agent-data/workflows";

export interface SkillDrift {
	name: string;
	state: "in-sync" | "drift" | "not-installed";
	staged: string;
	installed?: string;
}

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);

export function skillsStatus(stagedRoot: string, installedRoot = DEFAULT_INSTALLED_SKILLS): { skills: SkillDrift[]; counts: Record<SkillDrift["state"], number> } {
	const names = readdirSync(stagedRoot, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(stagedRoot, d.name, "SKILL.md")))
		.map((d) => d.name)
		.sort();
	const skills = names.map((name): SkillDrift => {
		const staged = sha(join(stagedRoot, name, "SKILL.md"));
		const target = join(installedRoot, name, "SKILL.md");
		if (!existsSync(target)) return { name, state: "not-installed", staged };
		const installed = sha(target);
		return { name, state: installed === staged ? "in-sync" : "drift", staged, installed };
	});
	const counts = { "in-sync": 0, drift: 0, "not-installed": 0 };
	for (const s of skills) counts[s.state]++;
	return { skills, counts };
}
