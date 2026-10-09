// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `ultrathink-grokbot answers`: the grok-bot stand-in for the plugin's AskUserQuestion PostToolUse hook
 * (hooks/answers.ts). Desk Lead asks Ming the clarifying questions in chat, then records his replies here; they are
 * folded into the session's clarifications and the saved spec XML with the plugin's own `applyAnswers` and
 * `injectClarificationsXml`, so `ctl hitl last`, `summary` and `prompts build` all see "answered: …" instead of the default.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLock, writeFileAtomic } from "../claude/atomic.ts";
import { lastRefreshMessage, type SessionRecord, withLastLock } from "../claude/state.ts";
import { applyAnswers } from "../hitl/answers.ts";
import { injectClarificationsXml } from "../hitl/format.ts";
import type { Clarification } from "../hitl/types.ts";

/** `{"answers": {"q1" | "<question text>": "<answer>"}, "response"?: "<free text>"}`, or the bare answers map. */
export interface AnswersInput {
	answers?: Record<string, string>;
	response?: string;
}

export function parseAnswersInput(raw: unknown): AnswersInput {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("answers input must be a JSON object");
	const rec = raw as Record<string, unknown>;
	const map = rec.answers && typeof rec.answers === "object" && !Array.isArray(rec.answers) ? (rec.answers as Record<string, unknown>) : "answers" in rec || "response" in rec ? {} : rec;
	const answers: Record<string, string> = {};
	for (const [key, value] of Object.entries(map)) {
		if (typeof value !== "string") throw new Error(`answer for ${key} must be a string`);
		answers[key] = value;
	}
	const response = typeof rec.response === "string" ? rec.response : undefined;
	if (Object.keys(answers).length === 0 && !response?.trim()) throw new Error("no answers given");
	return { answers, ...(response ? { response } : {}) };
}

export function recordAnswers(statePath: string, input: AnswersInput, now = Date.now()): { matched: Clarification[]; unknownIds: string[]; list: Clarification[] } {
	return withFileLock(statePath, () => {
		const record = JSON.parse(readFileSync(statePath, "utf8")) as SessionRecord;
		const existing: Clarification[] = Array.isArray(record.clarifications) ? record.clarifications : [];
		// Ids (q1, q2…) resolve to their question text, which is what applyAnswers matches on.
		const unknownIds: string[] = [];
		const byQuestion: Record<string, string> = {};
		for (const [key, value] of Object.entries(input.answers ?? {})) {
			const item = existing.find((c) => c.id === key);
			if (item) byQuestion[item.question] = value;
			else if (/^q\d+$/.test(key)) unknownIds.push(key);
			else byQuestion[key] = value;
		}
		if (unknownIds.length > 0) return { matched: [], unknownIds, list: existing };
		const { list, matched } = applyAnswers(existing, undefined, { answers: byQuestion, ...(input.response ? { response: input.response } : {}) }, now);
		const xmlPath = statePath.replace(/\.json$/, ".xml");
		const currentXml = existsSync(xmlPath) ? readFileSync(xmlPath, "utf8") : record.result.xml;
		const xml = injectClarificationsXml(currentXml, list).trimEnd();
		const next: SessionRecord = { ...record, result: { ...record.result, xml }, clarifications: list };
		writeFileAtomic(statePath, `${JSON.stringify(next, null, 2)}\n`);
		writeFileAtomic(xmlPath, `${xml}\n`);
		mirrorLast(statePath, next);
		return { matched, unknownIds, list };
	});
}

/** `ctl last` and `ctl hitl last` read `last.json`, a copy of the session written when the plan was saved. */
export function mirrorLast(statePath: string, record: SessionRecord): void {
	const lastPath = join(dirname(dirname(statePath)), "last.json");
	if (!existsSync(lastPath)) return;
	let refreshed = false;
	try {
		refreshed = withLastLock(lastPath, () => {
			const last = JSON.parse(readFileSync(lastPath, "utf8")) as { sessionId?: string };
			if (last.sessionId !== record.sessionId) return;
			writeFileAtomic(lastPath, `${JSON.stringify(record, null, "\t")}\n`);
		});
	} catch {
		// an unreadable last.json stays as it is
		return;
	}
	if (!refreshed) throw new Error(lastRefreshMessage(lastPath));
}
