// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { GraphView } from "../engine/graph-view.ts";
import { FIXTURES, FIXTURE_NAMES, type Fixture } from "./fixtures.ts";
import { GRAPH_APP_MIME, GRAPH_APP_URI, graphAppHtml, graphAppResourceMeta } from "./graph-app.ts";
import { APP_CSP, harnessFetch, startHarness } from "./harness/serve.ts";

const html = graphAppHtml();
const SCRIPT_RE = /<script>([\s\S]*)<\/script>/;
const script = SCRIPT_RE.exec(html)?.[1] ?? "";
const markup = html.replace(/<script>[\s\S]*<\/script>/, "").replace(/<style>[\s\S]*<\/style>/, "");

function graphOf(fixture: Fixture): GraphView | undefined {
	const sc = fixture.initial.structuredContent;
	if (!("graph" in sc)) return undefined;
	return sc.graph;
}

function graphFixtures(): [string, Fixture, GraphView][] {
	const out: [string, Fixture, GraphView][] = [];
	for (const name of FIXTURE_NAMES) {
		const fixture = FIXTURES[name];
		const graph = fixture ? graphOf(fixture) : undefined;
		if (fixture && graph) out.push([name, fixture, graph]);
	}
	return out;
}

/** Every cap of the locked GraphView contract; returns the violations. */
function capViolations(graph: GraphView): string[] {
	const bad: string[] = [];
	if (graph.goal.length > 300 || graph.goal.includes("\n")) bad.push("goal");
	for (const n of graph.nodes) {
		if (n.id.length > 40 || n.id.includes("\n")) bad.push(`id:${n.id.slice(0, 8)}`);
		if (n.title.length > 120 || n.title.includes("\n")) bad.push(`title:${n.id}`);
		if (n.question.length > 1000) bad.push(`question:${n.id}`);
		if (n.steps.length > 12) bad.push(`steps:${n.id}`);
		if (n.steps.some((s) => s.length > 600)) bad.push(`step:${n.id}`);
		if (n.conclusion.length > 2000) bad.push(`conclusion:${n.id}`);
	}
	return bad;
}

describe("graph app document", () => {
	test("is one HTML5 document with charset and viewport", () => {
		expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
		expect(html).toContain('<meta charset="utf-8">');
		expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
		expect(html).toContain('<meta name="color-scheme" content="light dark">');
		expect(html.match(/<script>/g)?.length).toBe(1);
		expect(html.match(/<\/script>/g)?.length).toBe(1);
		expect(html.match(/<style>/g)?.length).toBe(1);
		expect(graphAppHtml()).toBe(html);
	});

	test("exports the resource constants and metadata", () => {
		expect(GRAPH_APP_URI).toBe("ui://ultrathink/graph");
		expect(GRAPH_APP_MIME).toBe("text/html;profile=mcp-app");
		const meta = graphAppResourceMeta();
		expect(meta).toEqual({ csp: {}, prefersBorder: false });
		expect("domain" in meta).toBe(false);
		expect(graphAppResourceMeta()).not.toBe(meta);
	});

	test("contains none of the forbidden constructs", () => {
		const forbidden: [string, RegExp][] = [
			["eval", /\beval\s*\(/],
			["Function constructor", /\bnew\s+Function\b|\bFunction\s*\(/],
			["innerHTML", /innerHTML/],
			["outerHTML", /outerHTML/],
			["insertAdjacentHTML", /insertAdjacentHTML/],
			["document.write", /document\.write/],
			["fetch", /\bfetch\s*\(/],
			["XMLHttpRequest", /XMLHttpRequest/],
			["WebSocket", /WebSocket/],
			["EventSource", /EventSource/],
			["sendBeacon", /sendBeacon/],
			["dynamic import", /\bimport\s*\(/],
			["javascript: URL", /javascript:/i],
			["setTimeout with a string", /setTimeout\s*\(\s*["']/],
		];
		for (const [name, re] of forbidden) expect({ name, found: re.test(html) }).toEqual({ name, found: false });
	});

	test("client-side cuts never leave half of an emoji at the boundary", () => {
		const cutSource = /function cut\(s, n\) \{[\s\S]*?\n\s*\}/.exec(script)?.[0];
		const lineSource = /function oneLine\(s, max\) \{[\s\S]*?\n\s*\}/.exec(script)?.[0];
		expect(cutSource).toBeDefined();
		expect(lineSource).toBeDefined();
		const oneLine = new Function(`${cutSource}\n${lineSource}\nreturn oneLine;`)() as (s: string, max: number) => string;
		// Max 120 with the ellipsis: the emoji occupies units 118 and 119 and must go whole.
		expect(oneLine(`${"a".repeat(118)}😀tail`, 120)).toBe(`${"a".repeat(118)}…`);
		expect(oneLine(`${"a".repeat(117)}😀tail`, 120)).toBe(`${"a".repeat(117)}😀…`);
	});

	test("has no inline handlers, no external references and no handler properties", () => {
		expect(/\son[a-z]+\s*=/i.test(markup)).toBe(false);
		expect(/\s(?:src|href|srcset|action|formaction)\s*=/i.test(markup)).toBe(false);
		expect(/<(?:link|img|iframe|object|embed|base|form)\b/i.test(markup)).toBe(false);
		expect(/\.on[a-z]+\s*=[^=]/.test(script)).toBe(false);
		expect(/\.setAttribute\(\s*["']on/i.test(script)).toBe(false);
		expect(/\.setAttribute\(\s*["'](?:style|src|href)["']/i.test(script)).toBe(false);
		expect(script).toContain("textContent");
	});

	test("mentions no http(s) URL except the SVG namespace", () => {
		const urls = html.match(/https?:\/\/[^\s"'<>)]*/g) ?? [];
		expect(urls).toEqual(["http://www.w3.org/2000/svg"]);
	});

	test("interprets only messages from the parent window and listens before it initializes", () => {
		// The sender check runs before any message is interpreted.
		expect(script.indexOf("event.source !== window.parent")).toBeGreaterThan(-1);
		expect(script.indexOf("event.source !== window.parent")).toBeLessThan(script.indexOf("onHostRequest(m)"));
		// The listener is live before ui/initialize is sent.
		expect(script.indexOf('addEventListener("message"')).toBeLessThan(script.indexOf('request("ui/initialize"'));
	});

	test("stays under 80 KiB", () => {
		expect(Buffer.byteLength(html, "utf8")).toBeLessThan(80 * 1024);
	});

	test("the script parses as JavaScript", () => {
		expect(script.length).toBeGreaterThan(1000);
		const transpiler = new Bun.Transpiler({ loader: "js" });
		expect(() => transpiler.transformSync(script)).not.toThrow();
	});
});

describe("fixtures", () => {
	test("cover the acceptance list", () => {
		for (const name of ["diamond", "eight", "longtitles", "oversize", "hostile", "degraded", "questions", "running", "failed", "invalid", "skipped", "nograph", "plannedstart"]) {
			expect(FIXTURE_NAMES).toContain(name);
		}
	});

	test("the diamond has six nodes in three waves with a parallel middle", () => {
		const graph = graphOf(FIXTURES.diamond as Fixture) as GraphView;
		expect(graph.nodes).toHaveLength(6);
		expect(graph.waves.map((w) => w.parallel)).toEqual([false, true, false]);
		expect(graph.waves.map((w) => w.ids.length)).toEqual([1, 4, 1]);
		expect(graph.counts).toEqual({ nodes: 6, edges: 8, waves: 3, steps: graph.nodes.reduce((sum, n) => sum + n.steps.length, 0) });
		expect(graphOf(FIXTURES.eight as Fixture)?.nodes).toHaveLength(8);
	});

	test("conforming fixtures obey the GraphView contract", () => {
		const all = graphFixtures();
		expect(all.length).toBeGreaterThanOrEqual(6);
		for (const [name, fixture, graph] of all) {
			const violations = capViolations(graph);
			if (!fixture.conforming) {
				expect({ name, exceeds: violations.length > 0 }).toEqual({ name, exceeds: true });
				continue;
			}
			expect({ name, violations }).toEqual({ name, violations: [] });
			expect(graph.version).toBe(1);
			const ids = new Set(graph.nodes.map((n) => n.id));
			expect(ids.size).toBe(graph.nodes.length);
			const waveOf = new Map(graph.nodes.map((n) => [n.id, n.wave]));
			for (const n of graph.nodes) {
				for (const dep of n.dependsOn) {
					expect({ name, node: n.id, dep, known: ids.has(dep) }).toEqual({ name, node: n.id, dep, known: true });
					expect(waveOf.get(dep) as number).toBeLessThan(n.wave);
				}
				expect(n.wave).toBe(1 + Math.max(0, ...n.dependsOn.map((d) => waveOf.get(d) as number)));
			}
			// Topological order: a node never precedes a dependency.
			const seen = new Set<string>();
			for (const n of graph.nodes) {
				for (const dep of n.dependsOn) expect(seen.has(dep)).toBe(true);
				seen.add(n.id);
			}
			expect(graph.waves.flatMap((w) => w.ids).sort()).toEqual([...ids].sort());
			for (const w of graph.waves) expect(w.parallel).toBe(w.ids.length > 1);
			expect(graph.counts.nodes).toBe(graph.nodes.length);
			expect(graph.counts.waves).toBe(graph.waves.length);
			expect(graph.counts.edges).toBe(graph.nodes.reduce((sum, n) => sum + n.dependsOn.length, 0));
			expect(graph.counts.steps).toBe(graph.nodes.reduce((sum, n) => sum + n.steps.length, 0));
			expect(graph.degraded.fills.every((id) => ids.has(id))).toBe(true);
		}
	});

	test("the degraded fixture flags the nodes its fills name", () => {
		const graph = graphOf(FIXTURES.degraded as Fixture) as GraphView;
		expect(graph.degraded.fills).toEqual(["n3", "n5"]);
		expect(graph.nodes.filter((n) => n.fallback).map((n) => n.id)).toEqual(["n3", "n5"]);
	});

	test("hostile text is present in every text field and never in the document", () => {
		const graph = graphOf(FIXTURES.hostile as Fixture) as GraphView;
		const first = graph.nodes[0];
		expect(first?.title).toContain("<img src=x onerror=alert(1)>");
		expect(first?.question).toContain("</script>");
		expect(first?.steps.some((s) => s.includes("`"))).toBe(true);
		expect(first?.conclusion).toContain("</script>");
		expect(html).not.toContain("onerror=alert(1)");
	});

	test("results carry text content, a session id and a consistent poll sequence", () => {
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
		for (const name of FIXTURE_NAMES) {
			const fixture = FIXTURES[name] as Fixture;
			expect(fixture.name).toBe(name);
			const { initial, polls } = fixture;
			expect(initial.content[0]?.type).toBe("text");
			expect(uuid.test(initial.structuredContent.sessionId)).toBe(true);
			for (const poll of polls) expect(poll.structuredContent.sessionId).toBe(initial.structuredContent.sessionId);
		}
		const running = FIXTURES.running as Fixture;
		expect(running.initial.structuredContent.status).toBe("running");
		expect(running.polls.map((p) => p.structuredContent.status)).toEqual(["running", "running", "planned"]);
		expect(FIXTURES.failed?.initial.structuredContent.status).toBe("failed");
		expect(graphOf(FIXTURES.nograph as Fixture)).toBeUndefined();
	});

	test("fixtures survive a JSON round trip, as the harness sends them", () => {
		expect(JSON.parse(JSON.stringify(FIXTURES))).toEqual(FIXTURES);
	});
});

describe("harness", () => {
	test("the host page loads nothing from outside and sandboxes the app", async () => {
		const page = await Bun.file(new URL("./harness/host.html", import.meta.url)).text();
		expect(/https?:\/\//i.test(page)).toBe(false);
		expect(/<script[^>]*\ssrc=/i.test(page)).toBe(false);
		expect(/<link\b/i.test(page)).toBe(false);
		expect(page).toContain("allow-scripts allow-same-origin");
		expect(page).toContain("/app.html");
		expect(page).toContain("window.__log");
		expect(page).toContain('param("msgform", "array")');
		expect(page).toContain("-32602");
	});

	test("serves the host page, the app with the spec CSP, and the fixtures", async () => {
		const server = startHarness(0);
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const app = await fetch(`${base}/app.html`);
			expect(app.status).toBe(200);
			expect(await app.text()).toBe(html);
			expect(app.headers.get("content-security-policy")).toBe(APP_CSP);
			expect(APP_CSP).toContain("connect-src 'none'");
			const page = await fetch(`${base}/`);
			expect(page.headers.get("content-type")).toContain("text/html");
			expect(await page.text()).toContain("MCP Apps host harness");
			const data = (await (await fetch(`${base}/fixtures.json`)).json()) as { names: string[]; fixtures: Record<string, unknown> };
			expect(data.names).toEqual(FIXTURE_NAMES);
			expect(Object.keys(data.fixtures)).toEqual(FIXTURE_NAMES);
			expect((await fetch(`${base}/nope`)).status).toBe(404);
			expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
		} finally {
			await server.stop(true);
		}
	});

	test("answers without a server for unknown paths", async () => {
		const res = await harnessFetch(new Request("http://127.0.0.1/unknown"));
		expect(res.status).toBe(404);
	});
});
