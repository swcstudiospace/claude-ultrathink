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
	source?: "user" | "assumed";
}

export interface HitlConfig {
	enabled: boolean;
	maxQuestions: number;
}

export const MAX_QUESTIONS = 4;
export const MAX_HEADER_CHARS = 12;

export const DEFAULT_HITL_CONFIG: HitlConfig = { enabled: true, maxQuestions: MAX_QUESTIONS };
