import { normalizeQuestion } from "./pipeline.ts";
import type { Clarification, ClarificationOption } from "./types.ts";

export interface AskUserQuestionInput {
	questions?: {
		question?: string;
		header?: string;
		options?: { label?: string; description?: string }[];
		multiSelect?: boolean;
	}[];
}

export interface AskUserQuestionResponse {
	answers?: Record<string, string>;
	response?: string;
}

interface AskedQuestion {
	question: string;
	header: string;
	options: ClarificationOption[];
}

function askedQuestions(input: AskUserQuestionInput | undefined): AskedQuestion[] {
	const asked: AskedQuestion[] = [];
	for (const raw of input?.questions ?? []) {
		const question = raw.question?.trim() ?? "";
		if (!question) continue;
		const options: ClarificationOption[] = [];
		for (const option of raw.options ?? []) {
			const label = option.label?.trim() ?? "";
			if (!label) continue;
			const description = option.description?.trim();
			options.push(description ? { label, description } : { label });
		}
		asked.push({ question, header: raw.header?.trim() || "Asked", options });
	}
	return asked;
}

function findMatch(list: Clarification[], key: string): Clarification | undefined {
	const wanted = normalizeQuestion(key);
	if (!wanted) return undefined;
	const exact = list.find((item) => normalizeQuestion(item.question) === wanted);
	if (exact) return exact;
	return list.find((item) => {
		const have = normalizeQuestion(item.question);
		return have.length > 0 && (have.includes(wanted) || wanted.includes(have));
	});
}

function newClarification(id: string, asked: AskedQuestion | undefined, question: string, answer: string, now: number): Clarification {
	return {
		id,
		question,
		header: asked?.header ?? "Asked",
		why: "Asked by the agent during execution",
		options: asked?.options ?? [],
		blocking: false,
		answer,
		answeredAt: now,
		source: "user",
	};
}

/**
 * Pure: folds an AskUserQuestion tool call plus its response into the clarification list.
 * Returns a new list (input untouched) and the items whose answer was set by this call.
 */
export function applyAnswers(
	list: Clarification[],
	input: AskUserQuestionInput | undefined,
	response: AskUserQuestionResponse | string | undefined,
	now: number,
): { list: Clarification[]; matched: Clarification[] } {
	const next = list.map((item) => ({ ...item, options: item.options.map((option) => ({ ...option })) }));
	const matched: Clarification[] = [];
	const asked = askedQuestions(input);

	const record = (target: Clarification, answer: string): void => {
		target.answer = answer;
		target.answeredAt = now;
		target.source = "user";
		if (!matched.includes(target)) matched.push(target);
	};

	const append = (from: AskedQuestion | undefined, question: string, answer: string): void => {
		const item = newClarification(`q${next.length + 1}`, from, question, answer, now);
		next.push(item);
		matched.push(item);
	};

	const settle = (key: string, answer: string): void => {
		const text = answer.trim();
		if (!text) return;
		const target = findMatch(next, key);
		if (target) {
			record(target, text);
			return;
		}
		const askedItem = asked.find((item) => normalizeQuestion(item.question) === normalizeQuestion(key));
		append(askedItem, askedItem?.question ?? key.trim(), text);
	};

	if (typeof response === "string") {
		const text = response.trim();
		if (text) {
			const unanswered = asked.filter((item) => {
				const target = findMatch(next, item.question);
				return !target || target.answer === undefined;
			});
			if (unanswered.length === 1) settle(unanswered[0]!.question, text);
			else append(undefined, "Free-form response", text);
		}
		return { list: next, matched };
	}

	const answers = response?.answers;
	if (answers && typeof answers === "object") {
		for (const [key, value] of Object.entries(answers)) {
			if (typeof value === "string") settle(key, value);
		}
	}

	const freeform = response?.response?.trim() ?? "";
	if (freeform) {
		const pending = asked
			.map((item) => findMatch(next, item.question))
			.find((item): item is Clarification => item !== undefined && item.answer === undefined);
		if (pending) record(pending, freeform);
		else append(undefined, "Free-form response", freeform);
	}

	return { list: next, matched };
}
