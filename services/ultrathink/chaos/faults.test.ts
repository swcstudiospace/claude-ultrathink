// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OpenRouterCallInfo, type OpenRouterCompleterOptions, OpenRouterError, type OpenRouterFetch, createOpenRouterCompleter } from "../engine/openrouter.ts";
import { createFaultyFetch, type FaultPlan, type FaultStep, loadChaosFetch, parseFaultPlan } from "./faults.ts";

const BODY = "INNER-BODY-MARK";
const KEY = "sk-or-test-SECRETKEY-0123456789";

interface Recorded {
	fetch: OpenRouterFetch;
	calls: Array<{ input: string; init: RequestInit }>;
}

/** An inner fetch that records calls and answers 200 with a fixed body. */
function recordingInner(body: string = BODY): Recorded {
	const calls: Recorded["calls"] = [];
	return {
		calls,
		fetch: async (input, init) => {
			calls.push({ input, init });
			return new Response(body, { status: 200 });
		},
	};
}

/** A chat completion body with content "ok", for the completer tests. */
const COMPLETION_BODY = JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] });

function plan(...steps: FaultStep[]): FaultPlan {
	return { steps };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

function parseErrorOf(json: unknown): unknown {
	try {
		parseFaultPlan(json);
	} catch (error) {
		return error;
	}
	throw new Error("expected parseFaultPlan to throw");
}

function completerWith(fetch: OpenRouterFetch, overrides: Partial<OpenRouterCompleterOptions> = {}) {
	const sleeps: number[] = [];
	const calls: OpenRouterCallInfo[] = [];
	const complete = createOpenRouterCompleter({
		apiKey: KEY,
		baseUrl: "https://router.example.test/api/v1",
		model: "x-ai/test-model",
		maxOutputTokens: 16,
		timeoutMs: 5000,
		fetch,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		onCall: (info) => {
			calls.push(info);
		},
		...overrides,
	});
	return { complete, sleeps, calls };
}

describe("createFaultyFetch step sequencing", () => {
	test("status 503 x2 then pass gives two 503 responses, then the inner response; inner is called once", async () => {
		const inner = recordingInner();
		const faulty = createFaultyFetch(
			plan({ count: 2, fault: { kind: "status", status: 503 } }, { count: 1, fault: { kind: "pass" } }),
			inner.fetch,
		);
		const first = await faulty("https://upstream.test/v1", {});
		const second = await faulty("https://upstream.test/v1", {});
		const third = await faulty("https://upstream.test/v1", {});
		expect(first.status).toBe(503);
		expect(second.status).toBe(503);
		expect(third.status).toBe(200);
		expect(await third.text()).toBe(BODY);
		expect(inner.calls).toHaveLength(1);
	});

	test("exhausted plans pass through to the inner fetch", async () => {
		const inner = recordingInner();
		const faulty = createFaultyFetch(plan({ count: 1, fault: { kind: "status", status: 500 } }), inner.fetch);
		expect((await faulty("u", {})).status).toBe(500);
		expect(await (await faulty("u", {})).text()).toBe(BODY);
		expect(await (await faulty("u", {})).text()).toBe(BODY);
		expect(inner.calls).toHaveLength(2);
	});

	test("a forever step never advances and never reaches the inner fetch", async () => {
		const inner = recordingInner();
		const faulty = createFaultyFetch(plan({ count: "forever", fault: { kind: "status", status: 502 } }), inner.fetch);
		for (let call = 0; call < 5; call += 1) {
			expect((await faulty("u", {})).status).toBe(502);
		}
		expect(inner.calls).toHaveLength(0);
	});

	test("steps advance across fault kinds in order", async () => {
		const inner = recordingInner();
		const faulty = createFaultyFetch(
			plan(
				{ count: 1, fault: { kind: "status", status: 503 } },
				{ count: 1, fault: { kind: "reset" } },
				{ count: 1, fault: { kind: "pass" } },
			),
			inner.fetch,
		);
		expect((await faulty("u", {})).status).toBe(503);
		expect(await rejectionOf(faulty("u", {}))).toBeInstanceOf(TypeError);
		expect(await (await faulty("u", {})).text()).toBe(BODY);
		expect(inner.calls).toHaveLength(1);
	});

	test("concurrent calls consume units in call order", async () => {
		const inner = recordingInner();
		const faulty = createFaultyFetch(plan({ count: 1, fault: { kind: "status", status: 503 } }), inner.fetch);
		const first = faulty("u", {});
		const second = faulty("u", {});
		expect((await first).status).toBe(503);
		expect(await (await second).text()).toBe(BODY);
	});

	test("the caller's plan object is copied, so later mutation has no effect", async () => {
		const inner = recordingInner();
		const steps: FaultStep[] = [{ count: 1, fault: { kind: "status", status: 500 } }];
		const faulty = createFaultyFetch({ steps }, inner.fetch);
		steps.push({ count: "forever", fault: { kind: "status", status: 599 } });
		expect((await faulty("u", {})).status).toBe(500);
		expect(await (await faulty("u", {})).text()).toBe(BODY);
	});
});

describe("createFaultyFetch fault kinds", () => {
	test("status with retryAfterSec sets Retry-After and returns the injected body", async () => {
		const inner = recordingInner();
		const faulty = createFaultyFetch(plan({ count: 1, fault: { kind: "status", status: 429, retryAfterSec: 3 } }), inner.fetch);
		const response = await faulty("u", {});
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("3");
		expect(await response.text()).toBe('{"error":"injected"}');
		expect(inner.calls).toHaveLength(0);
	});

	test("status without retryAfterSec sets no Retry-After header", async () => {
		const faulty = createFaultyFetch(plan({ count: 1, fault: { kind: "status", status: 503 } }), recordingInner().fetch);
		expect((await faulty("u", {})).headers.get("retry-after")).toBeNull();
	});

	test("reset rejects with a TypeError and does not call the inner fetch", async () => {
		const inner = recordingInner();
		const faulty = createFaultyFetch(plan({ count: 1, fault: { kind: "reset" } }), inner.fetch);
		const error = await rejectionOf(faulty("u", {}));
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toBe("fetch failed: injected reset");
		expect(inner.calls).toHaveLength(0);
	});

	test("blackhole without init.signal rejects at once and does not call the inner fetch", async () => {
		const inner = recordingInner();
		const faulty = createFaultyFetch(plan({ count: 1, fault: { kind: "blackhole" } }), inner.fetch);
		const error = await rejectionOf(faulty("u", {}));
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("init.signal");
		expect(inner.calls).toHaveLength(0);
	});

	test("blackhole rejects with AbortError when the caller's signal aborts", async () => {
		const inner = recordingInner();
		const faulty = createFaultyFetch(plan({ count: 1, fault: { kind: "blackhole" } }), inner.fetch);
		const controller = new AbortController();
		const pending = faulty("u", { signal: controller.signal });
		controller.abort();
		const error = await rejectionOf(pending);
		expect(error).toBeInstanceOf(DOMException);
		expect((error as DOMException).name).toBe("AbortError");
		expect(inner.calls).toHaveLength(0);
	});

	test("blackhole with an already-aborted signal rejects with AbortError", async () => {
		const faulty = createFaultyFetch(plan({ count: 1, fault: { kind: "blackhole" } }), recordingInner().fetch);
		const controller = new AbortController();
		controller.abort();
		const error = await rejectionOf(faulty("u", { signal: controller.signal }));
		expect((error as DOMException).name).toBe("AbortError");
	});

	test("latency waits through the injected sleep with the fault's ms and then forwards to the inner fetch", async () => {
		const inner = recordingInner();
		const sleeps: Array<{ ms: number; signal: AbortSignal | undefined }> = [];
		const faulty = createFaultyFetch(
			plan({ count: 1, fault: { kind: "latency", ms: 250 } }),
			inner.fetch,
			async (ms, signal) => {
				sleeps.push({ ms, signal });
			},
		);
		const controller = new AbortController();
		const response = await faulty("u", { signal: controller.signal });
		expect(await response.text()).toBe(BODY);
		expect(sleeps).toEqual([{ ms: 250, signal: controller.signal }]);
		expect(inner.calls).toHaveLength(1);
	});

	test("latency aborted by the caller rejects with AbortError and does not call the inner fetch", async () => {
		const inner = recordingInner();
		// Resolves only when the signal aborts, so the test never waits on wall-clock time.
		const untilSignal = async (_ms: number, signal?: AbortSignal): Promise<void> => {
			const { promise, resolve } = Promise.withResolvers<void>();
			signal?.addEventListener("abort", () => resolve(), { once: true });
			await promise;
		};
		const faulty = createFaultyFetch(plan({ count: 1, fault: { kind: "latency", ms: 60_000 } }), inner.fetch, untilSignal);
		const controller = new AbortController();
		const pending = faulty("u", { signal: controller.signal });
		controller.abort();
		const error = await rejectionOf(pending);
		expect((error as DOMException).name).toBe("AbortError");
		expect(inner.calls).toHaveLength(0);
	});

	test("latency with an already-aborted signal rejects with AbortError without calling the inner fetch", async () => {
		const inner = recordingInner();
		const faulty = createFaultyFetch(plan({ count: 1, fault: { kind: "latency", ms: 0 } }), inner.fetch, async () => undefined);
		const controller = new AbortController();
		controller.abort();
		const error = await rejectionOf(faulty("u", { signal: controller.signal }));
		expect((error as DOMException).name).toBe("AbortError");
		expect(inner.calls).toHaveLength(0);
	});
});

describe("parseFaultPlan", () => {
	test("accepts the documented example", () => {
		const parsed = parseFaultPlan({ steps: [{ count: 3, fault: { kind: "status", status: 503 } }] });
		expect(parsed).toEqual({ steps: [{ count: 3, fault: { kind: "status", status: 503 } }] });
	});

	test("accepts every fault kind and the range boundaries", () => {
		const parsed = parseFaultPlan({
			steps: [
				{ count: 1, fault: { kind: "pass" } },
				{ count: 1, fault: { kind: "status", status: 400, retryAfterSec: 0 } },
				{ count: 1, fault: { kind: "status", status: 599, retryAfterSec: 20 } },
				{ count: 1, fault: { kind: "reset" } },
				{ count: 1, fault: { kind: "blackhole" } },
				{ count: 1, fault: { kind: "latency", ms: 0 } },
				{ count: Number.MAX_SAFE_INTEGER, fault: { kind: "latency", ms: 60000 } },
				{ count: "forever", fault: { kind: "pass" } },
			],
		});
		expect(parsed.steps).toHaveLength(8);
		expect(parsed.steps[7]).toEqual({ count: "forever", fault: { kind: "pass" } });
	});

	test("returns a fresh plan rather than the caller's object", () => {
		const input = { steps: [{ count: 1, fault: { kind: "reset" } }] };
		const parsed = parseFaultPlan(input);
		expect(parsed).not.toBe(input);
		expect(parsed.steps[0]).not.toBe(input.steps[0]);
	});

	const invalid: Array<{ label: string; json: unknown; error: new (message?: string) => Error; path: string }> = [
		{ label: "empty steps", json: { steps: [] }, error: RangeError, path: "steps" },
		{ label: "more than 100 steps", json: { steps: Array.from({ length: 101 }, () => ({ count: 1, fault: { kind: "pass" } })) }, error: RangeError, path: "steps" },
		{ label: "count 0", json: { steps: [{ count: 0, fault: { kind: "pass" } }] }, error: RangeError, path: "steps[0].count" },
		{ label: "count 1.5", json: { steps: [{ count: 1.5, fault: { kind: "pass" } }] }, error: TypeError, path: "steps[0].count" },
		{ label: "count above the safe integer range", json: { steps: [{ count: 2 ** 60, fault: { kind: "pass" } }] }, error: RangeError, path: "steps[0].count" },
		{ label: "count as a string other than forever", json: { steps: [{ count: "3", fault: { kind: "pass" } }] }, error: TypeError, path: "steps[0].count" },
		{
			label: "forever before the last step",
			json: { steps: [{ count: "forever", fault: { kind: "pass" } }, { count: 1, fault: { kind: "pass" } }] },
			error: RangeError,
			path: "steps[0].count",
		},
		{ label: "status 200", json: { steps: [{ count: 1, fault: { kind: "status", status: 200 } }] }, error: RangeError, path: "steps[0].fault.status" },
		{ label: "status 600", json: { steps: [{ count: 1, fault: { kind: "status", status: 600 } }] }, error: RangeError, path: "steps[0].fault.status" },
		{ label: "status 503.5", json: { steps: [{ count: 1, fault: { kind: "status", status: 503.5 } }] }, error: TypeError, path: "steps[0].fault.status" },
		{ label: "status missing", json: { steps: [{ count: 1, fault: { kind: "status" } }] }, error: TypeError, path: "steps[0].fault.status" },
		{
			label: "retryAfterSec 21",
			json: { steps: [{ count: 1, fault: { kind: "status", status: 429, retryAfterSec: 21 } }] },
			error: RangeError,
			path: "steps[0].fault.retryAfterSec",
		},
		{
			label: "retryAfterSec as a string",
			json: { steps: [{ count: 1, fault: { kind: "status", status: 429, retryAfterSec: "1" } }] },
			error: TypeError,
			path: "steps[0].fault.retryAfterSec",
		},
		{ label: "latency ms -1", json: { steps: [{ count: 1, fault: { kind: "latency", ms: -1 } }] }, error: RangeError, path: "steps[0].fault.ms" },
		{ label: "latency ms above 60000", json: { steps: [{ count: 1, fault: { kind: "latency", ms: 60001 } }] }, error: RangeError, path: "steps[0].fault.ms" },
		{ label: "latency ms missing", json: { steps: [{ count: 1, fault: { kind: "latency" } }] }, error: TypeError, path: "steps[0].fault.ms" },
		{ label: "unknown fault kind", json: { steps: [{ count: 1, fault: { kind: "explode" } }] }, error: TypeError, path: "steps[0].fault.kind" },
		{ label: "fault without kind", json: { steps: [{ count: 1, fault: {} }] }, error: TypeError, path: "steps[0].fault.kind" },
		{ label: "unknown field on a fault", json: { steps: [{ count: 1, fault: { kind: "reset", status: 500 } }] }, error: TypeError, path: "steps[0].fault.status" },
		{ label: "unknown field on a step", json: { steps: [{ count: 1, fault: { kind: "pass" }, note: "x" }] }, error: TypeError, path: "steps[0].note" },
		{ label: "unknown field on the plan", json: { steps: [{ count: 1, fault: { kind: "pass" } }], extra: true }, error: TypeError, path: "plan.extra" },
		{ label: "steps not an array", json: { steps: { count: 1 } }, error: TypeError, path: "steps" },
		{ label: "steps missing", json: {}, error: TypeError, path: "steps" },
		{ label: "step not an object", json: { steps: [42] }, error: TypeError, path: "steps[0]" },
		{ label: "plan null", json: null, error: TypeError, path: "plan" },
		{ label: "plan an array", json: [], error: TypeError, path: "plan" },
		{ label: "plan a string", json: "steps", error: TypeError, path: "plan" },
	];

	for (const entry of invalid) {
		test(`rejects ${entry.label} and names ${entry.path}`, () => {
			const error = parseErrorOf(entry.json);
			expect(error).toBeInstanceOf(entry.error);
			expect((error as Error).message).toContain(entry.path);
		});
	}
});

describe("completer integration", () => {
	test("reset on every call is an upstream error with retry, exhausted after MAX_RETRIES", async () => {
		const inner = recordingInner();
		const faulty = createFaultyFetch(plan({ count: "forever", fault: { kind: "reset" } }), inner.fetch);
		const { complete, calls } = completerWith(faulty);
		const error = await rejectionOf(complete("system", "user"));
		expect(error).toBeInstanceOf(OpenRouterError);
		expect((error as OpenRouterError).code).toBe("upstream");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.outcome).toBe("upstream");
		expect(calls[0]?.attempts).toBe(3);
		expect(inner.calls).toHaveLength(0);
	});

	test("blackhole under a 20 ms completer timeout is a timeout with no retry", async () => {
		const faulty = createFaultyFetch(plan({ count: "forever", fault: { kind: "blackhole" } }), recordingInner().fetch);
		const { complete, calls } = completerWith(faulty, { timeoutMs: 20 });
		const error = await rejectionOf(complete("system", "user"));
		expect(error).toBeInstanceOf(OpenRouterError);
		expect((error as OpenRouterError).code).toBe("timeout");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.outcome).toBe("timeout");
		expect(calls[0]?.attempts).toBe(1);
	});

	test("a 429 with retryAfterSec 1 then pass: the completer sleeps 1000 ms before the second attempt", async () => {
		const faulty = createFaultyFetch(
			plan(
				{ count: 1, fault: { kind: "status", status: 429, retryAfterSec: 1 } },
				{ count: 1, fault: { kind: "pass" } },
			),
			recordingInner(COMPLETION_BODY).fetch,
		);
		const { complete, sleeps, calls } = completerWith(faulty);
		expect(await complete("system", "user")).toBe("ok");
		expect(sleeps).toEqual([1000]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.outcome).toBe("ok");
		expect(calls[0]?.attempts).toBe(2);
	});
});

describe("loadChaosFetch", () => {
	const unreadable = (): string => {
		throw new Error("must not read the plan");
	};

	test("returns undefined when chaosEnabled is not true, even with a path set", () => {
		expect(loadChaosFetch({ chaosEnabled: false, chaosPlanPath: "/plans/a.json" }, unreadable)).toBeUndefined();
		expect(loadChaosFetch({ chaosPlanPath: "/plans/a.json" }, unreadable)).toBeUndefined();
	});

	test("returns undefined when chaos is off and no path is set", () => {
		expect(loadChaosFetch({}, unreadable)).toBeUndefined();
	});

	test("throws when chaos is enabled without a plan path", () => {
		expect(() => loadChaosFetch({ chaosEnabled: true }, unreadable)).toThrow("no fault plan path");
	});

	describe("with a real temp directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "chaos-faults-"));
		afterAll(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		test("reads a valid plan file and returns a fetch that applies its first step", async () => {
			const path = join(dir, "valid.json");
			writeFileSync(path, JSON.stringify({ steps: [{ count: 1, fault: { kind: "status", status: 503 } }] }));
			const faulty = loadChaosFetch({ chaosEnabled: true, chaosPlanPath: path });
			expect(faulty).toBeFunction();
			const response = await faulty?.("https://unused.invalid/v1", {});
			expect(response?.status).toBe(503);
		});

		test("a missing file throws an Error naming the path and the reason", () => {
			const path = join(dir, "missing.json");
			let thrown: unknown;
			try {
				loadChaosFetch({ chaosEnabled: true, chaosPlanPath: path });
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect((thrown as Error).message).toContain(path);
			expect((thrown as Error).message).toContain("ENOENT");
		});
	});

	test("a plan with status 200 throws an Error naming the field and not the plan contents", () => {
		const readText = (): string => JSON.stringify({ steps: [{ count: 1, fault: { kind: "status", status: 200 } }] });
		let thrown: unknown;
		try {
			loadChaosFetch({ chaosEnabled: true, chaosPlanPath: "/plans/bad.json" }, readText);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message).toContain("/plans/bad.json");
		expect(message).toContain("steps[0].fault.status");
		expect(message).not.toContain('"kind"');
		expect(message).not.toContain("steps\":[");
	});

	test("invalid JSON throws an Error that does not echo the file text", () => {
		const readText = (): string => "{not json SECRET-PLAN-MARK";
		let thrown: unknown;
		try {
			loadChaosFetch({ chaosEnabled: true, chaosPlanPath: "/plans/broken.json" }, readText);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("/plans/broken.json");
		expect((thrown as Error).message).not.toContain("SECRET-PLAN-MARK");
	});
});
