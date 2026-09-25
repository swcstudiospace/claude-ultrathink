// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Theme access and terminal-width helpers shared by the Omp bar, graph and message cards. */
// Capturing split: even parts are text runs, odd parts are ANSI CSI/OSC escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape matching
const ANSI_SPLIT = /(\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Terminal columns (ANSI stripped; wide CJK/emoji count 2). */
export function visibleWidth(text: string): number {
	return Bun.stringWidth(text);
}

/** ANSI-aware truncation to `width` terminal columns (measured per grapheme), ending with an ellipsis when cut. */
export function truncateToWidth(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 0) return "";
	const limit = width - 1;
	let out = "";
	let used = 0;
	fill: for (const [index, part] of text.split(ANSI_SPLIT).entries()) {
		if (index % 2 === 1) {
			out += part;
			continue;
		}
		for (const { segment } of GRAPHEMES.segment(part)) {
			const columns = Bun.stringWidth(segment);
			if (used + columns > limit) break fill;
			out += segment;
			used += columns;
		}
	}
	return `${out}…${text.includes("\x1b") ? "\x1b[0m" : ""}`;
}

interface ThemeLike {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	getFgAnsi(color: string): string;
	getBgAnsi(color: string): string;
	sep: Record<string, string>;
	status: Record<string, string>;
	icon: Record<string, string>;
	boxRound: Record<string, string>;
	getSpinnerFrames(kind: string): string[];
}

export interface BoxChars {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
}

export interface Paint {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	glyph(name: "success" | "error" | "warning" | "pending" | "running"): string;
	spinner(now: number): string;
	band(parts: string[]): { text: string; overhead: (count: number) => number };
	/** Rounded box-drawing chars from `theme.boxRound`; plain fallback when any is missing. */
	boxChars(): BoxChars;
	/** `theme.icon[name]` or "" when absent. */
	icon(name: string): string;
}

const PLAIN_GLYPHS = { success: "✓", error: "✗", warning: "!", pending: "○", running: "●" };
const PLAIN_BOX: BoxChars = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" };

/** Theme adapter: every access is guarded; any failure falls back to plain text. */
export function paint(theme: unknown): Paint {
	const t = theme as ThemeLike;
	const guard = <T>(fn: () => T, fallback: T): T => {
		try {
			const value = fn();
			return value ?? fallback;
		} catch {
			return fallback;
		}
	};
	return {
		fg: (color, text) => guard(() => t.fg(color, text), text),
		bg: (color, text) => guard(() => t.bg(color, text), text),
		bold: (text) => guard(() => t.bold(text), text),
		boxChars: () =>
			guard(() => {
				const { topLeft, topRight, bottomLeft, bottomRight, horizontal, vertical } = t.boxRound;
				const chars = { topLeft, topRight, bottomLeft, bottomRight, horizontal, vertical };
				return Object.values(chars).every((value) => typeof value === "string") ? chars : PLAIN_BOX;
			}, PLAIN_BOX),
		icon: (name) => guard(() => (typeof t.icon[name] === "string" ? t.icon[name] : ""), ""),
		glyph: (name) => guard(() => (typeof t.status[name] === "string" ? t.status[name] : PLAIN_GLYPHS[name]), PLAIN_GLYPHS[name]),
		spinner(now) {
			const frames = guard(() => t.getSpinnerFrames("activity"), [] as string[]);
			if (!Array.isArray(frames) || frames.length === 0) return PLAIN_GLYPHS.running;
			return frames[Math.floor(now / 100) % frames.length] ?? PLAIN_GLYPHS.running;
		},
		band(parts) {
			const styled = guard(() => {
				const bg = t.getBgAnsi("statusLineBg");
				const fg = t.getFgAnsi("text");
				const thin = t.sep.powerlineThinLeft;
				const sepColor = t.getFgAnsi("statusLineSep");
				if (typeof bg !== "string" || typeof fg !== "string" || typeof thin !== "string" || typeof sepColor !== "string") return undefined;
				// parts may reset colors; re-apply band colors after each part
				const body = `${bg}${fg} ${parts.map((part) => `${part}${bg}${fg}`).join(` ${sepColor}${thin}${fg} `)} \x1b[0m`;
				if (bg === "\x1b[49m") return { text: body, caps: 0, sep: visibleWidth(thin) + 2 };
				const capColor = bg.replace("\x1b[48;", "\x1b[38;");
				const open = t.sep.powerlineCapLeft ?? "";
				const close = t.sep.powerlineLeft ?? "";
				return { text: `${capColor}${open}\x1b[0m${body}${capColor}${close}\x1b[0m`, caps: visibleWidth(open) + visibleWidth(close), sep: visibleWidth(thin) + 2 };
			}, undefined);
			if (styled) return { text: styled.text, overhead: (count) => styled.caps + 2 + Math.max(0, count - 1) * styled.sep };
			return { text: parts.join(" │ "), overhead: (count) => Math.max(0, count - 1) * 3 };
		},
	};
}

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

