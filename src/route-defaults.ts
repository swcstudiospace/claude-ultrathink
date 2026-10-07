// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The one version-controlled source of built-in planning models for the legacy CLI routes (AD-1). Keyed by route, not by
 * credential provider: each entry is the wire model a route sends when no config layer pins one, and each entry can be
 * changed on its own without touching resolution logic. The native Omp path never reads this map; its defaults come from
 * the host (exact-provider configured selector, then the installed host catalog). Leaf module: no imports, so config and
 * the Grok and Muse types can reference it without cycles.
 */

/** A legacy planning route: the CLI or proxy transport family a named or host-routed engine runs on. */
export type LegacyRoute = "claude" | "grok" | "muse";

export const ROUTE_DEFAULT_MODELS: Readonly<Record<LegacyRoute, string>> = Object.freeze({
	claude: "sonnet",
	grok: "grok-4.7",
	muse: "muse-spark-1.3-contributor",
});
