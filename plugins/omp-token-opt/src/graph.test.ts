import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runGraphify, setGraphifyBinForTests } from "./graph.ts";

describe("runGraphify", () => {
	test("missing binary returns an error string and a cache hit does not spawn", async () => {
		const root = mkdtempSync(join(tmpdir(), "graphify-"));
		const binDir = join(root, "bin");
		mkdirSync(binDir);
		const log = join(root, "calls");
		const script = join(binDir, "graphify");
		writeFileSync(script, `#!/bin/sh\necho call >> ${JSON.stringify(log)}\necho ok\nexit 0\n`);
		chmodSync(script, 0o755);
		try {
			setGraphifyBinForTests(null);
			const missing = await runGraphify(root, ["query", "absent"]);
			expect(missing.exitCode).toBe(127);
			expect(missing.cached).toBe(false);
			expect(missing.text).toContain("not found");
			expect(missing.ms).toBeGreaterThanOrEqual(0);

			setGraphifyBinForTests(script);
			const cwd = join(root, "proj");
			mkdirSync(cwd);
			const first = await runGraphify(cwd, ["query", "same"]);
			const second = await runGraphify(cwd, ["query", "same"]);
			expect(first.cached).toBe(false);
			expect(first.exitCode).toBe(0);
			expect(second.cached).toBe(true);
			expect(second.text).toBe(first.text);
			expect(second.exitCode).toBe(0);
			expect(second.ms).toBeGreaterThanOrEqual(0);
			expect(readFileSync(log, "utf8").trim().split("\n").filter(Boolean)).toEqual(["call"]);

			writeFileSync(script, `#!/bin/sh\necho call >> ${JSON.stringify(log)}\necho no\nexit 1\n`);
			const fail1 = await runGraphify(cwd, ["explain", "missing"]);
			const fail2 = await runGraphify(cwd, ["explain", "missing"]);
			expect(fail1.cached).toBe(false);
			expect(fail2.cached).toBe(false);
			expect(readFileSync(log, "utf8").trim().split("\n").filter(Boolean)).toEqual(["call", "call", "call"]);
		} finally {
			setGraphifyBinForTests(null);
		}
	});

	test("missing graph.json with override unset does not spawn; a set override still spawns", async () => {
		const root = mkdtempSync(join(tmpdir(), "graphify-miss-"));
		const binDir = join(root, "bin");
		mkdirSync(binDir);
		const log = join(root, "calls");
		const script = join(binDir, "graphify");
		writeFileSync(script, `#!/bin/sh\necho call >> ${JSON.stringify(log)}\necho ok\nexit 0\n`);
		chmodSync(script, 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = `${binDir}${previousPath ? `:${previousPath}` : ""}`;
		try {
			setGraphifyBinForTests(undefined);
			const cwd = join(root, "proj");
			mkdirSync(cwd);
			const missing = await runGraphify(cwd, ["query", "where"]);
			expect(missing.exitCode).toBe(2);
			expect(missing.cached).toBe(false);
			expect(missing.text).toBe("graphify: no graph.json; run graphify extract first");
			expect(existsSync(log)).toBe(false);

			setGraphifyBinForTests(script);
			const spawned = await runGraphify(cwd, ["path", "a", "b"]);
			expect(spawned.exitCode).toBe(0);
			expect(spawned.cached).toBe(false);
			expect(readFileSync(log, "utf8").trim()).toBe("call");
		} finally {
			process.env.PATH = previousPath;
			setGraphifyBinForTests(null);
		}
	});
});
