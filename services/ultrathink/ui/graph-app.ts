// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The Claude MCP App that draws a plan's Graph of Thought x Chain of Thought: one HTML document with inline CSS and
 * JavaScript, no SDK, no bundler, no network. It speaks the MCP Apps View protocol (spec 2026-01-26) over postMessage.
 * Every string it shows came from a model and is untrusted: the script only ever uses `textContent` and
 * `setAttribute` on known attributes, never HTML strings. The script is a plain string so this module imports
 * nothing from the service.
 */

export const GRAPH_APP_URI = "ui://ultrathink/graph";
export const GRAPH_APP_MIME = "text/html;profile=mcp-app";

/** The `_meta.ui` object of the resource: nothing external is loaded, so the CSP lists no origins and there is no `domain`. */
export function graphAppResourceMeta(): { csp: Record<string, never>; prefersBorder: false } {
	return { csp: {}, prefersBorder: false };
}

// Dark palette, shared by the explicit host theme and the prefers-color-scheme fallback.
const DARK_VARS = `--fg:var(--color-text-primary,#faf9f5);--fg2:var(--color-text-secondary,#c2c0b6);--fg3:var(--color-text-tertiary,#9c9a92);--line:var(--color-border-primary,rgba(222,220,209,.35));--surface:var(--color-background-secondary,#30302e);--accent:var(--color-text-info,#80aadd);--focus:#93c5fd;--ok:var(--color-text-success,#7ab948);--bad:var(--color-text-danger,#ee8884);--warn:var(--color-text-warning,#d1a041);--cardfg:var(--fg);--tint:16%;--basefill:transparent;`;

const CSS = `
:root{color-scheme:light dark;--fg:var(--color-text-primary,#141413);--fg2:var(--color-text-secondary,#3d3d3a);--fg3:var(--color-text-tertiary,#6b6a64);--line:var(--color-border-primary,rgba(31,30,29,.35));--surface:var(--color-background-secondary,#f5f4ed);--accent:var(--color-text-info,#3266ad);--focus:#1d4ed8;--ok:var(--color-text-success,#265b19);--bad:var(--color-text-danger,#7f2c28);--warn:var(--color-text-warning,#5a4815);--cardfg:#0f172a;--tint:0%}
@media (prefers-color-scheme:dark){:root:not([data-theme]){${DARK_VARS}}}
:root[data-theme="dark"]{${DARK_VARS}}
[hidden]{display:none!important}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{min-height:160px;padding:4px;color:var(--fg);font:14px/1.45 var(--font-sans,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif)}
.app{border:1px solid var(--line);border-radius:12px;padding:16px;min-width:0}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
h1,h2,h3,p{margin:0}
.head{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px;margin-bottom:16px}
.head-text{flex:1 1 200px;min-width:0}
.goal{font-size:16px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.counts{margin-top:4px;font-size:13px;color:var(--fg2)}
.notice{margin-top:4px;font-size:13px;color:var(--warn);overflow-wrap:anywhere}
.chip{flex:none;padding:2px 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--c) 45%,transparent);background:color-mix(in srgb,var(--c) 14%,transparent);color:var(--c);font-size:13px;font-weight:600}
.s-running{--c:var(--accent)}
.s-planned{--c:var(--ok)}
.s-failed,.s-invalid{--c:var(--bad)}
.s-skipped{--c:var(--warn)}
.main{display:flex;flex-direction:column;gap:16px}
@media (min-width:1100px){.main:not(.solo){display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);align-items:start}}
.pane{min-width:0}
.graph{overflow-x:auto;padding:4px 4px 8px}
.inner{position:relative;width:max-content;min-width:100%}
.edges{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:0;color:var(--fg3)}
.edge{fill:none;stroke:var(--fg3);stroke-width:1.5;opacity:.75}
.edge.hot{stroke:var(--accent);stroke-width:2.5;opacity:1}
.edge.draw{stroke-dasharray:1;stroke-dashoffset:1;animation:draw .5s ease-out forwards}
.mk{fill:var(--fg3)}
.mk.hot{fill:var(--accent)}
.waves{position:relative;z-index:1;display:flex;align-items:flex-start;gap:40px}
.wave{flex:0 0 184px;min-width:0}
.wave-h{margin-bottom:8px;font-size:13px;font-weight:600;color:var(--fg2)}
.cards{display:flex;flex-direction:column;gap:12px}
.k-understand{--ks:#1d4ed8;--kl:#dbeafe}
.k-decompose{--ks:#4338ca;--kl:#e0e7ff}
.k-generate{--ks:#15803d;--kl:#dcfce7}
.k-compare{--ks:#a16207;--kl:#fef9c3}
.k-critique{--ks:#b91c1c;--kl:#fee2e2}
.k-aggregate{--ks:#6d28d9;--kl:#ede9fe}
.k-refine{--ks:#c2410c;--kl:#ffedd5}
.k-synthesize{--ks:#0f766e;--kl:#ccfbf1}
.k-other{--ks:#475569;--kl:#e2e8f0}
.card,.badge{border:1px solid var(--ks,var(--line));background:color-mix(in srgb,var(--ks,var(--line)) var(--tint),var(--basefill,var(--kl,transparent)));color:var(--cardfg)}
.card{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:4px;width:100%;min-width:0;min-height:40px;margin:0;padding:8px 10px 8px 16px;border-radius:8px;overflow:hidden;font:inherit;font-size:13px;line-height:1.35;text-align:left;cursor:pointer}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:6px;background:var(--ks)}
.card:hover{box-shadow:0 1px 6px rgba(0,0,0,.28);border-width:2px;padding:7px 9px 7px 15px}
.card.fb{border-style:dashed}
.card.sel{box-shadow:0 0 0 2px var(--accent)}
.card:focus-visible,.btn:focus-visible,.d-title:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.card .id,.idchip{display:inline-block;max-width:100%;padding:0 6px;border:1px solid currentColor;border-radius:4px;font-family:var(--font-mono,ui-monospace,monospace);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .title{max-width:100%;font-size:14px;font-weight:600;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.card .meta,.card .after{max-width:100%;overflow-wrap:anywhere;opacity:.85}
.card .after{display:none}
.skel{width:184px;max-width:100%;display:flex;flex-direction:column;gap:12px}
.skel-card{height:64px;border:1px solid var(--line);border-radius:8px;background:var(--surface);animation:pulse 1.4s ease-in-out infinite}
.bar{position:relative;height:4px;margin-top:16px;border-radius:2px;background:var(--line);overflow:hidden}
.bar::after{content:"";position:absolute;left:0;top:0;bottom:0;width:35%;background:var(--accent);animation:slide 1.2s linear infinite}
.detail{min-width:0;padding:16px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
.d-title{font-size:16px;font-weight:600;line-height:1.35;overflow-wrap:anywhere}
.badges{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px}
.badge{padding:1px 8px;border-radius:999px;font-size:12px}
.blk{--ks:var(--bad);--kl:transparent}
.fbbadge{--ks:var(--warn);--kl:transparent;border-style:dashed}
.sec{margin-top:16px}
.sec-h{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
h3{font-size:13px;font-weight:600;color:var(--fg2)}
.text{white-space:pre-line;overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.steps{margin:0;padding-left:20px}
.steps li{margin:4px 0;white-space:pre-line;overflow-wrap:anywhere}
.concl{padding:8px 12px;border-left:3px solid var(--accent);white-space:pre-line;overflow-wrap:anywhere}
.btn{min-height:40px;padding:0 16px;border:1px solid var(--accent);border-radius:8px;background:transparent;color:var(--accent);font:inherit;font-size:14px;cursor:pointer}
.btn.small{padding:0 12px;font-size:13px}
.btn.dep{font-family:var(--font-mono,ui-monospace,monospace);font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn:hover{background:color-mix(in srgb,var(--accent) 14%,transparent)}
.btn:disabled{opacity:.6;cursor:default}
.muted{color:var(--fg3)}
.line{margin-top:12px;overflow-wrap:anywhere}
.plain{white-space:pre-line}
.qs{margin-top:16px;padding:16px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
.qs h2{font-size:16px;font-weight:600;margin-bottom:8px}
.qlist{margin:0 0 12px;padding:0;list-style:none}
.q{padding:8px 0;border-top:1px solid var(--line)}
.q:first-child{border-top:0}
.qt{overflow-wrap:anywhere}
.qm{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:4px;font-size:13px;color:var(--fg2);overflow-wrap:anywhere}
.qnote{margin-top:8px;font-size:13px;color:var(--fg2)}
.foot{margin-top:12px;font-size:12px;color:var(--fg3)}
.foot code{font-family:var(--font-mono,ui-monospace,monospace);overflow-wrap:anywhere}
@keyframes pulse{50%{opacity:.45}}
@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(300%)}}
@keyframes draw{to{stroke-dashoffset:0}}
@media (min-width:520px) and (max-width:919.98px){
.app{padding:12px}
.graph{padding:4px 2px 8px}
.waves{gap:20px}
.wave{flex:0 0 146px}
}
@media (max-width:519.98px){
.app{padding:12px}
.edges{display:none}
.waves{flex-direction:column;gap:16px}
.wave{flex:none;width:100%}
.inner{width:auto}
.card .after{display:block}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.edge.draw{stroke-dasharray:none;stroke-dashoffset:0}}
@media (forced-colors:active){
.card,.badge,.chip,.app,.detail,.qs,.btn{border:1px solid CanvasText;background:Canvas;color:CanvasText}
.card::before{background:CanvasText}
.card.sel{outline:2px solid Highlight}
.card:focus-visible,.btn:focus-visible,.d-title:focus-visible{outline:2px solid Highlight}
.edge,.mk{stroke:CanvasText;fill:none}
.mk{fill:CanvasText}
.bar::after{background:Highlight}
}
`;

const BODY = `
<div id="app" class="app" hidden>
<header id="head" class="head"></header>
<div id="main" class="main">
<div id="pane" class="pane"></div>
<section id="detail" class="detail" aria-label="Node details" hidden></section>
</div>
<section id="qs" class="qs" aria-labelledby="qh" hidden></section>
<footer id="foot" class="foot" hidden></footer>
</div>
<div id="live" class="sr" role="status" aria-live="polite" aria-atomic="true"></div>
`;

// Plain ES2020, no template literals: this string must stay free of backticks and dollar-brace sequences.
const SCRIPT = String.raw`
(function () {
	"use strict";

	var PROTOCOL = "2026-01-26";
	var SVG_NS = "http://www.w3.org/2000/svg";
	var RESULT_TOOL = "ultrathink_result";
	var DEFAULTS_TEXT = "Use the defaults for all clarifying questions and go ahead.";
	var NARROW = 520;
	var MAX_NODES = 48;
	var MAX_POLL_FAILURES = 20;
	var KINDS = { understand: 1, decompose: 1, generate: 1, compare: 1, critique: 1, aggregate: 1, refine: 1, synthesize: 1 };
	var STATUSES = { running: 1, planned: 1, failed: 1, invalid: 1, skipped: 1 };
	var LABELS = { running: "Planning", planned: "Ready", failed: "Failed", skipped: "Skipped", invalid: "Invalid" };
	var DOT = "\u00b7";

	function $(id) { return document.getElementById(id); }
	var D = { app: $("app"), head: $("head"), main: $("main"), pane: $("pane"), detail: $("detail"), qs: $("qs"), foot: $("foot"), live: $("live") };

	var S = {
		status: "idle", sessionId: "", pollAfter: 0, text: "", error: "", graph: null, questions: [],
		selected: null, collapsed: false, startedAt: 0, note: "", gaveUp: false, failures: 0, torn: false,
		canTools: true, canMessage: false, sending: false, sent: false, finalFor: "",
		cards: new Map(), flat: [], waveCards: [], inner: null, svg: null, edges: [], animate: false,
		elapsedEl: null, defaultsBtn: null, qNote: null
	};
	var hostCtx = {};
	var ready = false;
	var fixedHeight = false;
	var nextId = 1;
	var pending = new Map();
	var observer = null;

	// ---- small helpers ----------------------------------------------------------------------------
	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined && text !== null) n.textContent = text;
		return n;
	}
	function clearNode(n) { while (n.firstChild) n.removeChild(n.firstChild); }
	// First n UTF-16 units, minus a trailing high surrogate that would lose its pair.
	function cut(s, n) {
		if (s.length <= n) return s;
		var end = n < 0 ? 0 : n;
		var last = end > 0 ? s.charCodeAt(end - 1) : 0;
		if (last >= 0xd800 && last <= 0xdbff) end -= 1;
		return s.slice(0, end);
	}
	function str(v, max) {
		if (typeof v === "number" && isFinite(v)) v = String(v);
		if (typeof v !== "string") return "";
		return v.length > max ? cut(v, max) : v;
	}
	function oneLine(s, max) {
		s = String(s).replace(/\s+/g, " ").trim();
		return s.length > max ? cut(s, max - 1) + "\u2026" : s;
	}
	function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }
	function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
	function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
	function isNarrow() { return window.innerWidth < NARROW; }
	function announce(msg) {
		D.live.textContent = "";
		setTimeout(function () { D.live.textContent = msg; }, 50);
	}

	// ---- JSON-RPC 2.0 over postMessage ------------------------------------------------------------
	function post(msg) {
		msg.jsonrpc = "2.0";
		// targetOrigin "*" is required: the host's origin is unknowable inside the sandbox. Only messages whose source is window.parent are accepted back.
		window.parent.postMessage(msg, "*");
	}
	function notify(method, params) {
		var m = { method: method };
		if (params !== undefined) m.params = params;
		post(m);
	}
	function request(method, params, timeoutMs) {
		return new Promise(function (resolve, reject) {
			var id = nextId++;
			var timer = setTimeout(function () {
				pending.delete(id);
				reject(new Error(method + " timed out"));
			}, timeoutMs || 15000);
			pending.set(id, { resolve: resolve, reject: reject, timer: timer });
			post({ id: id, method: method, params: params });
		});
	}
	window.addEventListener("message", function (event) {
		if (event.source !== window.parent) return;
		var m = event.data;
		if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
		if (typeof m.method === "string") {
			var hasId = m.id !== undefined && m.id !== null;
			var params = m.params && typeof m.params === "object" ? m.params : {};
			if (hasId) onHostRequest(m); else onNotification(m.method, params);
			return;
		}
		if (m.id === undefined || m.id === null) return;
		var p = pending.get(m.id);
		if (!p) return;
		pending.delete(m.id);
		clearTimeout(p.timer);
		if (m.error) {
			var err = new Error(m.error && m.error.message ? String(m.error.message) : "rpc error");
			err.code = m.error && typeof m.error.code === "number" ? m.error.code : 0;
			p.reject(err);
		} else p.resolve(m.result);
	});

	function onHostRequest(m) {
		if (m.method === "ui/resource-teardown") {
			teardown();
			post({ id: m.id, result: {} });
		} else if (m.method === "ping") {
			post({ id: m.id, result: {} });
		} else {
			post({ id: m.id, error: { code: -32601, message: "Method not found: " + m.method } });
		}
	}
	function onNotification(method, p) {
		if (S.torn) return;
		if (method === "ui/notifications/tool-result") {
			S.failures = 0;
			S.gaveUp = false;
			S.note = "";
			try { ingest(p, false); } catch (e) { fatal("Could not display this result."); }
		} else if (method === "ui/notifications/tool-input") {
			var a = p.arguments;
			if (a && typeof a === "object" && typeof a.sessionId === "string" && !S.sessionId) S.sessionId = a.sessionId.slice(0, 200);
		} else if (method === "ui/notifications/tool-cancelled") {
			stopPolling();
			S.status = "failed";
			S.text = "Cancelled" + (typeof p.reason === "string" && p.reason ? ": " + p.reason : ".");
			S.graph = null;
			render();
		} else if (method === "ui/notifications/host-context-changed") {
			hostCtx = Object.assign({}, hostCtx, p);
			applyContext(p);
		}
	}
	function teardown() {
		S.torn = true;
		stopPolling();
		syncTimers();
		pending.forEach(function (p) { clearTimeout(p.timer); });
		pending.clear();
	}

	// ---- host theme and container ------------------------------------------------------------------
	function applyContext(c) {
		var root = document.documentElement;
		if (c.theme === "light" || c.theme === "dark") {
			root.setAttribute("data-theme", c.theme);
			root.style.colorScheme = c.theme;
		}
		var vars = c.styles && c.styles.variables;
		if (vars && typeof vars === "object") {
			for (var k in vars) {
				if (has(vars, k) && k.indexOf("--") === 0 && typeof vars[k] === "string" && vars[k]) root.style.setProperty(k, vars[k]);
			}
		}
		var fonts = c.styles && c.styles.css && c.styles.css.fonts;
		if (typeof fonts === "string" && fonts && !$("host-fonts")) {
			var st = document.createElement("style");
			st.id = "host-fonts";
			st.textContent = fonts;
			document.head.appendChild(st);
		}
		var ins = c.safeAreaInsets;
		if (ins && typeof ins === "object") {
			document.body.style.padding = (4 + num(ins.top)) + "px " + (4 + num(ins.right)) + "px " + (4 + num(ins.bottom)) + "px " + (4 + num(ins.left)) + "px";
		}
		var cd = c.containerDimensions;
		if (cd && typeof cd === "object") {
			fixedHeight = typeof cd.height === "number";
			root.style.height = fixedHeight ? "100vh" : "";
			root.style.maxHeight = !fixedHeight && typeof cd.maxHeight === "number" ? cd.maxHeight + "px" : "";
			root.style.width = typeof cd.width === "number" ? "100vw" : "";
			root.style.maxWidth = typeof cd.width !== "number" && typeof cd.maxWidth === "number" ? cd.maxWidth + "px" : "";
		}
		scheduleSize();
		scheduleEdges();
	}

	// ---- size reporting ----------------------------------------------------------------------------
	var lastW = 0;
	var lastH = 0;
	var sizeRaf = 0;
	function scheduleSize() {
		if (!ready || sizeRaf) return;
		sizeRaf = requestAnimationFrame(function () {
			sizeRaf = 0;
			if (fixedHeight) return;
			var html = document.documentElement;
			var old = html.style.height;
			html.style.height = "max-content";
			var height = Math.ceil(html.getBoundingClientRect().height);
			html.style.height = old;
			var width = Math.ceil(window.innerWidth);
			if (height < 1) return;
			if (width !== lastW || height !== lastH) {
				lastW = width;
				lastH = height;
				notify("ui/notifications/size-changed", { width: width, height: height });
			}
		});
	}
	function observeLayout() {
		if (typeof ResizeObserver !== "function") return;
		if (!observer) {
			observer = new ResizeObserver(function () { scheduleSize(); scheduleEdges(); });
		}
		observer.disconnect();
		observer.observe(document.documentElement);
		observer.observe(document.body);
		if (S.inner) observer.observe(S.inner);
	}

	// ---- intake: tool results ----------------------------------------------------------------------
	function firstText(result) {
		var c = result && result.content;
		if (!Array.isArray(c)) return "";
		for (var i = 0; i < c.length; i++) {
			if (c[i] && typeof c[i] === "object" && c[i].type === "text" && typeof c[i].text === "string") return c[i].text.slice(0, 100000);
		}
		return "";
	}
	function normalizeQuestions(list) {
		var out = [];
		if (!Array.isArray(list)) return out;
		for (var i = 0; i < list.length && out.length < 20; i++) {
			var q = list[i];
			if (typeof q === "string") { if (q) out.push({ question: str(q, 2000), def: "", blocking: false }); continue; }
			if (!q || typeof q !== "object") continue;
			var text = str(q.question, 2000);
			if (!text) continue;
			out.push({ question: text, def: str(q.default, 500), blocking: q.blocking === true });
		}
		return out;
	}
	function normalizeGraph(g) {
		if (!g || typeof g !== "object" || !Array.isArray(g.nodes)) return null;
		var byId = new Map();
		var nodes = [];
		var i, j, raw, id, node, st;
		for (i = 0; i < g.nodes.length && nodes.length < MAX_NODES; i++) {
			raw = g.nodes[i];
			if (!raw || typeof raw !== "object") continue;
			id = oneLine(str(raw.id, 200), 80);
			if (!id || byId.has(id)) continue;
			node = {
				id: id,
				title: str(raw.title, 5000) || id,
				kind: typeof raw.kind === "string" && has(KINDS, raw.kind) ? raw.kind : "other",
				question: str(raw.question, 5000),
				rawDeps: Array.isArray(raw.dependsOn) ? raw.dependsOn : [],
				rawWave: raw.wave,
				dependsOn: [],
				wave: 1,
				steps: [],
				conclusion: str(raw.conclusion, 10000),
				fallback: raw.fallback === true
			};
			if (Array.isArray(raw.steps)) {
				for (j = 0; j < raw.steps.length && node.steps.length < 50; j++) {
					st = str(raw.steps[j], 5000);
					if (st) node.steps.push(st);
				}
			}
			byId.set(id, node);
			nodes.push(node);
		}
		if (nodes.length === 0) return null;
		nodes.forEach(function (nd) {
			nd.rawDeps.forEach(function (d) {
				var key = oneLine(str(d, 200), 80);
				if (key && key !== nd.id && byId.has(key) && nd.dependsOn.indexOf(key) < 0) nd.dependsOn.push(key);
			});
		});
		var level = new Map();
		function levelOf(nd, trail) {
			if (level.has(nd.id)) return level.get(nd.id);
			if (trail.indexOf(nd.id) >= 0) return 1;
			trail.push(nd.id);
			var best = 0;
			nd.dependsOn.forEach(function (d) { best = Math.max(best, levelOf(byId.get(d), trail)); });
			trail.pop();
			level.set(nd.id, best + 1);
			return best + 1;
		}
		nodes.forEach(function (nd) {
			var w = nd.rawWave;
			nd.wave = typeof w === "number" && isFinite(w) && w >= 1 && w <= 1000 ? Math.floor(w) : levelOf(nd, []);
		});
		var flags = new Map();
		if (Array.isArray(g.waves)) {
			g.waves.forEach(function (w) {
				if (w && typeof w === "object" && typeof w.wave === "number") flags.set(w.wave, w.parallel === true);
			});
		}
		var groups = new Map();
		var steps = 0;
		nodes.forEach(function (nd) {
			if (!groups.has(nd.wave)) groups.set(nd.wave, []);
			groups.get(nd.wave).push(nd);
			steps += nd.steps.length;
		});
		var keys = Array.from(groups.keys()).sort(function (a, b) { return a - b; });
		var waves = keys.map(function (k) {
			var list = groups.get(k);
			return { wave: k, parallel: flags.has(k) ? flags.get(k) : list.length > 1, nodes: list };
		});
		var fills = [];
		var fl = g.degraded && Array.isArray(g.degraded.fills) ? g.degraded.fills : [];
		for (i = 0; i < fl.length && fills.length < 20; i++) {
			if (typeof fl[i] === "string" && fl[i]) fills.push(oneLine(fl[i], 80));
		}
		return {
			goal: oneLine(str(g.goal, 2000), 2000),
			nodes: nodes,
			byId: byId,
			waves: waves,
			steps: steps,
			fills: fills,
			truncated: g.truncated === true
		};
	}

	function ingest(result, fromPoll) {
		if (!result || typeof result !== "object") return;
		var sc = result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : null;
		var text = firstText(result);
		var before = S.status;
		if (sc && typeof sc.sessionId === "string" && sc.sessionId) S.sessionId = sc.sessionId.slice(0, 200);
		if (sc) {
			S.graph = normalizeGraph(sc.graph);
			S.questions = normalizeQuestions(sc.questions);
			S.text = typeof sc.text === "string" ? sc.text : text;
			S.error = typeof sc.error === "string" ? sc.error : "";
			S.pollAfter = num(sc.pollAfterSec);
			if (typeof sc.status === "string" && has(STATUSES, sc.status)) S.status = sc.status;
			else S.status = result.isError === true ? "failed" : "planned";
		} else {
			S.graph = null;
			S.questions = [];
			S.text = text;
			S.error = "";
			S.status = result.isError === true ? "failed" : "planned";
		}
		if (S.status === "running") {
			if (!S.startedAt) S.startedAt = Date.now();
			ensurePolling(fromPoll ? 300 : Math.min(Math.max(S.pollAfter || 2, 1), 10) * 1000);
		} else {
			S.startedAt = 0;
			stopPolling();
		}
		if (S.selected && !(S.graph && S.graph.byId.has(S.selected))) S.selected = null;
		render();
		if (S.status !== before) {
			if (S.status === "planned" && S.graph) announce("Plan ready: " + plural(S.graph.nodes.length, "node", "nodes") + " in " + plural(S.graph.waves.length, "wave", "waves") + ".");
			else if (S.status === "running") announce("Planning started.");
			else announce((LABELS[S.status] || "Done") + ".");
		}
		fetchFinal();
	}
	// ultrathink_uplift can answer planned with no graph and no plan text (a quick or repeated plan); only ultrathink_result has the plan, so ask for it once per session.
	function fetchFinal() {
		if (S.status !== "planned" || S.graph || !S.sessionId || !S.canTools || S.torn || S.finalFor === S.sessionId) return;
		var sid = S.sessionId;
		S.finalFor = sid;
		S.note = "Fetching the plan.";
		renderHead();
		scheduleSize();
		function failed() {
			if (S.torn || S.sessionId !== sid) return;
			S.note = "Could not fetch the plan. Ask the assistant for the result.";
			renderHead();
			scheduleSize();
		}
		request("tools/call", { name: RESULT_TOOL, arguments: { sessionId: sid, waitSeconds: 0 } }, 30000).then(function (res) {
			if (S.torn || S.sessionId !== sid || S.status !== "planned" || S.graph) return;
			if (!res || typeof res !== "object" || res.isError === true) { failed(); return; }
			S.note = "";
			try { ingest(res, true); } catch (e) { fatal("Could not display this result."); }
		}, failed);
	}
	function fatal(message) {
		stopPolling();
		S.status = "failed";
		S.graph = null;
		S.questions = [];
		S.text = message;
		render();
	}

	// ---- polling ultrathink_result while the plan is running ---------------------------------------
	var pollTimer = 0;
	var polling = false;
	var pollGen = 0;
	function canPoll() { return !!S.sessionId && S.status === "running" && !S.torn && !S.gaveUp; }
	function ensurePolling(delayMs) {
		if (polling || pollTimer || !canPoll()) return;
		if (!S.canTools) { giveUp(); return; }
		pollTimer = setTimeout(pollOnce, delayMs);
	}
	function stopPolling() {
		clearTimeout(pollTimer);
		pollTimer = 0;
		pollGen++;
	}
	function giveUp() {
		stopPolling();
		S.gaveUp = true;
		S.note = "Stopped checking. Ask the assistant for the result.";
		syncTimers();
		renderHead();
		announce(S.note);
		scheduleSize();
	}
	function pollOnce() {
		pollTimer = 0;
		if (!canPoll() || polling) return;
		polling = true;
		var gen = ++pollGen;
		request("tools/call", { name: RESULT_TOOL, arguments: { sessionId: S.sessionId, waitSeconds: 25 } }, 60000).then(function (res) {
			polling = false;
			if (gen !== pollGen || S.torn) { ensurePolling(300); return; }
			S.failures = 0;
			S.note = "";
			try { ingest(res, true); } catch (e) { fatal("Could not display this result."); }
		}, function () {
			polling = false;
			if (gen !== pollGen || S.torn) { ensurePolling(300); return; }
			S.failures += 1;
			if (S.failures >= MAX_POLL_FAILURES) { giveUp(); return; }
			S.note = "Could not reach the planner. Retrying.";
			renderHead();
			scheduleSize();
			pollTimer = setTimeout(pollOnce, 5000);
		});
	}

	var elapsedTimer = 0;
	function elapsedText() {
		return "Planning... " + Math.max(0, Math.floor((Date.now() - S.startedAt) / 1000)) + " s elapsed";
	}
	function syncTimers() {
		var want = S.status === "running" && !S.gaveUp && !S.torn;
		if (want && !elapsedTimer) {
			elapsedTimer = setInterval(function () { if (S.elapsedEl) S.elapsedEl.textContent = elapsedText(); }, 1000);
		} else if (!want && elapsedTimer) {
			clearInterval(elapsedTimer);
			elapsedTimer = 0;
		}
	}

	// ---- rendering ---------------------------------------------------------------------------------
	function render() {
		var idle = S.status === "idle";
		D.app.hidden = idle;
		if (idle) { scheduleSize(); return; }
		renderHead();
		renderMain();
		renderQuestions();
		renderFoot();
		syncTimers();
		scheduleSize();
		scheduleEdges();
	}

	function renderHead() {
		clearNode(D.head);
		S.elapsedEl = null;
		D.head.appendChild(el("span", "chip s-" + S.status, LABELS[S.status] || "Ready"));
		var t = el("div", "head-text");
		var g = S.graph;
		if (S.status === "planned" && g) {
			var h = el("h1", "goal", g.goal || "Graph of Thought x Chain of Thought");
			if (g.goal) h.setAttribute("title", g.goal);
			t.appendChild(h);
			t.appendChild(el("p", "counts", plural(g.nodes.length, "node", "nodes") + " " + DOT + " " + plural(g.steps, "step", "steps") + " " + DOT + " " + plural(g.waves.length, "wave", "waves")));
			if (g.fills.length) t.appendChild(el("p", "notice", "Placeholder text was used for: " + g.fills.join(", ") + "."));
			if (g.truncated) t.appendChild(el("p", "notice", "Some text was shortened."));
		} else if (S.status === "running") {
			S.elapsedEl = el("p", "counts", elapsedText());
			t.appendChild(S.elapsedEl);
		}
		if (S.note) t.appendChild(el("p", "notice", S.note));
		D.head.appendChild(t);
	}

	function renderMain() {
		clearNode(D.pane);
		S.cards = new Map();
		S.flat = [];
		S.waveCards = [];
		S.inner = null;
		S.svg = null;
		S.edges = [];
		var solo = true;
		if (S.status === "running") {
			var sk = el("div", "skel");
			sk.setAttribute("aria-hidden", "true");
			for (var i = 0; i < 3; i++) sk.appendChild(el("div", "skel-card"));
			D.pane.appendChild(sk);
			var bar = el("div", "bar");
			bar.setAttribute("role", "progressbar");
			bar.setAttribute("aria-label", "Planning");
			D.pane.appendChild(bar);
		} else if (S.status === "planned" && S.graph) {
			solo = false;
			renderGraph(S.graph);
			renderDetail();
		} else if (S.status === "planned") {
			if (S.text) D.pane.appendChild(el("p", "plain", S.text.slice(0, 600)));
			D.pane.appendChild(el("p", "line muted", "No graph in this result."));
		} else {
			var line = oneLine(S.text || S.error, 300);
			if (line) D.pane.appendChild(el("p", "line", line));
		}
		D.detail.hidden = solo;
		D.main.className = solo ? "main solo" : "main";
		observeLayout();
	}

	function cardLabel(nd) {
		var s = nd.id + " " + oneLine(nd.title, 200) + ", " + nd.kind + ", " + plural(nd.steps.length, "step", "steps");
		if (nd.dependsOn.length) s += ", depends on " + nd.dependsOn.join(", ");
		if (nd.fallback) s += ", placeholder";
		return s;
	}
	function buildCard(nd, wi, pos) {
		var b = el("button", "card k-" + nd.kind + (nd.fallback ? " fb" : ""));
		b.type = "button";
		b.appendChild(el("span", "id", nd.id));
		b.appendChild(el("span", "title", nd.title));
		b.appendChild(el("span", "meta", plural(nd.steps.length, "step", "steps") + (nd.fallback ? " " + DOT + " placeholder" : "")));
		if (nd.dependsOn.length) b.appendChild(el("span", "after", "after " + nd.dependsOn.join(", ")));
		b.setAttribute("aria-label", cardLabel(nd));
		b.setAttribute("aria-pressed", nd.id === S.selected ? "true" : "false");
		if (nd.id === S.selected) b.classList.add("sel");
		b._ut = nd.id;
		b._w = wi;
		b._i = pos;
		return b;
	}

	function renderGraph(g) {
		var graph = el("div", "graph");
		graph.setAttribute("role", "group");
		graph.setAttribute("aria-label", "Dependency graph, " + plural(g.nodes.length, "node", "nodes") + " in " + plural(g.waves.length, "wave", "waves"));
		var inner = el("div", "inner");
		var svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("class", "edges");
		svg.setAttribute("aria-hidden", "true");
		svg.setAttribute("focusable", "false");
		var waves = el("div", "waves");
		g.waves.forEach(function (w, wi) {
			var label = "Wave " + w.wave + (w.parallel ? " " + DOT + " parallel" : "");
			var col = el("div", "wave");
			col.setAttribute("role", "group");
			col.setAttribute("aria-label", label);
			col.appendChild(el("div", "wave-h", label));
			var cards = el("div", "cards");
			var row = [];
			w.nodes.forEach(function (nd, pos) {
				var b = buildCard(nd, wi, pos);
				cards.appendChild(b);
				S.cards.set(nd.id, b);
				S.flat.push(b);
				row.push(b);
			});
			S.waveCards.push(row);
			col.appendChild(cards);
			waves.appendChild(col);
		});
		inner.appendChild(svg);
		inner.appendChild(waves);
		graph.appendChild(inner);
		D.pane.appendChild(graph);
		S.inner = inner;
		S.svg = svg;
		S.animate = true;
	}

	// ---- edges: recomputed from element rectangles ---------------------------------------------------
	var edgeRaf = 0;
	function scheduleEdges() {
		if (edgeRaf) return;
		edgeRaf = requestAnimationFrame(function () { edgeRaf = 0; drawEdges(); });
	}
	function marker(id, cls) {
		var m = document.createElementNS(SVG_NS, "marker");
		m.setAttribute("id", id);
		m.setAttribute("viewBox", "0 0 8 8");
		m.setAttribute("refX", "8");
		m.setAttribute("refY", "4");
		m.setAttribute("markerWidth", "8");
		m.setAttribute("markerHeight", "8");
		m.setAttribute("markerUnits", "userSpaceOnUse");
		m.setAttribute("orient", "auto");
		var p = document.createElementNS(SVG_NS, "path");
		p.setAttribute("d", "M0 0 L8 4 L0 8 z");
		p.setAttribute("class", cls);
		m.appendChild(p);
		return m;
	}
	function round(v) { return Math.round(v * 10) / 10; }
	function drawEdges() {
		var svg = S.svg;
		var inner = S.inner;
		if (!svg || !inner || !S.graph) return;
		clearNode(svg);
		S.edges = [];
		if (isNarrow()) return;
		var defs = document.createElementNS(SVG_NS, "defs");
		defs.appendChild(marker("ut-arrow", "mk"));
		defs.appendChild(marker("ut-arrow-hot", "mk hot"));
		svg.appendChild(defs);
		var base = inner.getBoundingClientRect();
		var animate = S.animate;
		S.animate = false;
		S.graph.nodes.forEach(function (nd) {
			var to = S.cards.get(nd.id);
			if (!to) return;
			var rb = to.getBoundingClientRect();
			nd.dependsOn.forEach(function (dep) {
				var from = S.cards.get(dep);
				if (!from) return;
				var ra = from.getBoundingClientRect();
				var x1 = ra.right - base.left;
				var y1 = ra.top + ra.height / 2 - base.top;
				var x2 = rb.left - base.left - 1;
				var y2 = rb.top + rb.height / 2 - base.top;
				var dx = Math.max(28, Math.abs(x2 - x1) / 2);
				var path = document.createElementNS(SVG_NS, "path");
				path.setAttribute("d", "M" + round(x1) + " " + round(y1) + " C" + round(x1 + dx) + " " + round(y1) + " " + round(x2 - dx) + " " + round(y2) + " " + round(x2) + " " + round(y2));
				path.setAttribute("pathLength", "1");
				path.setAttribute("class", "edge" + (animate ? " draw" : ""));
				path.setAttribute("marker-end", "url(#ut-arrow)");
				svg.appendChild(path);
				S.edges.push({ from: dep, to: nd.id, el: path });
			});
		});
		updateHot();
	}
	function updateHot() {
		var hot = [];
		S.edges.forEach(function (e) {
			var on = S.selected !== null && (e.from === S.selected || e.to === S.selected);
			var cls = "edge" + (on ? " hot" : "") + (e.el.getAttribute("class").indexOf("draw") >= 0 ? " draw" : "");
			e.el.setAttribute("class", cls);
			e.el.setAttribute("marker-end", on ? "url(#ut-arrow-hot)" : "url(#ut-arrow)");
			if (on) hot.push(e.el);
		});
		// Highlighted edges are re-appended so they paint above the others.
		hot.forEach(function (p) { if (S.svg) S.svg.appendChild(p); });
	}

	// ---- selection and the detail area -------------------------------------------------------------------
	function select(id, focusDetail) {
		if (id !== null && !(S.graph && S.graph.byId.has(id))) id = null;
		if (S.selected === id) {
			if (focusDetail) focusTitle();
			return;
		}
		S.selected = id;
		S.collapsed = false;
		S.cards.forEach(function (b, key) {
			var on = key === id;
			b.classList.toggle("sel", on);
			b.setAttribute("aria-pressed", on ? "true" : "false");
		});
		renderDetail();
		updateHot();
		if (id === null) {
			announce("Selection cleared.");
		} else {
			var nd = S.graph.byId.get(id);
			announce("Selected " + nd.id + " " + oneLine(nd.title, 120) + ", " + plural(nd.steps.length, "step", "steps") + ".");
		}
		scheduleSize();
		if (focusDetail) focusTitle();
	}
	function focusTitle() {
		var h = D.detail.querySelector(".d-title");
		if (h) h.focus();
	}
	function section(title) {
		var s = el("div", "sec");
		s.appendChild(el("h3", null, title));
		return s;
	}
	function renderDetail() {
		clearNode(D.detail);
		var nd = S.selected !== null && S.graph ? S.graph.byId.get(S.selected) : null;
		if (!nd) {
			D.detail.appendChild(el("p", "muted", "Select a node to read its reasoning."));
			return;
		}
		var title = el("h2", "d-title", nd.title);
		title.setAttribute("tabindex", "-1");
		D.detail.appendChild(title);
		var badges = el("div", "badges");
		badges.appendChild(el("span", "idchip", nd.id));
		badges.appendChild(el("span", "badge k-" + nd.kind, nd.kind));
		if (nd.fallback) badges.appendChild(el("span", "badge fbbadge", "placeholder"));
		D.detail.appendChild(badges);

		var q = section("Question");
		q.appendChild(el("p", "text", nd.question || "-"));
		D.detail.appendChild(q);

		if (nd.dependsOn.length) {
			var dep = section("Depends on");
			var chips = el("div", "chips");
			nd.dependsOn.forEach(function (d) {
				var b = el("button", "btn dep", d);
				b.type = "button";
				b.addEventListener("click", function () { select(d, true); });
				chips.appendChild(b);
			});
			dep.appendChild(chips);
			D.detail.appendChild(dep);
		}

		var cot = el("div", "sec");
		var head = el("div", "sec-h");
		head.appendChild(el("h3", null, "Chain of Thought"));
		var ol = el("ol", "steps");
		var items = [];
		nd.steps.forEach(function (s) {
			var li = el("li", null, s);
			ol.appendChild(li);
			items.push(li);
		});
		var toggle = null;
		function applySteps() {
			items.forEach(function (li, i) { li.hidden = S.collapsed && i >= 2; });
			if (toggle) {
				toggle.textContent = S.collapsed ? "Show all " + items.length + " steps" : "Collapse steps";
				toggle.setAttribute("aria-expanded", S.collapsed ? "false" : "true");
			}
		}
		if (items.length > 2) {
			toggle = el("button", "btn small");
			toggle.type = "button";
			toggle.addEventListener("click", function () {
				S.collapsed = !S.collapsed;
				applySteps();
				scheduleSize();
			});
			head.appendChild(toggle);
		}
		cot.appendChild(head);
		if (items.length) cot.appendChild(ol); else cot.appendChild(el("p", "muted", "No steps recorded."));
		applySteps();
		D.detail.appendChild(cot);

		var cc = section("Conclusion");
		cc.appendChild(el("div", "concl", nd.conclusion || "-"));
		D.detail.appendChild(cc);
	}

	function renderQuestions() {
		clearNode(D.qs);
		S.defaultsBtn = null;
		S.qNote = null;
		var list = S.status === "planned" ? S.questions : [];
		D.qs.hidden = list.length === 0;
		if (list.length === 0) return;
		var h = el("h2", null, "Questions");
		h.id = "qh";
		D.qs.appendChild(h);
		var ul = el("ul", "qlist");
		list.forEach(function (item) {
			var li = el("li", "q");
			li.appendChild(el("p", "qt", item.question));
			if (item.blocking || item.def) {
				var meta = el("p", "qm");
				if (item.blocking) meta.appendChild(el("span", "badge blk", "blocking"));
				if (item.def) meta.appendChild(el("span", null, "Default: " + item.def));
				li.appendChild(meta);
			}
			ul.appendChild(li);
		});
		D.qs.appendChild(ul);
		if (S.canMessage) {
			var btn = el("button", "btn", "Use all defaults");
			btn.type = "button";
			btn.disabled = S.sending || S.sent;
			btn.addEventListener("click", sendDefaults);
			D.qs.appendChild(btn);
			S.defaultsBtn = btn;
			S.qNote = el("p", "qnote", S.sent ? "Message sent." : "");
			S.qNote.hidden = !S.sent;
			D.qs.appendChild(S.qNote);
		}
	}
	function sendDefaults() {
		if (S.sending || S.sent) return;
		S.sending = true;
		if (S.defaultsBtn) S.defaultsBtn.disabled = true;
		// The SDK's AppBridge schema takes an array of content blocks, the spec prose a single block; -32602 means the host wanted the other one.
		var textBlock = { type: "text", text: DEFAULTS_TEXT };
		request("ui/message", { role: "user", content: [textBlock] }, 30000).catch(function (e) {
			if (e && e.code === -32602) return request("ui/message", { role: "user", content: textBlock }, 30000);
			throw e;
		}).then(function () {
			S.sending = false;
			S.sent = true;
			noteDefaults("Message sent.");
		}, function () {
			S.sending = false;
			noteDefaults("Could not send the message.");
		});
	}
	function noteDefaults(msg) {
		if (S.defaultsBtn) S.defaultsBtn.disabled = S.sent;
		if (S.qNote) { S.qNote.textContent = msg; S.qNote.hidden = false; }
		announce(msg);
		scheduleSize();
	}

	function renderFoot() {
		clearNode(D.foot);
		D.foot.hidden = !S.sessionId;
		if (!S.sessionId) return;
		D.foot.appendChild(document.createTextNode("Session "));
		D.foot.appendChild(el("code", null, S.sessionId));
	}

	// ---- input: click, keyboard ------------------------------------------------------------------------
	function cardOf(target) {
		return target && target.closest ? target.closest(".card") : null;
	}
	D.pane.addEventListener("click", function (event) {
		var c = cardOf(event.target);
		if (c) select(c._ut, false);
	});
	function nearest(row, y) {
		var best = null;
		var bestD = Infinity;
		row.forEach(function (b) {
			var r = b.getBoundingClientRect();
			var d = Math.abs(r.top + r.height / 2 - y);
			if (d < bestD) { bestD = d; best = b; }
		});
		return best;
	}
	D.pane.addEventListener("keydown", function (event) {
		var c = cardOf(event.target);
		if (!c || event.altKey || event.ctrlKey || event.metaKey) return;
		var key = event.key;
		var narrow = isNarrow();
		var flatIdx = S.flat.indexOf(c);
		var col = S.waveCards[c._w] || [];
		var target = null;
		var handled = true;
		if (key === "ArrowDown") target = narrow ? S.flat[flatIdx + 1] : col[c._i + 1];
		else if (key === "ArrowUp") target = narrow ? S.flat[flatIdx - 1] : col[c._i - 1];
		else if (key === "ArrowRight" && !narrow) target = S.waveCards[c._w + 1] ? nearest(S.waveCards[c._w + 1], c.getBoundingClientRect().top + c.offsetHeight / 2) : null;
		else if (key === "ArrowLeft" && !narrow) target = S.waveCards[c._w - 1] ? nearest(S.waveCards[c._w - 1], c.getBoundingClientRect().top + c.offsetHeight / 2) : null;
		else if (key === "Home") target = S.flat[0];
		else if (key === "End") target = S.flat[S.flat.length - 1];
		else handled = false;
		if (!handled) return;
		event.preventDefault();
		if (target) target.focus();
	});
	document.addEventListener("keydown", function (event) {
		if (event.key !== "Escape" || S.selected === null) return;
		var prev = S.cards.get(S.selected);
		var inDetail = D.detail.contains(document.activeElement);
		event.preventDefault();
		select(null, false);
		if (inDetail && prev) prev.focus();
	});
	window.addEventListener("resize", function () { scheduleEdges(); scheduleSize(); });
	if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { scheduleEdges(); scheduleSize(); });

	// ---- handshake: ui/initialize -> response -> ui/notifications/initialized -----------------------------
	request("ui/initialize", {
		protocolVersion: PROTOCOL,
		appInfo: { name: "ultrathink-graph-view", version: "1.0.0" },
		appCapabilities: { availableDisplayModes: ["inline"] }
	}, 15000).then(function (res) {
		res = res && typeof res === "object" ? res : {};
		var hc = res.hostCapabilities && typeof res.hostCapabilities === "object" ? res.hostCapabilities : null;
		S.canTools = !hc || !!hc.serverTools;
		S.canMessage = !!(hc && hc.message);
		hostCtx = res.hostContext && typeof res.hostContext === "object" ? res.hostContext : {};
		applyContext(hostCtx);
		notify("ui/notifications/initialized");
		ready = true;
		observeLayout();
		scheduleSize();
	}, function () {
		ready = true;
		fatal("Could not connect to the host.");
	});
})();
`;

function buildDocument(): string {
	return [
		"<!DOCTYPE html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="color-scheme" content="light dark">',
		"<title>UltraThink graph</title>",
		`<style>${CSS}</style>`,
		"</head>",
		"<body>",
		BODY,
		`<script>${SCRIPT}</script>`,
		"</body>",
		"</html>",
		"",
	].join("\n");
}

let cached: string | undefined;

/** The whole MCP App as one self-contained HTML5 document. */
export function graphAppHtml(): string {
	cached ??= buildDocument();
	return cached;
}
