// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeConfigPaths, defaultConfig, loadConfig } from "../config.ts";
import { checkConfig, suggestName } from "./config-check.ts";
import { buildReport, formatReport, reportJson } from "./report.ts";
import type { DoctorDeps, Finding } from "./types.ts";

const FAKE_KEY = "sk-test-not-a-real-key";

type Layer = "user" | "claude" | "project";

describe("checkConfig", () => {
	let dir: string;
	let deps: DoctorDeps;

	function path(layer: Layer): string {
		if (layer === "user") return join(dir, "xdg", "ultrathink", "config.json");
		if (layer === "claude") return join(dir, "claude", "ultrathink.json");
		return join(dir, "project", ".claude", "ultrathink.json");
	}

	function write(layer: Layer, content: unknown): void {
		mkdirSync(dirname(path(layer)), { recursive: true });
		writeFileSync(path(layer), typeof content === "string" ? content : JSON.stringify(content));
	}

	function aboveInfo(findings: Finding[]): Finding[] {
		return findings.filter((finding) => finding.level === "warn" || finding.level === "error");
	}

	function byId(findings: Finding[], id: string): Finding {
		const found = findings.find((finding) => finding.id === id);
		if (!found) throw new Error(`no finding ${id} in ${findings.map((finding) => finding.id).join(", ")}`);
		return found;
	}

	/** `defaultConfig()` as a user would write it: everything except the in-memory model provenance. */
	function defaultsAsFile(): Record<string, unknown> {
		const file: Record<string, unknown> = { ...defaultConfig() };
		delete file.modelProvenance;
		return file;
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-doctor-config-"));
		mkdirSync(join(dir, "project"), { recursive: true });
		deps = {
			env: { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg"), CLAUDE_CONFIG_DIR: join(dir, "claude") },
			cwd: join(dir, "project"),
			now: () => 0,
			which: () => undefined,
			bunVersion: "1.2.0",
			runVersion: () => undefined,
		};
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("a missing file is info, never an error", () => {
		const findings = checkConfig(deps);
		expect(findings.map((finding) => [finding.id, finding.level])).toEqual([
			["config.user.missing", "info"],
			["config.claude-user.missing", "info"],
			["config.project.missing", "info"],
		]);
		expect(byId(findings, "config.project.missing").detail).toContain(path("project"));
	});

	test.each<Layer>(["user", "claude", "project"])("a %s file written from defaultConfig() has nothing above info (guards schema drift)", (layer) => {
		write(layer, defaultsAsFile());
		const findings = checkConfig(deps);
		expect(aboveInfo(findings)).toEqual([]);
		expect(findings.some((finding) => finding.id.includes("project-restricted"))).toBe(false);
		expect(findings.some((finding) => finding.level === "ok")).toBe(true);
	});

	test("documented pstack.cursorDir and pstack.mapping are known settings", () => {
		write("user", {
			pstack: { enabled: true, cursorDir: "/opt/cursor", mapping: { plan: ["how"], review: ["interrogate"] } },
		});
		const findings = checkConfig(deps);
		expect(findings.filter((finding) => finding.id.includes("unknown"))).toEqual([]);
		expect(aboveInfo(findings)).toEqual([]);
	});

	test("every default key is known, so a new default key needs no edit here", () => {
		const defaults = defaultsAsFile();
		const keys = Object.entries(defaults).flatMap(([section, value]) => Object.keys(value as Record<string, unknown>).map((key) => `${section}.${key}`));
		expect(keys.length).toBeGreaterThan(50);
		write("user", defaults);
		expect(checkConfig(deps).filter((finding) => finding.id.includes("unknown"))).toEqual([]);
	});

	test("a key written with the value it already defaults to, padded or with a trailing slash, is not a finding", () => {
		write("user", { grok: { baseUrl: `${defaultConfig().grok.baseUrl}/`, bin: "  grok " }, ship: { autoMerge: false } });
		expect(aboveInfo(checkConfig(deps))).toEqual([]);
	});

	test.each<"direct" | "gateway">(["direct", "gateway"])("supported optional %s backends are known and honored in user layers", (backend) => {
		write("user", { hindsight: { backend: "gateway" }, ragflow: { backend: "gateway" }, substrate: { backend: "gateway" } });
		write("claude", { hindsight: { backend }, ragflow: { backend }, substrate: { backend } });
		const findings = checkConfig(deps);
		expect(aboveInfo(findings)).toEqual([]);
		expect(findings.filter((finding) => finding.id.includes("unknown-key"))).toEqual([]);
		const effective = loadConfig(claudeConfigPaths(deps.cwd, deps.env));
		for (const section of ["hindsight", "ragflow", "substrate"] as const) {
			expect(effective[section].backend ?? "direct").toBe(backend);
		}
	});

	test("invalid optional backend choices warn with the retained effective selection, not an unknown key", () => {
		write("user", { hindsight: { backend: "gateway" }, ragflow: { backend: "gateway" } });
		write("claude", { hindsight: { backend: "auto" }, ragflow: { backend: " gateway " }, substrate: { backend: " direct " } });
		const findings = checkConfig(deps);
		expect(findings.filter((finding) => finding.id.includes("unknown-key"))).toEqual([]);
		for (const section of ["hindsight", "ragflow", "substrate"]) {
			expect(byId(findings, `config.claude-user.ignored.${section}.backend`)).toMatchObject({ level: "warn" });
			expect(byId(findings, `config.claude-user.ignored.${section}.backend`).title).toContain(
				`effective value is "${section === "substrate" ? "direct" : "gateway"}"`,
			);
		}
		write("claude", { hindsight: { backend: false }, ragflow: { backend: [] }, substrate: { backend: null } });
		const wrongTypes = checkConfig(deps);
		for (const section of ["hindsight", "ragflow", "substrate"]) {
			expect(byId(wrongTypes, `config.claude-user.wrong-type.${section}.backend`).level).toBe("warn");
		}
	});

	test("project optional backends retain the lower selection and report the existing restriction IDs", () => {
		write("user", { hindsight: { backend: "gateway" }, ragflow: { backend: "gateway" }, substrate: { backend: "gateway" } });
		write("project", { hindsight: { backend: "direct" }, ragflow: { backend: "direct" }, substrate: { backend: "direct" } });
		const findings = checkConfig(deps);
		expect(aboveInfo(findings)).toEqual([]);
		const effective = loadConfig(claudeConfigPaths(deps.cwd, deps.env));
		for (const section of ["hindsight", "ragflow", "substrate"] as const) {
			expect(byId(findings, `config.project.project-restricted.${section}.backend`).level).toBe("info");
			expect(effective[section].backend).toBe("gateway");
		}
	});

	test("adjusted values use all preceding layers rather than fresh defaults", () => {
		write("user", { ship: { minScore: 4 }, hindsight: { enabled: true }, teach: { recallLimit: 8 } });
		write("claude", { ship: { minScore: 3 }, teach: { recallLimit: 99 } });
		write("project", { ship: { minScore: 6 }, hindsight: { enabled: false }, teach: { recallLimit: 9 } });
		const findings = checkConfig(deps);
		expect(byId(findings, "config.claude-user.ignored.teach.recallLimit").title).toContain("effective value is 8");
		expect(byId(findings, "config.project.ignored.ship.minScore").title).toContain("effective value is 3");
		expect(byId(findings, "config.project.project-restricted.teach.recallLimit").level).toBe("info");
		expect(findings.some((finding) => finding.id.endsWith("hindsight.enabled"))).toBe(false);
		const effective = loadConfig(claudeConfigPaths(deps.cwd, deps.env));
		expect(effective.ship.minScore).toBe(3);
		expect(effective.teach.recallLimit).toBe(8);
		expect(effective.hindsight.enabled).toBe(false);
	});

	test.each(["missing", "invalid-json", "not-object", "unreadable"] as const)("a %s intermediate layer preserves lower effective values", (kind) => {
		write("user", { ship: { minScore: 4 } });
		if (kind === "invalid-json") write("claude", "{");
		else if (kind === "not-object") write("claude", []);
		else if (kind === "unreadable") mkdirSync(path("claude"), { recursive: true });
		write("project", { ship: { minScore: 6 } });
		const findings = checkConfig(deps);
		expect(byId(findings, `config.claude-user.${kind}`).level).toBe(kind === "missing" ? "info" : "error");
		expect(byId(findings, "config.project.ignored.ship.minScore").title).toContain("effective value is 4");
		expect(loadConfig(claudeConfigPaths(deps.cwd, deps.env)).ship.minScore).toBe(4);
	});

	test("ship.autoMerg is an unknown key and suggests ship.autoMerge", () => {
		write("user", { ship: { autoMerg: true } });
		const finding = byId(checkConfig(deps), "config.user.unknown-key.ship.autoMerg");
		expect(finding.level).toBe("warn");
		expect(finding.title).toContain("ship.autoMerg");
		expect(finding.fix).toBe("Did you mean ship.autoMerge?");
	});

	test("a section typo is an unknown section and suggests the section", () => {
		write("claude", { shipp: { enabled: true } });
		const finding = byId(checkConfig(deps), "config.claude-user.unknown-section.shipp");
		expect(finding.level).toBe("warn");
		expect(finding.fix).toBe("Did you mean ship?");
	});

	test("an unknown key with nothing close has no suggestion", () => {
		write("user", { ship: { zzzzzz: 1 } });
		const finding = byId(checkConfig(deps), "config.user.unknown-key.ship.zzzzzz");
		expect(finding.fix).toBeUndefined();
	});

	test("modelProvenance is internal, not a typo of models", () => {
		write("user", { modelProvenance: { claude: "file-pin" } });
		const finding = byId(checkConfig(deps), "config.user.unknown-section.modelProvenance");
		expect(finding.fix).toBeUndefined();
		expect(finding.detail).toContain("never read from a file");
	});

	test("hitl.maxQuestions out of range names the effective value", () => {
		write("project", { hitl: { maxQuestions: 9 } });
		const finding = byId(checkConfig(deps), "config.project.ignored.hitl.maxQuestions");
		expect(finding.level).toBe("warn");
		expect(finding.title).toContain(`effective value is ${defaultConfig().hitl.maxQuestions}`);
	});

	test("an effective value that differs from the written one is named for numbers, enums and arrays", () => {
		write("user", { ship: { mergeMethod: "fast-forward", skills: ["gsd-", 7], minScore: 6 }, think: { engine: "gpt" } });
		const findings = checkConfig(deps);
		expect(byId(findings, "config.user.ignored.ship.mergeMethod").title).toContain('"squash"');
		expect(byId(findings, "config.user.ignored.ship.skills").title).toContain('["gsd-"]');
		expect(byId(findings, "config.user.ignored.ship.minScore").title).toContain("effective value is 5");
		expect(byId(findings, "config.user.ignored.think.engine").title).toContain('"auto"');
	});

	test.each([
		["plain", "doctor-dummy-user", "doctor-dummy-password"],
		["encoded", "%64%6f%63%74%6f%72%2d%64%75%6d%6d%79%2d%75%73%65%72", "%64%6f%63%74%6f%72%2d%64%75%6d%6d%79%2d%70%61%73%73%77%6f%72%64"],
		["username-only", "doctor-dummy-user", ""],
		["password-only", "", "doctor-dummy-password"],
		["long", "doctor-dummy-user", `doctor-dummy-password${"x".repeat(100)}`],
	])("%s URL credentials never reach either doctor report format", (_name, username, password) => {
		const lowerUrl = `https://${username}${password ? `:${password}` : ""}@gateway.test/api`;
		write("user", { substrate: { url: lowerUrl } });
		write("claude", { substrate: { url: "not-a-url" } });
		const findings = checkConfig(deps);
		const finding = byId(findings, "config.claude-user.ignored.substrate.url");
		expect(finding.level).toBe("warn");
		expect(finding.title).toContain("effective value");
		expect(finding.title).toContain("gateway.test");
		const report = buildReport(findings);
		for (const output of [formatReport(report), reportJson(report)]) {
			expect(output).toContain("substrate.url");
			expect(output).toContain("ignored");
			expect(output).toContain("gateway.test");
			for (const secret of ["doctor-dummy-user", "doctor-dummy-password", username, password].filter(Boolean)) {
				expect(output).not.toContain(secret);
				expect(decodeURIComponent(output)).not.toContain(decodeURIComponent(secret));
			}
		}
		// Only diagnostics change: the lower credential-bearing URL remains the runtime selection.
		expect(loadConfig(claudeConfigPaths(deps.cwd, deps.env)).substrate.url).toBe(lowerUrl);
	});

	test("a wrong type is reported with the expected and the actual type", () => {
		write("user", { ship: { autoMerge: "yes", skills: "gsd-" }, hitl: "on" });
		const findings = checkConfig(deps);
		expect(byId(findings, "config.user.wrong-type.ship.autoMerge").title).toContain("expected boolean, got string");
		expect(byId(findings, "config.user.wrong-type.ship.skills").title).toContain("expected array, got string");
		expect(byId(findings, "config.user.wrong-type.hitl").title).toContain("expected object, got string");
	});

	test("decisions.enabled false gets the special message, in a user and a project file", () => {
		write("user", { decisions: { enabled: false } });
		write("project", { decisions: { enabled: false } });
		const findings = checkConfig(deps);
		for (const layer of ["user", "project"]) {
			const finding = byId(findings, `config.${layer}.ignored.decisions.enabled`);
			expect(finding.level).toBe("warn");
			expect(finding.title).toContain("Jev is always on; set ULTRATHINK_DECISIONS=0 to turn it off");
		}
	});

	test("invalid JSON is an error with the path and the parse message, never the file content", () => {
		write("user", `{"k": ${FAKE_KEY}}`);
		const finding = byId(checkConfig(deps), "config.user.invalid-json");
		expect(finding.level).toBe("error");
		expect(finding.detail).toContain(path("user"));
		expect(finding.detail).toContain("JSON Parse error");
		expect(JSON.stringify(finding)).not.toContain("sk-test");
	});

	test("an empty file and a non-object top level are errors", () => {
		write("user", "");
		write("claude", [1, 2]);
		write("project", "null");
		const findings = checkConfig(deps);
		expect(byId(findings, "config.user.invalid-json").level).toBe("error");
		expect(byId(findings, "config.claude-user.not-object").title).toContain("top level is array");
		expect(byId(findings, "config.project.not-object").level).toBe("error");
	});

	test("a path that is not a readable file is an error naming the code", () => {
		mkdirSync(path("user"), { recursive: true });
		const finding = byId(checkConfig(deps), "config.user.unreadable");
		expect(finding.level).toBe("error");
		expect(finding.title).toContain("EISDIR");
	});

	test("a project file that sets keys a repository must not control gets the by-design info, not a warning", () => {
		write("project", {
			hindsight: { url: "https://hindsight.example", enabled: true },
			teach: { recallLimit: 9 },
			decisions: { zdr: false },
			ragflow: { ground: true, url: "https://ragflow.example" },
		});
		const findings = checkConfig(deps);
		expect(aboveInfo(findings)).toEqual([]);
		for (const id of ["hindsight.url", "hindsight.enabled", "teach.recallLimit", "decisions.zdr", "ragflow.url"]) {
			const finding = byId(findings, `config.project.project-restricted.${id}`);
			expect(finding.level).toBe("info");
			expect(finding.title).toContain("ignored in a project file by design");
		}
	});

	test("the same keys in a user file are honored and produce nothing above info", () => {
		write("user", { hindsight: { url: "https://hindsight.example", enabled: true }, teach: { recallLimit: 9 }, decisions: { zdr: false } });
		const findings = checkConfig(deps);
		expect(aboveInfo(findings)).toEqual([]);
		expect(findings.some((finding) => finding.id.includes("project-restricted"))).toBe(false);
	});

	test("a project key that a user file would also adjust is a warning, not the by-design info", () => {
		write("project", { teach: { recallLimit: 99 } });
		const finding = byId(checkConfig(deps), "config.project.ignored.teach.recallLimit");
		expect(finding.level).toBe("warn");
	});

	describe("models", () => {
		test("an unknown host is a warning with a suggestion; a known host with provider and model is clean", () => {
			write("user", { models: { hosts: { nonsense: { model: "x" }, ompp: { model: "x" }, omp: { provider: "openrouter", model: "gpt" } } } });
			const findings = checkConfig(deps);
			expect(byId(findings, "config.user.unknown-host.models.hosts.nonsense").level).toBe("warn");
			expect(byId(findings, "config.user.unknown-host.models.hosts.nonsense").detail).toContain("claude-code");
			expect(byId(findings, "config.user.unknown-host.models.hosts.ompp").fix).toBe("Did you mean models.hosts.omp?");
			expect(findings.filter((finding) => /models\.hosts\.omp(\.|$)/.test(finding.id))).toEqual([]);
		});

		test("a host entry may hold only provider and model strings", () => {
			write("user", { models: { hosts: { omp: { modle: "x", provider: 3 }, muse: "x" } } });
			const findings = checkConfig(deps);
			expect(byId(findings, "config.user.unknown-key.models.hosts.omp.modle").fix).toBe("Did you mean models.hosts.omp.model?");
			expect(byId(findings, "config.user.wrong-type.models.hosts.omp.provider").title).toContain("expected string, got number");
			expect(byId(findings, "config.user.wrong-type.models.hosts.muse").title).toContain("expected object, got string");
		});

		test.each(["\u0000", "\n", "\t", "\u001b", "\u007f", "\u0085"])("nonblank selectors carrying control %j name the actual rejection cause", (control) => {
			const provider = `${control}doctor-invalid-provider`;
			const model = `doctor-invalid${control}model`;
			const providerDefault = `doctor-invalid-default${control}`;
			write("user", { models: { hosts: { omp: { provider, model } }, providerDefaults: { "my-gateway": providerDefault } } });
			const findings = checkConfig(deps);
			for (const key of ["hosts.omp.provider", "hosts.omp.model", "providerDefaults.my-gateway"]) {
				const finding = byId(findings, `config.user.selector-invalid.models.${key}`);
				expect(finding.level).toBe("warn");
				expect(finding.title).toContain("control character");
				expect(finding.detail).toContain("selection");
				expect(findings.some((candidate) => candidate.id === `config.user.ignored.models.${key}`)).toBe(false);
			}
			const report = buildReport(findings);
			for (const output of [formatReport(report), reportJson(report)]) {
				expect(output).toContain("control character");
				expect(output).not.toContain("reserved provider");
				expect(output).not.toContain("doctor-invalid");
			}
			const effective = loadConfig(claudeConfigPaths(deps.cwd, deps.env));
			expect(effective.models.hosts.omp).toEqual({ provider, model });
			expect(effective.models.providerDefaults["my-gateway"]).toBe(providerDefault);
		});

		test("valid selectors and entirely blank resets retain normalization and layer precedence without warnings", () => {
			write("user", {
				models: {
					hosts: { omp: { provider: "  openrouter  ", model: " openrouter/anthropic/claude-x:beta " } },
					providerDefaults: { openrouter: " anthropic/claude-x:beta ", "my-gateway": " model-a " },
				},
			});
			expect(aboveInfo(checkConfig(deps))).toEqual([]);
			const lower = loadConfig(claudeConfigPaths(deps.cwd, deps.env));
			expect(lower.models.hosts.omp).toEqual({ provider: "openrouter", model: "openrouter/anthropic/claude-x:beta" });
			expect(lower.models.providerDefaults.openrouter).toBe("anthropic/claude-x:beta");
			write("claude", {
				models: { hosts: { omp: { model: "\n\t " } }, providerDefaults: { openrouter: "\n\t " } },
			});
			write("project", {
				models: { hosts: { omp: { provider: "" } }, providerDefaults: { "my-gateway": " model-b " } },
			});
			expect(aboveInfo(checkConfig(deps))).toEqual([]);
			const effective = loadConfig(claudeConfigPaths(deps.cwd, deps.env));
			expect(effective.models.hosts.omp).toEqual({ provider: "", model: "" });
			expect(Object.hasOwn(effective.models.providerDefaults, "openrouter")).toBe(false);
			expect(effective.models.providerDefaults["my-gateway"]).toBe("model-b");
		});

		test("providerDefaults keys are free, values must be strings, reserved names are ignored", () => {
			write("user", `{"models":{"providerDefaults":{"my-gateway":"model-a","blank":"  ","numeric":4,"__proto__":"x","constructor":"x","prototype":"x"}}}`);
			const findings = checkConfig(deps);
			expect(findings.some((finding) => finding.id.includes("my-gateway"))).toBe(false);
			expect(findings.some((finding) => finding.id.endsWith("providerDefaults.blank"))).toBe(false);
			expect(byId(findings, "config.user.wrong-type.models.providerDefaults.numeric").level).toBe("warn");
			for (const provider of ["__proto__", "constructor", "prototype"]) {
				const finding = byId(findings, `config.user.ignored.models.providerDefaults.${provider}`);
				expect(finding.level).toBe("warn");
				expect(finding.detail).toContain("reserved provider");
			}
			const effective = loadConfig(claudeConfigPaths(deps.cwd, deps.env));
			expect(Object.keys(effective.models.providerDefaults)).toEqual(["my-gateway"]);
		});

		test("an unknown key under models suggests the real one, and a wrong-typed models is reported", () => {
			write("user", { models: { host: {} } });
			write("claude", { models: [] });
			const findings = checkConfig(deps);
			expect(byId(findings, "config.user.unknown-key.models.host").fix).toBe("Did you mean models.hosts?");
			expect(byId(findings, "config.claude-user.wrong-type.models").title).toContain("expected object, got array");
		});
	});

	test("no finding carries a written value", () => {
		write("user", { ship: { autoMerg: FAKE_KEY, greptileOrganization: 5, mergeMethod: FAKE_KEY } });
		const output = JSON.stringify(checkConfig(deps));
		expect(output).toContain("autoMerg");
		expect(output).not.toContain(FAKE_KEY);
	});

	test("findings come out lowest layer first", () => {
		write("project", { shipp: {} });
		write("user", { shipp: {} });
		write("claude", { shipp: {} });
		expect(checkConfig(deps).map((finding) => finding.id)).toEqual([
			"config.user.unknown-section.shipp",
			"config.claude-user.unknown-section.shipp",
			"config.project.unknown-section.shipp",
		]);
	});
});

describe("suggestName", () => {
	const KEYS = ["autoMerge", "maxQuestions", "enabled", "deleteBranch"];

	test.each<[string, string | undefined]>([
		["autoMerg", "autoMerge"],
		["automerge", "autoMerge"],
		["enabld", "enabled"],
		["maxQuest", "maxQuestions"],
		["deleteBranchName", "deleteBranch"],
		["zzzzzz", undefined],
		["ab", undefined],
	])("%s -> %p", (name, expected) => {
		expect(suggestName(name, KEYS)).toBe(expected);
	});

	test("the closest candidate wins when several are near", () => {
		expect(suggestName("enable", ["enabled", "disabled", "enableAll"])).toBe("enabled");
	});
});
