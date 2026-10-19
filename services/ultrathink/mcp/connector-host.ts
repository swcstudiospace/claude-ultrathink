// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * What every transport of the connector builds the same way before it creates the tool host: the command catalog
 * and the UI resource registry. The HTTP router and the stdio server share these so a client sees one surface.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { GRAPH_APP_MIME, GRAPH_APP_URI, graphAppHtml, graphAppResourceMeta } from "../ui/graph-app.ts";
import { type CommandCatalog, loadCommandCatalog, REPOSITORY_ROOT } from "./commands.ts";
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

/** Whether a directory is missing; every other failure to look (permissions, a file in its place of a parent) is rethrown. */
function isAbsent(path: string): boolean {
	try {
		statSync(path);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}

/**
 * The catalog built from the real command files. A release without its commands/ and skills/ directories still
 * serves the static overlay instead of failing to start; `onFallback` receives the reason so the caller can log it.
 * Only that absence falls back: drift, a name collision, a malformed entry or an unreadable file throws, so a release
 * never serves silently degraded descriptions.
 */
export function loadCatalogWithFallback(onFallback: (error: unknown) => void, root: string = REPOSITORY_ROOT): CommandCatalog {
	if (isAbsent(join(root, "commands")) && isAbsent(join(root, "skills"))) {
		onFallback(new Error(`command sources are absent under ${root}`));
		return catalogFromOverlay();
	}
	return loadCommandCatalog(root);
}
