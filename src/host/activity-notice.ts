// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Display-only notice of what a substrate flow accessed. Shared by the planner progress event, the Omp card and the
 * observe receipt. No lesson bodies, skill bodies, paths, document ids, tokens or query text.
 */
import { redactLine } from "../teach/redact.ts";

export const ACTIVITY_KINDS = ["teachable-created", "teachable-recalled", "skill-recalled", "resource"] as const;
export const ACTIVITY_SOURCES = ["hindsight", "local", "substrate", "ragflow", "greptile"] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

export interface ActivityNotice {
	v: 1;
	kind: ActivityKind;
	title: string;
	source?: ActivitySource;
	outcome?: string;
	count?: number;
	names?: string[];
	detail?: string;
}

const NAME_CAP = 6;
const NAME_CHARS = 120;
const DETAIL_CHARS = 160;
const TITLE_CHARS = 120;
const OUTCOME_CHARS = 40;
const CONTROLS = /[\u0000-\u001f\u007f]/g;
const ABSOLUTE_PATH = /(?<![\w.~/])~?\/[^\s]+/g;

/** Redact, drop paths and controls. A redaction throw drops the field. */
function scrub(value: unknown, max: number): string | undefined {
	if (typeof value !== "string" || value === "") return undefined;
	try {
		const cleaned = redactLine(value, max).replace(ABSOLUTE_PATH, " ").replace(CONTROLS, "").replace(/\s+/g, " ").trim().slice(0, max);
		return cleaned === "" ? undefined : cleaned;
	} catch {
		return undefined;
	}
}

function kindOf(value: unknown): ActivityKind | undefined {
	return typeof value === "string" && ACTIVITY_KINDS.includes(value as ActivityKind) ? (value as ActivityKind) : undefined;
}

function sourceOf(value: unknown): ActivitySource | undefined {
	return typeof value === "string" && ACTIVITY_SOURCES.includes(value as ActivitySource) ? (value as ActivitySource) : undefined;
}

/** Validated, bounded notice. Undefined when the value is not a v1 activity notice. Never throws. */
export function toActivityNotice(value: unknown): ActivityNotice | undefined {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		if (!("v" in value) || value.v !== 1) return undefined;
		if (!("kind" in value) || !("title" in value)) return undefined;
		const kind = kindOf(value.kind);
		const title = scrub(value.title, TITLE_CHARS);
		if (!kind || !title) return undefined;
		const notice: ActivityNotice = { v: 1, kind, title };
		if ("source" in value) {
			const source = sourceOf(value.source);
			if (source) notice.source = source;
		}
		if ("outcome" in value) {
			const outcome = scrub(value.outcome, OUTCOME_CHARS);
			if (outcome) notice.outcome = outcome;
		}
		if ("count" in value && typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 0 && value.count <= Number.MAX_SAFE_INTEGER) {
			notice.count = value.count;
		}
		if ("names" in value && Array.isArray(value.names)) {
			const names: string[] = [];
			for (const name of value.names) {
				if (names.length >= NAME_CAP) break;
				const cleaned = scrub(name, NAME_CHARS);
				if (cleaned) names.push(cleaned);
			}
			if (names.length > 0) notice.names = names;
		}
		if ("detail" in value) {
			const detail = scrub(value.detail, DETAIL_CHARS);
			if (detail) notice.detail = detail;
		}
		return notice;
	} catch {
		return undefined;
	}
}
