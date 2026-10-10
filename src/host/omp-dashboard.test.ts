// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { createInsightDashboard, type InsightDashboard, type InsightDashboardCallbacks } from "./omp-dashboard.ts";
import type { InsightLesson, InsightSnapshot } from "./omp-insights.ts";

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
	test("tabs render in contract order with the first tab active", () => {
		const ui = createInsightDashboard(snapshot(), stubs(), { theme: {}, initialPanel: "overview" });
		const text = plain(ui.render(80)).join("\n");
		const order = [text.indexOf("Overview"), text.indexOf("Jev"), text.indexOf("Moments"), text.indexOf("Skills")];
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(text).toContain("[Overview]");
		ui.dispose();
	});

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

	test("narrow terminals show position instead of the strip", () => {
		const ui = createInsightDashboard(snapshot(), stubs(), { theme: {}, initialPanel: "jev" });
		const text = plain(ui.render(24)).join("\n");
		expect(text).toMatch(/\[Jev\] 2\/4/);
		expect(text).not.toContain("[Overview]");
		ui.dispose();
	});

	test("tiny viewports refuse mutation while browsing and escape stay live", () => {
		const cb = stubs();
		const ui = createInsightDashboard(snapshot(), cb, { theme: {}, initialPanel: "moments", rows: () => 30 });
		const text = plain(ui.render(20)).join("\n");
		expect(text).toMatch(/resize/i);
		ui.handleInput("tab");
		ui.handleInput("down");
		ui.handleInput("enter");
		const detail = plain(ui.render(20)).join("\n");
		expect(detail).toContain("l1");
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
	async function openCandidateConfirm(): Promise<{ ui: InsightDashboard; cb: RecordingCallbacks }> {
		const cb = stubs();
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
		ui.handleInput("enter");
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
		ui.handleInput("enter");
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
