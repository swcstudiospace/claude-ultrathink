// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { parseRepoSlug, resolveBranch, resolveRepoSlug } from "./git.ts";

describe("parseRepoSlug", () => {
	test("parses ssh and https remotes", () => {
		expect(parseRepoSlug("git@github.com:swcstudiospace/plugin.git")).toBe("swcstudiospace/plugin");
		expect(parseRepoSlug("https://github.com/swcstudiospace/plugin.git")).toBe("swcstudiospace/plugin");
		expect(parseRepoSlug("https://github.com/swcstudiospace/plugin")).toBe("swcstudiospace/plugin");
	});

	test("returns undefined for an unparsable or empty remote", () => {
		expect(parseRepoSlug("")).toBeUndefined();
		expect(parseRepoSlug("not a url")).toBeUndefined();
	});
});

describe("resolveRepoSlug", () => {
	test("reads the origin remote via the injected run function", () => {
		const slug = resolveRepoSlug("/repo", () => ({ stdout: "git@github.com:acme/widgets.git\n", code: 0 }));
		expect(slug).toBe("acme/widgets");
	});

	test("undefined when git exits non-zero or throws", () => {
		expect(resolveRepoSlug("/repo", () => ({ stdout: "", code: 1 }))).toBeUndefined();
		expect(
			resolveRepoSlug("/repo", () => {
				throw new Error("no git");
			}),
		).toBeUndefined();
	});
});

describe("resolveBranch", () => {
	test("reads the current branch via the injected run function", () => {
		expect(resolveBranch("/repo", () => ({ stdout: "feat/widget\n", code: 0 }))).toBe("feat/widget");
	});

	test("undefined when detached, git exits non-zero, or it throws", () => {
		expect(resolveBranch("/repo", () => ({ stdout: "\n", code: 0 }))).toBeUndefined();
		expect(resolveBranch("/repo", () => ({ stdout: "", code: 1 }))).toBeUndefined();
	});
});
