// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * What every transport of the connector builds the same way before it creates the tool host: the command catalog
 * and the UI resource registry. The HTTP router and the stdio server share these so a client sees one surface.
 */

import { GRAPH_APP_MIME, GRAPH_APP_URI, graphAppHtml, graphAppResourceMeta } from "../ui/graph-app.ts";
import { type CommandCatalog, loadCommandCatalog } from "./commands.ts";
import { type ResourceRegistry, createResourceRegistry } from "./resources.ts";
import { catalogFromOverlay } from "./tools-connector.ts";

/** The registry with the one resource the connector serves: the graph card. Throws when the document is invalid. */
export function defaultGraphResources(): ResourceRegistry {
	return createResourceRegistry([
		{
			uri: GRAPH_APP_URI,
			name: "ultrathink-graph",
			title: "UltraThink graph",
			description: "The Graph of Thought x Chain of Thought of a plan, drawn as an interactive card.",
			mimeType: GRAPH_APP_MIME,
			html: graphAppHtml,
			meta: graphAppResourceMeta(),
		},
	]);
}

/**
 * The catalog built from the real command files. A release without its commands/ and skills/ directories still
 * serves the static overlay instead of failing to start; `onFallback` receives the reason so the caller can log it.
 */
export function loadCatalogWithFallback(onFallback: (error: unknown) => void): CommandCatalog {
	try {
		return loadCommandCatalog();
	} catch (error) {
		onFallback(error);
		return catalogFromOverlay();
	}
}
