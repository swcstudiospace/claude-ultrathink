# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
"""Fail-open bridge from Hermes hooks into the TypeScript ultrathink engine.

pre_llm_call plans the prompt through hooks/engine.ts, inside the hook cap Hermes
enforces (plugins.hook_callback_timeout): Bun gets min(540, cap - 15) seconds in its
own process group, and the whole group is killed at that deadline. Slash commands
and already-uplifted ultrathink XML never start Bun. When a planned session's
tool call opens a pull request, transform_tool_result appends an ultrathink-sync
nudge to that tool result, so the model sees it in the same turn. If no tool
result carried it, post_tool_call queues the nudge and the session's next
pre_llm_call delivers it. Each PR URL is nudged once per session. When a coding
turn is about to finish (pre_verify) and the session's tracked plan has not been
synced, the turn continues once with a nudge to run ultrathink-sync.

The /ultrathink-<verb> slash commands run bin/ultrathink against the engine's
state directory; /ultrathink-quick sends one message that pre_llm_call leaves
unplanned.
"""

from __future__ import annotations

import json
import logging
import os
import re
import signal
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
ENGINE = REPO_ROOT / "hooks" / "engine.ts"
RUN_BUN = REPO_ROOT / "bin" / "run-bun"
CLI = REPO_ROOT / "bin" / "ultrathink"
DEFAULT_TIMEOUT_S = 540  # planning takes minutes; stay below Hermes' 600s hook cap maximum
HOOK_MARGIN_S = 15  # the bridge's deadline ends this long before Hermes abandons the hook
MIN_PLAN_S = 90  # below this a plan cannot finish, so Bun is not started at all
CONTROL_TIMEOUT_S = 20
QUICK_FALLBACK = "Ultrathink will not plan your next message. Send it now (or prefix any message with raw:)."
# A shared multi-user gateway session attributes each message: "[Alice] fix the typo".
SENDER_TAG_RE = re.compile(r"\[[^\]\n]*\]\s+")

# Ports of src/track/pr-detect.ts. JavaScript's \s, \b, and \d are spelled out
# because Python's are Unicode-aware and disagree with them at the edges.
JS_SPACE = r"\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
GH_PR_CREATE_RE = re.compile(rf"(?<![A-Za-z0-9_])gh[{JS_SPACE}]+pr[{JS_SPACE}]+create(?![A-Za-z0-9_])")
PR_URL_RE = re.compile(rf"https://github\.com/[^{JS_SPACE}/]+/[^{JS_SPACE}/]+/pull/[0-9]+")
PR_TOOL_RE = re.compile(
	r"create[_-]?pull[_-]?request|pull[_-]?request[_-]?create|createPullRequest", re.ASCII | re.IGNORECASE
)
SHELL_TOOLS = frozenset({"Bash", "bash", "run_terminal_command", "shell", "exec", "terminal"})

# Port of src/uplift/detect.ts isAlreadyUplifted: ROOT_TAGS (src/types.ts) plus "uplifted"
# and "ultrathink", case-insensitive. JavaScript's \w is ASCII.
UPLIFTED_ROOTS = frozenset(
	tag.lower()
	for tag in ("BUILD_PROMPT", "FIX_PROMPT", "RESEARCH_PROMPT", "CHANGE_PROMPT", "UPLIFTED_PROMPT", "uplifted", "ultrathink")
)
UPLIFTED_TAG_RE = re.compile(r"<([A-Za-z_][A-Za-z0-9_.-]*)")

logger = logging.getLogger(__name__)
_cap_lock = threading.Lock()
_cap_warned = False  # the short-cap warning is logged once per process

# Hooks fire from the agent thread and from parallel tool workers.
_pr_lock = threading.Lock()
_pr_delivered: set[tuple[str, str]] = set()  # (session_id, PR URL) the model was nudged about
_pr_pending: dict[str, dict[str, str]] = {}  # session_id -> PR URL -> nudge for its next turn
# Plan-scoped state is keyed by (session_id, graphId): a session's next planned prompt is a new graph with its own rows.
_pr_latest: dict[tuple[str, str], str] = {}  # (session_id, graphId) -> the last PR URL opened for that plan
_sync_nudged: set[tuple[str, str]] = set()  # (session_id, graphId) pre_verify already continued with a sync nudge

# /ultrathink-quick arms one skip per injected message. pre_llm_call consumes it only on
# that exact message, so a message queued behind a running turn still goes out unplanned.
_quick_lock = threading.Lock()
_quick_pending: dict[str, int] = {}  # stripped message -> injected copies pre_llm_call has not seen


def timeout_seconds() -> int:
	try:
		value = int(os.environ.get("ULTRATHINK_HERMES_TIMEOUT", ""))
	except ValueError:
		return DEFAULT_TIMEOUT_S
	return value if value > 0 else DEFAULT_TIMEOUT_S


def host_hook_cap() -> float | None:
	"""The pre_llm_call cap Hermes enforces right now, resolved the way Hermes does per
	hook invocation; None outside Hermes."""
	try:
		from hermes_cli.plugins import _resolve_hook_callback_timeout  # type: ignore[import-not-found]

		return float(_resolve_hook_callback_timeout())
	except Exception:
		return None


def plan_deadline() -> float | None:
	"""Seconds Bun may run: timeout_seconds(), cut to end HOOK_MARGIN_S before a positive
	Hermes cap (a cap <= 0 runs the hook inline, without one). None when that leaves
	less than MIN_PLAN_S."""
	deadline = float(timeout_seconds())
	cap = host_hook_cap()
	if cap is not None and cap > 0:
		deadline = min(deadline, cap - HOOK_MARGIN_S)
	return deadline if deadline >= MIN_PLAN_S else None


def is_already_uplifted(text: str) -> bool:
	trimmed = text.strip()
	if trimmed.startswith("<"):
		match = UPLIFTED_TAG_RE.match(trimmed)
		return match is not None and match.group(1).lower() in UPLIFTED_ROOTS
	return trimmed.lower() in UPLIFTED_ROOTS


def _warn_short_cap() -> None:
	global _cap_warned
	with _cap_lock:
		if _cap_warned:
			return
		_cap_warned = True
	logger.warning(
		"ultrathink: Hermes hook cap %ss leaves under %ss to plan, so prompts go unplanned; "
		"run `hermes config set plugins.hook_callback_timeout 600`",
		host_hook_cap(),
		MIN_PLAN_S,
	)


def message_text(message: Any) -> str:
	if isinstance(message, str):
		return message
	if isinstance(message, dict):
		for key in ("text", "content", "message"):
			value = message.get(key)
			if isinstance(value, str):
				return value
	return ""


def plan(payload: dict[str, Any], env: dict[str, str] | None = None) -> str:
	"""Return context to inject, or "" when the engine should not run."""
	parent = payload.get("parent_session_id") or payload.get("parentSessionId")
	if isinstance(parent, str) and parent.strip():
		return ""
	if payload.get("platform") == "cron":
		return ""
	prompt = message_text(payload.get("user_message") or payload.get("prompt"))
	if not prompt.strip() or _take_quick(prompt):
		return ""
	# Hermes expands /skill commands into an "[IMPORTANT: The user has invoked …]" scaffold
	# before pre_llm_call, so a prompt still starting with "/" is never a skill with a task.
	if prompt.strip().startswith("/") or is_already_uplifted(prompt):
		return ""
	deadline = plan_deadline()
	if deadline is None:
		_warn_short_cap()
		return ""
	request = {
		"host": "hermes",
		"session_id": payload.get("session_id") or payload.get("sessionId") or "",
		"prompt": prompt,
		"cwd": payload.get("cwd") or os.getcwd(),
		"platform": payload.get("platform") or "",
		"parent_session_id": parent or "",
	}
	child_env = os.environ.copy()
	child_env.update(env or {})
	child_env["ULTRATHINK_HOST"] = "hermes"
	bun = child_env.get("BUN")
	# BUN is an explicit override; otherwise bin/run-bun finds bun even when
	# PATH lacks it, and exits 0 with no output when bun is missing.
	command = [bun, str(ENGINE)] if bun else [str(RUN_BUN), str(ENGINE)]
	try:
		# Bun leads its own process group so the deadline can kill everything it spawned.
		proc = subprocess.Popen(
			command,
			stdin=subprocess.PIPE,
			stdout=subprocess.PIPE,
			stderr=subprocess.PIPE,
			text=True,
			env=child_env,
			cwd=str(REPO_ROOT),
			start_new_session=True,
		)
	except OSError:
		return ""
	try:
		stdout, _ = proc.communicate(input=json.dumps(request), timeout=deadline)
	except subprocess.TimeoutExpired:
		try:
			os.killpg(proc.pid, signal.SIGKILL)
		except (ProcessLookupError, PermissionError):
			pass
		proc.communicate()
		return ""
	try:
		parsed = json.loads(stdout or "{}")
	except json.JSONDecodeError:
		return ""
	context = parsed.get("context") if isinstance(parsed, dict) else ""
	return context if isinstance(context, str) else ""


def is_pr_creation_tool(tool_name: str, command: str) -> bool:
	"""Port of isPrCreationTool: a shell tool running `gh pr create` (a substring
	match, so a commit message quoting it counts too), or a tool whose name
	reads as PR creation."""
	if not tool_name:
		return False
	if tool_name in SHELL_TOOLS:
		return GH_PR_CREATE_RE.search(command) is not None
	return PR_TOOL_RE.search(tool_name) is not None


def extract_pr_url(output: str) -> str:
	"""Port of extractPrFromOutput: the first github.com/<owner>/<repo>/pull/<n> URL, or ""."""
	match = PR_URL_RE.search(output)
	return match.group(0) if match else ""


def state_dir(env: dict[str, str] | None = None) -> Path:
	"""The state directory hooks/engine.ts uses for Hermes, located the way
	src/host/paths.ts (resolveStateDir) does."""
	merged = {**os.environ, **(env or {})}
	override = merged.get("ULTRATHINK_STATE_DIR", "").strip()
	home = merged.get("HERMES_HOME", "").strip()
	if override and not _is_planning_path(override):
		directory = Path(override)
	elif home:
		directory = Path(home) / "ultrathink"
	else:
		directory = Path.home() / ".hermes" / "ultrathink"
	# The engine runs with cwd=REPO_ROOT, so a relative directory resolves there.
	return REPO_ROOT / directory


def state_path(session_id: str, env: dict[str, str] | None = None) -> Path:
	"""The session record hooks/engine.ts writes for Hermes (src/claude/state.ts sessionPath)."""
	safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id)[:120] or "unknown"
	return state_dir(env) / "sessions" / f"{safe_id}.json"


def _is_planning_path(path: str) -> bool:
	norm = path.replace("\\", "/").rstrip("/")
	return norm == ".planning" or norm.endswith("/.planning") or "/.planning/" in norm


def _result_text(result: Any) -> str:
	if isinstance(result, str):
		return result
	try:
		return json.dumps("" if result is None else result, ensure_ascii=False, default=str)
	except (TypeError, ValueError):
		return ""


def skill_reference(name: str) -> str:
	"""How a Hermes nudge names a plugin skill: its load call, with the SKILL.md
	path for a Hermes that did not register it (src/claude/output.ts skillReference)."""
	path = REPO_ROOT / "skills" / name / "SKILL.md"
	return f'the {name} skill (load it with skill_view name="ultrathink:{name}", or read {path})'


def _read_record(path: Path) -> dict[str, Any] | None:
	try:
		record = json.loads(path.read_text(encoding="utf-8"))
	except (OSError, ValueError):
		return None
	return record if isinstance(record, dict) else None


def _pr_event(payload: dict[str, Any], env: dict[str, str] | None) -> tuple[str, str, str, str] | None:
	"""(session_id, graphId, PR URL, nudge) when this tool call opened a PR for a
	planned session. Subagents never plan (plan() skips them), so they have no state file."""
	session_id = str(payload.get("session_id") or "").strip()
	args = payload.get("args")
	command = (args.get("command") or args.get("cmd") or "") if isinstance(args, dict) else ""
	if not session_id or not is_pr_creation_tool(str(payload.get("tool_name") or ""), str(command)):
		return None
	url = extract_pr_url(_result_text(payload.get("result")))
	if not url:
		return None
	path = state_path(session_id, env)
	record = _read_record(path)
	if record is None or not isinstance(record.get("plan"), dict):
		return None
	graph_id = str(record["plan"].get("graphId") or "")
	nudge = (
		f"Ultrathink: a pull request was opened for the tracked task (graph {graph_id}, {url}). "
		f"Invoke {skill_reference('ultrathink-sync')} now with stateFile={path} and prUrl={url}, "
		"so the tracked Notion Task row and Linear issues get the PR URL/number/branch and status. "
		"ultrathink-sync only updates existing rows; do not create new Notion rows or Linear issues."
	)
	return session_id, graph_id, url, nudge


def pr_tool_result(payload: dict[str, Any], env: dict[str, str] | None = None) -> str | None:
	"""transform_tool_result: the tool result with the nudge appended below it,
	the first time a planned session's tool call opens that PR. None keeps the
	result unchanged."""
	result = payload.get("result")
	if not isinstance(result, str):
		return None  # only text can carry the nudge; post_tool_call queues it instead
	event = _pr_event(payload, env)
	if event is None:
		return None
	session_id, graph_id, url, nudge = event
	with _pr_lock:
		if (session_id, url) in _pr_delivered:
			return None
		_pr_delivered.add((session_id, url))
		_pr_latest[(session_id, graph_id)] = url
	return f"{result}\n\n{nudge}"


def queue_pr_nudge(payload: dict[str, Any], env: dict[str, str] | None = None) -> None:
	"""post_tool_call: hold the nudge for the session's next turn in case no tool
	result carries it. Hermes' concurrent executor fires this before
	transform_tool_result and the sequential one after, so take_pr_nudges
	re-checks delivery."""
	event = _pr_event(payload, env)
	if event is None:
		return
	session_id, graph_id, url, nudge = event
	with _pr_lock:
		if (session_id, url) not in _pr_delivered:
			_pr_pending.setdefault(session_id, {})[url] = nudge
		_pr_latest[(session_id, graph_id)] = url


def take_pr_nudges(payload: dict[str, Any]) -> str:
	"""pre_llm_call: the queued nudges that no tool result delivered, each once."""
	session_id = str(payload.get("session_id") or "").strip()
	with _pr_lock:
		queued = _pr_pending.pop(session_id, {})
		nudges = [nudge for url, nudge in queued.items() if (session_id, url) not in _pr_delivered]
		_pr_delivered.update((session_id, url) for url in queued)
	return "\n\n".join(nudges)


def _tracking_enabled(env: dict[str, str] | None) -> bool:
	"""control.json's trackEnabled (src/claude/state.ts readControl); a missing or unreadable file means on."""
	record = _read_record(state_dir(env) / "control.json")
	return record is None or record.get("trackEnabled") is not False


def _has_rows(tracking: Any) -> bool:
	"""True when kickoff's tracking refs name at least one created Notion or Linear row."""
	if not isinstance(tracking, dict):
		return False
	sections = ((tracking.get("linear"), ("nodes", "steps")), (tracking.get("notion"), ("taskUrl", "nodes", "steps")))
	return any(isinstance(section, dict) and any(section.get(key) for key in keys) for section, keys in sections)


def sync_nudge(payload: dict[str, Any], env: dict[str, str] | None = None) -> dict[str, str] | None:
	"""pre_verify: continue the turn once per plan with an ultrathink-sync nudge
	when its plan has tracker rows that were never synced. Hermes re-fires the hook
	after each nudge (attempt 1, 2, ...), so only attempt 0 can nudge."""
	session_id = str(payload.get("session_id") or "").strip()
	if not session_id or payload.get("attempt"):
		return None
	path = state_path(session_id, env)
	record = _read_record(path)
	if record is None or record.get("synced") is True:
		return None
	plan_record = record.get("plan")
	# Kickoff creates the rows; without any, sync has nothing to update.
	if not isinstance(plan_record, dict) or not _has_rows(record.get("tracking")):
		return None
	if not _tracking_enabled(env):
		return None
	key = (session_id, str(plan_record.get("graphId") or ""))
	with _pr_lock:
		if key in _sync_nudged:
			return None
		_sync_nudged.add(key)
		url = _pr_latest.get(key, "")
	pr = f" and prUrl={url}" if url else ""
	message = (
		f"Ultrathink: this session's plan (graph {key[1]}) is tracked but not synced. "
		f"Before finishing, invoke {skill_reference('ultrathink-sync')} with stateFile={path}{pr}. "
		"It only updates the existing Notion Task row and Linear issues found by Graph ID and never creates rows; "
		"if Notion or Linear is down, report that in one line and finish without blocking."
	)
	return {"action": "continue", "message": message}


def control(args: list[str], env: dict[str, str] | None = None) -> tuple[bool, str]:
	"""Run `bin/ultrathink <args>` as Hermes against the engine's state directory:
	(True, its text), or (False, one line saying what failed). Never raises."""
	label = " ".join(["Ultrathink", *args[:1]])
	try:
		child_env = {**os.environ, **(env or {}), "ULTRATHINK_HOST": "hermes", "ULTRATHINK_STATE_DIR": str(state_dir(env))}
		completed = subprocess.run(
			[str(CLI), *args],
			encoding="utf-8",
			errors="replace",
			capture_output=True,
			timeout=CONTROL_TIMEOUT_S,
			env=child_env,
			check=False,
		)
	except subprocess.TimeoutExpired:
		return False, f"{label}: no answer after {CONTROL_TIMEOUT_S}s"
	except Exception as error:
		return False, " ".join(f"{label}: {error}".split())
	text = completed.stdout.strip()
	if completed.returncode == 0 and text:
		return True, text
	# bin/run-bun exits 0 with no output when bun is missing and says so on stderr.
	lines = [line.strip() for line in f"{completed.stderr}\n{text}".splitlines() if line.strip()]
	detail = next((line for line in lines if line.startswith("error:")), lines[0] if lines else "")
	return False, f"{label} failed: {detail or f'exit code {completed.returncode}'}"


def _take_quick(prompt: str) -> bool:
	"""Consume one /ultrathink-quick marker for exactly this message, sender tag aside."""
	text = prompt.strip()
	tag = SENDER_TAG_RE.match(text)
	with _quick_lock:
		for key in (text, text[tag.end() :]) if tag else (text,):
			count = _quick_pending.pop(key, 0)
			if count > 1:
				_quick_pending[key] = count - 1
			if count:
				return True
	return False


def quick(message: str, inject: Callable[[str], bool], env: dict[str, str] | None = None) -> str | None:
	"""/ultrathink-quick: hand `message` to Hermes as the next user turn, which pre_llm_call
	leaves unplanned. Without a message, or where Hermes cannot inject (the TUI, a gateway
	without allow_gateway_injection, an older Hermes), skip the next message instead."""
	text = message.strip()
	if text:
		# Armed before injecting: a gateway may start the turn before inject returns.
		with _quick_lock:
			_quick_pending[text] = _quick_pending.get(text, 0) + 1
		try:
			if inject(text):
				return None
		except Exception:
			pass
		_take_quick(text)
	ok, reply = control(["skip"], env)
	return QUICK_FALLBACK if ok else reply
