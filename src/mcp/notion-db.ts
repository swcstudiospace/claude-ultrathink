// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `ultrathink-mcp notion init`: creates the "Agent Task Graph" database that tracking writes to
 * (src/track/create.ts) and the ultrathink-kickoff/-sync skills update, through the Notion MCP
 * DDL tools, and records its data source in the user config. Never creates rows.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolCaller } from "../track/create.ts";

export const DEFAULT_TASK_GRAPH_TITLE = "Agent Task Graph";

type OptionColor = "default" | "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red";

export interface TaskGraphColumn {
	name: string;
	type: "TITLE" | "RICH_TEXT" | "SELECT" | "NUMBER" | "URL" | "DATE";
	/** SELECT options in display order. */
	options?: ReadonlyArray<readonly [name: string, color: OptionColor]>;
}

/**
 * Every property ultrathink writes: the planner's Task/Issue/Sub-Issue rows and the PR/status fields
 * ultrathink-sync sets. `Status` is a SELECT because DDL cannot define STATUS options and Notion
 * rejects a status value that is not already an option. `Reviewers` holds GitHub logins, so it is text.
 * The self-relation `Parent Item` (synced as `Sub-Items`) needs the new data source id, so
 * initTaskGraphDatabase adds it after the create.
 */
export const TASK_GRAPH_COLUMNS: readonly TaskGraphColumn[] = [
	{ name: "Item", type: "TITLE" },
	{ name: "Level", type: "SELECT", options: [["Task", "blue"], ["Issue", "purple"], ["Sub-Issue", "gray"]] },
	{
		name: "Status",
		type: "SELECT",
		options: [["Planning", "gray"], ["Implementing", "blue"], ["Blocked", "orange"], ["Failed", "red"], ["Done", "green"], ["Merged", "purple"]],
	},
	{
		name: "Linear State",
		type: "SELECT",
		options: [["Backlog", "gray"], ["Todo", "blue"], ["In Progress", "yellow"], ["In Review", "orange"], ["Done", "green"], ["Canceled", "red"]],
	},
	{ name: "Graph ID", type: "RICH_TEXT" },
	{ name: "Description", type: "RICH_TEXT" },
	{ name: "Uplifted Prompt", type: "RICH_TEXT" },
	{ name: "Agent", type: "RICH_TEXT" },
	{ name: "Thought", type: "RICH_TEXT" },
	{ name: "Step", type: "NUMBER" },
	{ name: "Linear URL", type: "URL" },
	{ name: "Issue ID", type: "RICH_TEXT" },
	{ name: "Repo", type: "RICH_TEXT" },
	{ name: "Branch", type: "RICH_TEXT" },
	{ name: "PR URL", type: "URL" },
	{ name: "PR #", type: "NUMBER" },
	{ name: "PR State", type: "SELECT", options: [["Open", "blue"], ["Approved", "green"], ["Merged", "purple"]] },
	{ name: "Checks", type: "SELECT", options: [["Pending", "gray"], ["Passing", "green"], ["Failing", "red"], ["Blocked", "orange"]] },
	{ name: "Reviewers", type: "RICH_TEXT" },
	{ name: "Completed", type: "DATE" },
];

/** The `schema` for notion-create-database; the title travels in its own argument. */
export function taskGraphDdl(): string {
	const columns = TASK_GRAPH_COLUMNS.map(({ name, type, options }) => {
		const values = options?.map(([option, color]) => `'${option}':${color}`).join(", ");
		return `"${name}" ${type}${values === undefined ? "" : `(${values})`}`;
	});
	return `CREATE TABLE (${columns.join(", ")})`;
}

const HEX_ID = "[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A page id closes the last path segment, alone or after the title slug. */
const PAGE_ID_RE = new RegExp(`(?:^|-)(${HEX_ID})$`, "i");
const DATA_SOURCE_RE = new RegExp(`collection://(${HEX_ID})`, "i");
const DATABASE_URL_RE = /<database\b[^>]*?(https:\/\/[^\s"'<>{}\\]+)/i;

function dashed(id: string): string {
	const hex = id.replaceAll("-", "").toLowerCase();
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The dashed page id in a Notion page URL (notion.so, notion.site, app.notion.com) or bare id; undefined when there is none. */
export function notionPageId(input: string): string | undefined {
	const segment = input.trim().replace(/[?#].*$/, "").split("/").filter(Boolean).at(-1) ?? "";
	const id = segment.match(PAGE_ID_RE)?.[1];
	return id === undefined ? undefined : dashed(id);
}

export interface TaskGraphDatabase {
	/** `collection://<id>`: the value for `notion.dataSourceUrl`. */
	dataSourceUrl: string;
	/** The database page, when the reply names it. */
	url?: string;
	/** Set when the database exists but its `Parent Item` self-relation could not be added. */
	relationError?: string;
}

/**
 * Creates the database under `parent` (page URL or id), then adds the two-way `Parent Item` ⇄
 * `Sub-Items` self-relation in the tool's documented form: both sides in one call, each naming the other.
 */
export async function initTaskGraphDatabase(client: ToolCaller, input: { parent: string; title: string }): Promise<TaskGraphDatabase> {
	const pageId = notionPageId(input.parent);
	if (pageId === undefined) throw new Error(`not a Notion page url or id: ${input.parent}`);
	const reply = await client.call("notion-create-database", { parent: { page_id: pageId }, title: input.title, schema: taskGraphDdl() });
	// The reply is Markdown (or JSON wrapping it) naming the new data source as `<data-source url="{{collection://…}}">`.
	const text = typeof reply === "string" ? reply : (JSON.stringify(reply) ?? "");
	const top = typeof reply === "object" && reply !== null && "url" in reply ? reply.url : undefined;
	const url = typeof top === "string" && top.startsWith("https://") ? top : text.match(DATABASE_URL_RE)?.[1];
	const found = text.match(DATA_SOURCE_RE)?.[1];
	if (found === undefined) {
		throw new Error(`notion-create-database: the reply names no collection:// data source${url ? ` (database ${url})` : ""}`);
	}
	const id = dashed(found);
	let relationError: string | undefined;
	try {
		await client.call("notion-update-data-source", {
			data_source_id: id,
			statements: `ADD COLUMN "Parent Item" RELATION('${id}', DUAL 'Sub-Items' 'subitems'); ADD COLUMN "Sub-Items" RELATION('${id}', DUAL 'Parent Item' 'parentitem')`,
		});
	} catch (error) {
		relationError = error instanceof Error ? error.message : String(error);
	}
	return { dataSourceUrl: `collection://${id}`, url, relationError };
}

/**
 * Sets `notion.dataSourceUrl` in the JSON config at `path`, keeping every other key, as 2-space JSON;
 * creates the file and its directory. Throws, leaving the file untouched, when it is not a JSON object.
 */
export function writeNotionConfig(path: string, dataSourceUrl: string): void {
	const text = existsSync(path) ? readFileSync(path, "utf8") : "";
	let config: unknown = {};
	if (text.trim()) {
		try {
			config = JSON.parse(text);
		} catch {
			config = undefined;
		}
	}
	if (typeof config !== "object" || config === null || Array.isArray(config)) {
		throw new Error(`cannot update ${path}: it is not a JSON object`);
	}
	const { notion } = config as { notion?: unknown };
	const next = {
		...config,
		notion: { ...(typeof notion === "object" && notion !== null && !Array.isArray(notion) ? notion : {}), dataSourceUrl },
	};
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(tmp, path);
}
