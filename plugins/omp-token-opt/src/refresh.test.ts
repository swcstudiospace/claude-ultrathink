import { describe, expect, test } from "bun:test";
import { createTrailingRefresh } from "./refresh.ts";

/** A manual clock: timers run only when the test advances time. */
function harness(minMs: number, readMs = 0) {
	let now = 1_000_000;
	const timers: { at: number; run: () => void; id: number }[] = [];
	let nextId = 1;
	const reads: number[] = [];
	const pendingReads: (() => void)[] = [];
	const refresh = createTrailingRefresh(
		() => {
			reads.push(now);
			if (readMs === 0) return Promise.resolve();
			return new Promise<void>((resolve) => pendingReads.push(resolve));
		},
		minMs,
		{
			now: () => now,
			setTimer: (run, ms) => {
				const id = nextId++;
				timers.push({ at: now + ms, run, id });
				return () => {
					const at = timers.findIndex((timer) => timer.id === id);
					if (at >= 0) timers.splice(at, 1);
				};
			},
		},
	);
	async function advance(ms: number): Promise<void> {
		const target = now + ms;
		for (;;) {
			const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			timers.splice(timers.indexOf(due), 1);
			now = Math.max(now, due.at);
			due.run();
			await Promise.resolve();
			await Promise.resolve();
		}
		now = target;
	}
	return { refresh, reads, advance, timers, finishRead: () => pendingReads.shift()?.() };
}

describe("createTrailingRefresh", () => {
	test("the first call reads at once", async () => {
		const h = harness(5_000);
		await h.refresh();
		expect(h.reads).toHaveLength(1);
		expect(h.timers).toHaveLength(0);
	});

	test("a call inside the window is skipped and one trailing read runs when the window ends", async () => {
		const h = harness(5_000);
		await h.refresh();
		await h.advance(1_000);
		await h.refresh();
		await h.refresh();
		expect(h.reads).toHaveLength(1);
		expect(h.timers).toHaveLength(1);
		await h.advance(3_999);
		expect(h.reads).toHaveLength(1);
		await h.advance(1);
		expect(h.reads).toHaveLength(2);
		expect(h.timers).toHaveLength(0);
	});

	test("no trailing read when nothing was skipped", async () => {
		const h = harness(5_000);
		await h.refresh();
		await h.advance(60_000);
		expect(h.reads).toHaveLength(1);
	});

	test("a call after the window starts a new read and cancels a pending trailing one", async () => {
		const h = harness(5_000);
		await h.refresh();
		await h.advance(1_000);
		await h.refresh();
		expect(h.timers).toHaveLength(1);
		await h.advance(4_500);
		await h.refresh();
		await h.advance(10_000);
		expect(h.reads.length).toBeLessThanOrEqual(3);
		expect(h.reads.length).toBeGreaterThanOrEqual(2);
		expect(h.timers).toHaveLength(0);
	});

	test("a call while a read is in flight shares it and schedules one trailing read after it", async () => {
		const h = harness(5_000, 1);
		const first = h.refresh();
		const second = h.refresh();
		expect(h.reads).toHaveLength(1);
		h.finishRead();
		await Promise.all([first, second]);
		expect(h.timers).toHaveLength(1);
		await h.advance(5_000);
		expect(h.reads).toHaveLength(2);
		h.finishRead();
		await h.advance(60_000);
		expect(h.reads).toHaveLength(2);
	});

	test("force reads now inside the window", async () => {
		const h = harness(5_000);
		await h.refresh();
		await h.refresh(true);
		expect(h.reads).toHaveLength(2);
	});

	test("a failing read does not stop later reads", async () => {
		let calls = 0;
		const refresh = createTrailingRefresh(
			() => {
				calls++;
				return Promise.reject(new Error("rtk missing"));
			},
			0,
		);
		await refresh();
		await refresh();
		expect(calls).toBe(2);
	});
});
