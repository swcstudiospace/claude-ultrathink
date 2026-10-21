const MASK = "***";

/** Hide the password in a URL. Returns "invalid-url" for anything that does not parse. Never throws. */
export function redactUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.password !== "") parsed.password = MASK;
		return parsed.toString();
	} catch {
		return "invalid-url";
	}
}

/** Replace every occurrence of each non-empty secret with "***". Longest secrets first so no partial leak remains. */
export function redactText(text: string, secrets: readonly string[]): string {
	const ordered = secrets
		.filter((secret) => typeof secret === "string" && secret.length > 0)
		.sort((a, b) => b.length - a.length);
	let out = text;
	for (const secret of ordered) out = out.replaceAll(secret, MASK);
	return out;
}
