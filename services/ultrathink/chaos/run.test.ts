// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import type { ChaosResponse, ChaosTarget } from "./observe.ts";
import { type RunOptions, runTemplate } from "./run.ts";
import type { ExperimentTemplate, Hypothesis } from "./schema.ts";

interface Call {
	method: string;
	path: string;
	body: unknown;
}

function respond(status: number, text = ""): ChaosResponse {
	return { status, headers: new Headers(), text };
}

function json(status: number, value: unknown): ChaosResponse {
	return respond(status, JSON.stringify(value));
}

/** A fake target whose answers come from `handle`. Every request is recorded in call order. */
function fakeTarget(handle: (method: string, path: string) => ChaosResponse): { target: ChaosTarget; calls: Call[] } {
	const calls: Call[] = [];
	const target: ChaosTarget = {
		async request(method, path, body) {
			calls.push({ method, path, body });
			return handle(method, path);
		},
		async close() {},
	};
	return { target, calls };
}

function healthy(_method: string, path: string): ChaosResponse {
	return path === "/healthz" ? json(200, { status: "ok" }) : respond(404);
}

function unhealthy(_method: string, path: string): ChaosResponse {
	return path === "/healthz" ? respond(503) : respond(404);
}

const HEALTHZ_200: Hypothesis = { id: "healthz-200", name: "healthz is 200", check: "status", path: "/healthz", equals: 200 };

function template(overrides: Partial<ExperimentTemplate> = {}): ExperimentTemplate {
	return {
		id: "fake-template",
		title: "Fake template",
		failureMode: "upstream_5xx",
		kind: "inprocess",
		load: { method: "POST", path: "/v1/plan", body: { goal: "x" }, requests: 4, concurrency: 2 },
		hypotheses: [HEALTHZ_200],
		rollbackOnFail: true,
		...overrides,
	};
}

const noSleep = async (): Promise<void> => {};

function baseOptions(target: ChaosTarget, extra: Partial<RunOptions> = {}): RunOptions {
	return {
		template: template(),
		target,
		driver: "inprocess",
		sleep: noSleep,
		now: () => new Date("2026-10-21T00:00:00.000Z"),
		staging: false,
		...extra,
	};
}

describe("runTemplate rollback", () => {
	test("all hypotheses pass: passed, score 100, no rollback, exec never called", async () => {
		const { target } = fakeTarget(healthy);
		const execCalls: string[][] = [];
		const result = await runTemplate(
			baseOptions(target, {
				driver: "http",
				staging: true,
				rollbackArgv: ["deploy/ultrathink-release.sh", "rollback"],
				exec: async (argv) => {
					execCalls.push(argv);
					return 0;
				},
			}),
		);
		expect(result.templateId).toBe("fake-template");
		expect(result.driver).toBe("http");
		expect(result.passed).toBe(true);
		expect(result.score).toBe(100);
		expect(result.rollback).toBe("not_needed");
		expect(result.rollbackExitCode).toBeUndefined();
		expect(result.settled).toBe("not_configured");
		expect(result.startedAt).toBe("2026-10-21T00:00:00.000Z");
		expect(execCalls).toHaveLength(0);
	});

	test("one failing hypothesis over http in staging invokes rollback once with the exact argv", async () => {
		const { target } = fakeTarget(unhealthy);
		const argv = ["deploy/ultrathink-release.sh", "rollback"];
		const execCalls: string[][] = [];
		const result = await runTemplate(
			baseOptions(target, {
				driver: "http",
				staging: true,
				rollbackArgv: argv,
				exec: async (received) => {
					execCalls.push(received);
					return 0;
				},
			}),
		);
		expect(result.passed).toBe(false);
		expect(result.score).toBe(0);
		expect(result.rollback).toBe("invoked");
		expect(result.rollbackExitCode).toBe(0);
		expect(execCalls).toHaveLength(1);
		expect(execCalls[0]).toBe(argv);
	});

	test("a non-zero rollback exit code is recorded as failed with that code", async () => {
		const { target } = fakeTarget(unhealthy);
		const result = await runTemplate(
			baseOptions(target, {
				driver: "http",
				staging: true,
				rollbackArgv: ["rollback"],
				exec: async () => 3,
			}),
		);
		expect(result.rollback).toBe("failed");
		expect(result.rollbackExitCode).toBe(3);
	});

	test("a rollback that throws is recorded as failed with no exit code", async () => {
		const { target } = fakeTarget(unhealthy);
		const result = await runTemplate(
			baseOptions(target, {
				driver: "http",
				staging: true,
				rollbackArgv: ["rollback"],
				exec: async () => {
					throw new Error("spawn failed");
				},
			}),
		);
		expect(result.rollback).toBe("failed");
		expect(result.rollbackExitCode).toBeUndefined();
	});

	test("outside staging the rollback is skipped and exec is not called", async () => {
		const { target } = fakeTarget(unhealthy);
		let execCalled = false;
		const result = await runTemplate(
			baseOptions(target, {
				driver: "http",
				staging: false,
				rollbackArgv: ["rollback"],
				exec: async () => {
					execCalled = true;
					return 0;
				},
			}),
		);
		expect(result.rollback).toBe("skipped:not_staging");
		expect(execCalled).toBe(false);
	});

	test("the inprocess driver skips rollback and exec is not called", async () => {
		const { target } = fakeTarget(unhealthy);
		let execCalled = false;
		const result = await runTemplate(
			baseOptions(target, {
				driver: "inprocess",
				staging: true,
				rollbackArgv: ["rollback"],
				exec: async () => {
					execCalled = true;
					return 0;
				},
			}),
		);
		expect(result.rollback).toBe("skipped:not_http");
		expect(execCalled).toBe(false);
	});

	test("no argv, or rollbackOnFail false, skips rollback as not requested", async () => {
		const { target } = fakeTarget(unhealthy);
		let execCalled = false;
		const exec = async () => {
			execCalled = true;
			return 0;
		};
		const noArgv = await runTemplate(baseOptions(target, { driver: "http", staging: true, exec }));
		const notOnFail = await runTemplate(
			baseOptions(target, {
				template: template({ rollbackOnFail: false }),
				driver: "http",
				staging: true,
				rollbackArgv: ["rollback"],
				exec,
			}),
		);
		expect(noArgv.rollback).toBe("skipped:not_requested");
		expect(notOnFail.rollback).toBe("skipped:not_requested");
		expect(execCalled).toBe(false);
	});
});

describe("runTemplate operator confirm", () => {
	const READYZ_503: Hypothesis = { id: "readyz-503", name: "readyz is 503", check: "status", path: "/readyz", equals: 503 };

	function operatorTemplate(): ExperimentTemplate {
		return template({
			kind: "operator",
			operatorStep: "Send SIGTERM to the ultrathink main process and do not restart it during the run.",
			load: { method: "GET", path: "/healthz", requests: 1, concurrency: 1 },
			hypotheses: [READYZ_503],
		});
	}

	test("confirm runs before the first load request and receives the operator step", async () => {
		const { target, calls } = fakeTarget((_method, path) => (path === "/readyz" ? respond(503) : respond(200)));
		const steps: string[] = [];
		let callsAtConfirm = -1;
		const result = await runTemplate(
			baseOptions(target, {
				template: operatorTemplate(),
				confirm: async (step) => {
					steps.push(step);
					callsAtConfirm = calls.length;
				},
			}),
		);
		expect(steps).toEqual([operatorTemplate().operatorStep ?? ""]);
		expect(callsAtConfirm).toBe(0);
		expect(calls[0]?.path).toBe("/healthz");
		expect(result.passed).toBe(true);
	});

	test("a rejected confirm aborts the run with zero load requests", async () => {
		const { target, calls } = fakeTarget(() => respond(200));
		await expect(
			runTemplate(
				baseOptions(target, {
					template: operatorTemplate(),
					confirm: async () => {
						throw new Error("operator declined");
					},
				}),
			),
		).rejects.toThrow("operator declined");
		expect(calls).toHaveLength(0);
	});

	test("an operator template without a confirm step is refused before any load", async () => {
		const { target, calls } = fakeTarget(() => respond(200));
		await expect(runTemplate(baseOptions(target, { template: operatorTemplate() }))).rejects.toThrow("needs a confirm step");
		expect(calls).toHaveLength(0);
	});
});

describe("runTemplate load", () => {
	test("issues exactly load.requests requests with the template method, path and body", async () => {
		const { target, calls } = fakeTarget(healthy);
		await runTemplate(baseOptions(target));
		const loads = calls.filter((call) => call.path === "/v1/plan");
		expect(loads).toHaveLength(4);
		for (const call of loads) {
			expect(call.method).toBe("POST");
			expect(call.body).toEqual({ goal: "x" });
		}
	});

	test("load responses are not judged: non-2xx and thrown load requests leave the verdict to hypotheses", async () => {
		const { target } = fakeTarget((method, path) => {
			if (path === "/v1/plan") throw new Error("reset");
			return healthy(method, path);
		});
		const result = await runTemplate(baseOptions(target));
		expect(result.passed).toBe(true);
		expect(result.score).toBe(100);
	});
});

describe("runTemplate settle", () => {
	const SETTLE = { metric: "ultrathink_planner_calls_total", labels: { outcome: "timeout" }, atLeast: 5 };

	function metricsWithTimeouts(count: number): ChaosResponse {
		return respond(200, `ultrathink_planner_calls_total{outcome="timeout"} ${count}\n`);
	}

	test("a settle that is reached stops polling early and reports settled true", async () => {
		let metricsPolls = 0;
		const sleeps: number[] = [];
		const { target } = fakeTarget((method, path) => {
			if (path !== "/metrics") return healthy(method, path);
			metricsPolls += 1;
			return metricsWithTimeouts(metricsPolls >= 3 ? 5 : 2);
		});
		const result = await runTemplate(
			baseOptions(target, {
				template: template({ settle: SETTLE }),
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		);
		expect(result.settled).toBe(true);
		expect(metricsPolls).toBe(3);
		expect(sleeps).toEqual([10, 10]);
	});

	test("a settle that never reaches atLeast gives settled false, polls 200 times, and still evaluates hypotheses", async () => {
		let metricsPolls = 0;
		const sleeps: number[] = [];
		const { target, calls } = fakeTarget((method, path) => {
			if (path !== "/metrics") return healthy(method, path);
			metricsPolls += 1;
			return metricsWithTimeouts(2);
		});
		const result = await runTemplate(
			baseOptions(target, {
				template: template({ settle: SETTLE }),
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		);
		expect(result.settled).toBe(false);
		expect(metricsPolls).toBe(200);
		expect(sleeps).toHaveLength(199);
		expect(result.hypotheses).toHaveLength(1);
		expect(result.hypotheses[0]?.passed).toBe(true);
		expect(result.passed).toBe(false);
		expect(calls.some((call) => call.path === "/healthz")).toBe(true);
	});

	test("a run whose settle never completes cannot pass, even when every hypothesis passes", async () => {
		const { target } = fakeTarget((method, path) => {
			if (path !== "/metrics") return healthy(method, path);
			return metricsWithTimeouts(2);
		});
		const result = await runTemplate(
			baseOptions(target, {
				template: template({ settle: SETTLE }),
			}),
		);
		expect(result.hypotheses.every((hypothesis) => hypothesis.passed)).toBe(true);
		expect(result.settled).toBe(false);
		expect(result.passed).toBe(false);
	});
});

describe("runTemplate hypotheses", () => {
	test("a metric hypothesis on a series that is absent fails with metric absent and no observed value", async () => {
		const { target } = fakeTarget((_method, path) => (path === "/metrics" ? respond(200, "other_metric 1\n") : respond(200)));
		const result = await runTemplate(
			baseOptions(target, {
				template: template({
					hypotheses: [{ id: "overload", name: "overload", check: "metric", metric: "ultrathink_overload_total", op: "gte", value: 1 }],
				}),
			}),
		);
		const [hypothesis] = result.hypotheses;
		expect(hypothesis?.passed).toBe(false);
		expect(hypothesis?.observed).toBeUndefined();
		expect(hypothesis?.reason).toBe("metric absent");
		expect(result.score).toBe(0);
	});

	test("a metric hypothesis compares the observed value with its operator", async () => {
		const { target } = fakeTarget((_method, path) => (path === "/metrics" ? respond(200, "ultrathink_overload_total 3\n") : respond(200)));
		const result = await runTemplate(
			baseOptions(target, {
				template: template({
					hypotheses: [
						{ id: "gte-ok", name: "", check: "metric", metric: "ultrathink_overload_total", op: "gte", value: 1 },
						{ id: "eq-bad", name: "", check: "metric", metric: "ultrathink_overload_total", op: "eq", value: 1 },
					],
				}),
			}),
		);
		expect(result.hypotheses[0]).toEqual({ id: "gte-ok", passed: true, observed: 3 });
		expect(result.hypotheses[1]?.passed).toBe(false);
		expect(result.hypotheses[1]?.observed).toBe(3);
		expect(result.score).toBe(50);
	});

	test("body hypotheses compare a top-level field; a missing field and non-JSON bodies fail with a reason", async () => {
		const { target } = fakeTarget((_method, path) => {
			if (path === "/healthz") return json(200, { breaker: "open", live: true });
			return respond(200, "not json");
		});
		const result = await runTemplate(
			baseOptions(target, {
				template: template({
					hypotheses: [
						{ id: "breaker-open", name: "", check: "body", path: "/healthz", field: "breaker", equals: "open" },
						{ id: "live-false", name: "", check: "body", path: "/healthz", field: "live", equals: false },
						{ id: "nope", name: "", check: "body", path: "/healthz", field: "missing", equals: 1 },
						{ id: "text", name: "", check: "body", path: "/text", field: "x", equals: 1 },
					],
				}),
			}),
		);
		expect(result.hypotheses[0]).toEqual({ id: "breaker-open", passed: true, observed: "open" });
		expect(result.hypotheses[1]?.passed).toBe(false);
		expect(result.hypotheses[1]?.observed).toBe("true");
		expect(result.hypotheses[2]?.reason).toBe("field missing absent");
		expect(result.hypotheses[3]?.reason).toBe("body is not JSON");
		expect(result.score).toBeCloseTo(25);
	});

	test("a hypothesis whose request throws is a failed hypothesis with a reason, not an exception", async () => {
		const { target } = fakeTarget((_method, path) => {
			if (path === "/boom") throw new Error("connection refused");
			return respond(200);
		});
		const result = await runTemplate(
			baseOptions(target, {
				template: template({
					hypotheses: [{ id: "boom", name: "", check: "status", path: "/boom", equals: 200 }],
				}),
			}),
		);
		expect(result.hypotheses[0]).toEqual({ id: "boom", passed: false, reason: "request failed: connection refused" });
		expect(result.passed).toBe(false);
	});
});
