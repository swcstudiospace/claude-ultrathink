// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Generic registry behind the MCP `resources` capability. It serves `ui://` documents (MCP Apps: self-contained HTML a
 * host renders in a sandboxed frame) and knows nothing about which documents exist: the caller injects descriptors, so
 * this module never imports the UI sources. Lookups report failure as data; the protocol error code that goes with
 * `not_found` depends on the negotiated revision and is chosen by the caller.
 */

/** MIME type MCP Apps hosts require for an embeddable HTML resource. */
export const UI_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
export const UI_URI_PREFIX = "ui://";
/** Largest document served, in UTF-8 bytes. */
export const MAX_UI_HTML_BYTES = 512 * 1024;
const MAX_URI_CHARS = 2048;

export interface UiResourceDescriptor {
	uri: string;
	name: string;
	title?: string;
	description: string;
	mimeType: string;
	/** Called on every read, so a rebuilt document is served without restarting the registry. */
	html(): string;
	/** Published under `_meta.ui` (CSP, permissions, border preference). Copied when the registry is created. */
	meta: Record<string, unknown>;
}

export interface UiResourceMeta {
	ui: Record<string, unknown>;
}

export interface UiResourceListing {
	uri: string;
	name: string;
	title?: string;
	description: string;
	mimeType: string;
	_meta: UiResourceMeta;
}

export interface UiResourceContents {
	uri: string;
	mimeType: string;
	text: string;
	_meta: UiResourceMeta;
}

export type ResourceReadResult = { ok: true; contents: [UiResourceContents] } | { ok: false; code: "not_found" | "invalid_uri" };

export interface ResourceRegistry {
	list(): UiResourceListing[];
	/** Never throws for a bad `uri`, whatever its type. */
	read(uri: unknown): ResourceReadResult;
	/** The registry has no URI templates. */
	templates(): never[];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is rejected
const UNSAFE_URI_CHARS = /[\u0000-\u0020\u007f-\u009f]/;

function isWellFormedUri(uri: unknown): uri is string {
	return typeof uri === "string" && uri.length > UI_URI_PREFIX.length && uri.length <= MAX_URI_CHARS && uri.startsWith(UI_URI_PREFIX) && !UNSAFE_URI_CHARS.test(uri);
}

/** The descriptor's document, or an error naming the descriptor; shared by creation and every read. */
function renderHtml(descriptor: UiResourceDescriptor): string {
	const html = descriptor.html();
	if (typeof html !== "string" || html.length === 0) throw new Error(`resource ${descriptor.uri}: html() must return a non-empty string`);
	if (Buffer.byteLength(html, "utf8") > MAX_UI_HTML_BYTES) throw new Error(`resource ${descriptor.uri}: html() exceeds ${MAX_UI_HTML_BYTES} bytes`);
	return html;
}

function validate(descriptor: UiResourceDescriptor, seen: Set<string>): void {
	if (typeof descriptor !== "object" || descriptor === null) throw new Error("resource descriptor must be an object");
	if (!isWellFormedUri(descriptor.uri)) throw new Error(`resource uri must be a ${UI_URI_PREFIX} uri without whitespace or control characters`);
	if (seen.has(descriptor.uri)) throw new Error(`duplicate resource uri ${descriptor.uri}`);
	if (typeof descriptor.name !== "string" || descriptor.name.length === 0) throw new Error(`resource ${descriptor.uri}: name must be a non-empty string`);
	if (descriptor.title !== undefined && typeof descriptor.title !== "string") throw new Error(`resource ${descriptor.uri}: title must be a string`);
	if (typeof descriptor.description !== "string") throw new Error(`resource ${descriptor.uri}: description must be a string`);
	if (descriptor.mimeType !== UI_RESOURCE_MIME_TYPE) throw new Error(`resource ${descriptor.uri}: mimeType must be ${UI_RESOURCE_MIME_TYPE}`);
	if (typeof descriptor.html !== "function") throw new Error(`resource ${descriptor.uri}: html must be a function`);
	if (typeof descriptor.meta !== "object" || descriptor.meta === null || Array.isArray(descriptor.meta)) throw new Error(`resource ${descriptor.uri}: meta must be an object`);
	renderHtml(descriptor);
}

/**
 * Validates every descriptor (throws on the first invalid one: a broken document must stop the server at startup, not
 * surface on a client's first read) and returns the registry. Listing order is registration order.
 */
export function createResourceRegistry(descriptors: readonly UiResourceDescriptor[]): ResourceRegistry {
	const seen = new Set<string>();
	const entries = new Map<string, { descriptor: UiResourceDescriptor; meta: Record<string, unknown> }>();
	for (const descriptor of descriptors) {
		validate(descriptor, seen);
		seen.add(descriptor.uri);
		entries.set(descriptor.uri, { descriptor, meta: structuredClone(descriptor.meta) });
	}

	return {
		list() {
			return [...entries.values()].map(({ descriptor, meta }) => ({
				uri: descriptor.uri,
				name: descriptor.name,
				...(descriptor.title === undefined ? {} : { title: descriptor.title }),
				description: descriptor.description,
				mimeType: descriptor.mimeType,
				_meta: { ui: structuredClone(meta) },
			}));
		},

		read(uri) {
			if (!isWellFormedUri(uri)) return { ok: false, code: "invalid_uri" };
			const entry = entries.get(uri);
			if (!entry) return { ok: false, code: "not_found" };
			// Re-checked on every read: html() is free to change between calls, and a corrupt document must not be served.
			const text = renderHtml(entry.descriptor);
			return { ok: true, contents: [{ uri, mimeType: entry.descriptor.mimeType, text, _meta: { ui: structuredClone(entry.meta) } }] };
		},

		templates() {
			return [];
		},
	};
}
