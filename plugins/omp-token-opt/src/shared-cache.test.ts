import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSharedCache, scopedKey, type SharedCache } from "./shared-cache.ts";

const MAX_VALUE_BYTES = 256 * 1024;
const REFUSED_URL = "redis://127.0.0.1:1";

function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (typeof address === "string" || address === null) {
			reject(new Error("no TCP address"));
			return;
		}
		const { port } = address;
		server.close(() => resolve(port));
	});
	return promise;
}

function portAccepts(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = connect(port, "127.0.0.1");
	socket.once("connect", () => {
		socket.destroy();
		resolve(true);
	});
	socket.once("error", () => resolve(false));
	return promise;
}

async function waitForPort(port: number): Promise<void> {
	// Readiness polling against a child process: no event fires when redis binds.
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await portAccepts(port)) return;
		await Bun.sleep(20);
	}
	throw new Error("redis-server did not start listening");
}

describe("disabled cache", () => {
	test("reports disabled and treats every operation as a miss or no-op", async () => {
		const cache = createSharedCache();
		expect(cache.state()).toBe("disabled");
		expect(await cache.get("anything")).toBeNull();
		await expect(cache.set("anything", "value")).resolves.toBeUndefined();
		expect(await cache.get("anything")).toBeNull();
		expect(cache.state()).toBe("disabled");
		await expect(cache.close()).resolves.toBeUndefined();
	});

	test("an empty url is treated the same as no url", async () => {
		const cache = createSharedCache({ url: "" });
		expect(cache.state()).toBe("disabled");
		expect(await cache.get("k")).toBeNull();
	});

	test("a closed cache reports disabled and stops serving reads and writes", async () => {
		const cache = createSharedCache({ url: REFUSED_URL });
		await cache.close();
		expect(cache.state()).toBe("disabled");
		expect(await cache.get("k")).toBeNull();
		await expect(cache.set("k", "v")).resolves.toBeUndefined();
	});
});

describe("option validation", () => {
	test.each([
		["ttlSeconds", { ttlSeconds: 0 }],
		["ttlSeconds", { ttlSeconds: 1.5 }],
		["ttlSeconds", { ttlSeconds: Number.NaN }],
		["timeoutMs", { timeoutMs: 0 }],
		["timeoutMs", { timeoutMs: 2_147_483_648 }],
		["breakerThreshold", { breakerThreshold: 0 }],
		["breakerThreshold", { breakerThreshold: -1 }],
		["breakerCooldownMs", { breakerCooldownMs: -1 }],
		["breakerCooldownMs", { breakerCooldownMs: Number.POSITIVE_INFINITY }],
	])("%s out of range throws RangeError at factory time", (_name, options) => {
		expect(() => createSharedCache(options)).toThrow(RangeError);
	});

	test("breakerCooldownMs of zero is accepted", () => {
		expect(() => createSharedCache({ url: REFUSED_URL, breakerCooldownMs: 0 })).not.toThrow();
	});
});

describe("scopedKey", () => {
	const base = { tenant: "acme", repo: "/home/alice/secret-repo", stamp: "abc123", args: ["graph", "--json"] };

	test("same input yields the same key with the versioned prefix and a sha256 hex digest", () => {
		const first = scopedKey(base);
		expect(scopedKey({ ...base, args: [...base.args] })).toBe(first);
		expect(first).toMatch(/^tokopt:v1:[0-9a-f]{64}$/);
	});

	test.each([
		["tenant", { tenant: "other" }],
		["repo", { repo: "/home/alice/other-repo" }],
		["stamp", { stamp: "def456" }],
		["args", { args: ["graph"] }],
		["args order", { args: ["--json", "graph"] }],
		["args split", { args: ["graph--json"] }],
	])("changing %s changes the key", (_label, change) => {
		expect(scopedKey({ ...base, ...change })).not.toBe(scopedKey(base));
	});

	test("the raw repo path never appears in the key", () => {
		expect(scopedKey(base)).not.toContain("secret-repo");
		expect(scopedKey(base)).not.toContain("/home/alice");
	});
});

describe("live redis", () => {
	let server: Subprocess | undefined;
	let dir = "";
	let url = "";
	let cache: SharedCache;

	beforeAll(async () => {
		const port = await freePort();
		dir = mkdtempSync(join(tmpdir(), "shared-cache-redis-"));
		server = Bun.spawn(
			["redis-server", "--port", String(port), "--save", "", "--appendonly", "no", "--dir", dir],
			{ stdout: "ignore", stderr: "ignore" },
		);
		await waitForPort(port);
		url = `redis://127.0.0.1:${port}`;
		cache = createSharedCache({ url, ttlSeconds: 60, timeoutMs: 2000 });
	});

	afterAll(async () => {
		await cache.close();
		server?.kill();
		await server?.exited;
		rmSync(dir, { recursive: true, force: true });
	});

	test("get returns null for a missing key", async () => {
		expect(await cache.get("missing-key")).toBeNull();
	});

	test("set then get round-trips the value", async () => {
		await cache.set("roundtrip", "payload-1");
		expect(await cache.get("roundtrip")).toBe("payload-1");
		expect(cache.state()).toBe("closed");
	});

	test("set applies the configured ttl", async () => {
		await cache.set("ttl-key", "v");
		const raw = new Bun.RedisClient(url);
		try {
			const ttl = await raw.ttl("ttl-key");
			expect(ttl).toBeGreaterThan(0);
			expect(ttl).toBeLessThanOrEqual(60);
		} finally {
			raw.close();
		}
	});

	test("a value of exactly 256 KiB is stored", async () => {
		const value = "a".repeat(MAX_VALUE_BYTES);
		await cache.set("at-limit", value);
		expect(await cache.get("at-limit")).toBe(value);
	});

	test("an oversized value is not stored", async () => {
		await cache.set("over-limit", "a".repeat(MAX_VALUE_BYTES + 1));
		expect(await cache.get("over-limit")).toBeNull();
		expect(cache.state()).toBe("closed");
	});

	test("the size limit counts UTF-8 bytes, not characters", async () => {
		// 131073 copies of a two-byte character: 131073 chars but 262146 bytes.
		await cache.set("multibyte-over", "é".repeat(131_073));
		expect(await cache.get("multibyte-over")).toBeNull();
	});
});

describe("circuit breaker", () => {
	test("opens after threshold consecutive failures and then answers immediately", async () => {
		const cache = createSharedCache({
			url: REFUSED_URL,
			timeoutMs: 200,
			breakerThreshold: 3,
			breakerCooldownMs: 60_000,
		});
		try {
			expect(await cache.get("k")).toBeNull();
			expect(await cache.get("k")).toBeNull();
			expect(cache.state()).toBe("closed");
			expect(await cache.get("k")).toBeNull();
			expect(cache.state()).toBe("open");

			// Open breaker short-circuits: no 200 ms wait. The bound is loose because
			// the short-circuit path is synchronous; a wait would take the full timeout.
			const started = performance.now();
			expect(await cache.get("k")).toBeNull();
			await cache.set("k", "v");
			expect(performance.now() - started).toBeLessThan(150);
			expect(cache.state()).toBe("open");
		} finally {
			await cache.close();
		}
	});

	test("after the cooldown the next call probes the backend and reopens on failure", async () => {
		const timeoutMs = 150;
		const cache = createSharedCache({
			url: REFUSED_URL,
			timeoutMs,
			breakerThreshold: 1,
			breakerCooldownMs: 50,
		});
		try {
			expect(await cache.get("k")).toBeNull();
			expect(cache.state()).toBe("open");

			// Real-time integration check: the breaker cooldown is a wall-clock window
			// and has no injectable clock, so the test waits out the 50 ms cooldown.
			await Bun.sleep(80);
			expect(cache.state()).toBe("closed");

			const started = performance.now();
			expect(await cache.get("k")).toBeNull();
			// A probe reaches the backend, so it waits out the timeout instead of returning at once.
			expect(performance.now() - started).toBeGreaterThanOrEqual(timeoutMs - 20);
			expect(cache.state()).toBe("open");
		} finally {
			await cache.close();
		}
	});

	test("a malformed url is fail-open: no throw, misses, and the breaker still opens", async () => {
		const cache = createSharedCache({
			url: "://not a valid url",
			breakerThreshold: 2,
			breakerCooldownMs: 60_000,
		});
		try {
			expect(await cache.get("k")).toBeNull();
			await expect(cache.set("k", "v")).resolves.toBeUndefined();
			expect(cache.state()).toBe("open");
		} finally {
			await cache.close();
		}
	});
});

describe("acquire fails open", () => {
	test("a disabled cache returns unavailable", async () => {
		const cache = createSharedCache();
		await expect(cache.acquire("tokopt:v1:k", 1000)).resolves.toBe("unavailable");
		expect(cache.state()).toBe("disabled");
	});

	test("a closed cache returns unavailable", async () => {
		const cache = createSharedCache({ url: REFUSED_URL });
		await cache.close();
		await expect(cache.acquire("tokopt:v1:k", 1000)).resolves.toBe("unavailable");
	});

	test("a malformed url returns unavailable without throwing", async () => {
		const cache = createSharedCache({ url: "://not a valid url" });
		try {
			await expect(cache.acquire("tokopt:v1:k", 1000)).resolves.toBe("unavailable");
		} finally {
			await cache.close();
		}
	});

	test("an open breaker returns unavailable immediately", async () => {
		const cache = createSharedCache({
			url: REFUSED_URL,
			timeoutMs: 200,
			breakerThreshold: 1,
			breakerCooldownMs: 60_000,
		});
		try {
			await expect(cache.acquire("tokopt:v1:k", 1000)).resolves.toBe("unavailable");
			expect(cache.state()).toBe("open");
			const started = performance.now();
			await expect(cache.acquire("tokopt:v1:k", 1000)).resolves.toBe("unavailable");
			expect(performance.now() - started).toBeLessThan(150);
		} finally {
			await cache.close();
		}
	});

	test("a peer that never replies times out to unavailable near timeoutMs", async () => {
		// Real timeout: the client's deadline is wall-clock, so no fake timer applies here.
		const silent = createServer(() => {});
		await new Promise<void>((resolve) => {
			silent.listen(0, "127.0.0.1", () => resolve());
		});
		const address = silent.address();
		if (typeof address === "string" || address === null) throw new Error("no TCP address");
		const cache = createSharedCache({ url: `redis://127.0.0.1:${address.port}`, timeoutMs: 150, breakerThreshold: 5 });
		try {
			const started = performance.now();
			await expect(cache.acquire("tokopt:v1:k", 1000)).resolves.toBe("unavailable");
			const took = performance.now() - started;
			expect(took).toBeGreaterThanOrEqual(130);
			expect(took).toBeLessThan(1000);
		} finally {
			await cache.close();
			silent.close();
		}
	});

	test("an out-of-range ttl is unavailable with no I/O, so the breaker does not move", async () => {
		const cache = createSharedCache({ url: REFUSED_URL, breakerThreshold: 1, breakerCooldownMs: 60_000 });
		try {
			for (const ttl of [0, 60_001, Number.NaN]) {
				await expect(cache.acquire("tokopt:v1:k", ttl)).resolves.toBe("unavailable");
			}
			// A reached backend would refuse the connection and open the breaker at threshold 1.
			expect(cache.state()).toBe("closed");
		} finally {
			await cache.close();
		}
	});
});

describe("acquire lease on live redis", () => {
	let server: Subprocess | undefined;
	let dir = "";
	let url = "";
	let cache: SharedCache;

	beforeAll(async () => {
		const port = await freePort();
		dir = mkdtempSync(join(tmpdir(), "shared-cache-lease-"));
		server = Bun.spawn(
			["redis-server", "--port", String(port), "--save", "", "--appendonly", "no", "--dir", dir],
			{ stdout: "ignore", stderr: "ignore" },
		);
		await waitForPort(port);
		url = `redis://127.0.0.1:${port}/1`;
		cache = createSharedCache({ url, timeoutMs: 2000 });
	});

	afterAll(async () => {
		await cache.close();
		server?.kill();
		await server?.exited;
		rmSync(dir, { recursive: true, force: true });
	});

	test("the first acquire is granted and the second is held", async () => {
		const key = "tokopt:v1:lease-nx";
		expect(await cache.acquire(key, 5000)).toBe("granted");
		expect(await cache.acquire(key, 5000)).toBe("held");
		expect(cache.state()).toBe("closed");
	});

	test("a result another caller stored under the key is never overwritten", async () => {
		const key = "tokopt:v1:lease-other-result";
		await cache.set(key, "other-caller-result");
		expect(await cache.acquire(key, 5000)).toBe("held");
		expect(await cache.get(key)).toBe("other-caller-result");
	});

	test("the lease holds a random uuid with the requested ttl and expires", async () => {
		const key = "tokopt:v1:lease-id";
		expect(await cache.acquire(key, 5000)).toBe("granted");
		const raw = new Bun.RedisClient(url);
		try {
			expect(await raw.get(key)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			const ttl = await raw.ttl(key);
			expect(ttl).toBeGreaterThan(0);
			expect(ttl).toBeLessThanOrEqual(5);
		} finally {
			raw.close();
		}
		const short = "tokopt:v1:lease-short";
		expect(await cache.acquire(short, 100)).toBe("granted");
		// Redis TTL runs on the server clock, so a fake timer cannot drive this expiry.
		await Bun.sleep(180);
		expect(await cache.acquire(short, 5000)).toBe("granted");
	});

	test("a ttl of 60000 ms is granted; out-of-range values resolve unavailable and create nothing", async () => {
		expect(await cache.acquire("tokopt:v1:lease-max", 60_000)).toBe("granted");
		for (const ttl of [0, -1, 1.5, Number.NaN, 60_001, Number.POSITIVE_INFINITY]) {
			const key = `tokopt:v1:lease-bad-${String(ttl)}`;
			expect(await cache.acquire(key, ttl)).toBe("unavailable");
			expect(await cache.get(key)).toBeNull();
		}
	});
});
