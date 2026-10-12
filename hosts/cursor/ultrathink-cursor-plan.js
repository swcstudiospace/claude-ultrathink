#!/usr/bin/env node
// ultrathink-cursor-managed: true
// ultrathink-cursor-plan.js — Cursor beforeSubmitPrompt planner.
//
// Cursor invokes this script when the user submits a prompt.
// Protocol: JSON from Cursor on stdin; one JSON object on stdout.
//
// Input (beforeSubmitPrompt):
//   { prompt, conversation_id, generation_id, model, hook_event_name,
//     cursor_version, workspace_roots, user_email, transcript_path }
//
// Output:
//   { continue?: boolean, additional_context?: string }
//
// The script does not plan itself. It sends one JSON request to
// bin/run-bun hooks/engine.ts with host "cursor" and maps PlanResponse.context
// into additional_context. Missing Bun, a planner error, a child session, or
// a timeout prints {} and exits 0 so a hook bug never wedges Cursor.
//
// ULTRATHINK_ROOT is the checkout. The installer also writes that path beside
// this file when the script is staged under ~/.cursor/hooks.
// ULTRATHINK_CURSOR_BUDGET_MS caps the wait (default 180000).
// ULTRATHINK_CHILD=1, SWARM_CHILD=1, or a non-empty SWARM_AGENT skips planning.
//
// No top-level import and no require: the file is ESM inside this repo
// ("type": "module") and CommonJS once staged under ~/.cursor/hooks.
// Dynamic import() is legal in both.

"use strict";

const GRAPH_ID = /^ut-[0-9a-z]+-[0-9a-f]{8}$/;
const DEFAULT_BUDGET_MS = 180000;

const SWARM_NOTE = [
	"## Cursor swarm",
	"If this plan is new implementation work, run the ultrathink-cursor skill.",
	"It spawns the a01-orchestrator subagent once with this plan's Graph ID.",
	"Do not spawn a02-requirements through a15-docs yourself, and do not run swarm_run.py or autonomous_run.py.",
	"Questions, short replies, and /ultrathink-quick stay in this session.",
].join("\n");

function positiveInt(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isChild(env, payload) {
	if (env.ULTRATHINK_CHILD === "1" || env.SWARM_CHILD === "1") return true;
	if (typeof env.SWARM_AGENT === "string" && env.SWARM_AGENT.trim() !== "") return true;
	if (!payload || typeof payload !== "object") return false;
	if (payload.is_subagent === true) return true;
	if (typeof payload.parent_conversation_id === "string" && payload.parent_conversation_id.trim() !== "") return true;
	if (typeof payload.parent_session_id === "string" && payload.parent_session_id.trim() !== "") return true;
	return false;
}

function graphIdOf(parsed) {
	const raw = parsed && typeof parsed.graphId === "string" ? parsed.graphId.trim() : "";
	return GRAPH_ID.test(raw) ? raw : "";
}

function planResponse(parsed) {
	if (!parsed || typeof parsed !== "object") return {};
	if (typeof parsed.skipped === "string" && parsed.skipped !== "") return {};
	const context = typeof parsed.context === "string" ? parsed.context.trim() : "";
	if (!context) return {};
	const graphId = graphIdOf(parsed);
	const note = graphId ? `${SWARM_NOTE}\nGraph ID: ${graphId}` : SWARM_NOTE;
	return { continue: true, additional_context: `${context}\n\n${note}` };
}

function promptOf(payload) {
	return payload && typeof payload.prompt === "string" ? payload.prompt : "";
}

function cwdOf(payload, fallback) {
	const roots = payload && payload.workspace_roots;
	if (Array.isArray(roots)) {
		const first = roots.find((root) => typeof root === "string" && root.trim() !== "");
		if (typeof first === "string") return first.trim();
	}
	if (payload && typeof payload.cwd === "string" && payload.cwd.trim() !== "") return payload.cwd.trim();
	return fallback;
}

function sessionOf(payload) {
	if (!payload || typeof payload !== "object") return "cursor";
	for (const key of ["conversation_id", "generation_id", "session_id"]) {
		const value = payload[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return "cursor";
}

function requestBody(payload, cwd) {
	const body = {
		host: "cursor",
		session_id: sessionOf(payload),
		prompt: promptOf(payload),
		cwd,
	};
	if (payload && typeof payload.transcript_path === "string" && payload.transcript_path.trim() !== "") {
		body.transcript_path = payload.transcript_path.trim();
	}
	if (payload && typeof payload.model === "string") {
		const model = payload.model.trim();
		if (model && !/[\r\n]/.test(model)) body.model = model;
	}
	return body;
}

function emit(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function pluginRoot(env, fs, path) {
	const fromEnv = typeof env.ULTRATHINK_ROOT === "string" ? env.ULTRATHINK_ROOT.trim() : "";
	if (fromEnv) return fromEnv;
	const script = process.argv[1] ? path.resolve(process.argv[1]) : "";
	const here = script ? path.dirname(script) : "";
	if (!here) return "";
	const near = path.join(here, "..", "..");
	if (fs.existsSync(path.join(near, "hooks", "engine.ts"))) return near;
	const rootFile = path.join(here, "ultrathink-cursor-plan.root");
	if (!fs.existsSync(rootFile)) return "";
	const text = fs.readFileSync(rootFile, "utf8").trim();
	return text.includes("\n") || text.includes("\0") ? "" : text;
}

function runEngine(spawn, root, body, budgetMs, env) {
	return new Promise((resolve) => {
		const path = requirePath(root);
		let child;
		try {
			child = spawn(path.launcher, [path.engine], {
				cwd: root,
				env: { ...env, ULTRATHINK_HOST: "cursor" },
				stdio: ["pipe", "pipe", "pipe"],
				detached: true,
			});
		} catch {
			resolve({});
			return;
		}
		let stdout = "";
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const stop = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGTERM");
			} catch {
				try {
					child.kill("SIGTERM");
				} catch {
					// already gone
				}
			}
		};
		const timer = setTimeout(() => {
			stop();
			finish({});
		}, budgetMs);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
			if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
		});
		child.on("error", () => finish({}));
		child.on("close", () => {
			const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
			try {
				finish(planResponse(JSON.parse(line)));
			} catch {
				finish({});
			}
		});
		child.stdin.on("error", () => {});
		try {
			child.stdin.end(JSON.stringify(body));
		} catch {
			stop();
			finish({});
		}
	});
}

function requirePath(root) {
	return { launcher: `${root}/bin/run-bun`, engine: `${root}/hooks/engine.ts` };
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function main() {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const childProcess = await import("node:child_process");
	let payload;
	try {
		payload = await readStdin();
	} catch {
		emit({});
		return;
	}
	if (payload === null || isChild(process.env, payload) || promptOf(payload).trim() === "") {
		emit({});
		return;
	}
	const root = await pluginRoot(process.env, fs, path);
	const launcher = root ? path.join(root, "bin", "run-bun") : "";
	const engine = root ? path.join(root, "hooks", "engine.ts") : "";
	if (!root || !fs.existsSync(launcher) || !fs.existsSync(engine)) {
		emit({});
		return;
	}
	const budget = positiveInt(process.env.ULTRATHINK_CURSOR_BUDGET_MS, DEFAULT_BUDGET_MS);
	const response = await runEngine(
		childProcess.spawn,
		root,
		requestBody(payload, cwdOf(payload, process.cwd())),
		budget,
		process.env,
	);
	emit(response);
}

main()
	.catch(() => emit({}))
	.finally(() => {
		process.exitCode = 0;
	});
