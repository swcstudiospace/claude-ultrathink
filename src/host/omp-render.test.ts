// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { PENDING_TYPE, PLAN_TYPE, registerUltrathinkRenderers, SHIP_TYPE, SYNC_TYPE } from "./omp-render.ts";
import { visibleWidth } from "./omp-paint.ts";
import type { PlanView } from "./view.ts";

const FG = ["accent", "muted", "dim", "success", "warning", "error", "borderMuted", "borderAccent", "customMessageLabel", "customMessageText"];
const CARD_BG = "\x1b[48;5;236m";

/** Omp-shaped theme: every color is a distinct invisible SGR marker, and unknown colors throw like Omp's theme. */
const theme = {
	fg(color: string, text: string) {
		if (!FG.includes(color)) throw new Error(`Unknown theme color: ${color}`);
		return `\x1b[38;5;${FG.indexOf(color) + 1}m${text}\x1b[39m`;
	},
	bg(color: string, text: string) {
		if (color !== "customMessageBg") throw new Error(`Unknown theme background color: ${color}`);
		return `${CARD_BG}${text}\x1b[49m`;
	},
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
	icon: { package: "📦" },
	status: { running: "RR", success: "OK", error: "XX", warning: "WW", pending: ".." },
};

const throwingTheme = {
	fg() {
		throw new Error("unknown color");
	},
	bg() {
		throw new Error("unknown color");
	},
	bold() {
		throw new Error("nope");
	},
};

const themes: Record<string, unknown> = { fake: theme, throwing: throwingTheme, empty: {} };

type Renderer = Parameters<Parameters<typeof registerUltrathinkRenderers>[0]["registerMessageRenderer"]>[1];

const renderers: Record<string, Renderer> = {};
registerUltrathinkRenderers({ registerMessageRenderer: (type, renderer) => void (renderers[type] = renderer) });
const renderPlan = renderers[PLAN_TYPE] as Renderer;
const renderPending = renderers[PENDING_TYPE] as Renderer;
const renderSync = renderers[SYNC_TYPE] as Renderer;

function planCard(view: PlanView, expanded: boolean, width: number, cardTheme: unknown = theme) {
	const rows = renderPlan({ content: "md", details: view }, { expanded }, cardTheme)?.render(width) ?? [];
	return { rows, plain: rows.map((row) => Bun.stripANSI(row)) };
}

/** Visible text of a fake-theme row that is not on the card background. */
function unpainted(row: string): string {
	let onCard = false;
	let out = "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape matching
	for (const part of row.split(/(\x1b\[[0-9;]*m)/)) {
		if (part === CARD_BG) onCard = true;
		else if (part === "\x1b[49m" || part === "\x1b[0m") onCard = false;
		else if (!onCard && !part.startsWith("\x1b")) out += part;
	}
	return out;
}

// a multi-line title and a wide-character (CJK) title
const TITLES: Partial<Record<number, string>> = { 1: "Wire the\nstatus bar", 2: "数据库迁移：拆分用户表并回填历史订单数据" };

const view: PlanView = {
	root: "BUILD_PROMPT",
	source: "llm",
	elapsedMs: 65_000,
	nodes: Array.from({ length: 10 }, (_, i) => ({
		id: `n${i + 1}`,
		title: TITLES[i] ?? `Node ${i + 1}`,
		kind: "task",
		wave: i,
		dependsOn: i === 0 ? [] : [`n${i}`],
		conclusion: "done\n\n".repeat(60),
		issue: { identifier: `SPE-${i + 10}`, url: `https://linear.app/x/SPE-${i + 10}` },
		steps: [{ step: 1, title: "Step one", identifier: `SPE-${i + 100}`, url: `https://linear.app/x/SPE-${i + 100}` }],
	})),
	waves: [["n1"], ["n2", "n3"], ["n4", "n5", "n6", "n7", "n8", "n9", "n10"]],
	clarifications: [
		{ id: "c1", question: "Which DB?", blocking: true, recommended: "Postgres" },
		{ id: "c2", question: "Keep the v1 API?", blocking: false, answer: "yes" },
	],
	tracking: { status: "partial", errors: ["notion down"], issues: 10, subIssues: 10, notionTaskUrl: "https://notion.so/t" },
};

const small: PlanView = { ...view, nodes: view.nodes.slice(0, 3), waves: [["n1"], ["n2", "n3"]] };

describe("plan card", () => {
	test("every row is one terminal line of exactly the render width", () => {
		for (const [name, cardTheme] of Object.entries(themes)) {
			for (const width of [8, 40, 60, 80, 100, 160]) {
				for (const expanded of [false, true]) {
					const { rows } = planCard(view, expanded, width, cardTheme);
					expect({ name, width, expanded, widths: rows.map(visibleWidth) }).toEqual({ name, width, expanded, widths: rows.map(() => width) });
					expect(rows.join("")).not.toMatch(/[\n\r\t]/);
				}
			}
		}
	});

	test("rounded border around a card background", () => {
		for (const cardTheme of Object.values(themes)) {
			for (const expanded of [false, true]) {
				const { plain } = planCard(view, expanded, 80, cardTheme);
				expect(plain[0]).toBe(`╭${"─".repeat(78)}╮`);
				expect(plain.at(-1)).toBe(`╰${"─".repeat(78)}╯`);
				for (const row of plain.slice(1, -1)) expect([row.at(0), row.at(-1)]).toEqual(["│", "│"]);
			}
		}
		// cut rows end in a full reset; the fill after it must still sit on the card background
		for (const row of planCard(view, true, 40).rows.slice(1, -1)) expect(unpainted(row)).toBe("││");
		const ascii = { ...theme, boxRound: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|" } };
		const asciiCard = planCard(view, false, 20, ascii).plain;
		expect([asciiCard[0], asciiCard[1]?.at(0), asciiCard.at(-1)]).toEqual([`+${"-".repeat(18)}+`, "|", `+${"-".repeat(18)}+`]);
	});

	test("collapsed folds each node's sub-issues; expanded drops every step down with its link", () => {
		const collapsed = planCard(small, false, 160).plain;
		expect(collapsed[2]).toContain("📦 ultrathink-plan · BUILD_PROMPT · 3 nodes · 10 issues · 1:05");
		const text = collapsed.join("\n");
		expect(text).toContain("▸ 1 sub-issues");
		expect(text).toContain("Wire the status bar");
		expect(text).toMatch(/[╭┌]/);
		expect(text).toContain("ctrl+o drops down sub-issues");
		for (let i = 0; i < 3; i++) expect(text).not.toContain(`SPE-${i + 100}`);
		expect(text).not.toContain("waves");
		const expanded = planCard(view, true, 160).plain.join("\n");
		expect(expanded).not.toContain("ctrl+o");
		for (let i = 0; i < 10; i++) {
			expect(expanded).toContain(`SPE-${i + 10} https://linear.app/x/SPE-${i + 10}`);
			expect(expanded).toContain(`SPE-${i + 100} https://linear.app/x/SPE-${i + 100}`);
		}
		expect(expanded).toContain("[blocking] Which DB? · recommended: Postgres");
		expect(expanded).toContain("Keep the v1 API? → yes");
		expect(expanded).toContain("XX notion down");
	});

	test("collapsed graph stays bounded for large plans", () => {
		// border, padding, header, blank, <=18 graph rows, hint, 2 clarification/tracking rows, notion task, padding, border
		expect(planCard(view, false, 160).plain.length).toBeLessThanOrEqual(4 + 2 + 18 + 4);
	});

	test("shows the invoking skill in the header", () => {
		expect(planCard({ ...small, skill: "gsd-autonomous" }, false, 160).plain[2]).toContain("1:05 · via /gsd-autonomous");
		expect(planCard(small, false, 160).plain[2]).not.toContain("via /");
	});

	test("summary rows: clarifications with blocking count, status-colored tracking, notion task", () => {
		const { rows, plain } = planCard(small, false, 160);
		const text = plain.join("\n");
		expect(text).toContain("? 2 clarifications · 1 blocking");
		expect(text).toContain("tracking partial · 10 issues · 10 sub-issues");
		expect(text).toContain("notion https://notion.so/t");
		expect(text).not.toContain("ctrl+o to expand");
		expect(rows.join("\n")).toContain(theme.fg("warning", "1 blocking"));
		for (const [status, color] of [["complete", "success"], ["partial", "warning"], ["failed", "error"]] as const) {
			const tracked = planCard({ ...small, tracking: { status, errors: [], issues: 5, subIssues: 20 } }, false, 160);
			expect(tracked.plain.join("\n")).toContain(`tracking ${status} · 5 issues · 20 sub-issues`);
			expect(tracked.rows.join("\n")).toContain(theme.fg(color, status));
		}
	});

	test("issues via kickoff until tracking exists", () => {
		const text = planCard({ ...view, tracking: undefined }, true, 160).plain.join("\n");
		expect(text).toContain("10 nodes · issues via kickoff · 1:05");
		expect(text).not.toContain("tracking");
	});

	test("narrow widths drop the frame instead of overflowing", () => {
		for (const expanded of [false, true]) {
			const { plain } = planCard(view, expanded, 6);
			expect(plain[0]).toBe("📦 ul…");
			for (const row of plain) expect(visibleWidth(row)).toBeLessThanOrEqual(6);
		}
	});

	test("re-render at the same width reuses the framed rows", () => {
		const component = renderPlan({ content: "md", details: view }, { expanded: false }, theme);
		const rows = component?.render(80);
		expect(component?.render(80)).toBe(rows);
		expect(component?.render(100).map(visibleWidth)).toEqual(rows?.map(() => 100));
	});

	test("undefined for non-PlanView or malformed details", () => {
		expect(renderPlan({ content: "md" }, { expanded: false }, theme)).toBeUndefined();
		expect(renderPlan({ content: "md", details: { root: 1 } }, { expanded: false }, theme)).toBeUndefined();
		const malformed = { root: "x", nodes: [null], waves: [], clarifications: [] };
		expect(renderPlan({ content: "md", details: malformed }, { expanded: false }, theme)).toBeUndefined();
	});

	test("a throwing or empty theme still renders plain rows", () => {
		for (const cardTheme of [throwingTheme, {}]) {
			const { rows, plain } = planCard(view, true, 120, cardTheme);
			expect(rows.join("\n")).not.toContain("\x1b");
			expect(plain[2]).toContain("ultrathink-plan · BUILD_PROMPT · 10 nodes");
			expect(plain.join("\n")).toContain("✗ notion down");
		}
	});
});

describe("pending card", () => {
	test("exactly one status row inside an accent border", () => {
		const component = renderPending({ content: "" }, { expanded: false }, theme);
		const rows = component?.render(80) ?? [];
		expect(rows).toHaveLength(3);
		expect(rows.map(visibleWidth)).toEqual([80, 80, 80]);
		expect(rows[0]).toBe(theme.fg("borderAccent", `╭${"─".repeat(78)}╮`));
		expect(Bun.stripANSI(component?.render(120)[1] ?? "")).toContain("RR ultrathink-pending · planning… live status in the ultrathink bar above the editor");
		expect(renderPending({ content: "" }, { expanded: false }, throwingTheme)?.render(120)[1]).toContain("● ultrathink-pending · planning…");
		expect(renderPending({ content: "" }, { expanded: false }, theme)?.render(6).map((row) => Bun.stripANSI(row))).toEqual(["RR ul…"]);
	});
});

describe("sync card", () => {
	const url = "https://github.com/o/r/pull/12";

	test("one PR row inside an accent border at exactly the render width", () => {
		const component = renderSync({ content: "nudge", details: { url, number: 12 } }, { expanded: false }, theme);
		for (const width of [20, 80]) {
			const rows = component?.render(width) ?? [];
			expect(rows.map(visibleWidth)).toEqual([width, width, width]);
			expect(rows[0]).toBe(theme.fg("borderAccent", `╭${"─".repeat(width - 2)}╮`));
		}
		expect(Bun.stripANSI(component?.render(80)[1] ?? "")).toContain(`RR ultrathink-sync · PR ${url}`);
	});

	test("details without a PR URL fall back to Omp's default card", () => {
		for (const details of [undefined, "x", null, { url: 12 }]) {
			expect(renderSync({ content: "nudge", details }, { expanded: false }, theme)).toBeUndefined();
		}
	});
});

describe("ship card", () => {
	const renderShip = renderers[SHIP_TYPE] as Renderer;

	test("one branch row inside an accent border at exactly the render width", () => {
		const component = renderShip({ content: "nudge", details: { branch: "feat/x", base: "master", ahead: 3 } }, { expanded: false }, theme);
		for (const width of [20, 80]) {
			const rows = component?.render(width) ?? [];
			expect(rows.map(visibleWidth)).toEqual([width, width, width]);
			expect(rows[0]).toBe(theme.fg("borderAccent", `╭${"─".repeat(width - 2)}╮`));
		}
		expect(Bun.stripANSI(component?.render(80)[1] ?? "")).toContain("RR ultrathink-ship · feat/x → master · 3 commits");
	});

	test("malformed details fall back to Omp's default card", () => {
		for (const details of [undefined, "x", null, { branch: "b", base: "m" }, { branch: "b", base: 1, ahead: 2 }, { branch: "b", base: "m", ahead: "2" }]) {
			expect(renderShip({ content: "nudge", details }, { expanded: false }, theme)).toBeUndefined();
		}
	});
});
