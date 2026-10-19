import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRAPH_POINTER, pointerFor } from "./pointer.ts";

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("pointerFor", () => {
	test("returns GRAPH_POINTER when the real graphify-out/graph.json exists", () => {
		const root = mkdtempSync(join(tmpdir(), "pointer-yes-"));
		roots.push(root);
		mkdirSync(join(root, "graphify-out"));
		writeFileSync(join(root, "graphify-out", "graph.json"), "{}");
		expect(pointerFor(root)).toBe(GRAPH_POINTER);
	});

	test("returns null when the directory exists but graph.json is absent", () => {
		const root = mkdtempSync(join(tmpdir(), "pointer-dir-"));
		roots.push(root);
		mkdirSync(join(root, "graphify-out"));
		writeFileSync(join(root, "graphify-out", "graph.html"), "<html></html>");
		expect(pointerFor(root)).toBeNull();
	});

	test("returns null when no graphify-out directory exists", () => {
		const root = mkdtempSync(join(tmpdir(), "pointer-none-"));
		roots.push(root);
		expect(pointerFor(root)).toBeNull();
	});

	test("checks the exact joined graph.json path through the injected exists", () => {
		const checked: string[] = [];
		const result = pointerFor("/some/project", (path) => {
			checked.push(path);
			return true;
		});
		expect(checked).toEqual([join("/some/project", "graphify-out", "graph.json")]);
		expect(result).toBe(GRAPH_POINTER);
	});

	test("fails open to null when the injected exists throws", () => {
		const result = pointerFor("/some/project", () => {
			throw new Error("boom");
		});
		expect(result).toBeNull();
	});
});

describe("GRAPH_POINTER", () => {
	test("contains no digits", () => {
		expect(/\d/.test(GRAPH_POINTER)).toBe(false);
	});
});
