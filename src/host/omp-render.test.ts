// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { ModelResolution } from "./engine.ts";
import { INSIGHT_TYPE, PENDING_TYPE, PLAN_TYPE, registerUltrathinkRenderers, SHIP_TYPE, SYNC_TYPE } from "./omp-render.ts";
import { visibleWidth } from "./omp-paint.ts";
import { toInsightCardSnapshot, type InsightCardSnapshot, type InsightDecision, type InsightSnapshot } from "./omp-insights.ts";
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
		issue: { identifier: `ENG-${i + 10}`, url: `https://linear.app/x/ENG-${i + 10}` },
		steps: [{ step: 1, title: "Step one", identifier: `ENG-${i + 100}`, url: `https://linear.app/x/ENG-${i + 100}` }],
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
		for (let i = 0; i < 3; i++) expect(text).not.toContain(`ENG-${i + 100}`);
		expect(text).not.toContain("waves");
		const expanded = planCard(view, true, 160).plain.join("\n");
		expect(expanded).not.toContain("ctrl+o");
		for (let i = 0; i < 10; i++) {
			expect(expanded).toContain(`ENG-${i + 10} https://linear.app/x/ENG-${i + 10}`);
			expect(expanded).toContain(`ENG-${i + 100} https://linear.app/x/ENG-${i + 100}`);
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

describe("plan card model row (§9 path 5)", () => {
	const DETECTED: ModelResolution = {
		version: "1.0.0",
		state: "detected",
		host: "omp",
		transport: "omp-native",
		source: "ctx.model",
		reason: "live-model",
		engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
		provider: "acme",
		modelId: "sol-1",
		modelKnown: true,
		label: "omp-native:acme/sol-1 [detected]",
	};

	test("a recorded resolution adds one model row: label, reason and engine request", () => {
		const withRecord = planCard({ ...small, modelResolution: DETECTED }, false, 200).plain;
		expect(withRecord.join("\n")).toContain("model omp-native:acme/sol-1 [detected] · reason live-model · engine auto (config)");
		expect(withRecord.length).toBe(planCard(small, false, 200).plain.length + 1);
	});

	test("no record, no row; an unsafe record shows the opaque marker and none of its text", () => {
		expect(planCard(small, true, 200).plain.join("\n")).not.toContain("· reason");
		const unsafe = planCard({ ...small, modelResolution: { ...DETECTED, label: "omp-native:https://SECRET.invalid [detected]" } }, true, 200).plain.join("\n");
		expect(unsafe).toContain("model <opaque-model> · reason live-model · engine auto (config)");
		expect(unsafe).not.toContain("SECRET");
	});

	test("every row keeps the render width with a record", () => {
		for (const [name, cardTheme] of Object.entries(themes)) {
			for (const width of [8, 40, 80, 160]) {
				const { rows } = planCard({ ...small, modelResolution: DETECTED }, true, width, cardTheme);
				expect({ name, width, widths: rows.map(visibleWidth) }).toEqual({ name, width, widths: rows.map(() => width) });
			}
		}
	});
});

describe("insight card", () => {
	const renderInsight = renderers[INSIGHT_TYPE] as Renderer;

	// fixture matches the frozen card DTO (asInsightCard); body/content ride along as leak bait the renderer must drop
	const cardDetails = {
		project: "demo",
		session: "s1",
		at: 1_700_000_000_000,
		policy: {
			enabled: true,
			capture: "explicit",
			recall: true,
			recallLimit: 5,
			recallChars: 4000,
			autoPromote: false,
			promoteAfter: 3,
			jevEnabled: true,
		},
		decisions: [
			{ point: "teachable", outcome: "ok", action: "keep", model: "m1" },
			{ point: "skillworthy", outcome: "error", action: "skip", model: "m1" },
		],
		lessons: [
			{ id: "l-1", name: "First", status: "candidate", kind: "pattern", occurrences: 1, eligible: false, body: "must never appear in compact rows", content: "draft leak" },
			{ id: "l-2", name: "Second", status: "confirmed", kind: "pattern", occurrences: 2, eligible: true },
			{ id: "l-3", name: "Third", status: "promoted", kind: "playbook", occurrences: 1, eligible: false, promoted: { target: "omp", skill: "" } },
			{ id: "l-4", name: "Fourth", status: "candidate", kind: "pitfall", occurrences: 1, eligible: false },
		],
		counts: { candidate: 2, confirmed: 1, promoted: 1, superseded: 0 },
		eligible: 1,
		promoted: 1,
		partial: true,
		limitations: ["partial read"],
	};

	function insightCard(details: unknown, expanded: boolean, width: number, cardTheme: unknown = theme) {
		const rows = renderInsight({ content: "card", details }, { expanded }, cardTheme)?.render(width) ?? [];
		return { rows, plain: rows.map((row) => Bun.stripANSI(row)) };
	}

	test("compact card stays within six content rows and never carries bodies or drafts", () => {
		const { rows, plain } = insightCard(cardDetails, false, 80);
		expect(rows.length).toBeLessThanOrEqual(6 + 4);
		expect(plain.join("\n")).not.toContain("must never appear");
		expect(plain.join("\n")).not.toContain("draft leak");
		// lifecycle counts share the limitation row: real snapshots always carry limitation
		// notes, so a dedicated counts row would never fit the six-row budget
		const countsRow = plain.find((row) => row.includes("2 candidate"));
		expect(countsRow).toBeDefined();
		expect(countsRow).toContain("partial read");
	});

	test("expanded card stays within twenty-four content rows with an omission notice when capped", () => {
		const { rows, plain } = insightCard(cardDetails, true, 80);
		expect(rows.length).toBeLessThanOrEqual(24 + 4);
		expect(plain.join("\n")).toMatch(/more lessons — open \/ultrathink-ui/);
	});

	test("captured cards are labeled with time and scope, never as live state", () => {
		const { plain } = insightCard(cardDetails, false, 80);
		const text = plain.join("\n");
		expect(text).toContain("demo");
		expect(text).toMatch(/captured/);
		expect(text).toMatch(/not live/);
		expect(text).not.toContain("is live");
	});

	test("malformed persisted details fall back to a safe bounded card", () => {
		for (const details of [undefined, null, "x", 42, ["array"], { project: 7, decisions: "nope" }]) {
			const { rows } = insightCard(details, false, 80, {});
			expect(rows.length).toBeLessThanOrEqual(6 + 4);
			for (const row of rows) expect(row).not.toContain(String.fromCharCode(27));
		}
	});

	test("hostile persisted text never reaches the terminal unsanitized", () => {
		const hostile = {
			project: "x\x1b[2Jcgi",
			session: "s\x1b]0;pwned\x07",
			at: 1_700_000_000_000,
			policy: {
				enabled: true,
				capture: "observe",
				recall: true,
				recallLimit: 5,
				recallChars: 4000,
				autoPromote: false,
				promoteAfter: 3,
				jevEnabled: true,
			},
			decisions: [{ point: "plan", outcome: "ok", action: "plan", model: "m" }],
			lessons: [{ id: "h-1", name: "a\u202eb", status: "candidate", kind: "bug", occurrences: 1, eligible: false }],
			counts: { candidate: 1, confirmed: 0, promoted: 0, superseded: 0 },
			eligible: 0,
			promoted: 0,
			partial: false,
			limitations: [],
		};
		const { rows } = insightCard(hostile, true, 80, {});
		for (const row of rows) expect(row).not.toContain(String.fromCharCode(27));
	});

	test("every row keeps the render width", () => {
		for (const width of [8, 40, 80, 160]) {
			const { rows } = insightCard(cardDetails, true, width);
			expect(rows.map(visibleWidth)).toEqual(rows.map(() => width));
		}
	});

	// Real canonical data: the card under test is produced by the actual
	// toInsightCardSnapshot writer, never a hand-copied DTO literal. Bodies,
	// descriptions and selection revisions ride along as leak bait.
	function canonicalCard(overrides: Partial<InsightSnapshot> = {}): InsightCardSnapshot {
		const snapshot: InsightSnapshot = {
			project: "demo",
			session: "s1",
			at: 1_700_000_000_000,
			decisions: [
				{
					point: "teachable",
					outcome: "ok",
					model: "jev-test-model",
					action: "keep",
					threshold: 0.5,
					latencyMs: 12,
					attempts: 1,
					at: 1_700_000_000_000,
					probabilities: { capture: 0.82 },
					questions: [{ key: "worth-keeping", p: 0.82 }],
				},
				{
					point: "skillworthy",
					outcome: "error",
					model: "jev-test-model",
					action: "fail-open",
					threshold: 0.5,
					latencyMs: 30,
					attempts: 2,
					at: 1_700_000_001_000,
					probabilities: {},
					questions: [],
				},
			],
			lessons: [
				{
					id: "l-1",
					name: "First lesson",
					description: "operator notes stay out of cards",
					body: "FULL BODY MUST NEVER RENDER",
					status: "confirmed",
					kind: "pattern",
					origin: "explicit",
					host: "omp",
					occurrences: 4,
					recalled: 1,
					createdAt: "2026-01-01T00:00:00Z",
					lastSeenAt: "2026-01-02T00:00:00Z",
					sourcePhase: "p1",
					sourceArtifacts: ["a"],
					tags: ["t"],
					relatedIds: [],
					selection: { id: "l-1", revision: "digest-must-never-render" },
					eligible: true,
				},
				{
					id: "l-2",
					name: "Second lesson",
					description: "",
					body: "",
					status: "promoted",
					kind: "playbook",
					origin: "explicit",
					host: "omp",
					occurrences: 9,
					recalled: 3,
					createdAt: "2026-01-03T00:00:00Z",
					lastSeenAt: "2026-01-04T00:00:00Z",
					sourcePhase: "p1",
					sourceArtifacts: [],
					tags: [],
					relatedIds: [],
					selection: { id: "l-2", revision: "r2" },
					eligible: false,
					promoted: { at: "2026-01-04T00:00:00Z", skill: "second-skill", target: "omp" },
				},
				{
					id: "l-3",
					name: "Third lesson",
					description: "",
					body: "",
					status: "candidate",
					kind: "bug",
					origin: "observe",
					host: "omp",
					occurrences: 1,
					recalled: 0,
					createdAt: "2026-02-01T00:00:00Z",
					lastSeenAt: "2026-02-01T00:00:00Z",
					sourcePhase: "p2",
					sourceArtifacts: [],
					tags: [],
					relatedIds: [],
					selection: { id: "l-3", revision: "r3" },
					eligible: false,
				},
			],
			policy: {
				enabled: true,
				capture: "observe",
				recall: true,
				recallLimit: 5,
				recallChars: 4000,
				autoPromote: false,
				promoteAfter: 3,
				jevEnabled: true,
			},
			counts: { candidate: 1, confirmed: 1, promoted: 1, superseded: 0 },
			eligible: 1,
			promoted: 1,
			partial: false,
			limitations: [],
			...overrides,
		};
		return toInsightCardSnapshot(snapshot);
	}

	test("recorded nonzero autonomy counts render instead of zeroed lists", () => {
		const { plain } = insightCard(canonicalCard(), false, 80);
		const text = plain.join("\n");
		expect(text).toMatch(/1 eligible/);
		expect(text).toMatch(/1 promoted/);
		expect(text).not.toMatch(/0 eligible/);
		expect(text).not.toMatch(/0 promoted/);
		expect(text).toMatch(/1 confirmed/);
		expect(text).not.toContain("superseded");
	});

	test("lesson bodies, descriptions and selection revisions never reach rows", () => {
		for (const expanded of [false, true]) {
			const { plain } = insightCard(canonicalCard(), expanded, 160);
			const text = plain.join("\n");
			expect(text).not.toContain("FULL BODY MUST NEVER RENDER");
			expect(text).not.toContain("operator notes stay out of cards");
			expect(text).not.toContain("digest-must-never-render");
		}
	});

	test("expanded card shows typed decision fields with the first question", () => {
		const { plain } = insightCard(canonicalCard(), true, 160);
		const text = plain.join("\n");
		expect(text).toMatch(/teachable/);
		expect(text).toMatch(/fail-open/);
		expect(text).toMatch(/jev-test-model/);
		expect(text).toMatch(/worth-keeping/);
		expect(text).toMatch(/0\.82/);
		expect(text).toMatch(/second-skill/);
		expect(text).toMatch(/Effective policy: teaching on/);
	});

	test("expanded card never rounds a saved probability across its threshold", () => {
		const snapshot = canonicalCard();
		const first = snapshot.decisions[0];
		if (first === undefined) throw new Error("canonical fixture must carry a decision");
		const near = { ...first, p: 0.1999, threshold: 0.2, questions: [{ key: "edge-case", p: 0.1999 }] };
		const { plain } = insightCard(canonicalCard({ decisions: [near, ...snapshot.decisions.slice(1)] }), true, 160);
		const text = plain.join("\n");
		expect(text).toContain("edge-case (0.19)");
		expect(text).toContain("P 0.19");
		expect(text).toContain("thr 0.20");
		expect(text).not.toContain("P 0.20");
		expect(text).not.toContain("20%");
	});

	test("expanded card keeps zero and one probabilities honest", () => {
		const snapshot = canonicalCard();
		const first = snapshot.decisions[0];
		const second = snapshot.decisions[1];
		if (first === undefined || second === undefined) throw new Error("canonical fixture must carry two decisions");
		const zero = { ...first, questions: [{ key: "never-asked", p: 0 }] };
		const one = { ...second, questions: [{ key: "always-asked", p: 1 }] };
		const { plain } = insightCard(canonicalCard({ decisions: [zero, one] }), true, 160);
		const text = plain.join("\n");
		expect(text).toContain("never-asked (0.00)");
		expect(text).toContain("always-asked (1.00)");
		expect(text).not.toContain("NaN");
	});

	test("legacy list-shaped counts fall back instead of rendering zero", () => {
		const legacy = { ...canonicalCard(), eligible: [{ id: "x" }], promoted: [{ id: "y" }] };
		const { plain } = insightCard(legacy, false, 80, {});
		const text = plain.join("\n");
		expect(text).toMatch(/unavailable/);
		expect(text).not.toMatch(/0 eligible/);
	});

	test("invented alias fields never override recorded counts", () => {
		const aliased = { ...canonicalCard(), eligibleCount: 99, promotedCount: 99, title: "Alias bait" };
		const { plain } = insightCard(aliased, false, 80);
		const text = plain.join("\n");
		expect(text).toMatch(/1 eligible/);
		expect(text).toMatch(/1 promoted/);
		expect(text).not.toContain("Alias bait");
		expect(text).not.toContain("99");
	});

	test("raw message content is never rendered", () => {
		const rows =
			renderInsight({ content: "SECRET-CONTENT-MARKER", details: canonicalCard() }, { expanded: true }, theme)?.render(160) ?? [];
		expect(rows.map((row) => Bun.stripANSI(row)).join("\n")).not.toContain("SECRET-CONTENT-MARKER");
	});

	test("repeated renders at the same width return the same rows", () => {
		const component = renderInsight({ content: "card", details: canonicalCard() }, { expanded: false }, theme);
		expect(component).toBeDefined();
		expect(component?.render(80)).toBe(component?.render(80));
	});

	test("recorded zeroes render as zeroes while absent cost stays absent", () => {
		const snapshot = canonicalCard();
		const first = snapshot.decisions[0];
		if (first === undefined) throw new Error("canonical fixture must carry a decision");
		const zeroed = { ...first, p: 0, threshold: 0.5, latencyMs: 0, attempts: 0, cost: 0, questions: [] };
		for (const width of [80, 120]) {
			const { plain, rows } = insightCard(canonicalCard({ decisions: [zeroed] }), true, width);
			const text = plain.map((row) => row.slice(1, -1).trim()).join(" ").replace(/\s+/g, " ");
			expect(text).toContain("P 0.00");
			expect(text).toContain("thr 0.50");
			expect(text).toContain("0ms");
			expect(text).toContain("0 attempts");
			expect(text).toContain("Cost 0");
			expect(text).toContain("2023-11-14T22:13:20.000Z");
			expect(rows.length).toBeLessThanOrEqual(24 + 4);
		}
		const { plain: noCost } = insightCard(canonicalCard(), true, 160);
		expect(noCost.join("\n")).not.toContain("Cost");
	});

	test("classified failure kinds render while invented kinds are dropped with the row kept", () => {
		const snapshot = canonicalCard();
		const second = snapshot.decisions[1];
		if (second === undefined) throw new Error("canonical fixture must carry two decisions");
		const { plain } = insightCard(canonicalCard({ decisions: [snapshot.decisions[0]!, { ...second, error: "timeout" }] }), true, 160);
		expect(plain.join("\n")).toContain("err timeout");
		const invented = { ...second, error: "meltdown" } as unknown as InsightDecision;
		const { plain: dropped } = insightCard(canonicalCard({ decisions: [snapshot.decisions[0]!, invented] }), true, 160);
		const text = dropped.join("\n");
		expect(text).not.toContain("meltdown");
		expect(text).not.toContain("err ");
		expect(text).toMatch(/fail-open/);
	});

	test("compact autonomy reflects effective capture/recall/auto-promotion settings", () => {
		const { plain } = insightCard(canonicalCard(), false, 160);
		const text = plain.join("\n");
		expect(text).toContain("capture observe");
		expect(text).toContain("recall on (5/4000)");
		expect(text).toContain("auto-promote off");
		expect(text).toContain("after 3");
		const snapshot = canonicalCard();
		const off = canonicalCard({
			policy: { ...snapshot.policy, capture: "auto", recall: false, autoPromote: true, promoteAfter: 5 },
		});
		const { plain: offPlain } = insightCard(off, false, 160);
		const offText = offPlain.join("\n");
		expect(offText).toContain("capture auto");
		expect(offText).toContain("recall off");
		expect(offText).toContain("auto-promote on");
		expect(offText).toContain("after 5");
	});

	test("expanded card discloses shown counts and omitted-skill overflow", () => {
		const snapshot = canonicalCard();
		const base = snapshot.lessons[0];
		if (base === undefined) throw new Error("canonical fixture must carry a lesson");
		const lessons = [0, 1, 2, 3, 4].map((index) => ({ ...base, id: `eligible-${index}`, name: `Eligible ${index}` }));
		const { rows, plain } = insightCard({ ...snapshot, lessons }, true, 160);
		const text = plain.join("\n");
		expect(text).toContain("5 shown");
		expect(text).toMatch(/2 more lessons — open \/ultrathink-ui/);
		expect(text).toMatch(/2 more skills omitted — open \/ultrathink-ui/);
		expect(rows.length).toBeLessThanOrEqual(24 + 4);
	});

	test("scarce limitation rows prefer actionable cap/read notes over boilerplate", () => {
		const card = {
			...cardDetails,
			limitations: [
				"Teaching Jev history is not recorded. Lesson state is not a verdict receipt.",
				"Partial snapshot — some local data could not be read. Available records remain visible; press r to refresh.",
			],
		};
		const { plain } = insightCard(card, false, 160);
		const countsRow = plain.find((row) => row.includes("Counts (shown)")) ?? "";
		expect(countsRow).toContain("Partial snapshot");
		expect(countsRow).not.toContain("Teaching Jev history");
	});

	test("compact card discloses capture omissions before a long lesson title can clip them", () => {
		const snapshot = canonicalCard();
		const first = snapshot.lessons[0]!;
		const lessons = Array.from({ length: 24 }, (_, index) => ({ ...first, id: `lesson-${index}`, name: "long ".repeat(24) }));
		const { plain } = insightCard({ ...snapshot, lessons, counts: { candidate: 1, confirmed: 31, promoted: 0, superseded: 0 } }, false, 120);
		const text = plain.join("\n");
		expect(text).toContain("24 shown");
		expect(text).toContain("8 omitted from card");
		expect(text).toContain("31 confirmed");
	});

	test("compact drops vertical padding while expanded keeps it", () => {
		const compact = insightCard(cardDetails, false, 80);
		expect(compact.rows.length).toBeLessThanOrEqual(6 + 2);
		const expanded = insightCard(cardDetails, true, 80);
		expect(expanded.rows.length).toBeLessThanOrEqual(24 + 4);
	});
});
