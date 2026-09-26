// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
export interface ClarificationOption {
	label: string;
	description?: string;
}

export interface Clarification {
	id: string;
	question: string;
	header: string;
	why: string;
	options: ClarificationOption[];
	default?: string;
	blocking: boolean;
	answer?: string;
	answeredAt?: number;
	source?: "user" | "assumed" | "knowledge";
	/** Knowledge-base document that settled this question (source "knowledge"). */
	evidence?: string;
}

export interface HitlConfig {
	enabled: boolean;
	maxQuestions: number;
	/** Read the repository's Greptile knowledge base before composing questions (opt-in). */
	knowledgeBase: boolean;
}

export const MAX_QUESTIONS = 4;
export const MAX_HEADER_CHARS = 12;
/** Most knowledge-base-settled questions one clarify pass records. */
export const MAX_SETTLED = 4;

export const DEFAULT_HITL_CONFIG: HitlConfig = { enabled: true, maxQuestions: MAX_QUESTIONS, knowledgeBase: false };
