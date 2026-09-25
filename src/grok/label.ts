// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { GrokConfig } from "./types.ts";

/**
 * Engine label recorded in session state and echoed to the user, e.g.
 * `grok-4.7@xhigh` (proxy/cli transports) or `<shuntModel>@shunt` (shunt
 * transport, where the wire model alias carries the effort; an unset
 * `shuntModel` falls back to `model`, matching what is sent on the wire).
 */
export function grokEngineLabel(grok: Pick<GrokConfig, "model" | "reasoningEffort" | "transport" | "shuntModel">): string {
	if (grok.transport === "shunt") return `${grok.shuntModel.trim() || grok.model}@shunt`;
	return `${grok.model}@${grok.reasoningEffort}`;
}
