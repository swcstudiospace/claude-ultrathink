#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Claude Code PostToolUse hook (matcher: AskUserQuestion): fold the user's
 * answers back into this session's clarifications and the saved spec XML.
 * Silent and fail-open.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../src/claude/atomic.ts";
import { isChildInvocation } from "../src/claude/complete.ts";
import { defaultStateDir, sessionPath, updateSession } from "../src/claude/state.ts";
import { parseEnvelope } from "../src/host/envelope.ts";
import { applyAnswers, type AskUserQuestionInput, type AskUserQuestionResponse } from "../src/hitl/answers.ts";
import { injectClarificationsXml } from "../src/hitl/format.ts";
import type { Clarification } from "../src/hitl/types.ts";

interface HookInput {
	session_id?: string;
	tool_name?: string;
	tool_input?: AskUserQuestionInput;
	tool_response?: AskUserQuestionResponse | string;
	cwd?: string;
}

async function main(): Promise<void> {
	if (isChildInvocation()) return;
	let input: HookInput = {};
	try {
		input = parseEnvelope(await new Response(Bun.stdin.stream()).text()) as HookInput;
	} catch {
		return;
	}
	if (input.tool_name !== "AskUserQuestion" || !input.session_id) return;

	const stateDir = defaultStateDir();
	const xmlPath = sessionPath(stateDir, input.session_id).replace(/\.json$/, ".xml");
	let matched: Clarification[] = [];
	// One locked read-apply-write, so a concurrent writer of this session record (ship, kickoff marks) is not overwritten.
	const updated = updateSession(stateDir, input.session_id, (record) => {
		const existing: Clarification[] = Array.isArray(record.clarifications) ? record.clarifications : [];
		const applied = applyAnswers(existing, input.tool_input, input.tool_response, Date.now());
		matched = applied.matched;
		const currentXml = existsSync(xmlPath) ? readFileSync(xmlPath, "utf8") : record.result.xml;
		const xml = injectClarificationsXml(currentXml, applied.list).trimEnd();
		writeFileAtomic(xmlPath, `${xml}\n`);
		return { ...record, result: { ...record.result, xml }, clarifications: applied.list };
	});
	if (!updated) return;

	if (matched.length > 0) {
		console.log(JSON.stringify({ systemMessage: `HITL · ${matched.length} answer(s) recorded` }));
	}
}

main().catch(() => process.exit(0));
