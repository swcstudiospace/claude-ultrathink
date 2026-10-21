// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Result views of finished planning sessions, as pure functions over the state directory. Shared by the hosted
 * headless planner and any other front end that reads the same session records.
 */
import { readSession, type SessionRecord } from "../../../src/claude/state.ts";
import { journalDir, readMeta } from "../../../src/host/grokbot.ts";
import { buildGraphView } from "./graph-view.ts";
import type { JobStatus, JobUsage, ResultView } from "./headless.ts";
import type { JournalResult } from "./journal.ts";
import { DEFAULT_MAX_CHARS, renderChatPlan } from "./render.ts";

/** What a server-planned job exposes to its result view. */
export interface ServerJobSnapshot {
	sessionId: string;
	status: JobStatus;
	error?: string;
	usage: JobUsage;
}

type Detail = "brief" | "full";

/** A client-driven session only moves when the chat model answers, so a poller has nothing to gain from asking sooner. */
const CLIENT_POLL_AFTER_SEC = 10;

export function statusLine(status: JobStatus, error?: string): string {
	switch (status) {
		case "running":
			return "The plan is still being prepared. Call ultrathink_result again with the same sessionId; no other work is needed meanwhile.";
		case "failed":
			return `Planning failed (${error ?? "engine_error"}). Tell the user, and offer to try again with a new sessionId.`;
		case "invalid":
			return `The planner produced an incomplete plan (${error ?? "invalid_plan"}). Offer to try again with a new sessionId, or rephrase the request.`;
		case "skipped":
			return `Planning was skipped (${error ?? "skipped"}). Rephrase the request as a plain description of the task, without a leading slash or a raw: prefix, and call ultrathink_uplift again with a new sessionId.`;
		default:
			return "";
	}
}

/** The planned view of a session record: chat text, open questions and the structured graph when there is one. */
export function renderPlanView(sessionId: string, mode: "server" | "client", detail: Detail, record: SessionRecord, usage?: JobUsage): ResultView {
	const rendered = renderChatPlan(record, { detail, maxChars: DEFAULT_MAX_CHARS[detail] });
	const graph = buildGraphView(record);
	return {
		sessionId,
		status: "planned",
		mode,
		text: rendered.text,
		...(rendered.truncated ? { truncated: true } : {}),
		...(rendered.questions.length > 0 ? { questions: rendered.questions } : {}),
		...(graph ? { graph } : {}),
		...(usage ? { usage: { ...usage } } : {}),
	};
}

/** The view of a job the server planned: the finished plan, or one status line for any other state. */
export function serverPlanView(stateDir: string, file: ServerJobSnapshot, detail: Detail): JournalResult<ResultView> {
	if (file.status === "planned") {
		const record = readSession(stateDir, file.sessionId);
		if (!record) return { ok: false, code: "engine_error" };
		return { ok: true, data: renderPlanView(file.sessionId, "server", detail, record, file.usage) };
	}
	return {
		ok: true,
		data: {
			sessionId: file.sessionId,
			status: file.status,
			mode: "server",
			text: statusLine(file.status, file.error),
			usage: { ...file.usage },
			...(file.error === undefined ? {} : { error: file.error }),
		},
	};
}

/** A finished session from the client-driven loop: the chat model did the thinking, the record is the same. */
export function clientPlanView(stateDir: string, sessionId: string, detail: Detail): JournalResult<ResultView> {
	const meta = readMeta(journalDir(stateDir, sessionId));
	if (!meta) return { ok: false, code: "not_found" };
	const status: JobStatus = meta.status === "planned" || meta.status === "invalid" || meta.status === "skipped" ? meta.status : "running";
	if (status === "planned") {
		const record = readSession(stateDir, sessionId);
		if (!record) return { ok: false, code: "engine_error" };
		return { ok: true, data: renderPlanView(sessionId, "client", detail, record) };
	}
	if (status === "running") {
		return {
			ok: true,
			data: {
				sessionId,
				status,
				mode: "client",
				text: "This session is driven by the chat model and is not finished: keep answering its pending requests with ultrathink_pending, ultrathink_show and ultrathink_answer.",
				pollAfterSec: CLIENT_POLL_AFTER_SEC,
			},
		};
	}
	return { ok: true, data: { sessionId, status, mode: "client", text: statusLine(status, status === "skipped" ? "skipped" : undefined) } };
}
