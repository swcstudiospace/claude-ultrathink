# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
"""Prime Agent host for ultrathink.

Prime Agent has no prompt hook: the agent's persistent Python kernel loads this package as the
``ultrathink`` skill and calls it. Planning still runs in the shared TypeScript engine
(``hooks/engine.ts``) through ``bin/run-bun``: one JSON request on stdin, one ``PlanResponse``
line on stdout, always exit 0. This module only spawns the engine, carries the result back
into the kernel and reads the files the engine wrote. It never plans by itself, never imports
Prime Agent and never raises on an engine failure (fail-open: the agent gets ``planned=False``
and a reason, the user's request still stands).

Request/response contract: ``hooks/engine.ts`` and ``src/host/plan.ts`` (``PlanRequest`` /
``PlanResponse``). State directory: ``src/host/paths.ts`` (``prime-agent`` branch).
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

HOST = "prime-agent"
__all__ = [
	"HOST",
	"run",
	"plan",
	"ctl",
	"status",
	"last",
	"spec",
	"teach",
	"state_dir",
	"repo_root",
	"session_id",
]

_THIS = Path(__file__).resolve()
# hosts/prime-agent/src/ultrathink/__init__.py -> the clone (the skill directory is a symlink into it, or a copy of hosts/prime-agent).
_HOST_DIR = _THIS.parents[2]
_LAYOUT_ROOT = _THIS.parents[4] if len(_THIS.parents) > 4 else _HOST_DIR
_DEFAULT_CLONE = Path.home() / "src" / "repos" / "claude-ultrathink"
ENGINE_REL = Path("hooks") / "engine.ts"
RUN_BUN_REL = Path("bin") / "run-bun"
CLI_REL = Path("bin") / "ultrathink"
TEACH_REL = Path("src") / "teach" / "cli.ts"

DEFAULT_TIMEOUT_S = 600.0
CONTROL_TIMEOUT_S = 30.0
TEACH_TIMEOUT_S = 120.0
SPEC_MAX_CHARS = 200_000


def _env(extra: dict[str, str] | None = None) -> dict[str, str]:
	merged = {**os.environ, **(extra or {})}
	merged["ULTRATHINK_HOST"] = HOST
	# The kernel is never an engine child; a leaked marker from another host's shell must not silence planning.
	merged.pop("ULTRATHINK_CHILD", None)
	return merged


def repo_root(env: dict[str, str] | None = None) -> Path:
	"""The claude-ultrathink clone the engine runs from: ``ULTRATHINK_PLUGIN_ROOT``, else the clone this file
	lives in (``hosts/prime-agent`` symlinked into ``~/.prime/agent/skills/ultrathink``), else ``~/src/repos/claude-ultrathink``."""
	merged = _env(env)
	override = merged.get("ULTRATHINK_PLUGIN_ROOT", "").strip()
	if override:
		return Path(override).expanduser()
	for candidate in (_LAYOUT_ROOT, _DEFAULT_CLONE):
		if (candidate / ENGINE_REL).is_file():
			return candidate
	return _LAYOUT_ROOT


def _is_planning_path(path: str) -> bool:
	norm = path.replace("\\", "/").rstrip("/")
	return norm == ".planning" or norm.endswith("/.planning") or "/.planning/" in norm


def state_dir(env: dict[str, str] | None = None) -> Path:
	"""Where the engine keeps control, sessions, specs and ``last-plan.json`` for Prime Agent, located the way
	``src/host/paths.ts`` does: ``ULTRATHINK_STATE_DIR`` unless it points into a ``.planning`` tree, else
	``${PRIME_AGENT_CODING_AGENT_DIR:-~/.prime/agent}/ultrathink``."""
	merged = _env(env)
	override = merged.get("ULTRATHINK_STATE_DIR", "").strip()
	if override and not _is_planning_path(override):
		return Path(override).expanduser()
	home = merged.get("PRIME_AGENT_CODING_AGENT_DIR", "").strip() or str(Path.home() / ".prime" / "agent")
	return Path(home).expanduser() / "ultrathink"


def session_id(env: dict[str, str] | None = None) -> str:
	"""The Prime Agent session id (the ``RLM_SESSION_DIR`` leaf), ``ULTRATHINK_SESSION_ID`` when set, else ``unknown``.
	The engine names its session record and spec after it, so a session re-plans into its own files."""
	merged = _env(env)
	explicit = merged.get("ULTRATHINK_SESSION_ID", "").strip()
	if explicit:
		return explicit
	session = merged.get("RLM_SESSION_DIR", "").strip()
	if session:
		leaf = Path(session).name.strip()
		if leaf:
			return leaf
	return "unknown"


def _engine_command(root: Path, env: dict[str, str]) -> list[str] | None:
	engine = root / ENGINE_REL
	if not engine.is_file():
		return None
	bun = env.get("BUN", "").strip()
	if bun:
		return [bun, "--no-env-file", str(engine)]
	runner = root / RUN_BUN_REL
	if not runner.is_file():
		return None
	return [str(runner), str(engine)]


def _read_text(path: str | None, limit: int = SPEC_MAX_CHARS) -> str | None:
	if not path:
		return None
	try:
		text = Path(path).read_text(encoding="utf-8", errors="replace")
	except OSError:
		return None
	return text if len(text) <= limit else text[:limit]


def _skip(reason: str, **extra: Any) -> dict[str, Any]:
	return {"planned": False, "skipped": reason, "context": "", **extra}


def plan(
	text: str,
	*,
	cwd: str | None = None,
	session: str | None = None,
	force: bool = False,
	raw: bool = False,
	timeout: float = DEFAULT_TIMEOUT_S,
	env: dict[str, str] | None = None,
) -> dict[str, Any]:
	"""Plan one request through the engine (synchronous; ``run`` is the awaitable wrapper).

	Returns a dict: ``planned`` (bool), ``context`` (the plan text the agent works from), ``skipped`` (reason when
	not planned), ``summary``, ``spec_path`` / ``spec`` (the XML), ``state_path``, ``graph_id``, ``carrier_path``,
	``view``, ``model_resolution``, ``elapsed_s``. Never raises.
	"""
	prompt = (text or "").strip()
	if not prompt:
		return _skip("empty")
	if raw and not prompt.lower().startswith("raw:"):
		prompt = f"raw: {prompt}"
	elif force and not prompt.lower().startswith("uplift:"):
		prompt = f"uplift: {prompt}"
	child_env = _env(env)
	root = repo_root(env)
	command = _engine_command(root, child_env)
	if command is None:
		return _skip(
			"engine-missing",
			error=f"{root / ENGINE_REL} or {root / RUN_BUN_REL} not found; set ULTRATHINK_PLUGIN_ROOT to a full clone of claude-ultrathink",
		)
	workdir = (cwd or "").strip() or os.getcwd()
	request = {
		"host": HOST,
		"session_id": (session or "").strip() or session_id(env),
		"prompt": prompt,
		"cwd": workdir,
		"platform": "prime-agent",
	}
	started = time.monotonic()
	try:
		# Bun leads its own process group so a timeout can end everything it spawned (the Claude/Grok CLI it calls).
		proc = subprocess.Popen(
			command,
			stdin=subprocess.PIPE,
			stdout=subprocess.PIPE,
			stderr=subprocess.PIPE,
			text=True,
			encoding="utf-8",
			errors="replace",
			env=child_env,
			cwd=str(root),
			start_new_session=True,
		)
	except OSError as error:
		return _skip("engine-spawn-failed", error=str(error))
	try:
		stdout, stderr = proc.communicate(input=json.dumps(request), timeout=timeout)
	except subprocess.TimeoutExpired:
		try:
			os.killpg(proc.pid, signal.SIGKILL)
		except (ProcessLookupError, PermissionError):
			pass
		proc.communicate()
		return _skip("timeout", error=f"no plan after {timeout:g}s", elapsed_s=round(time.monotonic() - started, 1))
	elapsed = round(time.monotonic() - started, 1)
	# bin/run-bun exits 0 with no output when bun is missing (fail-open); the hint is on stderr.
	line = next((entry for entry in reversed((stdout or "").splitlines()) if entry.strip().startswith("{")), "")
	try:
		parsed = json.loads(line) if line else {}
	except json.JSONDecodeError:
		parsed = {}
	if not isinstance(parsed, dict) or not parsed:
		detail = " ".join((stderr or "").split())[:300]
		return _skip("engine-no-output", error=detail or f"exit code {proc.returncode}", elapsed_s=elapsed)
	context = parsed.get("context") if isinstance(parsed.get("context"), str) else ""
	result: dict[str, Any] = {
		"planned": bool(context),
		"context": context,
		"skipped": parsed.get("skipped"),
		"summary": parsed.get("summary"),
		"spec_path": parsed.get("specPath"),
		"state_path": parsed.get("statePath"),
		"graph_id": parsed.get("graphId"),
		"carrier_path": parsed.get("carrierPath"),
		"view": parsed.get("view"),
		"model_resolution": parsed.get("modelResolution"),
		"elapsed_s": elapsed,
	}
	result["spec"] = _read_text(result["spec_path"]) if context else None
	return result


async def run(
	text: str,
	*,
	cwd: str | None = None,
	session: str | None = None,
	force: bool = False,
	raw: bool = False,
	timeout: float = DEFAULT_TIMEOUT_S,
) -> dict[str, Any]:
	"""Plan a request with ultrathink: Prompt Uplift (XML spec), Graph of Thought with WORKFLOW waves, HITL
	questions and, when configured, Linear/Notion rows.

	Args:
		text: the user's request, verbatim. ``/skill:<name> <task>`` is planned as that skill's task.
		cwd: project directory (config layers and skill lookup); defaults to the kernel's cwd.
		session: session id for the state files; defaults to the Prime Agent session id.
		force: prefix ``uplift:`` so planning-off and trivial-prompt gates do not skip.
		raw: prefix ``raw:`` so nothing is planned (returns ``planned=False``).
		timeout: seconds the engine may run (planning takes 1-5 minutes on a CLI route).

	Returns the ``plan()`` dict. Work from ``context``; it names the spec file, the HITL questions and, with tracking
	on, tells you to run the ``ultrathink-kickoff`` skill first. Never raises.
	"""
	import asyncio

	return await asyncio.to_thread(plan, text, cwd=cwd, session=session, force=force, raw=raw, timeout=timeout)


def _run_cli(root: Path, argv: list[str], timeout: float, env: dict[str, str] | None, stdin: str | None = None) -> tuple[bool, str]:
	try:
		completed = subprocess.run(
			argv,
			input=stdin,
			encoding="utf-8",
			errors="replace",
			capture_output=True,
			timeout=timeout,
			env=_env(env),
			cwd=str(root),
			check=False,
		)
	except subprocess.TimeoutExpired:
		return False, f"no answer after {timeout:g}s"
	except OSError as error:
		return False, " ".join(str(error).split())
	text = completed.stdout.strip()
	if completed.returncode == 0:
		return True, text
	lines = [line.strip() for line in f"{completed.stderr}\n{text}".splitlines() if line.strip()]
	detail = next((line for line in lines if line.startswith("error:")), lines[0] if lines else "")
	return False, detail or f"exit code {completed.returncode}"


def ctl(*args: str, env: dict[str, str] | None = None) -> str:
	"""Planner controls against the Prime Agent state directory, the ``/ultrathink-*`` commands of the other hosts:
	``ctl("status")``, ``ctl("off")``, ``ctl("on")``, ``ctl("skip")``, ``ctl("track", "off"|"on"|"status")``,
	``ctl("think", "on"|"off"|"last"|"status")``, ``ctl("hitl", ...)``, ``ctl("grok", "engine", "auto"|"claude"|"grok"|"muse")``,
	``ctl("last")``. Returns the CLI's text, or one line saying what failed."""
	root = repo_root(env)
	cli = root / CLI_REL
	if not cli.is_file():
		return f"Ultrathink: {cli} not found; set ULTRATHINK_PLUGIN_ROOT to a full clone of claude-ultrathink"
	ok, text = _run_cli(root, [str(cli), *args], CONTROL_TIMEOUT_S, env)
	return text if ok else f"Ultrathink {' '.join(args[:1]) or 'status'} failed: {text}"


def status(env: dict[str, str] | None = None) -> dict[str, Any]:
	"""Where things are and what the planner would do: clone, engine presence, state dir, session id, and the
	``ultrathink status`` text (planning on/off, tracking, engine route)."""
	root = repo_root(env)
	return {
		"host": HOST,
		"repo_root": str(root),
		"engine": str(root / ENGINE_REL),
		"engine_present": (root / ENGINE_REL).is_file(),
		"state_dir": str(state_dir(env)),
		"session_id": session_id(env),
		"control": ctl("status", env=env),
	}


def last(env: dict[str, str] | None = None) -> dict[str, Any] | None:
	"""The carrier of the last planned prompt (``last-plan.json``: session, spec path, graph id, context), or None."""
	path = state_dir(env) / "last-plan.json"
	try:
		parsed = json.loads(path.read_text(encoding="utf-8"))
	except (OSError, json.JSONDecodeError):
		return None
	return parsed if isinstance(parsed, dict) else None


def spec(env: dict[str, str] | None = None) -> str | None:
	"""The XML spec of the last planned prompt, or None."""
	carrier = last(env)
	return _read_text(carrier.get("specPath")) if carrier else None


def teach(*args: str, stdin: str | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
	"""Teachable Moments (``src/teach/cli.ts``) for this host: ``teach("status")``, ``teach("recall", "<query>")``,
	``teach("capture", "--stdin", stdin=json)``, ``teach("promote", "--due")``, ``teach("promote", "<id>", "--target", "prime-agent", "--install")``.
	``--json`` is added when absent; returns the parsed JSON, or ``{"error": ...}``."""
	root = repo_root(env)
	entry = root / TEACH_REL
	runner = root / RUN_BUN_REL
	if not entry.is_file() or not runner.is_file():
		return {"error": f"{entry} or {runner} not found"}
	argv = [str(runner), str(entry), *args]
	if "--json" not in args:
		argv.append("--json")
	ok, text = _run_cli(root, argv, TEACH_TIMEOUT_S, env, stdin=stdin)
	if not ok:
		return {"error": text}
	try:
		parsed = json.loads(text) if text else {}
	except json.JSONDecodeError:
		return {"error": "teach CLI did not answer JSON", "text": text[:500]}
	return parsed if isinstance(parsed, dict) else {"result": parsed}
