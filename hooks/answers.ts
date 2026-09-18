#!/usr/bin/env bun
/**
 * Claude Code PostToolUse hook (matcher: AskUserQuestion): fold the user's
 * answers back into this session's clarifications and the saved spec XML.
 * Silent and fail-open.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isChildInvocation } from "../src/claude/complete.ts";
import { defaultStateDir, readSession, type SessionRecord, sessionPath, writeSession } from "../src/claude/state.ts";
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
		input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as HookInput;
	} catch {
		return;
	}
	if (input.tool_name !== "AskUserQuestion" || !input.session_id) return;

	const stateDir = defaultStateDir();
	const record = readSession(stateDir, input.session_id);
	if (!record) return;

	// `clarifications` lands on SessionRecord in src/claude/state.ts; read it defensively so this compiles either way.
	const existing: Clarification[] = "clarifications" in record && Array.isArray(record.clarifications) ? record.clarifications : [];
	const { list, matched } = applyAnswers(existing, input.tool_input, input.tool_response, Date.now());

	const xmlPath = sessionPath(stateDir, input.session_id).replace(/\.json$/, ".xml");
	const currentXml = existsSync(xmlPath) ? readFileSync(xmlPath, "utf8") : record.result.xml;
	const xml = injectClarificationsXml(currentXml, list).trimEnd();
	writeFileSync(xmlPath, `${xml}\n`);
	const next: SessionRecord & { clarifications: Clarification[] } = {
		...record,
		result: { ...record.result, xml },
		clarifications: list,
	};
	writeSession(stateDir, next);

	if (matched.length > 0) {
		console.log(JSON.stringify({ systemMessage: `HITL · ${matched.length} answer(s) recorded` }));
	}
}

main().catch(() => process.exit(0));
