/** Measured character estimate. Not a provider count. */
export function estimateTokens(text: string): number {
	if (typeof text !== "string" || text.length === 0) return 0;
	return Math.ceil(text.length / 4);
}

/** 999, 1.2k, 1.2M. Never negative. */
export function formatTokens(n: number): string {
	const value = typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}
