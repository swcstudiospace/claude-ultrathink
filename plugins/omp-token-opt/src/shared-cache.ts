// Optional Redis-backed L2 cache for keyed graph results.
//
// Every operation is fail-open: errors, timeouts and an open breaker all
// surface as a miss (`null`) or a silent no-op. Nothing here throws after the
// factory returns, and nothing logs the connection URL.

/**
 * Outcome of a lease attempt. `granted`: this call created the key. `held`: the key
 * already exists, so another caller holds the lease. `unavailable`: the cache could not
 * answer (disabled, closed, breaker open, timeout, error, or an out-of-range ttl).
 */
export type LeaseOutcome = "granted" | "held" | "unavailable";

export interface SharedCache {
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<void>;
	/** SET NX PX lease. Resolves `granted`, `held`, or `unavailable`; never throws. */
	acquire(key: string, ttlMs: number): Promise<LeaseOutcome>;
	state(): "disabled" | "closed" | "open";
	close(): Promise<void>;
}

export interface SharedCacheOptions {
	url?: string;
	ttlSeconds?: number;
	timeoutMs?: number;
	breakerThreshold?: number;
	breakerCooldownMs?: number;
}

export interface ScopedKeyParts {
	tenant: string;
	repo: string;
	stamp: string;
	args: readonly string[];
}

const MAX_VALUE_BYTES = 256 * 1024;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_LEASE_MS = 60_000;
const KEY_PREFIX = "tokopt:v1:";

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_TIMEOUT_MS = 300;
const DEFAULT_BREAKER_THRESHOLD = 3;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;

function requireInteger(name: string, value: number, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
	}
	return value;
}

function withTimeout<T>(task: () => Promise<T>, ms: number): Promise<T> {
	const { promise: deadline, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error("shared cache timeout")), ms);
	const work = (async () => task())();
	// A late rejection after the deadline has already won must not go unhandled.
	work.catch(() => {});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export function createSharedCache(options: SharedCacheOptions = {}): SharedCache {
	const ttlSeconds = requireInteger("ttlSeconds", options.ttlSeconds ?? DEFAULT_TTL_SECONDS, 1, MAX_TIMER_MS);
	const timeoutMs = requireInteger("timeoutMs", options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMER_MS);
	const breakerThreshold = requireInteger(
		"breakerThreshold",
		options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD,
		1,
		Number.MAX_SAFE_INTEGER,
	);
	const breakerCooldownMs = requireInteger(
		"breakerCooldownMs",
		options.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS,
		0,
		MAX_TIMER_MS,
	);

	const url = options.url;
	const enabled = url !== undefined && url !== "";

	let client: Bun.RedisClient | undefined;
	let closed = false;
	let consecutiveFailures = 0;
	// Epoch ms until which the breaker stays open. 0 means closed.
	let openUntil = 0;

	// Decide whether this call may reach Redis. After the cooldown the first
	// caller reserves a single probe by extending the open window; concurrent
	// callers during that probe are turned away until it settles.
	function admit(): boolean {
		if (!enabled || closed) return false;
		if (openUntil === 0) return true;
		const now = Date.now();
		if (now < openUntil) return false;
		openUntil = now + breakerCooldownMs;
		return true;
	}

	function recordSuccess(): void {
		consecutiveFailures = 0;
		openUntil = 0;
	}

	function recordFailure(): void {
		consecutiveFailures += 1;
		if (consecutiveFailures >= breakerThreshold) {
			openUntil = Date.now() + breakerCooldownMs;
		}
	}

	async function run<T>(op: (redis: Bun.RedisClient) => Promise<T>, fallback: T): Promise<T> {
		if (!admit()) return fallback;
		try {
			// Constructing the client throws on a malformed URL; that counts as a failure.
			client ??= new Bun.RedisClient(url);
			const redis = client;
			const result = await withTimeout(() => op(redis), timeoutMs);
			recordSuccess();
			return result;
		} catch {
			recordFailure();
			return fallback;
		}
	}

	return {
		async get(key: string): Promise<string | null> {
			return run((redis) => redis.get(key), null);
		},

		async set(key: string, value: string): Promise<void> {
			if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) return;
			await run((redis) => redis.set(key, value, "EX", ttlSeconds), undefined);
		},

		/**
		 * SET NX PX lease. `granted` when this call created the key, `held` when a refused NX
		 * shows the key exists. Disabled, breaker-open, timeout, error and an out-of-range ttlMs
		 * all resolve `unavailable`; the ttl check does no I/O.
		 */
		async acquire(key: string, ttlMs: number): Promise<LeaseOutcome> {
			if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_LEASE_MS) return "unavailable";
			// The value is a random id private to this call. A refused NX replies null, so no holder is revealed.
			const lease = crypto.randomUUID();
			// `undefined` is the failure fallback; a refused NX replies null, so the two stay distinct.
			const reply = await run<string | null | undefined>(
				(redis) => redis.set(key, lease, "PX", String(ttlMs), "NX"),
				undefined,
			);
			if (reply === "OK") return "granted";
			if (reply === null) return "held";
			return "unavailable";
		},

		state(): "disabled" | "closed" | "open" {
			if (!enabled || closed) return "disabled";
			return openUntil > Date.now() ? "open" : "closed";
		},

		async close(): Promise<void> {
			closed = true;
			const redis = client;
			client = undefined;
			try {
				redis?.close();
			} catch {
				// Closing is best-effort; the cache is already unusable.
			}
		},
	};
}

export function scopedKey(parts: ScopedKeyParts): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(JSON.stringify([parts.tenant, parts.repo, parts.stamp, parts.args]));
	return `${KEY_PREFIX}${hasher.digest("hex")}`;
}
