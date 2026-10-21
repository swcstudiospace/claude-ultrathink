// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { AsyncLocalStorage } from "node:async_hooks";
import type { Admission } from "./fair-share.ts";

/**
 * Request-scoped identifiers for log enrichment and outbound trace propagation. The router enters it once per
 * request; async work started inside that request (including planner jobs it kicks off) reads the same values.
 * `sampled` follows the inbound trace flags; undefined means sampled, which is what a fresh trace starts as.
 */
export interface RequestContext {
	reqId: string;
	traceId: string;
	spanId: string;
	sampled?: boolean;
	/** Priority class and principal set by the router after authentication; absent outside authenticated routes. */
	admission?: Admission;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `ctx` as the current request context for everything it starts asynchronously. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
	return storage.run(ctx, fn);
}

/** The context of the request whose work is running, or undefined outside any request. */
export function currentRequestContext(): RequestContext | undefined {
	return storage.getStore();
}
