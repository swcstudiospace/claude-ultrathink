// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { MAX_UI_HTML_BYTES, UI_RESOURCE_MIME_TYPE, type UiResourceDescriptor, createResourceRegistry } from "./resources.ts";

const GRAPH_URI = "ui://ultrathink/graph";

function descriptor(overrides: Partial<UiResourceDescriptor> = {}): UiResourceDescriptor {
	return {
		uri: GRAPH_URI,
		name: "ultrathink-graph",
		title: "Ultrathink graph",
		description: "Interactive Graph of Thought view.",
		mimeType: UI_RESOURCE_MIME_TYPE,
		html: () => "<!doctype html><title>graph</title>",
		meta: { prefersBorder: true, csp: { connectDomains: [] } },
		...overrides,
	};
}

describe("createResourceRegistry", () => {
	test("lists descriptors with their ui metadata, in registration order", () => {
		const registry = createResourceRegistry([descriptor(), descriptor({ uri: "ui://ultrathink/other", name: "other", title: undefined, meta: {} })]);
		expect(registry.list()).toEqual([
			{
				uri: GRAPH_URI,
				name: "ultrathink-graph",
				title: "Ultrathink graph",
				description: "Interactive Graph of Thought view.",
				mimeType: "text/html;profile=mcp-app",
				_meta: { ui: { prefersBorder: true, csp: { connectDomains: [] } } },
			},
			{ uri: "ui://ultrathink/other", name: "other", description: "Interactive Graph of Thought view.", mimeType: "text/html;profile=mcp-app", _meta: { ui: {} } },
		]);
		// No title key at all when the descriptor has none.
		expect(Object.hasOwn(registry.list()[1] ?? {}, "title")).toBe(false);
	});

	test("reads a document with its MIME type and metadata", () => {
		const registry = createResourceRegistry([descriptor()]);
		expect(registry.read(GRAPH_URI)).toEqual({
			ok: true,
			contents: [{ uri: GRAPH_URI, mimeType: "text/html;profile=mcp-app", text: "<!doctype html><title>graph</title>", _meta: { ui: { prefersBorder: true, csp: { connectDomains: [] } } } }],
		});
	});

	test("an empty registry lists nothing and reads as not_found", () => {
		const registry = createResourceRegistry([]);
		expect(registry.list()).toEqual([]);
		expect(registry.read(GRAPH_URI)).toEqual({ ok: false, code: "not_found" });
	});

	test("an unknown ui:// uri is not_found", () => {
		const registry = createResourceRegistry([descriptor()]);
		expect(registry.read("ui://ultrathink/missing")).toEqual({ ok: false, code: "not_found" });
		expect(registry.read(`${GRAPH_URI}/`)).toEqual({ ok: false, code: "not_found" });
		expect(registry.read("ui://ultrathink/GRAPH")).toEqual({ ok: false, code: "not_found" });
	});

	test("anything that is not a ui:// uri string is invalid_uri, without throwing", () => {
		const registry = createResourceRegistry([descriptor()]);
		const invalid: unknown[] = [undefined, null, 0, 1, true, {}, [], [GRAPH_URI], () => GRAPH_URI, Symbol("uri"), 10n, "", "ui://", "http://example.com/graph", "file:///etc/passwd", "UI://ultrathink/graph", "ui://has space", "ui://tab\there", "ui://nul\u0000", "ui://new\nline", `ui://${"a".repeat(3000)}`, "__proto__", "constructor"];
		for (const uri of invalid) expect(registry.read(uri)).toEqual({ ok: false, code: "invalid_uri" });
	});

	test("html() runs on every read and its result is not cached", () => {
		let calls = 0;
		const registry = createResourceRegistry([descriptor({ html: () => `<p>build ${++calls}</p>` })]);
		// Creation validates once; list() never asks for the document.
		const afterCreate = calls;
		registry.list();
		expect(calls).toBe(afterCreate);
		const first = registry.read(GRAPH_URI);
		const second = registry.read(GRAPH_URI);
		expect(first.ok && first.contents[0].text).toBe(`<p>build ${afterCreate + 1}</p>`);
		expect(second.ok && second.contents[0].text).toBe(`<p>build ${afterCreate + 2}</p>`);
	});

	test("a document that turns invalid after startup is never served", () => {
		let html = "<p>ok</p>";
		const registry = createResourceRegistry([descriptor({ html: () => html })]);
		html = "";
		expect(() => registry.read(GRAPH_URI)).toThrow("non-empty");
		html = "x".repeat(MAX_UI_HTML_BYTES + 1);
		expect(() => registry.read(GRAPH_URI)).toThrow("exceeds");
	});

	test("callers cannot change the registry through what it returns", () => {
		const source = descriptor();
		const registry = createResourceRegistry([source]);
		(registry.list()[0]?._meta.ui as Record<string, unknown>).prefersBorder = false;
		const read = registry.read(GRAPH_URI);
		if (read.ok) (read.contents[0]._meta.ui as Record<string, unknown>).prefersBorder = false;
		source.meta.prefersBorder = false;
		expect(registry.list()[0]?._meta.ui.prefersBorder).toBe(true);
		const again = registry.read(GRAPH_URI);
		expect(again.ok && again.contents[0]._meta.ui.prefersBorder).toBe(true);
	});

	test("templates() is empty", () => {
		expect(createResourceRegistry([descriptor()]).templates()).toEqual([]);
	});

	describe("validation at creation", () => {
		const bad: [string, Partial<UiResourceDescriptor>, string][] = [
			["a non-ui uri", { uri: "https://example.com/graph" }, "ui://"],
			["a bare ui:// prefix", { uri: "ui://" }, "ui://"],
			["a uri with whitespace", { uri: "ui://a b" }, "ui://"],
			["a wrong MIME type", { mimeType: "text/html" }, "mimeType"],
			["the MIME type without its profile", { mimeType: "text/html;profile=other" }, "mimeType"],
			["an empty name", { name: "" }, "name"],
			["a non-string title", { title: 5 as unknown as string }, "title"],
			["a non-string description", { description: undefined as unknown as string }, "description"],
			["a missing html function", { html: undefined as unknown as () => string }, "html must be a function"],
			["an empty document", { html: () => "" }, "non-empty"],
			["a non-string document", { html: (() => 42) as unknown as () => string }, "non-empty"],
			["a document over 512 KiB", { html: () => "x".repeat(MAX_UI_HTML_BYTES + 1) }, "exceeds"],
			["array metadata", { meta: [] as unknown as Record<string, unknown> }, "meta"],
			["null metadata", { meta: null as unknown as Record<string, unknown> }, "meta"],
		];
		for (const [label, overrides, message] of bad) {
			test(`rejects ${label}`, () => {
				expect(() => createResourceRegistry([descriptor(overrides)])).toThrow(message);
			});
		}

		test("rejects a duplicate uri", () => {
			expect(() => createResourceRegistry([descriptor(), descriptor({ name: "again" })])).toThrow("duplicate");
		});

		test("rejects a descriptor that is not an object", () => {
			expect(() => createResourceRegistry([null as unknown as UiResourceDescriptor])).toThrow("object");
		});

		test("a document of exactly 512 KiB is accepted and counted in bytes, not characters", () => {
			const exact = "x".repeat(MAX_UI_HTML_BYTES);
			expect(createResourceRegistry([descriptor({ html: () => exact })]).read(GRAPH_URI).ok).toBe(true);
			// 3 bytes per character: well under the limit by length, over it by bytes.
			const wide = "€".repeat(Math.floor(MAX_UI_HTML_BYTES / 3) + 1);
			expect(wide.length).toBeLessThan(MAX_UI_HTML_BYTES);
			expect(() => createResourceRegistry([descriptor({ html: () => wide })])).toThrow("exceeds");
		});

		test("a throwing html() fails creation instead of the first read", () => {
			expect(() =>
				createResourceRegistry([
					descriptor({
						html: () => {
							throw new Error("build missing");
						},
					}),
				]),
			).toThrow("build missing");
		});
	});
});
