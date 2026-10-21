// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/** Worker entry for `createAuditVerifier`: answers each `VerifyRequest` with one `ScanReply`. */

import { type VerifyRequest, verifyObserved } from "./audit-verify.ts";
import type { ScanReply } from "./audit-watch.ts";

// The worker global, typed for the two members used here; the service's tsconfig carries no worker library.
declare const self: { onmessage: ((event: { data: VerifyRequest }) => void) | null; postMessage(message: ScanReply): void };

self.onmessage = (event) => {
	let reply: ScanReply;
	try {
		reply = verifyObserved(event.data);
	} catch (error) {
		reply = { ok: false, records: 0, brokenAt: 0, reason: `verifier failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	self.postMessage(reply);
};
