// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { createInsightDashboard, type InsightDashboard, type InsightDashboardCallbacks } from "./omp-dashboard.ts";
import type { InsightActionResult, InsightLesson, InsightSnapshot } from "./omp-insights.ts";

function mkLesson(id: string, name: string, overrides: Partial<InsightLesson> = {}): InsightLesson {
	return {
		id,
		name,
		description: "",
		body: "",
		status: "candidate",
		kind: "pattern",
		origin: "explicit",
		host: "omp-test",
		occurrences: 1,
		recalled: 0,
		createdAt: "2026-01-01T00:00:00Z",
		lastSeenAt: "2026-01-02T00:00:00Z",
		sourcePhase: "test",
		sourceArtifacts: [],
		tags: [],
		relatedIds: [],
		selection: { id, revision: `${id}-r` },
		eligible: false,
		...overrides,
	};
}

function snapshot(overrides: Partial<InsightSnapshot> = {}): InsightSnapshot {
	return {
		project: "demo",
		session: "s1",
		at: 1_700_000_000_000,
		decisions: [
			{ point: "teachable", outcome: "ok", model: "test-model", action: "auto-confirm", threshold: 0.5, latencyMs: 12, attempts: 1, at: 1_700_000_000_000, p: 0.75, probabilities: { teachable_worthy: 0.75 }, questions: [{ key: "teachable_worthy", p: 0.75 }] },
			{ point: "skillworthy", outcome: "error", model: "test-model", action: "fail-open", threshold: 0.5, latencyMs: 3, attempts: 1, at: 1_699_999_999_000, error: "auth", probabilities: {}, questions: [] },
		],
		lessons: [
			mkLesson("l1", "First lesson", { description: "details", body: "full body", selection: { id: "l1", revision: "r1" } }),
			mkLesson("l2", "Second lesson", { description: "details", body: "full body", status: "confirmed", kind: "playbook", occurrences: 9, createdAt: "2026-01-03T00:00:00Z", lastSeenAt: "2026-01-04T00:00:00Z", eligible: true, selection: { id: "l2", revision: "r2" } }),
		],
		policy: { enabled: true, capture: "explicit", recall: true, recallLimit: 5, recallChars: 4000, autoPromote: false, promoteAfter: 3, jevEnabled: true },
		counts: { candidate: 1, confirmed: 1, promoted: 0, superseded: 0 },
		eligible: 1,
		promoted: 0,
		partial: false,
		limitations: [],
		...overrides,
	};
}

interface RecordingCallbacks extends InsightDashboardCallbacks {
	calls: string[];
}

function stubs(overrides: Partial<InsightDashboardCallbacks> = {}): RecordingCallbacks {
	const calls: string[] = [];
	return {
		calls,
		refresh: async () => {
			calls.push("refresh");
			return snapshot();
		},
		confirmCandidate: async () => {
			calls.push("confirm");
			return { status: "ok", message: "confirmed", retention: "retained" as const };
		},
		previewSkill: async () => {
			calls.push("preview");
			return { status: "ok", message: "ready", preview: { selection: { id: "l2", revision: "r2" }, fingerprint: "f", name: "draft", description: "d", content: "content", warnings: [] } };
		},
		installPreview: async () => {
			calls.push("install");
			return { status: "ok", message: "Omp install recorded.", install: { action: "created", skill: "second-lesson" } };
		},
		publishCard: async () => {
			calls.push("publish");
			return { status: "ok", message: "published" };
		},
		close: () => {
			calls.push("close");
		},
		...overrides,
	};
}

/** Drain the fixed-length promise chains the dashboard uses; no wall-clock waits. */
const flush = async (): Promise<void> => {
	for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
const plain = (rows: readonly string[]): string[] => rows.map((row) => Bun.stripANSI(row));

test("Jev details preserve numeric thresholds and zero cost with and without question rows", () => {
	for (const threshold of [0.9, 0]) {
		const ui = createInsightDashboard(snapshot({ decisions: [{
			point: "plan", outcome: "ok", model: "fixture-model", action: "hold",
			threshold, cost: 0, latencyMs: 0, attempts: 1, at: 1_700_000_000_000,
			p: 0, probabilities: threshold === 0 ? { plan_worthy: 0 } : {},
			questions: threshold === 0 ? [{ key: "plan_worthy", p: 0 }] : [],
		}] }), stubs(), { theme: {}, initialPanel: "jev", rows: () => 40 });
		ui.render(120);
		ui.handleInput("\t");
		ui.handleInput("\r");
		const text = plain(ui.render(120)).join("\n");
		expect(text).toContain(`Threshold: ${threshold === 0 ? "0.00" : "0.90"}`);
		expect(text).toContain("Cost: 0");
		ui.dispose();
	}
});

describe("dashboard tabs and focus", () => {

	test("tab focus cycles through regions without trapping", () => {
		const ui = createInsightDashboard(snapshot(), stubs(), { theme: {}, initialPanel: "moments" });
		ui.handleInput("tab");
		let text = plain(ui.render(80)).join("\n");
		expect(text).toContain("> First lesson");
		ui.handleInput("tab");
		ui.handleInput("tab");
		text = plain(ui.render(80)).join("\n");
		expect(text).toContain("[Moments]");
		ui.dispose();
	});

	test("left and right move one panel without wrapping", () => {
		const ui = createInsightDashboard(snapshot(), stubs(), { theme: {}, initialPanel: "jev" });
		ui.handleInput("left");
		expect(plain(ui.render(80)).join("\n")).toContain("[Overview]");
		ui.handleInput("left");
		expect(plain(ui.render(80)).join("\n")).toContain("[Overview]");
		ui.handleInput("right");
		ui.handleInput("right");
		ui.handleInput("right");
		expect(plain(ui.render(80)).join("\n")).toContain("[Skills]");
		ui.handleInput("right");
		expect(plain(ui.render(80)).join("\n")).toContain("[Skills]");
		ui.dispose();
	});
});

describe("dashboard list keyboard behavior", () => {
	test("cursors stop at both ends and enter opens details with escape unwinding", () => {
		const cb = stubs();
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments" });
		ui.handleInput("tab");
		for (let i = 0; i < 10; i += 1) ui.handleInput("down");
		let text = plain(ui.render(80)).join("\n");
		expect(text).toMatch(/item 2 of 2 shown/);
		ui.handleInput("down");
		expect(plain(ui.render(80)).join("\n")).toMatch(/item 2 of 2 shown/);
		ui.handleInput("up");
		ui.handleInput("up");
		ui.handleInput("up");
		expect(plain(ui.render(80)).join("\n")).toMatch(/item 1 of 2 shown/);
		ui.handleInput("enter");
		text = plain(ui.render(80)).join("\n");
		expect(text).toContain("l1");
		ui.handleInput("escape");
		text = plain(ui.render(80)).join("\n");
		expect(text).toContain("> First lesson");
		ui.handleInput("escape");
		expect(cb.calls).toContain("close");
		ui.dispose();
	});

	test("empty panels have no cursor and enter is safe", () => {
		const ui = createInsightDashboard(snapshot({ lessons: [], decisions: [] }), stubs(), { theme: {}, initialPanel: "moments" });
		const text = plain(ui.render(80)).join("\n");
		expect(text).not.toContain(">");
		ui.handleInput("enter");
		ui.handleInput("tab");
		expect(plain(ui.render(80)).join("\n")).not.toContain(">");
		ui.dispose();
	});

	test("refresh retains selection by exact id across reorder", async () => {
		const first = snapshot();
		let current = first;
		const cb = stubs({ refresh: async () => current });
		const ui = createInsightDashboard(first, cb, { theme: {}, initialPanel: "moments" });
		ui.handleInput("tab");
		ui.handleInput("down");
		expect(plain(ui.render(80)).join("\n")).toContain("> Second lesson");
		current = snapshot({
			lessons: [
				mkLesson("l9", "Newcomer", { createdAt: "2026-02-01T00:00:00Z", lastSeenAt: "2026-02-01T00:00:00Z", selection: { id: "l9", revision: "r9" } }),
				mkLesson("l2", "Second lesson", { status: "confirmed", kind: "playbook", occurrences: 9, createdAt: "2026-01-03T00:00:00Z", lastSeenAt: "2026-01-04T00:00:00Z", eligible: true, selection: { id: "l2", revision: "r2" } }),
				mkLesson("l1", "First lesson", { selection: { id: "l1", revision: "r1" } }),
			],
		});
		ui.handleInput("r");
		await flush();
		await flush();
		expect(plain(ui.render(80)).join("\n")).toContain("> Second lesson");
		ui.dispose();
	});

	test("refresh clears a disappeared selection with a notice instead of reusing the index", async () => {
		let current = snapshot();
		const cb = stubs({ refresh: async () => current });
		const ui = createInsightDashboard(current, cb, { theme: {}, initialPanel: "moments" });
		ui.handleInput("tab");
		ui.handleInput("down");
		current = snapshot({
			lessons: [mkLesson("l9", "Only survivor", { createdAt: "2026-02-01T00:00:00Z", lastSeenAt: "2026-02-01T00:00:00Z", selection: { id: "l9", revision: "r9" } })],
		});
		ui.handleInput("r");
		await flush();
		await flush();
		const text = plain(ui.render(80)).join("\n");
		expect(text).toContain("Only survivor");
		expect(text).not.toContain("Second lesson");
		expect(text).toMatch(/no\s+longer/);
		ui.dispose();
	});
});

describe("dashboard bounds and viewports", () => {
	test("every width keeps rows within bounds including CJK and emoji", () => {
		const wide = snapshot({
			lessons: [mkLesson("l1", "数据库迁移：拆分用户表并回填历史订单数据 🚀 combined", { description: "x".repeat(400), body: "y".repeat(400), selection: { id: "l1", revision: "r1" } })],
		});
		for (const width of [0, 1, 7, 8, 40, 120]) {
			const ui = createInsightDashboard(wide, stubs(), { theme: {}, initialPanel: "moments" });
			ui.handleInput("tab");
			ui.handleInput("enter");
			const rows = plain(ui.render(width));
			if (width === 0) {
				expect(rows.length).toBe(0);
			} else {
				for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
			}
			ui.dispose();
		}
	});


	test("tiny viewports refuse mutation while browsing and escape stay live", () => {
		const cb = stubs();
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments", rows: () => 30 });
		const text = plain(ui.render(20)).join("\n");
		expect(text).toMatch(/resize/i);
		ui.handleInput("tab");
		// Below the mutation floor the list stays navigable: Tab focuses it and
		// ↑/↓ select records; only data-changing actions stay gated.
		expect(plain(ui.render(20)).join("\n")).toContain("> First lesson");
		ui.handleInput("down");
		expect(plain(ui.render(20)).join("\n")).toContain("> Second lesson");
		ui.handleInput("enter");
		const detail = plain(ui.render(20)).join("\n");
		expect(detail).toContain("l2");
		ui.handleInput("escape");
		ui.handleInput("escape");
		expect(cb.calls).toContain("close");
		expect(cb.calls).not.toContain("install");
		expect(cb.calls).not.toContain("confirm");
		ui.dispose();
	});

	test("unframed output under 8 columns stays bounded", () => {
		const ui = createInsightDashboard(snapshot(), stubs(), { theme: {}, initialPanel: "overview" });
		const rows = plain(ui.render(7));
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(7);
		ui.dispose();
	});
});

describe("dashboard guarded confirmations", () => {
	async function openCandidateConfirm(overrides: Partial<InsightDashboardCallbacks> = {}): Promise<{ ui: InsightDashboard; cb: RecordingCallbacks }> {
		const cb = stubs(overrides);
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments" });
		ui.handleInput("tab");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		return { ui, cb };
	}

	test("candidate confirmation defaults to the non-mutating choice and arrows never confirm", async () => {
		const { ui, cb } = await openCandidateConfirm();
		let text = plain(ui.render(80)).join("\n");
		expect(text).toContain("Confirm this candidate?");
		ui.handleInput("enter");
		await flush();
		expect(cb.calls).not.toContain("confirm");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("shift-tab");
		ui.handleInput("left");
		ui.handleInput("right");
		ui.handleInput("up");
		ui.handleInput("down");
		await flush();
		expect(cb.calls).not.toContain("confirm");
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
		await flush();
		expect(cb.calls).toContain("confirm");
		ui.dispose();
	});

	test("preview install opens a separate confirmation that ignores its triggering enter", async () => {
		const cb = stubs();
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments" });
		ui.handleInput("tab");
		ui.handleInput("down");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		await flush();
		let text = plain(ui.render(80)).join("\n");
		expect(text).toMatch(/Preview only/);
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		text = plain(ui.render(80)).join("\n");
		expect(text).toMatch(/Install this preview into Omp/);
		ui.handleInput("enter");
		await flush();
		expect(cb.calls).not.toContain("install");
		ui.handleInput("escape");
		expect(cb.calls).not.toContain("install");
		ui.dispose();
	});

	test("escape during an in-flight confirmation detaches its late completion", async () => {
		const gate = Promise.withResolvers<InsightActionResult>();
		const { ui, cb } = await openCandidateConfirm({
			confirmCandidate: async () => {
				cb.calls.push("confirm");
				return gate.promise;
			},
		});
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
		expect(cb.calls).toContain("confirm");
		// Escape detaches the run while the dispatched confirmation waits.
		ui.handleInput("escape");
		const detached = plain(ui.render(80)).join("\n");
		expect(detached).toContain("Escape dismissed the wait");
		// The late completion lands nowhere: no receipt, no auto-refresh.
		gate.resolve({ status: "ok", message: "LATE-CONFIRM-RECEIPT", retention: "retained" as const });
		await flush();
		await flush();
		const after = plain(ui.render(80)).join("\n");
		expect(after).toContain("Escape dismissed the wait");
		expect(after).not.toContain("LATE-CONFIRM-RECEIPT");
		expect(cb.calls).not.toContain("refresh");
		ui.dispose();
	});

	test("escape during an in-flight install detaches its late completion", async () => {
		const gate = Promise.withResolvers<InsightActionResult>();
		const cb = stubs({
			installPreview: async () => {
				cb.calls.push("install");
				return gate.promise;
			},
		});
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments" });
		ui.handleInput("tab");
		ui.handleInput("down");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		await flush();
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
		expect(cb.calls).toContain("install");
		ui.handleInput("escape");
		const detached = plain(ui.render(80)).join("\n");
		expect(detached).toContain("Escape dismissed the wait");
		// The late completion lands nowhere: no receipt, no auto-refresh.
		gate.resolve({ status: "ok", message: "LATE-INSTALL-RECEIPT", install: { action: "created", skill: "second-lesson" } });
		await flush();
		await flush();
		const after = plain(ui.render(80)).join("\n");
		expect(after).toContain("Escape dismissed the wait");
		expect(after).not.toContain("LATE-INSTALL-RECEIPT");
		expect(cb.calls).not.toContain("refresh");
		ui.dispose();
	});

	test("escape during a settled confirmation's follow-up refresh detaches the re-read", async () => {
		const gate = Promise.withResolvers<InsightSnapshot>();
		let refreshes = 0;
		const { ui, cb } = await openCandidateConfirm({
			confirmCandidate: async () => {
				cb.calls.push("confirm");
				return { status: "ok", message: "RECEIPT-KEEP", retention: "retained" as const };
			},
			refresh: async () => {
				refreshes += 1;
				if (refreshes === 1) return gate.promise;
				cb.calls.push("refresh");
				return snapshot();
			},
		});
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
		await flush();
		expect(cb.calls).toContain("confirm");
		expect(refreshes).toBe(1);
		// Escape cancels the owned follow-up refresh while it waits.
		ui.handleInput("escape");
		const detached = plain(ui.render(80)).join("\n");
		expect(detached).toContain("RECEIPT-KEEP");
		expect(detached).toContain("Follow-up refresh cancelled");
		// The late snapshot lands nowhere: no disappearance claim, no swap.
		gate.resolve(snapshot({ lessons: [], counts: { candidate: 0, confirmed: 0, promoted: 0, superseded: 0 }, eligible: 0 }));
		await flush();
		await flush();
		const after = plain(ui.render(80)).join("\n");
		expect(after).toContain("RECEIPT-KEEP");
		expect(after).toContain("Follow-up refresh cancelled");
		expect(after).not.toContain("no longer in this snapshot");
		ui.dispose();
	});

	test("late confirmation completion after dispose changes nothing", async () => {
		const gate = Promise.withResolvers<InsightActionResult>();
		const { ui, cb } = await openCandidateConfirm({
			confirmCandidate: async () => {
				cb.calls.push("confirm");
				return gate.promise;
			},
		});
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
		expect(cb.calls).toContain("confirm");
		ui.dispose();
		gate.resolve({ status: "ok", message: "LATE-DISPOSE-RECEIPT", retention: "retained" as const });
		await flush();
		await flush();
		expect(cb.calls).not.toContain("refresh");
		expect(ui.render(80).length).toBe(0);
	});

	test("only one preview request runs while pending", async () => {
		let releases: Array<() => void> = [];
		const cb = stubs({
			previewSkill: async () => {
				cb.calls.push("preview");
				const gate = Promise.withResolvers<void>();
				releases.push(gate.resolve);
				await gate.promise;
				return { status: "ok", message: "ready", preview: { selection: { id: "l2", revision: "r2" }, fingerprint: "f", name: "draft", description: "d", content: "c", warnings: [] } };
			},
		});
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments" });
		ui.handleInput("tab");
		ui.handleInput("down");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
		ui.handleInput("enter");
		ui.handleInput("r");
		await flush();
		expect(cb.calls.filter((call) => call === "preview").length).toBe(1);
		for (const release of releases) release();
		releases = [];
		await flush();
		await flush();
		ui.dispose();
	});

	test("late refresh completion after dispose changes nothing", async () => {
		const gate = Promise.withResolvers<InsightSnapshot>();
		const cb = stubs({ refresh: () => gate.promise });
		const ui = createInsightDashboard(snapshot(), cb, { theme: {} });
		ui.handleInput("r");
		ui.dispose();
		gate.resolve(snapshot());
		await flush();
		await flush();
		expect(ui.render(80).length).toBe(0);
	});
});

describe("dashboard untrusted text", () => {
	test("hostile terminal sequences never reach painted rows", () => {
		const hostile = "x\x1b[2Jcgi\x1b]0;pwned\x07y\u202e\u2066z";
		const ui = createInsightDashboard(
			snapshot({ lessons: [mkLesson("l1", hostile, { description: hostile, body: hostile, createdAt: hostile, lastSeenAt: hostile, selection: { id: "l1", revision: "r1" } })] }),
			stubs(),
			{ theme: {}, initialPanel: "moments" },
		);
		ui.handleInput("tab");
		ui.handleInput("enter");
		for (const row of plain(ui.render(80))) expect(row).not.toContain(String.fromCharCode(27));
		ui.dispose();
	});

	test("render performs no reads and stays synchronous", () => {
		let reads = 0;
		const cb = stubs({
			refresh: async () => {
				reads += 1;
				return snapshot();
			},
		});
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "jev" });
		ui.render(80);
		ui.render(40);
		ui.render(120);
		expect(reads).toBe(0);
		ui.dispose();
	});
});

describe("dashboard key protocols", () => {
	const ESC = String.fromCharCode(27);
	test("CSI-u, SS3, and modifier-suffixed legacy sequences drive the same actions", () => {
		const ui = createInsightDashboard(snapshot(), stubs(), { theme: {}, initialPanel: "moments" });
		ui.handleInput(`${ESC}[13u`);
		expect(plain(ui.render(80)).join("\n")).toContain("> First lesson");
		ui.handleInput(`${ESC}OB`);
		expect(plain(ui.render(80)).join("\n")).toContain("> Second lesson");
		ui.handleInput(`${ESC}[1;1B`);
		expect(plain(ui.render(80)).join("\n")).toContain("> Second lesson");
		ui.handleInput(`${ESC}OA`);
		expect(plain(ui.render(80)).join("\n")).toContain("> First lesson");
		ui.handleInput(`${ESC}[13;1u`);
		expect(plain(ui.render(80)).join("\n")).toContain("Id: l1");
		ui.dispose();
	});

	test("modified keys, releases, and shifted letters never act", async () => {
		const cb = stubs();
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments" });
		const ctrlR = String.fromCharCode(1);
		for (const sequence of [`${ESC}[1;5A`, `${ESC}[1;5B`, `${ESC}[1;3C`, `${ESC}[1;4D`, `${ESC}[13;2u`, `${ESC}[13;5u`, `${ESC}[9;5u`, `${ESC}[27;5;13~`, `${ESC}[13;1:3u`, `${ESC}[1;1:3A`, "R", ctrlR, `${ESC}[200~`]) {
			ui.handleInput(sequence);
		}
		await flush();
		expect(cb.calls.length).toBe(0);
		expect(plain(ui.render(80)).join("\n")).toContain("[Moments]");
		ui.dispose();
	});

	test("modifyOtherKeys and CSI-u shift+tab move focus backward", () => {
		const ui = createInsightDashboard(snapshot(), stubs(), { theme: {}, initialPanel: "moments" });
		ui.handleInput(`${ESC}[27;2;9~`);
		ui.handleInput(`${ESC}[9;2u`);
		expect(plain(ui.render(80)).join("\n")).toContain("[Moments]");
		ui.dispose();
	});
});

describe("dashboard action receipts survive refresh", () => {
	/** Drive moments l1 to the confirm-candidate screen; caller fires the affirmative. */
	function openConfirm(ui: InsightDashboard): void {
		ui.render(80);
		ui.handleInput("tab");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
	}

	async function fireConfirmYes(ui: InsightDashboard): Promise<void> {
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
	}

	test("confirmed receipt stays visible during and after its follow-up refresh", async () => {
		const RECEIPT = "Candidate confirmed receipt-7.";
		const pending: Array<(next: InsightSnapshot) => void> = [];
		const cb = stubs({
			confirmCandidate: async () => {
				cb.calls.push("confirm");
				return { status: "ok", message: RECEIPT, retention: "retained" as const };
			},
			refresh: () => {
				cb.calls.push("refresh");
				return new Promise<InsightSnapshot>((resolve) => {
					pending.push(resolve);
				});
			},
		});
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments" });
		openConfirm(ui);
		await flush();
		expect(plain(ui.render(80)).join("\n")).toContain("Confirm this candidate?");
		await fireConfirmYes(ui);
		// Follow-up refresh in flight: the settled receipt shares the screen with the busy label.
		let text = plain(ui.render(80)).join("\n");
		expect(text).toContain("Refreshing local snapshot");
		expect(text).toContain(RECEIPT);
		// Refresh lands with the confirmed row live; the receipt still stands.
		pending.shift()?.(
			snapshot({
				lessons: [
					mkLesson("l1", "First lesson", { status: "confirmed", selection: { id: "l1", revision: "r1" } }),
					mkLesson("l2", "Second lesson", { status: "confirmed", kind: "playbook", occurrences: 9, eligible: true, selection: { id: "l2", revision: "r2" } }),
				],
			}),
		);
		await flush();
		await flush();
		text = plain(ui.render(80)).join("\n");
		expect(text).toContain(RECEIPT);
		expect(text).toContain("First lesson");
		ui.dispose();
	});

	test("install receipt stays visible during and after its follow-up refresh", async () => {
		const RECEIPT = "Omp install recorded receipt-9.";
		const pending: Array<(next: InsightSnapshot) => void> = [];
		const cb = stubs({
			installPreview: async () => {
				cb.calls.push("install");
				return { status: "ok", message: RECEIPT, install: { action: "created", skill: "second-lesson" } };
			},
			refresh: () => {
				cb.calls.push("refresh");
				return new Promise<InsightSnapshot>((resolve) => {
					pending.push(resolve);
				});
			},
		});
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments" });
		ui.render(80);
		ui.handleInput("tab");
		ui.handleInput("down");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		await flush();
		expect(plain(ui.render(80)).join("\n")).toMatch(/Preview only/);
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		expect(plain(ui.render(80)).join("\n")).toMatch(/Install this preview into Omp/);
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
		let text = plain(ui.render(80)).join("\n");
		expect(text).toContain("Refreshing local snapshot");
		expect(text).toContain(RECEIPT);
		pending.shift()?.(snapshot());
		await flush();
		await flush();
		text = plain(ui.render(80)).join("\n");
		expect(text).toContain(RECEIPT);
		ui.dispose();
	});

	test("confirmed receipt survives a failed follow-up refresh without a rollback claim", async () => {
		const RECEIPT = "Candidate confirmed receipt-11.";
		const cb = stubs({
			confirmCandidate: async () => {
				cb.calls.push("confirm");
				return { status: "ok", message: RECEIPT, retention: "retained" as const };
			},
			refresh: async () => {
				cb.calls.push("refresh");
				throw new Error("snapshot store unavailable");
			},
		});
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments" });
		openConfirm(ui);
		await flush();
		await fireConfirmYes(ui);
		await flush();
		const text = plain(ui.render(80)).join("\n");
		expect(text).toContain(RECEIPT);
		expect(text).toContain("Could not read local snapshot");
		expect(text).toMatch(/no rollback/i);
		ui.dispose();
	});

	test("confirmed receipt survives a disappeared selection without a rollback claim", async () => {
		const RECEIPT = "Candidate confirmed receipt-13.";
		let current = snapshot();
		const cb = stubs({
			confirmCandidate: async () => {
				cb.calls.push("confirm");
				return { status: "ok", message: RECEIPT, retention: "retained" as const };
			},
			refresh: async () => {
				cb.calls.push("refresh");
				return current;
			},
		});
		const ui = createInsightDashboard(current, cb, { theme: {}, initialPanel: "moments" });
		openConfirm(ui);
		await flush();
		// The confirmed record leaves the next snapshot; the receipt must stand
		// beside the disappearance note instead of being wiped by it.
		current = snapshot({
			lessons: [mkLesson("l9", "Only survivor", { selection: { id: "l9", revision: "r9" } })],
		});
		await fireConfirmYes(ui);
		await flush();
		const text = plain(ui.render(80)).join("\n");
		expect(text).toContain(RECEIPT);
		expect(text).toContain("Only survivor");
		ui.dispose();
	});

	test("a later manual refresh clears the obsolete receipt", async () => {
		const RECEIPT = "Candidate confirmed receipt-17.";
		const pending: Array<(next: InsightSnapshot) => void> = [];
		const cb = stubs({
			confirmCandidate: async () => {
				cb.calls.push("confirm");
				return { status: "ok", message: RECEIPT, retention: "retained" as const };
			},
			refresh: () => {
				cb.calls.push("refresh");
				return new Promise<InsightSnapshot>((resolve) => {
					pending.push(resolve);
				});
			},
		});
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments" });
		openConfirm(ui);
		await flush();
		await fireConfirmYes(ui);
		pending.shift()?.(snapshot());
		await flush();
		await flush();
		expect(plain(ui.render(80)).join("\n")).toContain(RECEIPT);
		// Explicit manual refresh: the obsolete receipt clears with the new snapshot.
		ui.handleInput("r");
		pending.shift()?.(snapshot());
		await flush();
		await flush();
		expect(plain(ui.render(80)).join("\n")).not.toContain(RECEIPT);
		expect(cb.calls.filter((call) => call === "refresh").length).toBe(2);
		ui.dispose();
	});
});

describe("dashboard physical viewport boundaries", () => {
	const TAIL = "ownership-marker-tail-line";
	function longBodyLesson(): InsightLesson {
		return mkLesson("lb", "Long body lesson", {
			status: "confirmed",
			kind: "pattern",
			occurrences: 5,
			eligible: true,
			body: [`head ${"n".repeat(900)}`, `${"数据库迁移".repeat(60)} recall`, "middle", `${"y".repeat(900)}`, TAIL].join("\n"),
			selection: { id: "lb", revision: "rlb" },
		});
	}
	function openDetail(ui: InsightDashboard): void {
		ui.render(80);
		ui.handleInput("tab");
		ui.handleInput("enter");
	}
	function scrollTo(text: string, ui: InsightDashboard, width: number, key: string, limit = 600): string {
		let rendered = plain(ui.render(width)).join("\n");
		for (let i = 0; i < limit && !rendered.includes(text); i += 1) {
			ui.handleInput(key);
			const next = plain(ui.render(width)).join("\n");
			if (next === rendered) break;
			rendered = next;
		}
		return rendered;
	}

	test("long unbroken, multiline, and CJK detail scrolls to the tail without row or height overflow", () => {
		const height = 24;
		const width = 80;
		const ui = createInsightDashboard(snapshot({ lessons: [longBodyLesson()] }), stubs(), { theme: {}, initialPanel: "moments", rows: () => height });
		openDetail(ui);
		for (const rows of [plain(ui.render(width))]) {
			expect(rows.length).toBeLessThanOrEqual(height);
			for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
		}
		const text = scrollTo(TAIL, ui, width, "down");
		expect(text).toContain(TAIL);
		const tailRows = plain(ui.render(width));
		expect(tailRows.length).toBeLessThanOrEqual(height);
		for (const row of tailRows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
		ui.dispose();
	});


	test("a supported preview scrolls its ownership tail into view with install reachable", async () => {
		const marker = "ownership: generated-by-ultrathink";
		const content = `---\n${"draft line\n".repeat(200)}${marker}\n`;
		const cb = stubs({
			previewSkill: async () => {
				cb.calls.push("preview");
				return { status: "ok", message: "ready", preview: { selection: { id: "l2", revision: "r2" }, fingerprint: "f", name: "draft", description: "d", content, warnings: [] } };
			},
		});
		const height = 24;
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments", rows: () => height });
		ui.render(80);
		ui.handleInput("tab");
		ui.handleInput("down");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		await flush();
		let text = scrollTo(marker, ui, 80, "down");
		expect(text).toContain(marker);
		const tailRows = plain(ui.render(80));
		expect(tailRows.length).toBeLessThanOrEqual(height);
		for (const row of tailRows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(80);
		// The reviewable preview still opens its separate install confirmation.
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		expect(plain(ui.render(80)).join("\n")).toMatch(/Install this preview into Omp/);
		ui.dispose();
	});

	test("a clipped preview disables every install path without claiming review", async () => {
		const content = `${"z".repeat(70_000)}\nownership-tail\n`;
		const cb = stubs({
			previewSkill: async () => {
				cb.calls.push("preview");
				return { status: "ok", message: "ready", preview: { selection: { id: "l2", revision: "r2" }, fingerprint: "f", name: "draft", description: "d", content, warnings: [] } };
			},
		});
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments", rows: () => 40 });
		ui.render(80);
		ui.handleInput("tab");
		ui.handleInput("down");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		await flush();
		const text = plain(ui.render(80)).join("\n");
		expect(text).toMatch(/60KB/);
		// The strip's install entry is present but disabled: activating it
		// explains instead of opening install consent.
		ui.handleInput("tab");
		ui.handleInput("enter");
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
		expect(cb.calls).not.toContain("install");
		ui.handleInput("escape");
		expect(cb.calls).not.toContain("install");
		ui.dispose();
	});

	test("short viewports refuse mutation while browsing and escape stay live", () => {
		let height = 7;
		const cb = stubs();
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments", rows: () => height });
		const short = plain(ui.render(80));
		expect(short.length).toBeLessThanOrEqual(7);
		for (const row of short) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(80);
		expect(short.join("\n")).toMatch(/resize/i);
		// Navigation still advances the stored cursor while short; growing the
		// viewport proves the selection survived clamping with data intact.
		ui.handleInput("tab");
		ui.handleInput("down");
		height = 30;
		expect(plain(ui.render(80)).join("\n")).toContain("> Second lesson");
		height = 7;
		ui.handleInput("escape");
		expect(cb.calls).toContain("close");
		expect(cb.calls).not.toContain("confirm");
		expect(cb.calls).not.toContain("install");
		ui.dispose();
	});

	test("short viewports keep eligibility facts and the full body reachable by scrolling", () => {
		const tail = "tiny-viewport-body-tail";
		const candidate = mkLesson("tc", "Tiny candidate lesson", {
			body: [`top ${"c".repeat(400)}`, `${"d".repeat(400)}`, tail].join("\n"),
			selection: { id: "tc", revision: "rtc" },
		});
		const cases: Array<[number, number, InsightLesson, string, string]> = [
			[80, 8, longBodyLesson(), "Eligible: confirmed", TAIL],
			[40, 8, candidate, "Not eligible: status candidate", tail],
		];
		for (const [width, height, lesson, factPrefix, scrollTarget] of cases) {
			const ui = createInsightDashboard(snapshot({ lessons: [lesson] }), stubs(), { theme: {}, initialPanel: "moments", rows: () => height });
			ui.render(width);
			ui.handleInput("tab");
			ui.handleInput("enter");
			// The eligibility facts lead the scrolled surface, so a fresh detail
			// shows them first even at the shortest eligible viewport.
			const top = plain(ui.render(width)).join("\n");
			expect(top).toContain(factPrefix);
			expect(top).toMatch(/Details 1–\d+ of \d+ shown/);
			// The complete body, tail included, is reachable by scrolling while
			// the frame stays inside the short viewport.
			expect(scrollTo(scrollTarget, ui, width, "down")).toContain(scrollTarget);
			const rows = plain(ui.render(width));
			expect(rows.length).toBeLessThanOrEqual(height);
			for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
			ui.dispose();
		}
	});

	test("overview scrolls to lesson totals and teaching settings at 40x12", () => {
		const ui = createInsightDashboard(snapshot({ decisions: [] }), stubs(), { theme: {}, initialPanel: "overview", rows: () => 12 });
		const first = plain(ui.render(40));
		expect(first.length).toBeLessThanOrEqual(12);
		// Clipping alone would drop the totals and settings below the fold;
		// scrolling reaches each of them instead of losing them irretrievably.
		expect(scrollTo("candidate: 1", ui, 40, "down")).toContain("candidate: 1");
		expect(scrollTo("Skills: 1 eligible", ui, 40, "down")).toContain("Skills: 1 eligible");
		const settings = scrollTo("Capture:", ui, 40, "down");
		expect(settings).toContain("Capture:");
		expect(settings).toMatch(/Overview \d+–\d+ of \d+ shown/);
		const rows = plain(ui.render(40));
		expect(rows.length).toBeLessThanOrEqual(12);
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
		ui.dispose();
	});

	test("skills panel shares one scroll budget between policy prefix and lesson list", () => {
		// Tiny viewport: the policy prefix and the list fit one shared budget —
		// the panel never overflows and at least one lesson row stays reachable.
		const tiny = createInsightDashboard(snapshot(), stubs(), { theme: {}, initialPanel: "skills", rows: () => 8 });
		const tinyRows = plain(tiny.render(24));
		expect(tinyRows.length).toBeLessThanOrEqual(8);
		for (const row of tinyRows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(24);
		expect(tinyRows.join("\n")).toContain("Second");
		expect(tinyRows.join("\n")).toContain("1 record shown");
		tiny.dispose();
		// Roomier viewport: the full policy prefix, the lesson, and the count
		// line are all on screen within the shared budget.
		const roomy = createInsightDashboard(snapshot(), stubs(), { theme: {}, initialPanel: "skills", rows: () => 20 });
		const roomyRows = plain(roomy.render(40));
		expect(roomyRows.length).toBeLessThanOrEqual(20);
		const roomyText = roomyRows.join("\n");
		expect(roomyText).toContain("Capture:");
		expect(roomyText).toContain("Second");
		expect(roomyText).toContain("1 record shown");
		roomy.dispose();
		// Empty collection: the why-empty message is reachable under the same
		// shared budget instead of being clipped away by the policy prefix.
		const empty = createInsightDashboard(snapshot({ lessons: [], eligible: 0 }), stubs(), { theme: {}, initialPanel: "skills", rows: () => 8 });
		const emptyRows = plain(empty.render(24));
		expect(emptyRows.length).toBeLessThanOrEqual(8);
		expect(emptyRows.join("\n")).toContain("No lessons meet the");
		empty.dispose();
	});

	test("an affirmative cannot fire when its identity does not fit", async () => {
		const cb = stubs();
		const longId = `l-${"x".repeat(300)}`;
		let height = 12;
		const ui = createInsightDashboard(
			snapshot({ lessons: [mkLesson(longId, "A very long candidate title that wraps across many terminal rows", { selection: { id: longId, revision: "r" } })] }),
			cb,
			{ theme: {}, initialPanel: "moments", rows: () => height },
		);
		ui.render(40);
		ui.handleInput("tab");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("right");
		ui.handleInput("enter");
		// The refusal names the withheld action instead of clipping identity,
		// and the layout stays within the viewport.
		let rows = plain(ui.render(40));
		expect(rows.length).toBeLessThanOrEqual(12);
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
		expect(rows.join("\n")).not.toContain(longId);
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
		await flush();
		expect(cb.calls).not.toContain("confirm");
		// Even shorter: the strip-level refusal survives while staying bounded.
		height = 8;
		rows = plain(ui.render(40));
		expect(rows.length).toBeLessThanOrEqual(8);
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
		await flush();
		expect(cb.calls).not.toContain("confirm");
		ui.dispose();
	});

	test("resize clamps scroll and selection without changing data or permission", () => {
		let height = 40;
		const ui = createInsightDashboard(snapshot({ lessons: [longBodyLesson()] }), stubs(), { theme: {}, initialPanel: "moments", rows: () => height });
		openDetail(ui);
		for (let i = 0; i < 30; i += 1) ui.handleInput("down");
		height = 10;
		const rows = plain(ui.render(80));
		expect(rows.length).toBeLessThanOrEqual(10);
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(80);
		// The same lesson identity remains reachable after shrinking.
		const top = scrollTo("Long body lesson", ui, 80, "up");
		expect(top).toContain("Long body lesson");
		const bottom = scrollTo(TAIL, ui, 80, "down");
		expect(bottom).toContain(TAIL);
		// The eligible lesson keeps its named preview action after resize.
		ui.handleInput("tab");
		expect(plain(ui.render(80)).join("\n")).toContain("Preview skill draft");
		ui.dispose();
	});

	test("a notice shares a low viewport with windowed content", async () => {
		const cb = stubs({
			previewSkill: async () => {
				cb.calls.push("preview");
				return { status: "error", message: "draft too large" };
			},
		});
		const height = 12;
		const ui = createInsightDashboard(snapshot({ lessons: [longBodyLesson()] }), cb, { theme: {}, initialPanel: "moments", rows: () => height });
		openDetail(ui);
		ui.handleInput("tab");
		ui.handleInput("right");
		ui.handleInput("enter");
		await flush();
		await flush();
		// The failed preview leaves its notice beside windowed details.
		let rows = plain(ui.render(80));
		expect(rows.length).toBeLessThanOrEqual(height);
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(80);
		// Reach the details viewport, then scroll the tail back into view.
		ui.handleInput("tab");
		ui.handleInput("tab");
		const text = scrollTo(TAIL, ui, 80, "down");
		expect(text).toContain(TAIL);
		rows = plain(ui.render(80));
		expect(rows.length).toBeLessThanOrEqual(height);
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(80);
		ui.dispose();
	});

	test("a settled receipt shares a low viewport with its follow-up refresh", async () => {
		const RECEIPT = "Candidate confirmed receipt-low.";
		const pending: Array<(next: InsightSnapshot) => void> = [];
		const cb = stubs({
			confirmCandidate: async () => {
				cb.calls.push("confirm");
				return { status: "ok", message: RECEIPT, retention: "retained" as const };
			},
			refresh: () => {
				cb.calls.push("refresh");
				return new Promise<InsightSnapshot>((resolve) => {
					pending.push(resolve);
				});
			},
		});
		const height = 12;
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments", rows: () => height });
		ui.render(80);
		ui.handleInput("tab");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
		// Busy refresh plus receipt stay bounded and visible together.
		let rows = plain(ui.render(80));
		expect(rows.length).toBeLessThanOrEqual(height);
		expect(rows.join("\n")).toContain(RECEIPT);
		expect(rows.join("\n")).toMatch(/Refreshing local snapshot/);
		pending.shift()?.(snapshot());
		await flush();
		await flush();
		rows = plain(ui.render(80));
		expect(rows.length).toBeLessThanOrEqual(height);
		expect(rows.join("\n")).toContain(RECEIPT);
		ui.dispose();
	});
});

describe("dashboard source fidelity and partial truth", () => {
	function openFirstDetail(ui: InsightDashboard): void {
		ui.render(80);
		ui.handleInput("tab");
		ui.handleInput("enter");
	}

	test("lesson body keeps indentation and repeated spaces through reflow and scrolling", () => {
		const tail = "whitespace-tail-marker";
		const lesson = mkLesson("ws", "Whitespace lesson", {
			status: "confirmed",
			kind: "pattern",
			occurrences: 5,
			eligible: true,
			body: ["def check():", '    return "a  b"', "", "      nested: true", `${"filler ".repeat(120)}`, tail].join("\n"),
			selection: { id: "ws", revision: "rws" },
		});
		const ui = createInsightDashboard(snapshot({ lessons: [lesson] }), stubs(), { theme: {}, initialPanel: "moments", rows: () => 40 });
		openFirstDetail(ui);
		let text = plain(ui.render(40)).join("\n");
		expect(text).toContain('    return "a  b"');
		expect(text).toContain("      nested: true");
		ui.dispose();
		// Narrow reflow preserves leading spaces instead of folding them away.
		const narrow = createInsightDashboard(snapshot({ lessons: [lesson] }), stubs(), { theme: {}, initialPanel: "moments", rows: () => 40 });
		openFirstDetail(narrow);
		text = plain(narrow.render(24)).join("\n");
		expect(text).toContain("      nested: true");
		narrow.dispose();
		// The in-bound tail stays reachable by scrolling within bounds.
		const height = 12;
		const scrolled = createInsightDashboard(snapshot({ lessons: [lesson] }), stubs(), { theme: {}, initialPanel: "moments", rows: () => height });
		openFirstDetail(scrolled);
		let rendered = plain(scrolled.render(40)).join("\n");
		for (let i = 0; i < 200 && !rendered.includes(tail); i += 1) {
			scrolled.handleInput("down");
			rendered = plain(scrolled.render(40)).join("\n");
		}
		expect(rendered).toContain(tail);
		const tailRows = plain(scrolled.render(40));
		expect(tailRows.length).toBeLessThanOrEqual(height);
		for (const row of tailRows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
		scrolled.dispose();
	});

	test("preview draft keeps source indentation instead of folding lines into labels", async () => {
		const content = ["---", "name: indented-draft", '  setting: "a  b"', "    deeper: true", "ownership: generated-by-ultrathink"].join("\n");
		const cb = stubs({
			previewSkill: async () => {
				cb.calls.push("preview");
				return { status: "ok", message: "ready", preview: { selection: { id: "l2", revision: "r2" }, fingerprint: "f", name: "draft", description: "d", content, warnings: [] } };
			},
		});
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments", rows: () => 40 });
		ui.render(80);
		ui.handleInput("tab");
		ui.handleInput("down");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		await flush();
		const text = plain(ui.render(80)).join("\n");
		expect(text).toMatch(/Preview only/);
		expect(text).toContain('  setting: "a  b"');
		expect(text).toContain("    deeper: true");
		ui.dispose();
	});

	test("partial snapshots qualify every panel list, count, and selected details", () => {
		const partial = snapshot({ partial: true, limitations: ["scan capped at 500 files"] });
		for (const panel of ["jev", "moments", "skills"] as const) {
			const ui = createInsightDashboard(partial, stubs(), { theme: {}, initialPanel: panel, rows: () => 40 });
			const browse = plain(ui.render(80)).join("\n");
			expect(browse).toMatch(/Partial snapshot/);
			expect(browse).toMatch(/partial/);
			ui.handleInput("tab");
			ui.handleInput("enter");
			const detail = plain(ui.render(80)).join("\n");
			// Empty-or-not, the directly opened record carries the qualifier.
			if (!detail.includes("No saved Jev decisions") && !detail.includes("No lessons")) {
				expect(detail).toMatch(/Partial snapshot/);
			}
			ui.dispose();
		}
	});

	test("long bounded provenance wraps complete instead of a narrower recap", () => {
		const phase = "p".repeat(300);
		const artifact = "a".repeat(200);
		const related = "r".repeat(80);
		const dest = "s".repeat(300);
		const lesson = mkLesson("lp", "Long provenance lesson", {
			status: "promoted",
			sourcePhase: phase,
			sourceArtifacts: [artifact],
			relatedIds: [related],
			promoted: { at: "2026-01-05T00:00:00Z", skill: "long-lesson", target: "omp", path: dest },
			selection: { id: "lp", revision: "rlp" },
		});
		const ui = createInsightDashboard(snapshot({ lessons: [lesson] }), stubs(), { theme: {}, initialPanel: "moments", rows: () => 40 });
		ui.render(80);
		ui.handleInput("tab");
		ui.handleInput("enter");
		const views = [plain(ui.render(80)).join("")];
		for (let page = 0; page < 3; page += 1) {
			ui.handleInput("pagedown");
			views.push(plain(ui.render(80)).join(""));
		}
		for (const value of [phase, artifact, related, dest]) {
			expect(views.some((text) => text.includes(value))).toBe(true);
		}
		ui.dispose();
	});
});

describe("dashboard policy-off and layout guidance", () => {
	test("known teaching-off disables confirm, preview, and install without dispatching", async () => {
		const off = snapshot({ policy: { ...snapshot().policy, enabled: false } });
		const cb = stubs();
		const ui = createInsightDashboard(off, cb, { theme: {}, initialPanel: "moments", rows: () => 40 });
		ui.render(80);
		ui.handleInput("tab");
		ui.handleInput("enter");
		let text = plain(ui.render(80)).join("\n");
		expect(text).toMatch(/Teaching is off/);
		// The candidate strip offers confirmation only as unavailable; firing
		// it explains instead of dispatching.
		ui.handleInput("tab");
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
		await flush();
		expect(cb.calls).not.toContain("confirm");
		expect(plain(ui.render(80)).join("\n")).toMatch(/Teaching is off/);
		ui.dispose();
		// The eligible lesson offers preview only as unavailable; firing it
		// explains instead of dispatching.
		const previewUi = createInsightDashboard(off, cb, { theme: {}, initialPanel: "moments", rows: () => 40 });
		previewUi.render(80);
		previewUi.handleInput("tab");
		previewUi.handleInput("down");
		previewUi.handleInput("enter");
		expect(plain(previewUi.render(80)).join("\n")).toMatch(/Teaching is off/);
		previewUi.handleInput("tab");
		previewUi.handleInput("tab");
		previewUi.handleInput("enter");
		await flush();
		await flush();
		expect(cb.calls).not.toContain("preview");
		previewUi.dispose();
	});

	test("growing the viewport clears stale fit guidance but keeps durable receipts", async () => {
		const longId = `l-${"x".repeat(300)}`;
		let height = 12;
		const cb = stubs();
		const ui = createInsightDashboard(
			snapshot({ lessons: [mkLesson(longId, "A very long candidate title that wraps across many terminal rows", { selection: { id: longId, revision: "r" } })] }),
			cb,
			{ theme: {}, initialPanel: "moments", rows: () => height },
		);
		ui.render(40);
		ui.handleInput("tab");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("right");
		ui.handleInput("enter");
		expect(plain(ui.render(40)).join("\n")).toMatch(/does not fit/);
		// Firing the withheld affirmative records only transient guidance.
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
		expect(cb.calls).not.toContain("confirm");
		expect(plain(ui.render(40)).join("\n")).toMatch(/does not fit/);
		// Growing restores the complete identity and clears the stale refusal.
		height = 40;
		const grown = plain(ui.render(40)).join("\n");
		expect(grown).toContain("Confirm this candidate?");
		expect(grown).not.toMatch(/does not fit/);
		ui.dispose();
		// A durable settled receipt survives the same growth.
		const RECEIPT = "Candidate confirmed receipt-growth.";
		let currentHeight = 12;
		const receiptCb = stubs({
			confirmCandidate: async () => {
				receiptCb.calls.push("confirm");
				return { status: "ok", message: RECEIPT, retention: "retained" as const };
			},
		});
		const receiptUi = createInsightDashboard(snapshot(), receiptCb, { theme: {}, initialPanel: "moments", rows: () => currentHeight });
		receiptUi.render(80);
		receiptUi.handleInput("tab");
		receiptUi.handleInput("enter");
		receiptUi.handleInput("tab");
		receiptUi.handleInput("tab");
		receiptUi.handleInput("enter");
		await flush();
		receiptUi.handleInput("down");
		receiptUi.handleInput("enter");
		await flush();
		await flush();
		expect(plain(receiptUi.render(80)).join("\n")).toContain(RECEIPT);
		currentHeight = 40;
		expect(plain(receiptUi.render(80)).join("\n")).toContain(RECEIPT);
		receiptUi.dispose();
	});

	test("unknown height uses the bounded content fallback with a width-based mutation guard", () => {
		const ui = createInsightDashboard(snapshot(), stubs(), { theme: {}, initialPanel: "moments" });
		const rows = plain(ui.render(80));
		expect(rows.length).toBeLessThanOrEqual(2 + 12 + 8);
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(80);
		// Mutation stays available by width: the confirmation opens complete.
		ui.handleInput("tab");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
		expect(plain(ui.render(80)).join("\n")).toContain("Confirm this candidate?");
		ui.dispose();
		// Missing, invalid, and throwing heights fall back the same way.
		const fallbacks: Array<() => number | undefined> = [() => undefined, () => Number.NaN, () => { throw new Error("rows unavailable"); }];
		for (const rowsOf of fallbacks) {
			const fallback = createInsightDashboard(snapshot(), stubs(), { theme: {}, initialPanel: "moments", rows: rowsOf });
			const fallbackRows = plain(fallback.render(80));
			expect(fallbackRows.length).toBeLessThanOrEqual(2 + 12 + 8);
			fallback.dispose();
		}
	});
});

describe("dashboard skills collections and preview navigation", () => {
	test("skills labels eligible-empty and promoted-empty independently, including mixed collections", () => {
		// Fully empty: both absence states are labeled.
		const empty = createInsightDashboard(snapshot({ lessons: [], eligible: 0, promoted: 0 }), stubs(), { theme: {}, initialPanel: "skills", rows: () => 40 });
		const emptyText = plain(empty.render(80)).join("\n");
		expect(emptyText).toContain("No lessons meet the promotion rules");
		expect(emptyText).toContain("No promotions recorded for this project");
		empty.dispose();
		// Eligible-only: subset counts plus the promoted-empty state.
		const eligibleOnly = createInsightDashboard(snapshot(), stubs(), { theme: {}, initialPanel: "skills", rows: () => 40 });
		const eligibleText = plain(eligibleOnly.render(80)).join("\n");
		expect(eligibleText).toContain("Eligible: 1 shown");
		expect(eligibleText).toContain("Promoted: 0 shown");
		expect(eligibleText).toContain("No promotions recorded for this project");
		eligibleOnly.dispose();
		// Promoted-only: subset counts plus the eligible-empty state.
		const promoted = mkLesson("sp", "Promoted lesson", {
			status: "promoted",
			promoted: { at: "2026-01-05T00:00:00Z", skill: "promoted-lesson", target: "omp" },
			selection: { id: "sp", revision: "rsp" },
		});
		const promotedOnly = createInsightDashboard(snapshot({ lessons: [promoted], eligible: 0, promoted: 1 }), stubs(), { theme: {}, initialPanel: "skills", rows: () => 40 });
		const promotedText = plain(promotedOnly.render(80)).join("\n");
		expect(promotedText).toContain("Eligible: 0 shown");
		expect(promotedText).toContain("Promoted: 1 shown");
		expect(promotedText).toContain("No lessons meet the promotion rules");
		promotedOnly.dispose();
	});

	test("canonical refused results display once without added wrapping", async () => {
		const reason = "z".repeat(300);
		const message = `Installation refused: ${reason}. Existing files were not replaced by this refused install; review the lesson/slot outside this dashboard, then preview again.`;
		const cb = stubs({
			installPreview: async () => {
				cb.calls.push("install");
				return { status: "refused", message };
			},
		});
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments", rows: () => 40 });
		ui.render(80);
		ui.handleInput("tab");
		ui.handleInput("down");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		await flush();
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		ui.handleInput("down");
		ui.handleInput("enter");
		await flush();
		await flush();
		const text = plain(ui.render(80)).join("\n");
		expect(cb.calls).toContain("install");
		// The complete canonical reason survives (never re-capped) and the
		// prefix appears exactly once (never wrapped again).
		expect(text.replaceAll("\n", "")).toContain(reason);
		expect(text.split("Installation refused").length - 1).toBe(1);
		ui.dispose();
	});

	test("preview Back returns to lesson details and Tab stays in viewport and actions", async () => {
		const cb = stubs();
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments", rows: () => 40 });
		ui.render(80);
		ui.handleInput("tab");
		ui.handleInput("down");
		ui.handleInput("enter");
		ui.handleInput("tab");
		ui.handleInput("tab");
		ui.handleInput("enter");
		await flush();
		await flush();
		expect(plain(ui.render(80)).join("\n")).toMatch(/Preview only/);
		// Arrow keys never leave the preview for unrelated tabs.
		for (let i = 0; i < 6; i += 1) {
			ui.handleInput("tab");
			ui.handleInput("left");
			ui.handleInput("right");
		}
		let text = plain(ui.render(80)).join("\n");
		expect(text).toMatch(/Preview only/);
		expect(text).toContain("[Moments]");
		expect(text).toMatch(/back to lesson/);
		// Back returns to the exact selected lesson details, not the browse list.
		ui.handleInput("tab");
		ui.handleInput("left");
		ui.handleInput("enter");
		await flush();
		text = plain(ui.render(80)).join("\n");
		expect(text).not.toMatch(/Preview only/);
		expect(text).toContain("Second lesson");
		expect(text).toContain("l2");
		ui.dispose();
	});
});
