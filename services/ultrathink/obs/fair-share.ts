// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Weighted admission for a bounded pool (Phase 70, RATE-03).
//
// Admission is refuse-at-once: a refused acquire returns a reason immediately and never waits.
// Priority classes: `owner` may take any free slot; `connector` and `bearer` may not take the
// last `reserve` slots and may not hold more than `perPrincipalMax` slots per principal.
//
// Pure and synchronous. Construction throws `RangeError` for invalid options.

/** Priority class of an admitted request. `owner` > `connector` > `bearer`. */
export type AdmissionClass = "owner" | "connector" | "bearer";

/** Who is asking for a slot and at which priority. */
export interface Admission {
	principal: string;
	class: AdmissionClass;
}

export interface FairShareOptions {
	/** Total slots. Positive safe integer. */
	capacity: number;
	/** Slots non-owner classes may not take. Integer, `0 <= reserve < capacity`. */
	reserve: number;
	/** Slots one non-owner principal may hold. Integer `1..capacity`; default `capacity`. */
	perPrincipalMax?: number;
}

/** Why an acquire was refused. Checked in this order. */
export type FairShareRefusal = "capacity" | "reserved" | "principal";

export interface FairShare {
	/**
	 * Try to take one slot. Refusal changes nothing. The returned `release` frees the slot;
	 * calling it again on the same handle frees nothing.
	 */
	acquire(admission: Admission): { ok: true; release: () => void } | { ok: false; reason: FairShareRefusal };
	/** Slots currently held across all principals and classes. */
	readonly held: number;
}

/** Create a fair-share pool. Throws `RangeError` on invalid options. */
export function createFairShare(options: FairShareOptions): FairShare {
	const { capacity, reserve } = options;
	const perPrincipalMax = options.perPrincipalMax ?? capacity;
	if (!Number.isSafeInteger(capacity) || capacity <= 0) {
		throw new RangeError(`createFairShare: capacity must be a positive safe integer, got ${String(capacity)}`);
	}
	if (!Number.isSafeInteger(reserve) || reserve < 0 || reserve >= capacity) {
		throw new RangeError(`createFairShare: reserve must be an integer in 0..${capacity - 1}, got ${String(reserve)}`);
	}
	if (!Number.isSafeInteger(perPrincipalMax) || perPrincipalMax < 1 || perPrincipalMax > capacity) {
		throw new RangeError(
			`createFairShare: perPrincipalMax must be an integer in 1..${capacity}, got ${String(perPrincipalMax)}`,
		);
	}

	let held = 0;
	const heldByPrincipal = new Map<string, number>();

	return {
		get held() {
			return held;
		},
		acquire(admission) {
			if (held >= capacity) return { ok: false, reason: "capacity" };
			const owner = admission.class === "owner";
			if (!owner && held >= capacity - reserve) return { ok: false, reason: "reserved" };
			const principal = admission.principal;
			const principalHeld = heldByPrincipal.get(principal) ?? 0;
			if (!owner && principalHeld >= perPrincipalMax) return { ok: false, reason: "principal" };

			held++;
			heldByPrincipal.set(principal, principalHeld + 1);
			let released = false;
			return {
				ok: true,
				release: () => {
					if (released) return;
					released = true;
					held--;
					const remaining = (heldByPrincipal.get(principal) ?? 1) - 1;
					if (remaining > 0) heldByPrincipal.set(principal, remaining);
					else heldByPrincipal.delete(principal);
				},
			};
		},
	};
}
