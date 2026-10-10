// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	EVENT,
	HOOK_FILE,
	isOwned,
	main,
	readHooksFile,
	removeHook,
	resolveNode,
	upsertHook,
	writeHooksFile,
} from "./cursor-hooks.ts";

const WANTED = {
	type: "command",
	command: `/usr/bin/node /home/u/.cursor/hooks/${HOOK_FILE}`,
	"ultrathink-managed": true,
};
const GSD = { type: "command", command: "/usr/bin/node /root/.cursor/hooks/gsd-cursor-session-start.js", "gsd-managed": true };
const SUBSTRATE = {
	type: "command",
	command: "bun /root/src/repos/agent-substrate/packages/cli/src/index.ts brief --surface cursor",
	"substrate-managed": true,
};
const FOREIGN = { type: "command", command: "echo keep me" };
const OURS_OLD = { type: "command", command: `/opt/old/node /old/.cursor/hooks/${HOOK_FILE}`, "ultrathink-managed": true };

function entries(value: unknown): unknown[] {
	if (typeof value !== "object" || value === null || !("hooks" in value)) return [];
	const { hooks } = value;
	if (typeof hooks !== "object" || hooks === null || !(EVENT in hooks)) return [];
	const list = hooks[EVENT];
	return Array.isArray(list) ? list : [];
}

describe("isOwned", () => {
	test("marker, hook-file command and foreign entries", () => {
		expect(isOwned({ ...WANTED })).toBe(true);
		expect(isOwned({ type: "command", command: `node /x/hooks/${HOOK_FILE}` })).toBe(true);
		expect(isOwned(GSD)).toBe(false);
		expect(isOwned(SUBSTRATE)).toBe(false);
		expect(isOwned(FOREIGN)).toBe(false);
		expect(isOwned("nope")).toBe(false);
	});
});

describe("upsertHook", () => {
	test("adds into an empty config", () => {
		expect(upsertHook(undefined, WANTED)).toEqual({ next: { hooks: { [EVENT]: [WANTED] } }, action: "added" });
	});

	test("appends after foreign entries without touching them", () => {
		const merged = upsertHook({ hooks: { [EVENT]: [GSD, SUBSTRATE] } }, WANTED);
		expect(merged.action).toBe("added");
		expect(entries(merged.next)).toEqual([GSD, SUBSTRATE, WANTED]);
	});

	test("replaces an owned entry in place", () => {
		const merged = upsertHook({ hooks: { [EVENT]: [GSD, OURS_OLD, FOREIGN] } }, WANTED);
		expect(merged.action).toBe("replaced");
		expect(entries(merged.next)).toEqual([GSD, WANTED, FOREIGN]);
	});

	test("collapses duplicate owned entries into one", () => {
		const merged = upsertHook({ hooks: { [EVENT]: [OURS_OLD, FOREIGN, { ...OURS_OLD }] } }, WANTED);
		expect(merged.action).toBe("replaced");
		expect(entries(merged.next)).toEqual([WANTED, FOREIGN]);
	});

	test("reports unchanged for an identical single owned entry", () => {
		expect(upsertHook({ hooks: { [EVENT]: [WANTED] } }, WANTED)).toEqual({ action: "unchanged" });
	});

	test("refuses malformed shapes with a reason", () => {
		expect(upsertHook([], WANTED).reason).toContain("top-level value is not an object");
		expect(upsertHook({ hooks: [] }, WANTED).reason).toContain('"hooks" is not an object');
		expect(upsertHook({ hooks: { [EVENT]: {} } }, WANTED).reason).toContain(`"hooks.${EVENT}" is not an array`);
	});
});

describe("removeHook", () => {
	test("removes owned entries only, keeping foreign positions", () => {
		const merged = removeHook({ hooks: { [EVENT]: [GSD, OURS_OLD, SUBSTRATE, FOREIGN] } });
		expect(merged.action).toBe("removed");
		expect(entries(merged.next)).toEqual([GSD, SUBSTRATE, FOREIGN]);
	});

	test("not present when the config has no owned entry or is missing", () => {
		expect(removeHook({ hooks: { [EVENT]: [GSD] } })).toEqual({ action: "not present" });
		expect(removeHook(undefined)).toEqual({ action: "not present" });
	});

	test("refuses the same malformed shapes as upsertHook", () => {
		expect(removeHook([]).reason).toContain("top-level value is not an object");
		expect(removeHook({ hooks: { [EVENT]: "no" } }).reason).toContain(`"hooks.${EVENT}" is not an array`);
	});
});

describe("resolveNode", () => {
	test("picks the first executable candidate", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-hooks-node-"));
		try {
			const noExec = join(dir, "no-exec");
			const yes = join(dir, "node");
			writeFileSync(noExec, "", { mode: 0o644 });
			writeFileSync(yes, "#!/bin/sh\n", { mode: 0o755 });
			expect(resolveNode([join(dir, "missing"), noExec, yes])).toBe(yes);
			expect(resolveNode([join(dir, "missing"), noExec])).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("readHooksFile / writeHooksFile", () => {
	test("missing file is an empty config, unparseable file is a reason", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-hooks-io-"));
		try {
			expect(readHooksFile(join(dir, "hooks.json"))).toEqual({ config: undefined });
			writeFileSync(join(dir, "hooks.json"), "{ not json");
			const parsed = readHooksFile(join(dir, "hooks.json"));
			expect("reason" in parsed ? parsed.reason : "").toContain("not valid JSON");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("atomic write leaves pretty JSON, mode 0600 and no temp file behind", () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-hooks-write-"));
		try {
			const file = join(dir, "hooks.json");
			writeHooksFile(file, { hooks: {} });
			expect(readFileSync(file, "utf8")).toBe('{\n  "hooks": {}\n}\n');
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(readdirSync(dir)).toEqual(["hooks.json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

interface Sandbox {
	home: string;
	cursor: string;
	source: string;
	staged: string;
	node: string;
	lines: string[];
	/** Runs main with hermetic env/root; `over` swaps the repo root or node candidates. */
	run: (args: string[], over?: { root?: string; candidates?: string[] }) => number;
	hooksJson: () => unknown;
	list: () => unknown[];
}

function sandbox(fn: (box: Sandbox) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "cursor-hooks-main-"));
	const home = join(dir, "home");
	const repo = join(dir, "repo");
	const node = join(dir, "node");
	const source = join(repo, "hosts", "cursor", HOOK_FILE);
	mkdirSync(home);
	mkdirSync(dirname(source), { recursive: true });
	writeFileSync(source, "// staged ultrathink cursor pstack hook (test fixture)\n");
	writeFileSync(node, "#!/bin/sh\n", { mode: 0o755 });
	const lines: string[] = [];
	const cursor = join(home, ".cursor");
	const run = (args: string[], over?: { root?: string; candidates?: string[] }) =>
		main(args, {
			env: { HOME: home },
			root: over?.root ?? repo,
			log: (line) => lines.push(line),
			// A missing first candidate proves the loop skips non-existent paths.
			nodeCandidates: over?.candidates ?? [join(dir, "missing-node"), node],
		});
	try {
		fn({
			home,
			cursor,
			source,
			staged: join(cursor, "hooks", HOOK_FILE),
			node,
			lines,
			run,
			hooksJson: () => JSON.parse(readFileSync(join(cursor, "hooks.json"), "utf8")),
			list: () => entries(JSON.parse(readFileSync(join(cursor, "hooks.json"), "utf8"))),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("main", () => {
	test("install into an empty dir creates the entry and stages the hook", () => {
		sandbox((box) => {
			expect(box.run(["install"])).toBe(0);
			expect(box.hooksJson()).toEqual({ hooks: { [EVENT]: [{ ...WANTED, command: `${box.node} ${box.staged}` }] } });
			expect(readFileSync(box.staged, "utf8")).toBe(readFileSync(box.source, "utf8"));
			expect(statSync(box.cursor).mode & 0o777).toBe(0o700);
			expect(statSync(join(box.cursor, "hooks")).mode & 0o777).toBe(0o755);
			expect(statSync(box.staged).mode & 0o777).toBe(0o644);
			expect(statSync(join(box.cursor, "hooks.json")).mode & 0o777).toBe(0o600);
		});
	});

	test("double install keeps exactly one owned entry and an identical staged file", () => {
		sandbox((box) => {
			expect(box.run(["install"])).toBe(0);
			const file = join(box.cursor, "hooks.json");
			const bytes = readFileSync(file, "utf8");
			expect(box.run(["install"])).toBe(0);
			expect(box.list()).toHaveLength(1);
			expect(box.list().filter(isOwned)).toHaveLength(1);
			expect(readFileSync(file, "utf8")).toBe(bytes);
			expect(readFileSync(box.staged, "utf8")).toBe(readFileSync(box.source, "utf8"));
		});
	});

	test("gsd-managed, substrate-managed and foreign entries stay byte-identical through install and remove", () => {
		sandbox((box) => {
			const before = [GSD, OURS_OLD, SUBSTRATE, FOREIGN];
			const otherEvent = { hooks: { postToolUse: [{ ...SUBSTRATE }], [EVENT]: before } };
			const foreign = JSON.stringify(before.filter((entry) => !isOwned(entry)));
			mkdirSync(box.cursor, { recursive: true });
			writeFileSync(join(box.cursor, "hooks.json"), JSON.stringify(otherEvent, null, 2));
			expect(box.run(["install"])).toBe(0);
			const mid = box.list();
			expect(JSON.stringify(mid.filter((entry) => !isOwned(entry)))).toBe(foreign);
			const owned = mid.filter(isOwned);
			expect(owned).toHaveLength(1);
			expect(owned[0]).toEqual({ ...WANTED, command: `${box.node} ${box.staged}` });
			expect(mid.indexOf(owned[0])).toBe(1); // replaced in place, foreign slots untouched
			expect(box.hooksJson()).toHaveProperty("hooks.postToolUse", [{ ...SUBSTRATE }]);
			expect(box.run(["remove"])).toBe(0);
			expect(JSON.stringify(box.list())).toBe(foreign); // owned gone, foreign order intact
			expect(box.hooksJson()).toHaveProperty("hooks.postToolUse", [{ ...SUBSTRATE }]);
		});
	});

	test("remove deletes the staged file and the owned entry", () => {
		sandbox((box) => {
			expect(box.run(["install"])).toBe(0);
			expect(existsSync(box.staged)).toBe(true);
			expect(box.run(["remove"])).toBe(0);
			expect(existsSync(box.staged)).toBe(false);
			expect(box.list()).toEqual([]);
		});
	});

	test("remove without a prior install creates nothing", () => {
		sandbox((box) => {
			expect(box.run(["remove"])).toBe(0);
			expect(existsSync(box.cursor)).toBe(false);
		});
	});

	test("unparseable hooks.json fails install and remove without writing", () => {
		sandbox((box) => {
			const file = join(box.cursor, "hooks.json");
			mkdirSync(box.cursor, { recursive: true });
			const bytes = "{ not json";
			writeFileSync(file, bytes);
			mkdirSync(dirname(box.staged), { recursive: true });
			writeFileSync(box.staged, "staged before");
			box.lines.length = 0;
			expect(box.run(["install"])).toBe(1);
			expect(box.lines.join("\n")).toContain("not valid JSON");
			box.lines.length = 0;
			expect(box.run(["remove"])).toBe(1);
			expect(box.lines.join("\n")).toContain("not valid JSON");
			expect(readFileSync(file, "utf8")).toBe(bytes);
			expect(readFileSync(box.staged, "utf8")).toBe("staged before"); // neither overwritten nor unlinked
		});
	});

	test("install --cursor-dir targets the given directory instead of ~/.cursor", () => {
		sandbox((box) => {
			const other = join(box.home, "other-cursor");
			expect(box.run(["install", "--cursor-dir", other])).toBe(0);
			expect(existsSync(join(other, "hooks", HOOK_FILE))).toBe(true);
			expect(existsSync(join(other, "hooks.json"))).toBe(true);
			expect(existsSync(join(box.cursor, "hooks.json"))).toBe(false);
		});
	});

	test("install fails clearly without a hook source or an executable node", () => {
		sandbox((box) => {
			box.lines.length = 0;
			expect(box.run(["install"], { root: join(box.home, "no-repo") })).toBe(1);
			expect(box.lines.join("\n")).toContain("hook source not found");
			expect(existsSync(box.cursor)).toBe(false);
			const repo = join(box.home, "repo2");
			mkdirSync(join(repo, "hosts", "cursor"), { recursive: true });
			writeFileSync(join(repo, "hosts", "cursor", HOOK_FILE), "// hook\n");
			box.lines.length = 0;
			expect(box.run(["install"], { root: repo, candidates: [join(box.home, "not-node")] })).toBe(1);
			expect(box.lines.join("\n")).toContain("no executable node");
			expect(existsSync(box.cursor)).toBe(false);
		});
	});

	test("usage errors print USAGE and exit 2; --help exits 0", () => {
		sandbox((box) => {
			expect(box.run([])).toBe(2);
			expect(box.run(["bogus"])).toBe(2);
			expect(box.run(["install", "--cursor-dir"])).toBe(2);
			expect(box.run(["install", "extra", "--cursor-dir", box.cursor])).toBe(2);
			expect(box.lines.some((line) => line.includes("Usage:"))).toBe(true);
			box.lines.length = 0;
			expect(box.run(["--help"])).toBe(0);
			expect(box.lines[0]).toContain("Usage:");
		});
	});
});
