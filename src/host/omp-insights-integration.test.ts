// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Host integration tests for `/ultrathink-ui` (Phase 26, plan 26-04): registration, capability
 * guards, dashboard lifetimes, safe delivery, and regression preservation.
 *
 * The real siblings run underneath: the read model reads a seeded tmpdir store through the real
 * `readInsightSnapshot`, actions go through the real adapter, and the host mounts the real
 * `createInsightDashboard` through a structural `ui.custom` recorder. Only what crosses the host
 * boundary is faked: `pi.sendMessage`/`sendUserMessage` (the helper harness), `ctx.ui.custom`
 * (a recorder that plays the TUI), dashboard callbacks in the interleaving test, the session
 * manager, and the filesystem (tmpdir state dirs). No domain module is substituted: refresh
 * interleavings run the real dashboard against controlled host-boundary callbacks, and every
 * other await rides a recorded call, rendered text, or a resolved promise — never tick counts.
 * Verification is Main-owned after the union.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type Dirent, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UltrathinkConfig } from "../config.ts";
import type { TeachContextOptions } from "../teach/context.ts";
import { teachContext as realTeachContext } from "../teach/context.ts";
import { projectOf } from "../teach/mapping.ts";
import { storeDir } from "../teach/store.ts";
import type { TeachContext } from "../teach/types.ts";
import { createInsightDashboard, type InsightDashboard, type InsightDashboardCallbacks } from "./omp-dashboard.ts";
import type { OmpPlan, OmpPlanRequest, OmpPlanner } from "./omp.ts";
import { INSIGHT_TYPE } from "./omp-render.ts";
import { readInsightSnapshot, type InsightActionResult, type InsightScope, type InsightSnapshot } from "./omp-insights.ts";
import { controlled, flush, quietConfig, setup } from "./omp-test.helpers.ts";

// --- Raw terminal wire keys: the host delivers opaque bytes and the dashboard
// decodes them. Tests drive the same bytes a terminal sends, never friendly
// aliases, so key-protocol regressions surface here. ---
const K_TAB = "	";
const K_SHIFT_TAB = "[Z";
const K_ENTER = "\r";
const K_ESC = "";
const K_UP = "[A";
const K_DOWN = "[B";
const K_LEFT = "[D";
const K_RIGHT = "[C";

// Zero-duration yield only: the awaited condition is the real signal (recorded
// call, rendered text, resolved promise). Real fs reads need event-loop turns
// that microtask-only spins would starve, so deterministic time control cannot apply.
const until = async (condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> => {
	const start = Date.now();
	for (;;) {
		if (condition()) return;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
		await Bun.sleep(0);
	}
};

// --- Fixtures: a tmpdir checkout plus state dir; the store is seeded with real schema-2 files. ---

interface Fixture {
	root: string;
	cwd: string;
	stateDir: string;
	project: string;
}

const dirs: string[] = [];
// Teaching-on cases run on config alone: a developer-level `ULTRATHINK_TEACH=0` must not flip them.
const savedKillSwitch = process.env.ULTRATHINK_TEACH;
beforeEach(() => {
	delete process.env.ULTRATHINK_TEACH;
});
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (savedKillSwitch === undefined) delete process.env.ULTRATHINK_TEACH;
	else process.env.ULTRATHINK_TEACH = savedKillSwitch;
});

function freshFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "ut-omp-ui-"));
	dirs.push(root);
	const cwd = join(root, "proj");
	mkdirSync(cwd, { recursive: true });
	return { root, cwd, stateDir: join(root, "state"), project: projectOf(cwd) };
}

function seedMoment(fixture: Fixture, overrides: Record<string, unknown> = {}): string {
	const id = typeof overrides.id === "string" ? overrides.id : `mom-${Math.random().toString(36).slice(2, 10)}`;
	const moment = {
		schema: 2,
		name: "Seed lesson",
		description: "Seeded for the host suite.",
		body: "Use the real read model.",
		kind: "pattern",
		status: "candidate",
		origin: "explicit",
		dedupeKey: `dedupe-${id}`,
		createdAt: "2026-01-01T00:00:00Z",
		lastSeenAt: "2026-01-02T00:00:00Z",
		project: fixture.project,
		host: "omp",
		confidence: 1,
		occurrences: 1,
		recalled: 0,
		...overrides,
		id,
	};
	const dir = join(storeDir(fixture.stateDir), "moments");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(moment, null, "\t")}\n`);
	return id;
}

/** Content-addressed inventory of the whole fixture: any state write by inspection shows up here. */
function fingerprint(root: string): string {
	const hash = createHash("sha256");
	const walk = (dir: string, prefix: string): void => {
		let entries: Dirent<string>[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const rel = `${prefix}/${entry.name}`;
			if (entry.isDirectory()) walk(join(dir, entry.name), rel);
			else if (entry.isFile()) {
				hash.update(rel);
				hash.update(readFileSync(join(dir, entry.name)));
			}
		}
	};
	walk(root, "");
	return hash.digest("hex");
}

/** Terminal controls (C0 except legitimate LF, C1, DEL) without escape-sequence literals in this source. */
function hasControls(text: string): boolean {
	for (const char of text) {
		const code = char.codePointAt(0) ?? 32;
		if (code === 10) continue;
		if (code < 32 || code === 127 || (code >= 128 && code <= 159)) return true;
	}
	return false;
}

/** A mounted copy is calm when no owned async run (refresh/preview/confirm/install) is in flight. */
const BUSY_LABELS = ["Refreshing local snapshot", "Building deterministic preview", "Confirming candidate", "Installing into Omp"];
const settledView = (mounted: CustomMount): boolean => {
	const visible = render(mounted.component);
	return BUSY_LABELS.every((label) => !visible.includes(label));
};
/** The host awaits the real read before invoking custom UI: one recorded call proves the read settled. */
const awaitMountable = async (host: { calls: CustomCall[] }, at = 0): Promise<void> =>
	until(() => host.calls.length > at, "initial snapshot read with custom UI invocation");

// --- Structural `ui.custom` recorder: the test plays the TUI the host talks to. ---

interface CustomMount {
	component: InsightDashboard;
	dones: unknown[][];
}
interface CustomCall {
	factory: CustomFactory;
	options?: { signal?: AbortSignal; overlay?: boolean };
	finish?: (result: unknown) => void;
	mounts: CustomMount[];
}

/** Structural factory order the host uses: tui/theme/keybindings/done. */
type CustomFactory = (
	tui: { requestRender(): void; terminal?: { rows?: number; columns?: number } },
	theme: unknown,
	keybindings: unknown,
	done: (result: unknown) => void,
) => InsightDashboard;

function uiHost() {
	const calls: CustomCall[] = [];
	const custom = (factory: CustomFactory, options?: { signal?: AbortSignal; overlay?: boolean }): Promise<unknown> => {
		const record: CustomCall = { factory, options, mounts: [] };
		calls.push(record);
		return new Promise<unknown>((resolve, reject) => {
			record.finish = resolve;
			const abort = () => reject(new Error("custom ui aborted by the host signal"));
			const signal = options?.signal;
			if (!signal) return;
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		});
	};
	const mount = (at = calls.length - 1): CustomMount => {
		const call = calls.at(at);
		if (!call) throw new Error("no custom call recorded");
		const dones: unknown[][] = [];
		const raw: InsightDashboard = call.factory(
			{ requestRender: () => undefined, terminal: { rows: 30, columns: 120 } },
			{},
			{},
			(result: unknown) => {
				dones.push([result]);
				call.finish?.(result);
			},
		);
		const mount: CustomMount = { component: raw, dones };
		call.mounts.push(mount);
		return mount;
	};
	return { calls, custom, mount };
}

/** A session ctx with its own notify sink; `ui` merges in `custom`/`setWidget` as needed. */
function sessionCtx(options: {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	mode?: string;
	hasUI?: boolean;
	ui?: Record<string, unknown>;
}): { ctx: Record<string, unknown>; notices: string[] } {
	const notices: string[] = [];
	const ctx: Record<string, unknown> = {
		cwd: options.cwd,
		sessionManager: {
			getSessionId: () => options.sessionId ?? "s1",
			...(options.sessionFile ? { getSessionFile: () => options.sessionFile } : {}),
		},
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		setInterval: () => 0,
		ui: { notify: (text: string) => void notices.push(text), ...options.ui },
	};
	return { ctx, notices };
}

// --- Harness: the shared helper plus this lane's extension options. ---

interface Harness {
	run: (prompt?: string) => Promise<unknown>;
	sent: { message: unknown; options: unknown }[];
	emit: (event: string, payload?: Record<string, unknown>, context?: Record<string, unknown>) => unknown;
	renderers: string[];
	commands: Map<string, { description?: string; getArgumentCompletions?: (prefix: string) => unknown; handler: (args: unknown, ctx: unknown) => unknown }>;
	command: (name: string, args?: string) => Promise<unknown>;
	userMessages: string[];
	notices: string[];
}

type SuitePlan = (...args: Parameters<OmpPlanner>) => Promise<string | OmpPlan>;

interface Suite {
	harness: Harness;
	fixture: Fixture;
	teachInputs: (Pick<TeachContextOptions, "sessionId" | "stateDir" | "signal"> & { hasConfig: boolean })[];
	teachContexts: TeachContext[];
	mcpReads: () => number;
}

function buildSuite(options: { ui?: boolean; teach?: (config: UltrathinkConfig) => void; plan?: SuitePlan } = {}): Suite {
	const fixture = freshFixture();
	const teachInputs: Suite["teachInputs"] = [];
	const teachContexts: TeachContext[] = [];
	let mcpCount = 0;
	const config = quietConfig(options.teach);
	const extra = {
		ui: options.ui ?? true,
		stateDir: fixture.stateDir,
		config: () => config,
		teachContext: (input: TeachContextOptions) => {
			teachInputs.push({ sessionId: input.sessionId, stateDir: input.stateDir, signal: input.signal, hasConfig: input.config !== undefined });
			const built = realTeachContext(input);
			teachContexts.push(built);
			return built;
		},
	};
	const mcp = () => {
		mcpCount += 1;
		return { linear: "none", notion: "none", greptile: "none" } as const;
	};
	// `setup` accepts the `mcp` override so credential-store reads stay countable in-lane.
	const setupExtra = { ...extra, mcp };
	const harness = setup(options.plan, 5, setupExtra, { cwd: fixture.cwd }) as unknown as Harness;
	return { harness, fixture, teachInputs, teachContexts, mcpReads: () => mcpCount };
}

type UiCommand = (args: string, ctx: unknown) => Promise<void>;

function uiCommand(suite: Suite): UiCommand {
	const handler = suite.harness.commands.get("ultrathink-ui")?.handler;
	if (!handler) throw new Error("ultrathink-ui is not registered");
	return handler as unknown as UiCommand;
}

function textOf(message: unknown): string {
	const content = message !== null && typeof message === "object" && "content" in message ? Reflect.get(message, "content") : undefined;
	return typeof content === "string" ? content : "";
}

function propOf(value: unknown, name: string): unknown {
	return value !== null && typeof value === "object" && name in value ? Reflect.get(value, name) : undefined;
}

const render = (component: InsightDashboard): string => Bun.stripANSI(component.render(80).join("\n"));



// --- Capability matrix: every refused cell shows its copy and mounts nothing ---

describe("capability guards", () => {
	test("ui:false shows the off copy through default display-only delivery and mounts nothing", async () => {
		const suite = buildSuite({ ui: false });
		await suite.harness.command("ultrathink-ui", "");
		expect(suite.harness.sent).toHaveLength(1);
		const entry = suite.harness.sent[0];
		if (!entry) throw new Error("expected one sent message");
		expect(textOf(entry.message)).toContain("disabled by the extension option");
		expect(propOf(entry.message, "display")).toBe(true);
		expect(propOf(entry.message, "customType")).toBeUndefined();
		expect(entry.options).toEqual({ triggerTurn: false });
		expect(suite.teachInputs).toHaveLength(0);
		expect(suite.harness.userMessages).toHaveLength(0);
		expect(suite.harness.renderers).toHaveLength(0);
	});

	test("child session gets the child copy with no model forwarding even with full UI present", async () => {
		const suite = buildSuite();
		const host = uiHost();
		const { ctx, notices } = sessionCtx({
			cwd: suite.fixture.cwd,
			sessionFile: join(suite.fixture.root, "omp-task-1", "Agent.json"),
			hasUI: false,
			ui: { custom: host.custom },
		});
		await uiCommand(suite)("", ctx);
		expect(notices.join("\n")).not.toContain("Dashboard");
		expect(suite.harness.sent).toHaveLength(1);
		const childSent = suite.harness.sent[0];
		if (!childSent) throw new Error("expected one sent message");
		expect(textOf(childSent.message)).toContain("top-level Omp session");
		expect(childSent.options).toEqual({ triggerTurn: false });
		expect(host.calls).toHaveLength(0);
		expect(suite.teachInputs).toHaveLength(0);
		expect(suite.harness.userMessages).toHaveLength(0);
	});

	test("missing session id refuses with the scope copy before any read or mount", async () => {
		const suite = buildSuite();
		const host = uiHost();
		const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "", ui: { custom: host.custom } });
		await uiCommand(suite)("", ctx);
		expect(suite.harness.sent).toHaveLength(1);
		const missingSent = suite.harness.sent[0];
		if (!missingSent) throw new Error("expected one sent message");
		expect(textOf(missingSent.message)).toContain("Scope unavailable");
		expect(host.calls).toHaveLength(0);
		expect(suite.teachInputs).toHaveLength(0);
	});
});

// --- Unsupported hosts: bounded, sanitized plain text through the safe channel ---

describe("unsupported host fallback", () => {
	test("TUI host without ui.custom receives the real snapshot text plus the TUI-only explanation", async () => {
		const suite = buildSuite();
		seedMoment(suite.fixture, { id: "mom-plain", name: "Fallback lesson", status: "confirmed", kind: "playbook" });
		const host = uiHost();
		const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "s1", ui: {} });
		await uiCommand(suite)("", ctx);
		expect(host.calls).toHaveLength(0);
		expect(suite.harness.sent).toHaveLength(1);
		const entry = suite.harness.sent[0];
		if (!entry) throw new Error("expected one sent message");
		const body = textOf(entry.message);
		expect(entry.options).toEqual({ triggerTurn: false });
		expect(propOf(entry.message, "display")).toBe(true);
		expect(propOf(entry.message, "customType")).toBeUndefined();
		expect(body).toContain("Fallback lesson");
		expect(body).toContain("eligible by saved lesson rules");
		expect(body).toContain("use Omp TUI for guarded actions");
		const rows = body.split("\n");
		expect(rows.length).toBeLessThanOrEqual(24);
		for (const row of rows) {
			expect(hasControls(row)).toBe(false);
			expect(Bun.stringWidth(row)).toBeLessThanOrEqual(120);
		}
		// The fallback lifetime is torn down behind the send: its own signal is aborted.
		const firstTeachInput = suite.teachInputs[0];
		if (!firstTeachInput) throw new Error("expected one teach input");
		expect(firstTeachInput.signal?.aborted).toBe(true);
	});

	test("RPC host (hasUI, non-tui mode) gets the same bounded fallback with no model admission", async () => {
		const suite = buildSuite();
		const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "s1", mode: "rpc" });
		await uiCommand(suite)("", ctx);
		const rpcSent = suite.harness.sent[0];
		if (!rpcSent) throw new Error("expected one sent message");
		const body = textOf(rpcSent.message);
		expect(body).toContain("Native dashboard unavailable in this host");
		expect(rpcSent.options).toEqual({ triggerTurn: false });
		expect(suite.harness.userMessages).toHaveLength(0);
		expect(rpcSent.message).toBeDefined();
		expect(propOf(rpcSent.message, "display")).toBe(true);
	});

	test("hostile lesson text reaches the fallback with zero control characters and bounded rows", async () => {
		const suite = buildSuite();
		const esc = String.fromCharCode(27);
		const bel = String.fromCharCode(7);
		seedMoment(suite.fixture, {
			id: "mom-hostile",
			name: `${esc}[31mEVIL${bel}${esc}]8;;https://evil.test${bel}link${esc}[0m ${"x".repeat(300)}`,
			status: "confirmed",
			kind: "playbook",
		});
		const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "s1", mode: "rpc" });
		await uiCommand(suite)("", ctx);
		const hostileSent = suite.harness.sent[0];
		if (!hostileSent) throw new Error("expected one sent message");
		const body = textOf(hostileSent.message);
		expect(hasControls(body)).toBe(false);
		expect(body).toContain("EVIL");
		expect(body).not.toContain("https://evil.test");
		for (const row of body.split("\n")) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(120);
	});
});

// --- Native TUI lifetime: identity, mount, refresh, interleavings ---

describe("native dashboard lifetime", () => {

	test("argv selects the initial panel: explicit jev mounts Jev, unknown argv falls back to Overview", async () => {
		const suite = buildSuite();
		const host = uiHost();
		const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "sA", ui: { custom: host.custom } });
		const jev = uiCommand(suite)("jev", ctx);
		await awaitMountable(host);
		expect(host.calls).toHaveLength(1);
		expect(render(host.mount().component)).toContain("[Jev]");
		const overview = uiCommand(suite)("bogus-argv", ctx);
		await awaitMountable(host, 1);
		expect(host.calls).toHaveLength(2);
		expect(render(host.mount(1).component)).toContain("[Overview]");
		// The replacement open tore the first lifetime down behind the second.
		const replacedFirst = suite.teachInputs[0];
		const replacedSecond = suite.teachInputs[1];
		if (!replacedFirst || !replacedSecond) throw new Error("expected two teach inputs");
		expect(replacedFirst.signal?.aborted).toBe(true);
		expect(replacedSecond.signal?.aborted).toBe(false);
		const secondCall = host.calls[1];
		if (!secondCall) throw new Error("expected two custom calls");
		secondCall.finish?.(undefined);
		await Promise.all([jev, overview]);
	});

	test("latest refresh publishes through the real read model and clears busy", async () => {
		const suite = buildSuite();
		seedMoment(suite.fixture, { id: "mom-first", name: "First seeded" });
		const host = uiHost();
		const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "sA", ui: { custom: host.custom } });
		const pending = uiCommand(suite)("moments", ctx);
		await awaitMountable(host);
		const mounted = host.mount();
		// Lesson titles live on the Moments panel; Overview intentionally shows counts.
		expect(render(mounted.component)).toContain("First seeded");
		seedMoment(suite.fixture, { id: "mom-second", name: "Second seeded" });
		mounted.component.handleInput("r");
		await until(
			() => settledView(mounted) && render(mounted.component).includes("Second seeded"),
			"refresh publishes the reseeded snapshot and clears busy",
		);
		const visible = render(mounted.component);
		expect(visible).toContain("First seeded");
		expect(visible).toContain("Second seeded");
		// Initial read plus the one refresh ran through the real read model.
		expect(suite.teachInputs).toHaveLength(2);
		mounted.component.handleInput(K_ESC);
		await pending;
	});

	test("deferred refresh interleavings: latest alone publishes, clears busy and sets errors; a held earlier refresh can neither publish nor error", async () => {
		// Real dashboard, real snapshots, controlled host boundary: the refresh
		// callback is the host's seam, so held and failing runs are scripted
		// there instead of inside the domain read model.
		const fixture = freshFixture();
		seedMoment(fixture, { id: "mom-a", name: "Interleaved lesson" });
		const gate = new AbortController();
		const scope: InsightScope = { sessionId: "sA", cwd: fixture.cwd, stateDir: fixture.stateDir, epoch: 1 };
		const liveCtx = (): TeachContext =>
			realTeachContext({
				host: "omp",
				cwd: fixture.cwd,
				env: { ...process.env, ULTRATHINK_HOST: "omp" },
				sessionId: "sA",
				stateDir: fixture.stateDir,
				config: quietConfig(),
				signal: gate.signal,
			});
		const first = await readInsightSnapshot(scope, liveCtx(), gate.signal);
		const firstGate = Promise.withResolvers<InsightSnapshot>();
		const lateGate = Promise.withResolvers<InsightSnapshot>();
		const behaviors: Array<() => Promise<InsightSnapshot>> = [
			() => firstGate.promise,
			() => readInsightSnapshot(scope, liveCtx(), gate.signal),
			() => Promise.reject(new Error("fresh boom")),
			() => lateGate.promise,
		];
		let closed = false;
		const offDuty = (): Promise<InsightActionResult> => Promise.resolve({ status: "refused", message: "not under test" });
		const callbacks: InsightDashboardCallbacks = {
			refresh: () => (behaviors.shift() ?? (() => Promise.reject(new Error("unexpected refresh"))))(),
			confirmCandidate: () => offDuty(),
			previewSkill: () => offDuty(),
			installPreview: () => offDuty(),
			publishCard: () => offDuty(),
			close: () => {
				closed = true;
			},
		};
		const raw = createInsightDashboard(first, callbacks, { theme: {}, initialPanel: "moments" });
		const mounted: CustomMount = { component: raw, dones: [] };
		expect(render(mounted.component)).toContain("Interleaved lesson");

		// Refresh #1 is held inside the host boundary; Escape detaches it, and the
		// next refresh alone publishes, leaving no busy and no error behind.
		mounted.component.handleInput("r");
		await until(() => render(mounted.component).includes("Refreshing local snapshot"), "held refresh shows busy");
		mounted.component.handleInput(K_ESC);
		await until(() => settledView(mounted), "detached refresh clears busy without publishing");
		seedMoment(fixture, { id: "mom-b", name: "Second wave" });
		mounted.component.handleInput("r");
		await until(
			() => settledView(mounted) && render(mounted.component).includes("Second wave"),
			"latest refresh publishes and clears busy",
		);
		let visible = render(mounted.component);
		expect(visible).toContain("Interleaved lesson");
		expect(visible).not.toContain("refresh failed");

		// The released, stale run resolves late: it must neither publish nor surface.
		firstGate.resolve(first);
		await firstGate.promise;
		await Bun.sleep(0);
		visible = render(mounted.component);
		expect(visible).toContain("Second wave");
		expect(visible).not.toContain("Refreshing local snapshot");

		// The latest failing refresh is the one that sets the visible error.
		mounted.component.handleInput("r");
		await until(
			() => settledView(mounted) && render(mounted.component).includes("fresh boom"),
			"failed refresh surfaces its error and clears busy",
		);
		visible = render(mounted.component);
		expect(visible).toContain("Second wave");

		// A detached failing run stays silent: no late error, no busy, no publish.
		mounted.component.handleInput("r");
		await until(() => render(mounted.component).includes("Refreshing local snapshot"), "late refresh shows busy");
		mounted.component.handleInput(K_ESC);
		await until(() => settledView(mounted), "late refresh detaches and clears busy");
		lateGate.reject(new Error("late boom"));
		await lateGate.promise.then(
			() => undefined,
			() => undefined,
		);
		await Bun.sleep(0);
		visible = render(mounted.component);
		expect(visible).not.toContain("late boom");
		expect(visible).toContain("fresh boom");
		expect(visible).toContain("Second wave");
		expect(visible).not.toContain("Refreshing local snapshot");
		mounted.component.dispose();
		expect(closed).toBe(false);
	});
});

// --- Session identity: A-B-A switch, shutdown, reopen, planner-flight isolation ---

describe("session switch and shutdown", () => {
	test("A-B-A switch aborts the old lifetime, suppresses its late refresh and never resurrects it", async () => {
		const suite = buildSuite();
		const hostA = uiHost();
		const hostB = uiHost();
		const a = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "sA", ui: { custom: hostA.custom } });
		const b = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "sB", ui: { custom: hostB.custom } });
		const openA = uiCommand(suite)("", a.ctx);
		await awaitMountable(hostA);
		const mountedA = hostA.mount();
		const firstInput = suite.teachInputs[0];
		if (!firstInput) throw new Error("expected one teach input");

		// The switch aborts the old lifetime and closes its pending open.
		suite.harness.emit("session_switch", {}, b.ctx);
		expect(b.notices.join("\n")).toContain("Session changed");
		expect(firstInput.signal?.aborted).toBe(true);
		await openA;

		// A late refresh attempt from the old copy runs against the torn-down
		// lifetime: it sends nothing, forwards nothing to the model, and the
		// frozen snapshot gains none of the newer store state.
		seedMoment(suite.fixture, { id: "mom-late", name: "Late lesson" });
		const inputsBefore = suite.teachInputs.length;
		const sentBefore = suite.harness.sent.length;
		// The switch already tore the lifetime down: the disposed copy ignores "r" by design,
		// so the proof is inertness — two event-loop turns bound it, growth never arrives.
		mountedA.component.handleInput("r");
		await Bun.sleep(0);
		await Bun.sleep(0);
		expect(suite.teachInputs.length).toBe(inputsBefore);
		expect(suite.harness.sent.length).toBe(sentBefore);
		expect(suite.harness.userMessages).toHaveLength(0);
		expect(render(mountedA.component)).not.toContain("Late lesson");

		const openB = uiCommand(suite)("", b.ctx);
		await awaitMountable(hostB);
		const mountedB = hostB.mount();
		expect(render(mountedB.component)).toContain("[Overview]");
		const bInput = suite.teachInputs.at(-1);
		if (!bInput) throw new Error("expected a session-B teach input");
		expect(bInput).toMatchObject({ sessionId: "sB", stateDir: suite.fixture.stateDir });

		suite.harness.emit("session_switch", {}, a.ctx);
		expect(a.notices.join("\n")).toContain("Session changed");
		expect(bInput.signal?.aborted).toBe(true);
		await openB;

		const reopenA = uiCommand(suite)("", a.ctx);
		await awaitMountable(hostA, 1);
		const mountedA2 = hostA.mount(1);
		const reopenedInput = suite.teachInputs.at(-1);
		if (!reopenedInput) throw new Error("expected a reopened teach input");
		expect(reopenedInput).toMatchObject({ sessionId: "sA", stateDir: suite.fixture.stateDir });
		expect(reopenedInput.signal?.aborted).toBe(false);

		// The old copy is inert: nothing it does reaches the reopened lifetime.
		mountedA.component.handleInput(K_ESC);
		mountedA2.component.handleInput(K_ESC);
		await reopenA;
		expect(suite.harness.sent).toHaveLength(sentBefore);
	});

	test("session_shutdown aborts the lifetime; reopen starts a fresh lifetime", async () => {
		const suite = buildSuite();
		const host = uiHost();
		const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "sA", ui: { custom: host.custom } });
		const open = uiCommand(suite)("", ctx);
		await awaitMountable(host);
		host.mount();
		suite.harness.emit("session_shutdown", {}, ctx);
		const shutdownInput = suite.teachInputs[0];
		if (!shutdownInput) throw new Error("expected one teach input");
		expect(shutdownInput.signal?.aborted).toBe(true);
		await open;

		const reopen = uiCommand(suite)("", ctx);
		await awaitMountable(host, 1);
		const reopenInput = suite.teachInputs.at(-1);
		if (!reopenInput) throw new Error("expected a reopened teach input");
		expect(reopenInput.signal?.aborted).toBe(false);
		const reopenCall = host.calls[1];
		if (!reopenCall) throw new Error("expected two custom calls");
		reopenCall.finish?.(undefined);
		await reopen;
	});

	test("closing the display never cancels or mutates an in-flight planner flight", async () => {
		const flightGate = Promise.withResolvers<void>();
		const flightSignals: AbortSignal[] = [];
		const plan = async (_request: OmpPlanRequest, signal: AbortSignal): Promise<string> => {
			flightSignals.push(signal);
			await flightGate.promise;
			return "PLANNED CONTEXT";
		};
		const suite = buildSuite({ plan });
		const raced = (await suite.harness.run("plan this while the dashboard is open")) as { message?: unknown };
		expect(flightSignals).toHaveLength(1);
		// The pending note is the inline race delivery, not a transcript send.
		expect(textOf(raced.message)).toContain("still planning");

		const host = uiHost();
		const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "s1", ui: { custom: host.custom } });
		const open = uiCommand(suite)("", ctx);
		await awaitMountable(host);
		const mounted = host.mount();
		mounted.component.handleInput(K_ESC);
		await open;
		const flightSignal = flightSignals[0];
		if (!flightSignal) throw new Error("expected one planner flight");
		expect(flightSignal.aborted).toBe(false);

		flightGate.resolve();
		await until(
			() => suite.harness.sent.some((entry) => propOf(entry.message, "customType") === "ultrathink-plan"),
			"in-flight planner delivers its aside after the display closes",
		);
	});
});

// --- Delivery: card via default sendMessage only, never per-turn spam ---

describe("insight card delivery", () => {
	test("card publishes a real card DTO through default sendMessage with triggerTurn:false and no mount", async () => {
		const suite = buildSuite({ teach: (config) => void (config.teach.enabled = true) });
		seedMoment(suite.fixture, { id: "mom-card", name: "Card lesson", status: "confirmed", kind: "playbook" });
		const host = uiHost();
		const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "sA", ui: { custom: host.custom } });
		await uiCommand(suite)("card", ctx);
		expect(suite.harness.sent).toHaveLength(1);
		const entry = suite.harness.sent[0];
		if (!entry) throw new Error("expected one sent message");
		const message = entry.message as Record<string, unknown>;
		expect(entry.options).toEqual({ triggerTurn: false });
		expect(message.customType).toBe(INSIGHT_TYPE);
		expect(message.display).toBe(true);
		expect(textOf(message)).toContain("Ultrathink insight");
		expect(textOf(message)).not.toContain("\n");
		expect(Bun.stringWidth(textOf(message))).toBeLessThanOrEqual(120);
		const details = message.details as Record<string, unknown>;
		expect(details.project).toBe(suite.fixture.project);
		expect(details.session).toBe("sA");
		const policy = details.policy as Record<string, unknown>;
		expect(policy.enabled).toBe(true);
		const lessons = details.lessons as Record<string, unknown>[];
		expect(lessons).toHaveLength(1);
		const cardLesson = lessons[0];
		if (!cardLesson) throw new Error("expected one card lesson");
		expect(cardLesson.name).toBe("Card lesson");
		// The card DTO excludes lesson bodies and runtime scope by construction.
		expect(Object.hasOwn(cardLesson, "body")).toBe(false);
		expect(Object.hasOwn(details, "sessionId")).toBe(false);
		expect(Object.hasOwn(details, "stateDir")).toBe(false);
		expect(Object.hasOwn(details, "epoch")).toBe(false);
		expect(host.calls).toHaveLength(0);
		expect(suite.harness.userMessages).toHaveLength(0);
		// The card lifetime is torn down behind the publish: its own signal is aborted.
		const cardInput = suite.teachInputs[0];
		if (!cardInput) throw new Error("expected one teach input");
		expect(cardInput.signal?.aborted).toBe(true);
	});

	test("registration is the only entry: turn and tool events never open a dashboard or send a card", async () => {
		const suite = buildSuite();
		const host = uiHost();
		const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "sA", ui: { custom: host.custom } });
		const open = uiCommand(suite)("", ctx);
		await awaitMountable(host);
		const mounted = host.mount();
		mounted.component.handleInput(K_ESC);
		await open;
		for (const event of ["session_start", "agent_start", "agent_end", "turn_start", "turn_end", "tool_execution_start", "tool_execution_end"]) {
			suite.harness.emit(event, {}, ctx);
		}
		// Turn and tool events run no reads and send nothing: only the explicit
		// command opened the dashboard, and Escape already closed it.
		expect(suite.harness.sent).toHaveLength(0);
		expect(suite.teachInputs).toHaveLength(1);
		expect(host.calls).toHaveLength(1);
	});

	test("a stale lifetime cannot publish a card into the replaced session", async () => {
		const suite = buildSuite();
		const hostA = uiHost();
		const { ctx: ctxA } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "sA", ui: { custom: hostA.custom } });
		const openA = uiCommand(suite)("", ctxA);
		await awaitMountable(hostA);

		// The replacing card command tears lifetime 1 down before any card of it could fire.
		const { ctx: ctxCard } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "sA", ui: { notify: () => {} } });
		await uiCommand(suite)("card", ctxCard);
		const staleInput = suite.teachInputs[0];
		if (!staleInput) throw new Error("expected one teach input");
		expect(staleInput.signal?.aborted).toBe(true);
		expect(suite.harness.sent).toHaveLength(1);
		const staleSent = suite.harness.sent[0];
		if (!staleSent) throw new Error("expected one sent message");
		expect(propOf(staleSent.message, "customType")).toBe(INSIGHT_TYPE);
		// The replaced open closes instead of publishing anything of its own.
		await openA;
		expect(suite.harness.sent).toHaveLength(1);
	});
});

// --- SAFEUI-01: browsing purity and idempotent, state-preserving actions ---

describe("SAFEUI-01 browsing purity", () => {
	test("open, refresh, card and close perform zero network, credential, model or state-write operations", async () => {
		const plannerCalls: unknown[][] = [];
		const plan = async (...args: Parameters<OmpPlanner>): Promise<string> => {
			plannerCalls.push(args);
			return "";
		};
		const suite = buildSuite({
			teach: (config) => void (config.teach.enabled = true),
			plan,
		});
		seedMoment(suite.fixture, { id: "mom-pure", name: "Purity lesson" });
		const realFetch = globalThis.fetch;
		let networkTouched = false;
		globalThis.fetch = (() => {
			networkTouched = true;
			throw new Error("network use during inspection");
		}) as unknown as typeof fetch;
		try {
			const before = fingerprint(suite.fixture.root);
			const host = uiHost();
			const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "sA", ui: { custom: host.custom } });
			const open = uiCommand(suite)("", ctx);
			await awaitMountable(host);
			const mounted = host.mount();
			mounted.component.handleInput("r");
			// Escape only after the refresh actually settles: closing mid-busy
			// detaches instead, and the test would hang on the unclosed open.
			await until(() => settledView(mounted), "refresh settles before close");
			mounted.component.handleInput(K_ESC);
			await open;
			await uiCommand(suite)("card", ctx);
			const after = fingerprint(suite.fixture.root);

			expect(after).toBe(before);
			expect(networkTouched).toBe(false);
			expect(plannerCalls).toHaveLength(0);
			expect(suite.mcpReads()).toBe(0);
			expect(suite.harness.userMessages).toHaveLength(0);
			// Every TeachContext the host built for inspection carries no model,
			// recall, hindsight, or credential handles: passive omp identity only.
			expect(suite.teachContexts.length).toBeGreaterThan(0);
			for (const teachCtx of suite.teachContexts) {
				expect(teachCtx.fetch).toBeUndefined();
				expect(teachCtx.complete).toBeUndefined();
				expect(teachCtx.hindsight).toBeUndefined();
				expect(teachCtx.env.ULTRATHINK_HOST).toBe("omp");
			}
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("an empty store browses with the empty-store copy and still writes nothing", async () => {
		const suite = buildSuite();
		const before = fingerprint(suite.fixture.root);
		const host = uiHost();
		const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "sA", ui: { custom: host.custom } });
		const open = uiCommand(suite)("moments", ctx);
		await awaitMountable(host);
		const mounted = host.mount();
		const visible = render(mounted.component);
		expect(visible).toContain("No lessons recorded for this project");
		mounted.component.handleInput("r");
		await until(() => settledView(mounted), "refresh settles before close");
		mounted.component.handleInput(K_ESC);
		await open;
		expect(fingerprint(suite.fixture.root)).toBe(before);
	});

	test("confirming a real candidate writes once; the follow-up preview repeats locally without writes", async () => {
		const suite = buildSuite({ teach: (config) => void (config.teach.enabled = true) });
		seedMoment(suite.fixture, { id: "mom-confirm", name: "Confirmable lesson", kind: "playbook" });
		const host = uiHost();
		const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "sA", ui: { custom: host.custom } });
		const open = uiCommand(suite)("moments", ctx);
		await awaitMountable(host);
		const mounted = host.mount();
		expect(render(mounted.component)).toContain("Confirmable lesson");

		// Confirm through the real adapter: focus tabs → list → detail →
		// actions → confirm screen → affirmative. Detail strips move between
		// actions with ←/→; the confirm screen chooses with ↑/↓.
		mounted.component.handleInput(K_TAB);
		mounted.component.handleInput(K_ENTER);
		mounted.component.handleInput(K_ENTER);
		mounted.component.handleInput(K_RIGHT);
		mounted.component.handleInput(K_ENTER);
		expect(render(mounted.component)).toContain("Confirm this candidate?");
		const beforeCancellation = fingerprint(suite.fixture.root);
		mounted.component.handleInput(K_ENTER);
		expect(fingerprint(suite.fixture.root)).toBe(beforeCancellation);
		mounted.component.handleInput(K_ENTER);
		mounted.component.handleInput(K_ENTER);
		mounted.component.handleInput(K_DOWN);
		mounted.component.handleInput(K_ENTER);
		// The adapter persists first; the dashboard then auto-refreshes. The
		// settled canonical receipt survives that refresh, so the durable proof
		// is the live store transition plus the visible receipt and the settled
		// confirmed row.
		const momentPath = join(storeDir(suite.fixture.stateDir), "moments", "mom-confirm.json");
		await until(() => {
			if (!settledView(mounted)) return false;
			try {
				return (JSON.parse(readFileSync(momentPath, "utf8")) as { status: string }).status === "confirmed";
			} catch {
				return false;
			}
		}, "candidate confirm persists and refresh settles");
		const stored = JSON.parse(readFileSync(momentPath, "utf8")) as { status: string };
		expect(stored.status).toBe("confirmed");
		// The dashboard auto-refreshes after success; the confirmed row is the live state.
		expect(render(mounted.component)).toContain("confirmed");
		// Narrow receipt check on the real-domain effect: the actual adapter
		// confirmation outcome stays on screen after the follow-up refresh.
		expect(render(mounted.component)).toContain("Candidate confirmed.");

		// The deterministic preview repeats with zero filesystem changes: draft, back, draft again.
		const afterConfirm = fingerprint(suite.fixture.root);
		const drivePreview = (): void => {
			mounted.component.handleInput(K_ENTER);
			// Detail scroll is clamped window dressing: it never moves selection.
			mounted.component.handleInput(K_DOWN);
			mounted.component.handleInput(K_UP);
			mounted.component.handleInput(K_ENTER);
			mounted.component.handleInput(K_LEFT);
			mounted.component.handleInput(K_RIGHT);
			mounted.component.handleInput(K_ENTER);
		};
		drivePreview();
		await until(
			() => settledView(mounted) && render(mounted.component).includes("Preview lines"),
			"skill preview renders and busy clears",
		);
		expect(fingerprint(suite.fixture.root)).toBe(afterConfirm);
		mounted.component.handleInput(K_ESC);
		mounted.component.handleInput(K_ESC);
		drivePreview();
		await until(
			() => settledView(mounted) && render(mounted.component).includes("Preview lines"),
			"repeated skill preview renders and busy clears",
		);
		expect(fingerprint(suite.fixture.root)).toBe(afterConfirm);
		mounted.component.handleInput(K_ESC);
		mounted.component.handleInput(K_ESC);
		mounted.component.handleInput(K_ESC);
		await open;
	});

	test("with teaching disabled the refused action leaves the store byte-identical, twice", async () => {
		const suite = buildSuite();
		seedMoment(suite.fixture, { id: "mom-off", name: "Teaching-off lesson" });
		const before = fingerprint(suite.fixture.root);
		const host = uiHost();
		const { ctx } = sessionCtx({ cwd: suite.fixture.cwd, sessionId: "sA", ui: { custom: host.custom } });
		const open = uiCommand(suite)("moments", ctx);
		await awaitMountable(host);
		const mounted = host.mount();
		const fireConfirm = (): void => {
			mounted.component.handleInput(K_ENTER);
			mounted.component.handleInput(K_ENTER);
			mounted.component.handleInput(K_ENTER);
			mounted.component.handleInput(K_RIGHT);
			mounted.component.handleInput(K_ENTER);
			mounted.component.handleInput(K_DOWN);
			mounted.component.handleInput(K_ENTER);
		};
		fireConfirm();
		await until(
			() => settledView(mounted) && render(mounted.component).includes("Teaching is off"),
			"refused confirm explains the disabled policy",
		);
		// A refused confirm lands back in the detail view; one Escape returns to browse.
		mounted.component.handleInput(K_ESC);
		mounted.component.handleInput(K_SHIFT_TAB);
		fireConfirm();
		await until(
			() => settledView(mounted) && render(mounted.component).includes("Teaching is off"),
			"repeated refused confirm explains the disabled policy",
		);
		expect(fingerprint(suite.fixture.root)).toBe(before);
		mounted.component.handleInput(K_ESC);
		mounted.component.handleInput(K_ESC);
		await open;
	});
});

// --- Regression: child guards and delivery behavior outside the UI command are unchanged ---

describe("existing behavior preserved", () => {
	test("child sessions still forward other verbs via sendUserMessage; the UI command never does", async () => {
		const suite = buildSuite();
		const { ctx } = sessionCtx({
			cwd: suite.fixture.cwd,
			sessionFile: join(suite.fixture.root, "omp-task-1", "Agent.json"),
			hasUI: false,
		});
		await (suite.harness.commands.get("ultrathink-quick")?.handler as unknown as UiCommand)("hello", ctx);
		expect(suite.harness.userMessages).toEqual(["/ultrathink-quick hello"]);
		// The UI command path forwards nothing to the model in the same child shape.
		await uiCommand(suite)("", ctx);
		expect(suite.harness.userMessages).toHaveLength(1);
		expect(textOf(suite.harness.sent.at(-1)?.message)).toContain("top-level Omp session");
	});

	test("controlled planner still races and delivers its aside", async () => {
		const flight = controlled();
		const suite = buildSuite({ plan: flight.plan });
		const result = (await suite.harness.run("planned prompt")) as { message?: unknown };
		expect(textOf(result.message)).toContain("still planning");
		flight.resolve("ASYNC PLAN");
		await flush();
		expect(suite.harness.sent.some((entry) => propOf(entry.message, "customType") === "ultrathink-plan")).toBe(true);
	});
});

