// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Test worker for atomic.test.ts: `bun atomic.worker.ts <stateDir> <sessionId> <count>` adds one to the numeric
 * `counter` field of a session record `count` times, each through `updateSession`. Several of these running at once
 * must end at the sum of their counts. The lock wait is long so a loaded machine never turns a wait into an unlocked
 * write, which would be a lost update the test is looking for.
 */
import { type SessionRecord, updateSession } from "./state.ts";

const [dir, sessionId, countArg] = process.argv.slice(2);
const count = Number(countArg);
if (!dir || !sessionId || !Number.isInteger(count) || count < 0) {
	process.stderr.write("usage: atomic.worker.ts <stateDir> <sessionId> <count>\n");
	process.exit(2);
}

type Counted = SessionRecord & { counter?: number };

for (let i = 0; i < count; i++) {
	const updated = updateSession(
		dir,
		sessionId,
		(record: Counted): Counted => ({ ...record, counter: (record.counter ?? 0) + 1 }),
		{ timeoutMs: 120_000 },
	);
	if (!updated) {
		process.stderr.write(`session ${sessionId} missing in ${dir}\n`);
		process.exit(1);
	}
}
