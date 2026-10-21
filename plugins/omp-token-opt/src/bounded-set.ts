const MAX_LIMIT = 1_000_000;

/**
 * String set with LRU eviction. `add` and `has` both mark a value most recently used.
 * Inserting beyond `max` evicts the least recently used value.
 */
export class BoundedSet {
	readonly #max: number;
	// Set preserves insertion order: first value is least recently used.
	readonly #values = new Set<string>();

	constructor(max: number) {
		if (!Number.isSafeInteger(max) || max < 1 || max > MAX_LIMIT) {
			throw new RangeError(`BoundedSet max must be an integer in [1, ${MAX_LIMIT}], got ${max}`);
		}
		this.#max = max;
	}

	add(value: string): void {
		this.#values.delete(value);
		this.#values.add(value);
		if (this.#values.size > this.#max) {
			const oldest = this.#values.values().next();
			if (!oldest.done) this.#values.delete(oldest.value);
		}
	}

	has(value: string): boolean {
		if (!this.#values.has(value)) return false;
		this.#values.delete(value);
		this.#values.add(value);
		return true;
	}

	get size(): number {
		return this.#values.size;
	}
}
