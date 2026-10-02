// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Maps a Teachable Moment to and from its Hindsight document (id, content, tags, metadata) and names its project.
 * One document per moment keeps retain idempotent (same id replaces) and lets recall filter by tag instead of text.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { RecallHit } from "../hindsight/types.ts";
import { MOMENT_KINDS, type MomentKind, type RecalledLesson, type TeachableMoment } from "./types.ts";

/** Hindsight's `chunks` mode stores content up to this many characters as one unit. */
export const MAX_CONTENT_CHARS = 3_000;
const MAX_TAG_CHARS = 40;
/** Tag namespaces the mapping owns; a moment's own tags cannot claim them (a `status:superseded` tag would hide a lesson). */
const RESERVED_PREFIXES = ["project:", "host:", "kind:", "status:"];
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;

export interface GitRoots {
	/** Directory that holds the `.git` entry nearest to the start directory (the working tree being edited). */
	worktree: string;
	/** Root of the primary checkout: the same as `worktree` except in a linked worktree. */
	primary: string;
}

/** Walks up from `cwd` to the nearest `.git`; undefined outside a repository. Never throws. */
export function gitRootsOf(cwd: string): GitRoots | undefined {
	let dir = resolve(cwd);
	for (let depth = 0; depth < 64; depth++) {
		const dotGit = resolve(dir, ".git");
		try {
			const info = lstatSync(dotGit);
			if (info.isDirectory()) return { worktree: dir, primary: dir };
			if (info.isFile()) return { worktree: dir, primary: primaryFromGitFile(dir, dotGit) };
		} catch {
			// no .git here: keep walking
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/** A linked worktree's `.git` file points at `<common>/worktrees/<name>`; the primary checkout is the parent of `<common>`. */
function primaryFromGitFile(dir: string, dotGit: string): string {
	try {
		const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
		if (!match?.[1]) return dir;
		const gitdir = resolve(dir, match[1]).replace(/\\/g, "/");
		const marker = gitdir.lastIndexOf("/worktrees/");
		if (marker <= 0) return dir;
		const common = gitdir.slice(0, marker);
		// A bare repository has no `.git` directory: its own directory (minus `.git`) names the project.
		return basename(common) === ".git" ? dirname(common) : common;
	} catch {
		return dir;
	}
}

/** Lowercase basename of the primary checkout (linked worktrees collapse onto it), else of `cwd`, else "unknown". */
export function projectOf(cwd: string): string {
	const roots = gitRootsOf(cwd);
	const name = basename(roots ? roots.primary : resolve(cwd)).replace(/\.git$/, "").toLowerCase();
	return name === "" ? "unknown" : name;
}

function normalizeName(name: string): string {
	return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** sha256 of `project|kind|normalized name`, first 32 hex characters: the same lesson captured twice merges. */
export function dedupeKeyFor(project: string, kind: MomentKind, name: string): string {
	return createHash("sha256").update(`${project}|${kind}|${normalizeName(name)}`).digest("hex").slice(0, 32);
}

export function documentIdFor(momentId: string): string {
	return `tm:${momentId}`;
}

/** Lowercase, `[a-z0-9:_.-]` only (anything else becomes `-`), at most 40 characters; "" when nothing is left. */
export function sanitizeTag(tag: string): string {
	return tag
		.toLowerCase()
		.replace(/[^a-z0-9:_.-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_TAG_CHARS)
		.replace(/-+$/, "");
}

export function tagsFor(moment: TeachableMoment): string[] {
	const tags = new Set<string>();
	const base = ["ultrathink", "teachable", `project:${moment.project}`, `host:${moment.host}`, `kind:${moment.kind}`, `status:${moment.status}`];
	for (const tag of base) {
		const clean = sanitizeTag(tag);
		if (clean) tags.add(clean);
	}
	for (const own of moment.tags) {
		const clean = sanitizeTag(own);
		if (clean && !RESERVED_PREFIXES.some((prefix) => clean.startsWith(prefix))) tags.add(clean);
	}
	return [...tags];
}

/** `# <name>\n\n<description>\n\n<body>`, hard-capped at 3000 characters. The description slot stays even when empty so the text parses back. */
export function contentFor(moment: TeachableMoment): string {
	const text = `# ${moment.name}\n\n${moment.description}\n\n${moment.body}`;
	if (text.length <= MAX_CONTENT_CHARS) return text;
	const cut = text.slice(0, MAX_CONTENT_CHARS);
	// Do not leave half of a surrogate pair at the cut.
	return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** String metadata Hindsight keeps next to the document (it drops nulls and rejects non-strings). */
export function metadataFor(moment: TeachableMoment): Record<string, string> {
	return {
		tm_id: moment.id,
		schema: "tm/2",
		name: moment.name,
		kind: moment.kind,
		status: moment.status,
		origin: moment.origin,
		project: moment.project,
		host: moment.host,
		confidence: String(moment.confidence),
		occurrences: String(moment.occurrences),
		created_at: moment.createdAt,
		last_seen_at: moment.lastSeenAt,
		source_phase: moment.sourcePhase,
		source_artifacts: JSON.stringify(moment.sourceArtifacts),
		related_ids: JSON.stringify(moment.relatedIds),
	};
}

function tagValue(tags: readonly string[], prefix: string): string | undefined {
	return tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length) || undefined;
}

/** Splits `# <name>\n\n<description>\n\n<body>`; text that does not follow the layout yields the first line as the name and the rest as the body. */
function parseContent(text: string): { name?: string; description: string; body: string } {
	const clean = text.replace(/\r\n/g, "\n").trim();
	const header = /^# ([^\n]*)(?:\n\n|\n|$)([\s\S]*)$/.exec(clean);
	if (!header) return { description: "", body: clean };
	const rest = header[2] ?? "";
	const split = rest.indexOf("\n\n");
	if (split === -1) return { name: header[1]?.trim(), description: "", body: rest.trim() };
	return { name: header[1]?.trim(), description: rest.slice(0, split).trim(), body: rest.slice(split + 2).trim() };
}

/** The lesson a Hindsight hit stands for; undefined for hits that are not ultrathink lessons or are superseded. */
export function lessonFromHit(hit: RecallHit): RecalledLesson | undefined {
	const meta = hit.metadata ?? {};
	const tags = hit.tags ?? [];
	const fromDocument = hit.documentId?.startsWith("tm:") ? hit.documentId.slice(3) : undefined;
	const id = meta.tm_id || fromDocument;
	if (!id || !ID_PATTERN.test(id)) return undefined;
	if (tags.includes("status:superseded") || meta.status === "superseded") return undefined;
	const parsed = parseContent(typeof hit.text === "string" ? hit.text : "");
	const name = (meta.name || parsed.name || "").trim();
	if (name === "") return undefined;
	const kind = [meta.kind, tagValue(tags, "kind:")].find((candidate): candidate is MomentKind => MOMENT_KINDS.includes(candidate as MomentKind));
	const occurrences = Number.parseInt(meta.occurrences ?? "", 10);
	return {
		id,
		name,
		description: parsed.description,
		body: parsed.body,
		kind: kind ?? "pitfall",
		project: meta.project || tagValue(tags, "project:") || "unknown",
		host: meta.host || tagValue(tags, "host:") || "unknown",
		occurrences: Number.isFinite(occurrences) && occurrences >= 1 ? occurrences : 1,
		createdAt: meta.created_at || hit.mentionedAt || "",
		source: "hindsight",
	};
}
