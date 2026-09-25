// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, userConfigPath } from "../config.ts";
import { initTaskGraphDatabase, notionPageId, taskGraphDdl, writeNotionConfig } from "./notion-db.ts";

const PAGE = "0123456789abcdef0123456789abcdef";
const PAGE_ID = "01234567-89ab-cdef-0123-456789abcdef";
const DS = "0f2c6a1e-3b4d-4c5e-8f90-a1b2c3d4e5f6";
const DB_URL = "https://www.notion.so/9a8b7c6d5e4f40312a1b2c3d4e5f6a7b";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-notion-db-"));
	dirs.push(dir);
	return dir;
}

function fakeNotion(reply: (name: string) => unknown) {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const client = {
		async call(name: string, args: Record<string, unknown>): Promise<unknown> {
			calls.push({ name, args });
			return reply(name);
		},
	};
	return { calls, client };
}

describe("taskGraphDdl", () => {
	test("declares exactly the properties the planner and ultrathink-sync write, each with its Notion type", () => {
		const columns: Record<string, string> = {
			Item: "TITLE",
			Level: "SELECT('Task':blue, 'Issue':purple, 'Sub-Issue':gray)",
			Status: "SELECT('Planning':gray, 'Implementing':blue, 'Blocked':orange, 'Failed':red, 'Done':green, 'Merged':purple)",
			"Linear State": "SELECT('Backlog':gray, 'Todo':blue, 'In Progress':yellow, 'In Review':orange, 'Done':green, 'Canceled':red)",
			"Graph ID": "RICH_TEXT",
			Description: "RICH_TEXT",
			"Uplifted Prompt": "RICH_TEXT",
			Agent: "RICH_TEXT",
			Thought: "RICH_TEXT",
			Step: "NUMBER",
			"Linear URL": "URL",
			"Issue ID": "RICH_TEXT",
			Repo: "RICH_TEXT",
			Branch: "RICH_TEXT",
			"PR URL": "URL",
			"PR #": "NUMBER",
			"PR State": "SELECT('Open':blue, 'Approved':green, 'Merged':purple)",
			Checks: "SELECT('Pending':gray, 'Passing':green, 'Failing':red, 'Blocked':orange)",
			Reviewers: "RICH_TEXT",
			Completed: "DATE",
		};
		const ddl = taskGraphDdl();
		expect(ddl).toStartWith("CREATE TABLE (");
		expect(ddl).toEndWith(")");
		for (const [name, type] of Object.entries(columns)) expect(ddl).toContain(`"${name}" ${type}`);
		const declared = [...ddl.matchAll(/"([^"]+)" [A-Z_]+/g)].map((match) => match[1]);
		expect(declared.sort()).toEqual(Object.keys(columns).sort());
	});
});

describe("notionPageId", () => {
	test.each([
		[`https://www.notion.so/acme/Agent-Command-Center-${PAGE}?pvs=4`, PAGE_ID],
		[`https://www.notion.so/${PAGE}#${"f".repeat(32)}`, PAGE_ID],
		[`https://app.notion.com/p/${PAGE}`, PAGE_ID],
		[`https://acme.notion.site/Home-${PAGE.toUpperCase()}/`, PAGE_ID],
		[`www.notion.so/${PAGE}`, PAGE_ID],
		[` ${PAGE_ID} `, PAGE_ID],
		[PAGE, PAGE_ID],
	])("%s", (input, expected) => {
		expect(notionPageId(input)).toBe(expected);
	});

	test.each(["https://www.notion.so/acme", "Home", `${PAGE}0`, `Home-${PAGE.slice(1)}`, ""])("%p has no page id", (input) => {
		expect(notionPageId(input)).toBeUndefined();
	});
});

describe("initTaskGraphDatabase", () => {
	const created = `Created the database.\n<database url="{{${DB_URL}}}">\n<data-source url="{{collection://${DS}}}">\n<sqlite-table>CREATE TABLE IF NOT EXISTS "collection://${DS}" (url TEXT UNIQUE)</sqlite-table>\n</data-source>\n</database>`;

	test("creates the database under the parent page, then adds the Parent Item ⇄ Sub-Items self-relation", async () => {
		const { calls, client } = fakeNotion((name) => (name === "notion-create-database" ? { result: created } : "Updated the data source."));
		const result = await initTaskGraphDatabase(client, {
			parent: `https://www.notion.so/acme/Agent-Command-Center-${PAGE}?pvs=4`,
			title: "Agent Task Graph",
		});
		expect(calls).toEqual([
			{ name: "notion-create-database", args: { parent: { page_id: PAGE_ID }, title: "Agent Task Graph", schema: taskGraphDdl() } },
			{
				name: "notion-update-data-source",
				args: {
					data_source_id: DS,
					statements: `ADD COLUMN "Parent Item" RELATION('${DS}', DUAL 'Sub-Items' 'subitems'); ADD COLUMN "Sub-Items" RELATION('${DS}', DUAL 'Parent Item' 'parentitem')`,
				},
			},
		]);
		expect(result).toEqual({ dataSourceUrl: `collection://${DS}`, url: DB_URL });
	});

	test.each([
		["plain Markdown", created],
		["JSON with a url field", { text: `<data-source url="{{collection://${DS}}}">`, url: DB_URL }],
		["structured content", { dataSources: [{ url: `collection://${DS}` }] }],
		["an undashed upper-case id", `<data-source url="collection://${DS.replaceAll("-", "").toUpperCase()}">`],
	])("reads the data source from %s", async (_shape, reply) => {
		const { client } = fakeNotion((name) => (name === "notion-create-database" ? reply : "ok"));
		expect((await initTaskGraphDatabase(client, { parent: PAGE, title: "T" })).dataSourceUrl).toBe(`collection://${DS}`);
	});

	test("a reply without a data source fails after the create, naming the database, and adds no relation", async () => {
		const { calls, client } = fakeNotion(() => ({ result: `Created <database url="{{${DB_URL}}}">` }));
		await expect(initTaskGraphDatabase(client, { parent: PAGE, title: "T" })).rejects.toThrow(`(database ${DB_URL})`);
		expect(calls.map((call) => call.name)).toEqual(["notion-create-database"]);
	});

	test("a failed self-relation still returns the created data source, with the error", async () => {
		const { client } = fakeNotion((name) => {
			if (name === "notion-update-data-source") throw new Error("notion-update-data-source: relation rejected");
			return `<data-source url="{{collection://${DS}}}">`;
		});
		expect(await initTaskGraphDatabase(client, { parent: PAGE, title: "T" })).toEqual({
			dataSourceUrl: `collection://${DS}`,
			relationError: "notion-update-data-source: relation rejected",
		});
	});

	test("a parent without a page id fails before calling Notion", async () => {
		const { calls, client } = fakeNotion(() => "");
		await expect(initTaskGraphDatabase(client, { parent: "https://www.notion.so/acme", title: "T" })).rejects.toThrow("not a Notion page url or id");
		expect(calls).toEqual([]);
	});
});

describe("writeNotionConfig", () => {
	test("merges into an existing user config, keeping every other key, as 2-space JSON", () => {
		const path = userConfigPath({ XDG_CONFIG_HOME: tempDir() });
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ linear: { team: "Acme" }, notion: { dataSourceUrl: "collection://old", note: "kept" }, hitl: { maxQuestions: 1 } }));
		writeNotionConfig(path, `collection://${DS}`);
		const expected = { linear: { team: "Acme" }, notion: { dataSourceUrl: `collection://${DS}`, note: "kept" }, hitl: { maxQuestions: 1 } };
		expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
		const config = loadConfig([path]);
		expect(config.notion.dataSourceUrl).toBe(`collection://${DS}`);
		expect(config.linear.team).toBe("Acme");
		expect(config.hitl.maxQuestions).toBe(1);
	});

	test("creates the config directory and file when missing", () => {
		const path = userConfigPath({ XDG_CONFIG_HOME: join(tempDir(), "fresh") });
		writeNotionConfig(path, `collection://${DS}`);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ notion: { dataSourceUrl: `collection://${DS}` } });
	});

	test.each(["{ not json", "[1, 2]", "null"])("leaves a config that is not a JSON object untouched: %s", (content) => {
		const path = join(tempDir(), "config.json");
		writeFileSync(path, content);
		expect(() => writeNotionConfig(path, `collection://${DS}`)).toThrow("is not a JSON object");
		expect(readFileSync(path, "utf8")).toBe(content);
	});
});
