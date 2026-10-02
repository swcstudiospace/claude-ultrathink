// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecallHit } from "../hindsight/types.ts";
import { contentFor, dedupeKeyFor, documentIdFor, gitRootsOf, lessonFromHit, metadataFor, projectOf, sanitizeTag, tagsFor } from "./mapping.ts";
import type { TeachableMoment } from "./types.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-teach-map-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function moment(overrides: Partial<TeachableMoment> = {}): TeachableMoment {
	return {
		id: "m1",
		name: "tsc rejects value imports of types",
		description: "Use import type.",
		body: "With verbatimModuleSyntax, a value import of a type fails.\n\nFix: import type { X }.",
		sourcePhase: "phase-2",
		sourceArtifacts: ["src/a.ts"],
		createdAt: "2026-02-01T00:00:00.000Z",
		tags: [],
		relatedIds: ["m0"],
		schema: 2,
		kind: "pitfall",
		status: "confirmed",
		origin: "explicit",
		project: "claude-ultrathink",
		host: "omp",
		confidence: 1,
		occurrences: 3,
		lastSeenAt: "2026-02-02T00:00:00.000Z",
		dedupeKey: "k",
		recalled: 0,
		...overrides,
	};
}

describe("projectOf", () => {
	test("a plain repository names the project from its root, from any subdirectory", () => {
		const root = tempDir();
		const repo = join(root, "My-Repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, "src", "deep"), { recursive: true });
		expect(projectOf(repo)).toBe("my-repo");
		expect(projectOf(join(repo, "src", "deep"))).toBe("my-repo");
		expect(gitRootsOf(join(repo, "src"))).toEqual({ worktree: repo, primary: repo });
	});

	test("a linked worktree collapses onto the primary checkout, absolute or relative gitdir", () => {
		const root = tempDir();
		const primary = join(root, "Main-Repo");
		mkdirSync(join(primary, ".git", "worktrees", "wt1"), { recursive: true });
		const worktree = join(root, "feature-branch-checkout");
		mkdirSync(worktree);
		writeFileSync(join(worktree, ".git"), `gitdir: ${join(primary, ".git", "worktrees", "wt1")}\n`);
		expect(projectOf(worktree)).toBe("main-repo");
		expect(gitRootsOf(worktree)).toEqual({ worktree, primary });

		const relative = join(root, "relative-checkout");
		mkdirSync(relative);
		writeFileSync(join(relative, ".git"), "gitdir: ../Main-Repo/.git/worktrees/wt1\n");
		expect(projectOf(relative)).toBe("main-repo");
	});

	test("a worktree of a bare repository is named after the bare directory", () => {
		const root = tempDir();
		mkdirSync(join(root, "proj.git", "worktrees", "w"), { recursive: true });
		const worktree = join(root, "w-checkout");
		mkdirSync(worktree);
		writeFileSync(join(worktree, ".git"), `gitdir: ${join(root, "proj.git", "worktrees", "w")}\n`);
		expect(projectOf(worktree)).toBe("proj");
	});

	test("a submodule's .git file names the submodule, not its superproject", () => {
		const root = tempDir();
		const sub = join(root, "super", "vendor", "Lib");
		mkdirSync(sub, { recursive: true });
		mkdirSync(join(root, "super", ".git", "modules", "Lib"), { recursive: true });
		writeFileSync(join(sub, ".git"), "gitdir: ../../.git/modules/Lib\n");
		expect(projectOf(sub)).toBe("lib");
	});

	test("outside a repository the working directory's name is used, and an unreadable .git file falls back to it", () => {
		const root = tempDir();
		const plain = join(root, "Scratch Dir");
		mkdirSync(plain);
		expect(gitRootsOf(plain)).toBeUndefined();
		expect(projectOf(plain)).toBe("scratch dir");
		writeFileSync(join(plain, ".git"), "not a gitdir line");
		expect(projectOf(plain)).toBe("scratch dir");
		expect(projectOf("/")).toBe("unknown");
	});
});

describe("dedupeKeyFor", () => {
	test("is 32 hex characters and ignores case, punctuation and spacing in the name", () => {
		const key = dedupeKeyFor("proj", "pitfall", "tsc rejects value imports");
		expect(key).toMatch(/^[0-9a-f]{32}$/);
		expect(dedupeKeyFor("proj", "pitfall", "  TSC rejects   value-imports! ")).toBe(key);
	});

	test("differs by project, kind and wording", () => {
		const key = dedupeKeyFor("proj", "pitfall", "same name");
		expect(dedupeKeyFor("other", "pitfall", "same name")).not.toBe(key);
		expect(dedupeKeyFor("proj", "bug", "same name")).not.toBe(key);
		expect(dedupeKeyFor("proj", "pitfall", "same other name")).not.toBe(key);
	});

	test("non-ASCII letters count as letters", () => {
		expect(dedupeKeyFor("p", "bug", "Über-Fehler")).toBe(dedupeKeyFor("p", "bug", "über fehler"));
		expect(dedupeKeyFor("p", "bug", "日本語 メモ")).not.toBe(dedupeKeyFor("p", "bug", "中文"));
	});
});

describe("documentIdFor, tagsFor, sanitizeTag", () => {
	test("document ids are tm:<id>", () => {
		expect(documentIdFor("abc")).toBe("tm:abc");
	});

	test("tags are the six base tags plus sanitized, deduplicated own tags", () => {
		const tags = tagsFor(moment({ tags: ["Needs Review", "ultrathink", "dup", "dup", "", "!!!", "a".repeat(60)] }));
		expect(tags).toEqual([
			"ultrathink",
			"teachable",
			"project:claude-ultrathink",
			"host:omp",
			"kind:pitfall",
			"status:confirmed",
			"needs-review",
			"dup",
			"a".repeat(40),
		]);
	});

	test("own tags cannot claim a reserved namespace", () => {
		const tags = tagsFor(moment({ tags: ["status:superseded", "project:evil", "host:x", "kind:bug", "ok:fine"] }));
		expect(tags).not.toContain("status:superseded");
		expect(tags).not.toContain("project:evil");
		expect(tags).toContain("ok:fine");
		expect(tags.filter((tag) => tag.startsWith("status:"))).toEqual(["status:confirmed"]);
	});

	test("a project name with odd characters becomes a stable tag", () => {
		expect(tagsFor(moment({ project: "scratch dir" }))).toContain("project:scratch-dir");
		expect(sanitizeTag("Scratch  Dir/Å")).toBe("scratch-dir");
		expect(sanitizeTag("---")).toBe("");
	});
});

describe("contentFor", () => {
	test("is # name, description, body separated by blank lines", () => {
		expect(contentFor(moment({ name: "N", description: "D", body: "B" }))).toBe("# N\n\nD\n\nB");
	});

	test("is hard-capped at 3000 characters without splitting a surrogate pair", () => {
		const long = contentFor(moment({ body: "x".repeat(5000) }));
		expect(long).toHaveLength(3000);
		const emoji = contentFor(moment({ name: "N", description: "", body: `${"x".repeat(2990)}\u{1F600}\u{1F600}\u{1F600}` }));
		expect(emoji).toHaveLength(2999);
		expect(/[\uD800-\uDBFF]$/.test(emoji)).toBe(false);
	});
});

describe("metadataFor", () => {
	test("carries exactly the documented keys and only string values", () => {
		const meta = metadataFor(moment());
		expect(Object.keys(meta).sort()).toEqual(
			[
				"tm_id",
				"schema",
				"name",
				"kind",
				"status",
				"origin",
				"project",
				"host",
				"confidence",
				"occurrences",
				"created_at",
				"last_seen_at",
				"source_phase",
				"source_artifacts",
				"related_ids",
			].sort(),
		);
		for (const value of Object.values(meta)) expect(typeof value).toBe("string");
		expect(meta).toMatchObject({ tm_id: "m1", schema: "tm/2", confidence: "1", occurrences: "3", source_artifacts: '["src/a.ts"]', related_ids: '["m0"]' });
	});
});

function hitFor(m: TeachableMoment, overrides: Partial<RecallHit> = {}): RecallHit {
	return { id: "unit-1", text: contentFor(m), documentId: documentIdFor(m.id), tags: tagsFor(m), metadata: metadataFor(m), ...overrides };
}

describe("lessonFromHit", () => {
	test("a hit made from a moment maps back to its lesson", () => {
		const m = moment();
		expect(lessonFromHit(hitFor(m))).toEqual({
			id: "m1",
			name: m.name,
			description: m.description,
			body: m.body,
			kind: "pitfall",
			project: "claude-ultrathink",
			host: "omp",
			occurrences: 3,
			createdAt: m.createdAt,
			source: "hindsight",
		});
	});

	test("an empty description still separates from the body", () => {
		const m = moment({ description: "", body: "first paragraph\n\nsecond paragraph" });
		const lesson = lessonFromHit(hitFor(m));
		expect(lesson?.description).toBe("");
		expect(lesson?.body).toBe("first paragraph\n\nsecond paragraph");
	});

	test("without metadata the tm: document id, header, tags and mentionedAt carry it", () => {
		const lesson = lessonFromHit({
			id: "unit",
			text: "# Pin the lockfile\n\nCI drifts.\n\nCommit bun.lock.",
			documentId: "tm:abc-1",
			tags: ["ultrathink", "kind:decision", "project:acme", "host:hermes"],
			metadata: {},
			mentionedAt: "2026-03-01T00:00:00Z",
		});
		expect(lesson).toEqual({
			id: "abc-1",
			name: "Pin the lockfile",
			description: "CI drifts.",
			body: "Commit bun.lock.",
			kind: "decision",
			project: "acme",
			host: "hermes",
			occurrences: 1,
			createdAt: "2026-03-01T00:00:00Z",
			source: "hindsight",
		});
	});

	test("hits that are not ultrathink lessons are dropped", () => {
		expect(lessonFromHit({ id: "u", text: "# Something\n\nelse", tags: [], metadata: {} })).toBeUndefined();
		expect(lessonFromHit({ id: "u", text: "# x\n\ny", documentId: "doc-9", tags: [], metadata: { name: "x" } })).toBeUndefined();
		expect(lessonFromHit({ id: "u", text: "# x\n\ny", documentId: "tm:../bad", tags: [], metadata: {} })).toBeUndefined();
		expect(lessonFromHit({ id: "u", text: "", documentId: "tm:nameless", tags: [], metadata: {} })).toBeUndefined();
	});

	test("superseded lessons are dropped, by tag or by metadata", () => {
		const m = moment();
		expect(lessonFromHit(hitFor(m, { tags: [...tagsFor(m), "status:superseded"] }))).toBeUndefined();
		expect(lessonFromHit(hitFor(m, { metadata: { ...metadataFor(m), status: "superseded" } }))).toBeUndefined();
	});

	test("bad numbers and kinds fall back instead of failing", () => {
		const m = moment();
		const lesson = lessonFromHit(hitFor(m, { tags: [], metadata: { ...metadataFor(m), occurrences: "many", kind: "mystery", project: "", host: "" } }));
		expect(lesson).toMatchObject({ occurrences: 1, kind: "pitfall", project: "unknown", host: "unknown" });
	});
});
