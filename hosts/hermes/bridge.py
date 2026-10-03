# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
"""Fail-open bridge from Hermes hooks into the TypeScript ultrathink engine.

pre_llm_call plans the prompt through hooks/engine.ts, inside the hook cap Hermes
enforces (plugins.hook_callback_timeout): Bun gets min(540, cap - 15) seconds in its
own process group, and the whole group is killed at that deadline. Slash commands
and already-uplifted ultrathink XML never start Bun, even behind a shared session's
"[Name] " sender tag. When a planned session's tool call opens a pull request (or a
delegate_task subagent's result names one), transform_tool_result appends an
ultrathink-sync nudge to that tool result, so the model sees it in the same turn. If no tool
result carried it, post_tool_call queues the nudge and the session's next
pre_llm_call delivers it. Each PR URL is nudged once per session. When a coding
turn is about to finish (pre_verify) and the session's tracked plan has not been
synced, the turn continues once with a nudge to run ultrathink-sync.

When Hermes does not report its hook cap, the bridge reads plugins.hook_callback_timeout
from ${HERMES_HOME:-~/.hermes}/config.yaml, else assumes Hermes' 30 s default. When the
engine is not beside the plugin (a copied directory, not a symlink into a clone), Bun never
starts. Each case logs one warning naming the fix.

The /ultrathink-<verb> slash commands run bin/ultrathink against the engine's
state directory; /ultrathink-quick sends one message that pre_llm_call leaves
unplanned.

Teachable Moments (TS side: src/teach). post_llm_call hands a finished turn to
`bin/ultrathink teach observe` as a detached process, on_session_finalize starts
`teach sync`, and the ultrathink_lesson_save / ultrathink_lesson_recall tools and the
/ultrathink-learn and /ultrathink-lessons commands call the same CLI. Nothing runs
unless `teach status` reports enabled, and every failure here is swallowed.
"""

from __future__ import annotations

import json
import logging
import os
import re
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
ENGINE = REPO_ROOT / "hooks" / "engine.ts"
RUN_BUN = REPO_ROOT / "bin" / "run-bun"
CLI = REPO_ROOT / "bin" / "ultrathink"
DEFAULT_TIMEOUT_S = 540  # planning takes minutes; stay below Hermes' 600s hook cap maximum
HOOK_MARGIN_S = 15  # the bridge's deadline ends this long before Hermes abandons the hook
MIN_PLAN_S = 90  # below this a plan cannot finish, so Bun is not started at all
HERMES_DEFAULT_CAP_S = 30.0  # Hermes' plugins.hook_callback_timeout when its config sets none
HERMES_MAX_CAP_S = 600.0  # Hermes clamps a larger plugins.hook_callback_timeout to this
CONTROL_TIMEOUT_S = 20
TEACH_STATUS_TIMEOUT_S = 10  # a status check also gates tool visibility, so it must not hang a hook
TEACH_CAPTURE_TIMEOUT_S = 25
TEACH_RECALL_TIMEOUT_S = 15
TEACH_STATUS_TTL_S = 600.0
TEACH_STATUS_FAILED_TTL_S = 60.0
TEACH_OBSERVE_INTERVAL_S = 30.0  # at most one observe process per session in this window
TEACH_KINDS = ("bug", "pitfall", "pattern", "decision", "playbook")
# src/teach/types.ts DIGEST_MAX_TURNS and DIGEST_TURN_CHARS; the TS side applies its own minimum of tool calls.
DIGEST_MAX_TURNS = 60
DIGEST_TURN_CHARS = 1500
DIGEST_MIN_TOOL_ROWS = 2
TOOL_CALL_ARGS_CHARS = 300
LEARN_NAME_CHARS = 80
TEACH_MAX_TAGS = 20
QUICK_FALLBACK = "Ultrathink will not plan your next message. Send it now (or prefix any message with raw:)."
# A shared multi-user gateway session attributes each message: "[Alice] fix the typo".
SENDER_TAG_RE = re.compile(r"\[([^\]\n]*)\]\s+")
# Hermes' skill scaffold also opens with a bracket; it is the prompt, not a sender tag.
SKILL_SCAFFOLD_PREFIX = "[IMPORTANT: The user has invoked the "

# Ports of src/track/pr-detect.ts. JavaScript's \s, \b, and \d are spelled out
# because Python's are Unicode-aware and disagree with them at the edges; its $
# (no m flag) is \Z, since Python's $ also matches before a trailing newline.
JS_SPACE = r"\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
GH_PR_CREATE_RE = re.compile(rf"(?<![A-Za-z0-9_])gh[{JS_SPACE}]+pr[{JS_SPACE}]+create(?![A-Za-z0-9_])")
PR_URL_RE = re.compile(rf"https://github\.com/[^{JS_SPACE}/]+/[^{JS_SPACE}/]+/pull/[0-9]+")
# The name must end in the verb: create_pull_request_review or _with_copilot does not open a PR.
PR_TOOL_RE = re.compile(
	r"(?:create[_-]?pull[_-]?request|pull[_-]?request[_-]?create|createPullRequest)\Z", re.ASCII | re.IGNORECASE
)
SHELL_TOOLS = frozenset({"Bash", "bash", "run_terminal_command", "run_terminal_cmd", "shell", "exec", "terminal"})

# Port of src/uplift/detect.ts isAlreadyUplifted: ROOT_TAGS (src/types.ts) plus "uplifted"
# and "ultrathink", case-insensitive. JavaScript's \w is ASCII.
UPLIFTED_ROOTS = frozenset(
	tag.lower()
	for tag in ("BUILD_PROMPT", "FIX_PROMPT", "RESEARCH_PROMPT", "CHANGE_PROMPT", "UPLIFTED_PROMPT", "uplifted", "ultrathink")
)
UPLIFTED_TAG_RE = re.compile(r"<([A-Za-z_][A-Za-z0-9_.-]*)")

# config.yaml, read line by line when Hermes does not report its hook cap. A YAML
# comment starts with "#" at the start of a line or after whitespace.
YAML_COMMENT_RE = re.compile(r"(?:^|\s)#.*")
PLUGINS_KEY_RE = re.compile(r"plugins\s*:")
HOOK_CAP_KEY_RE = re.compile(r"hook_callback_timeout\s*:(?:\s+(.*))?")

logger = logging.getLogger(__name__)
_warn_lock = threading.Lock()
_warned: set[str] = set()  # warnings this process already logged, each once: "cap" (hook cap), "engine"

# Hooks fire from the agent thread and from parallel tool workers.
_pr_lock = threading.Lock()
_pr_delivered: set[tuple[str, str]] = set()  # (session_id, PR URL) the model was nudged about
_pr_pending: dict[str, dict[str, str]] = {}  # session_id -> PR URL -> nudge for its next turn
# Plan-scoped state is keyed by (session_id, graphId): a session's next planned prompt is a new graph with its own rows.
_pr_latest: dict[tuple[str, str], str] = {}  # (session_id, graphId) -> the last PR URL opened for that plan
# Subagents never plan, but their tool calls fire the same hooks: a PR URL a child's own `gh pr create`
# printed is proof it was opened, and its delegate_task result can then nudge the parent.
_child_parent: dict[str, str] = {}  # child session_id -> parent session_id (from subagent_start)
_child_opened: dict[tuple[str, str], set[str]] = {}  # (parent session_id, graphId) -> PR URLs its children opened for that plan
DELEGATE_TOOL = "delegate_task"  # Hermes runs subagents through this tool; its result is the child's text
_sync_nudged: set[tuple[str, str]] = set()  # (session_id, graphId) pre_verify already continued with a sync nudge

# /ultrathink-quick arms one skip per injected message. pre_llm_call consumes it only on
# that exact message, so a message queued behind a running turn still goes out unplanned.
_quick_lock = threading.Lock()
_quick_pending: dict[str, int] = {}  # stripped message -> injected copies pre_llm_call has not seen

# Teachable Moments state. The lock guards the dicts only and is never held across I/O.
_teach_lock = threading.Lock()
_teach_status_cache: dict[str, tuple[float, float, dict[str, Any]]] = {}  # cwd -> (cached at, ttl seconds, `teach status --json`)
_observed_at: dict[str, float] = {}  # session_id -> clock time of its last observe spawn
_synced: set[str] = set()  # session_ids whose outbox sync was already started
_clock = time.monotonic


def timeout_seconds() -> int:
	try:
		value = int(os.environ.get("ULTRATHINK_HERMES_TIMEOUT", ""))
	except ValueError:
		return DEFAULT_TIMEOUT_S
	return value if value > 0 else DEFAULT_TIMEOUT_S


def _first_warning(key: str) -> bool:
	"""True only the first time this process asks to log warning `key`."""
	with _warn_lock:
		if key in _warned:
			return False
		_warned.add(key)
		return True


def host_hook_cap() -> float | None:
	"""The pre_llm_call cap Hermes enforces right now, resolved the way Hermes does per
	hook invocation; None outside Hermes (hermes_cli.plugins not importable). A Hermes
	whose private resolver is missing or fails gets plugins.hook_callback_timeout from
	the active profile's config.yaml (_hermes_config_file), else Hermes' 30 s default,
	and one warning."""
	try:
		from hermes_cli import plugins as hermes_plugins  # type: ignore[import-not-found]
	except Exception:
		return None
	try:
		return float(hermes_plugins._resolve_hook_callback_timeout())
	except Exception:
		pass
	config = _hermes_config_file()
	configured = None if config is None else _config_hook_cap(config)
	cap = HERMES_DEFAULT_CAP_S if configured is None else configured
	if _first_warning("cap"):
		if configured is not None:
			source = f"plugins.hook_callback_timeout = {cap:g} from {config}"
		elif config is not None:
			source = f"Hermes' {cap:g}s default, as {config} sets no plugins.hook_callback_timeout"
		else:
			source = f"Hermes' {cap:g}s default, as the active Hermes profile (active_profile) has no directory"
		logger.warning(
			"ultrathink: this Hermes does not report its plugin hook cap, so ultrathink uses %s; "
			"prompts are planned only when the cap is at least %ss (`hermes config set plugins.hook_callback_timeout 600`)",
			source,
			MIN_PLAN_S + HOOK_MARGIN_S,
		)
	return cap


def _hermes_config_file() -> Path | None:
	"""The config.yaml Hermes reads, resolved like its profile override (and scripts/mcp-register.ts
	hermesConfigFile): a HERMES_HOME that is a `<root>/profiles/<name>` directory is used as is;
	otherwise a non-default `active_profile` in the Hermes root selects `profiles/<name>` under
	HERMES_HOME (or ~/.hermes). None when that profile cannot be resolved, which Hermes refuses to run with."""
	native = Path.home() / ".hermes"
	raw = os.environ.get("HERMES_HOME", "").strip()
	# Expanded the way Hermes expands HERMES_HOME.
	env_home = Path(os.path.expanduser(os.path.expandvars(raw))) if raw else None
	if env_home is not None and env_home.parent.name == "profiles":
		return env_home / "config.yaml"
	base = env_home or native
	env_path = None if env_home is None else env_home.absolute()
	root = native if env_path is None or env_path == native or native in env_path.parents else base
	try:
		active = (root / "active_profile").read_text(encoding="utf-8").strip().lower()
	except (OSError, ValueError):
		active = ""
	if not active or active == "default":
		return base / "config.yaml"
	if re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", active) is None:
		return None
	profile = base / "profiles" / active
	return profile / "config.yaml" if profile.exists() else None


def _config_hook_cap(path: Path) -> float | None:
	"""plugins.hook_callback_timeout in the Hermes config.yaml at `path`, applied the way
	Hermes applies it: a negative value is ignored, one over HERMES_MAX_CAP_S is clamped.
	A line parser, not YAML: only a `hook_callback_timeout:` key at the indentation of the
	top-level `plugins:` block's own keys counts. None when unreadable, unset or not a number."""
	try:
		lines = path.read_text(encoding="utf-8-sig").splitlines()
	except (OSError, ValueError):
		return None
	raw: str | None = None
	in_plugins = False
	key_indent: int | None = None  # the indentation of the plugins: block's keys, from its first line
	for line in lines:
		text = YAML_COMMENT_RE.sub("", line).rstrip()
		if not text.strip():
			continue
		indent = len(text) - len(text.lstrip(" "))
		if indent == 0:
			# A repeated top-level plugins: replaces the earlier block, as a duplicate YAML key does.
			in_plugins = PLUGINS_KEY_RE.fullmatch(text) is not None
			key_indent = None
			if in_plugins:
				raw = None
			continue
		if not in_plugins:
			continue
		if key_indent is None:
			key_indent = indent
		match = HOOK_CAP_KEY_RE.fullmatch(text[indent:]) if indent == key_indent else None
		if match is not None:
			raw = match.group(1) or ""
	if raw is None:
		return None
	value = raw.strip()
	if len(value) > 1 and value[0] == value[-1] and value[0] in "'\"":
		value = value[1:-1]
	try:
		cap = float(value)
	except ValueError:
		return None
	return None if cap < 0 else min(cap, HERMES_MAX_CAP_S)


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
	if _first_warning("cap"):
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


def strip_sender_tag(prompt: str, sender: str | None = None) -> str:
	"""The message without a shared session's leading "[Name] " sender tag; unchanged
	when it has none. Hermes' "[IMPORTANT: …]" skill scaffold is not a tag. With `sender`,
	only a tag naming that sender is removed, so a user's own "[backend] …" label stays."""
	text = prompt.lstrip()
	if text.startswith(SKILL_SCAFFOLD_PREFIX):
		return prompt
	tag = SENDER_TAG_RE.match(text)
	if tag is None:
		return prompt
	# Slack tags read "[Name | Slack user <@U…>]" (gateway/run_inbound.py _prefix_inbound_sender_context).
	if sender is not None and tag.group(1).split(" | ", 1)[0].strip() != sender.strip():
		return prompt
	return text[tag.end() :]


def session_sender() -> str:
	"""The current gateway sender's display name (HERMES_SESSION_USER_NAME, which Hermes
	binds for the turn and copies into hook threads); "" outside a gateway turn."""
	try:
		from gateway.session_context import get_session_env  # type: ignore[import-not-found]

		return get_session_env("HERMES_SESSION_USER_NAME") or ""
	except Exception:
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
	# Only the sender's own tag goes: a leading "[label] " the user typed is part of the request.
	sender = session_sender()
	if sender:
		prompt = strip_sender_tag(prompt, sender)
	# Hermes expands /skill commands into an "[IMPORTANT: The user has invoked …]" scaffold
	# before pre_llm_call, so a prompt still starting with "/" is never a skill with a task.
	if not prompt.strip() or prompt.strip().startswith("/") or is_already_uplifted(prompt):
		return ""
	deadline = plan_deadline()
	if deadline is None:
		_warn_short_cap()
		return ""
	child_env = os.environ.copy()
	child_env.update(env or {})
	# Hermes passes no cwd to pre_llm_call, so the turn directory comes from the
	# environment. Local CLI turns (platform "cli") run in the process directory
	# (the launch dir; --in chdirs first); every other turn only has TERMINAL_CWD.
	terminal_cwd = child_env.get("TERMINAL_CWD", "").strip()
	try:
		process_cwd = os.getcwd()
	except OSError:
		process_cwd = ""
	if payload.get("platform") == "cli":
		cwd = payload.get("cwd") or process_cwd or terminal_cwd
	else:
		cwd = payload.get("cwd") or terminal_cwd or process_cwd
	request = {
		"host": "hermes",
		"session_id": payload.get("session_id") or payload.get("sessionId") or "",
		"prompt": prompt,
		"cwd": cwd,
		"platform": payload.get("platform") or "",
		"parent_session_id": parent or "",
		"model": payload.get("model") or "",
	}
	child_env["ULTRATHINK_HOST"] = "hermes"
	bun = child_env.get("BUN")
	# A plugin directory copied out of its clone has no engine (nor bin/run-bun) beside it.
	missing = next((path for path in ((ENGINE,) if bun else (ENGINE, RUN_BUN)) if not path.exists()), None)
	if missing is not None:
		if _first_warning("engine"):
			logger.warning(
				"ultrathink: %s not found; install hosts/hermes as a symlink into a full clone of ultrathink "
				"(docs/install.md#hermes-agent)",
				missing,
			)
		return ""
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


def note_subagent(payload: dict[str, Any]) -> None:
	"""subagent_start: remember which parent a child session works for."""
	child = str(payload.get("child_session_id") or "").strip()
	parent = str(payload.get("parent_session_id") or "").strip()
	if child and parent:
		with _pr_lock:
			_child_parent[child] = parent


def _opened_pr(payload: dict[str, Any]) -> tuple[str, str, bool] | None:
	"""(owner session_id, PR URL, opened by a child) when this tool call may prove a PR was
	opened: the session's own `gh pr create`, a child's `gh pr create` (owned by its parent),
	or a delegate_task result naming a PR; _pr_event checks the last against the plan's proof."""
	session_id = str(payload.get("session_id") or "").strip()
	tool_name = str(payload.get("tool_name") or "")
	args = payload.get("args")
	command = (args.get("command") or args.get("cmd") or "") if isinstance(args, dict) else ""
	if not session_id:
		return None
	url = extract_pr_url(_result_text(payload.get("result")))
	if not url:
		return None
	if is_pr_creation_tool(tool_name, str(command)):
		with _pr_lock:
			parent = _child_parent.get(session_id)
		return (session_id, url, False) if parent is None else (parent, url, True)
	if tool_name == DELEGATE_TOOL:
		return session_id, url, False
	return None


def _pr_event(payload: dict[str, Any], env: dict[str, str] | None) -> tuple[str, str, str, str, bool] | None:
	"""(session_id, graphId, PR URL, nudge, opened by a child) for a planned session's
	opened PR; subagents never plan, so a child's PR belongs to the parent's current plan."""
	opened = _opened_pr(payload)
	if opened is None:
		return None
	session_id, url, by_child = opened
	path = state_path(session_id, env)
	record = _read_record(path)
	if record is None or not isinstance(record.get("plan"), dict):
		return None
	graph_id = str(record["plan"].get("graphId") or "")
	# Proof is plan-scoped: a child's PR counts for the plan the parent had when it was opened, so a later
	# delegate result that cites it after a new plan replaced that graph proves nothing for the new one.
	if by_child:
		with _pr_lock:
			_child_opened.setdefault((session_id, graph_id), set()).add(url)
	elif str(payload.get("tool_name") or "") == DELEGATE_TOOL:
		with _pr_lock:
			proven = url in _child_opened.get((session_id, graph_id), set())
		if not proven:
			return None  # a delegate result that merely cites a PR (a review, a failed attempt) is not an opened PR
	nudge = (
		f"Ultrathink: a pull request was opened for the tracked task (graph {graph_id}, {url}). "
		f"Invoke {skill_reference('ultrathink-sync')} now with stateFile={path}, graphId={graph_id} and prUrl={url}, "
		"so the tracked Notion Task row and Linear issues get the PR URL/number/branch and status. "
		"ultrathink-sync only updates existing rows; do not create new Notion rows or Linear issues."
	)
	return session_id, graph_id, url, nudge, by_child


def _queue(session_id: str, graph_id: str, url: str, nudge: str) -> None:
	"""Hold the nudge for the session's next turn unless it was already delivered; caller holds no lock."""
	with _pr_lock:
		if (session_id, url) not in _pr_delivered:
			_pr_pending.setdefault(session_id, {})[url] = nudge
		_pr_latest[(session_id, graph_id)] = url


def pr_tool_result(payload: dict[str, Any], env: dict[str, str] | None = None) -> str | None:
	"""transform_tool_result: the tool result with the nudge appended below it,
	the first time a planned session's tool call opens that PR. None keeps the
	result unchanged. A child's own `gh pr create` result stays untouched: the
	parent owns the tracked task, so its nudge is queued for the parent instead."""
	result = payload.get("result")
	if not isinstance(result, str):
		return None  # only text can carry the nudge; post_tool_call queues it instead
	event = _pr_event(payload, env)
	if event is None:
		return None
	session_id, graph_id, url, nudge, by_child = event
	if by_child:
		_queue(session_id, graph_id, url, nudge)
		return None
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
	session_id, graph_id, url, nudge, _by_child = event
	_queue(session_id, graph_id, url, nudge)


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
		f"Before finishing, invoke {skill_reference('ultrathink-sync')} with stateFile={path}, graphId={key[1]}{pr}. "
		"It only updates the existing Notion Task row and Linear issues found by Graph ID and never creates rows; "
		"if Notion or Linear is down, report that in one line and finish without blocking."
	)
	return {"action": "continue", "message": message}


def control(args: list[str], env: dict[str, str] | None = None) -> tuple[bool, str]:
	"""Run `bin/ultrathink <args>` as Hermes against the engine's state directory:
	(True, its text), or (False, one line saying what failed). Never raises."""
	label = " ".join(["Ultrathink", *args[:1]])
	try:
		child_env = _child_env(env)
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
	# A failing CLI says why on stderr: without bun, bin/ultrathink exits 127 with an install hint.
	lines = [line.strip() for line in f"{completed.stderr}\n{text}".splitlines() if line.strip()]
	detail = next((line for line in lines if line.startswith("error:")), lines[0] if lines else "")
	return False, f"{label} failed: {detail or f'exit code {completed.returncode}'}"


def _take_quick(prompt: str) -> bool:
	"""Consume one /ultrathink-quick marker for exactly this message, sender tag aside."""
	text = prompt.strip()
	untagged = strip_sender_tag(text)
	with _quick_lock:
		for key in (text, untagged) if untagged != text else (text,):
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


def _child_env(env: dict[str, str] | None = None) -> dict[str, str]:
	"""The environment every bin/ultrathink child gets: Hermes as the host, the engine's state directory."""
	return {**os.environ, **(env or {}), "ULTRATHINK_HOST": "hermes", "ULTRATHINK_STATE_DIR": str(state_dir(env))}


def _one_line(text: object, limit: int = 300) -> str:
	line = " ".join(str(text).split())
	return line if len(line) <= limit else line[: limit - 1] + "…"


def _failure_detail(completed: subprocess.CompletedProcess[str]) -> str:
	"""One line saying why a CLI run failed, the way control() words it."""
	lines = [line.strip() for line in f"{completed.stderr}\n{completed.stdout}".splitlines() if line.strip()]
	detail = next((line for line in lines if line.startswith("error:")), lines[0] if lines else "")
	return _one_line(detail or f"exit code {completed.returncode}")


def _teach_json(args: list[str], timeout: float, env: dict[str, str] | None = None, stdin: str | None = None) -> tuple[Any, str]:
	"""Run `bin/ultrathink teach <args>` and parse its stdout as JSON: (value, "") or (None, one line
	saying what failed). A CLI that exits non-zero but still prints JSON ({"ok": false, ...}) counts as an answer.
	Never raises, and the error text never carries the input."""
	try:
		completed = subprocess.run(
			[str(CLI), "teach", *args],
			input=stdin,
			encoding="utf-8",
			errors="replace",
			capture_output=True,
			timeout=timeout,
			env=_child_env(env),
			check=False,
		)
	except subprocess.TimeoutExpired:
		return None, f"no answer after {timeout}s"
	except Exception as error:
		return None, _one_line(error)
	try:
		value = json.loads(completed.stdout)
	except ValueError:
		return None, _failure_detail(completed)
	return (value, "") if isinstance(value, (dict, list)) else (None, _failure_detail(completed))


def _cwd() -> str:
	try:
		return os.getcwd()
	except OSError:
		return ""


def teach_status(env: dict[str, str] | None = None) -> dict[str, Any]:
	"""`teach status --json` for the current directory, cached per process for 10 minutes (a failed
	run caches {"enabled": False} for one). Never raises."""
	key = _cwd()
	with _teach_lock:
		entry = _teach_status_cache.get(key)
	if entry is not None and _clock() - entry[0] < entry[1]:
		return dict(entry[2])
	try:
		data, _ = _teach_json(["status", "--json"], TEACH_STATUS_TIMEOUT_S, env)
	except Exception:
		data = None
	if isinstance(data, dict) and "enabled" in data:
		status, ttl = data, TEACH_STATUS_TTL_S
	else:
		status, ttl = {"enabled": False}, TEACH_STATUS_FAILED_TTL_S
	with _teach_lock:
		_teach_status_cache[key] = (_clock(), ttl, status)
	return dict(status)


def _content_text(content: Any) -> str:
	if isinstance(content, str):
		return content
	if isinstance(content, list):
		parts = [part if isinstance(part, str) else part.get("text") for part in content if isinstance(part, (str, dict))]
		return "\n".join(part for part in parts if isinstance(part, str))
	return ""


def _tool_row_failed(row: dict[str, Any], text: str) -> bool:
	"""Whether a Hermes tool row reports a failure: its own status, text that starts with Error, or a JSON
	result with an error, success false or a non-zero exit_code."""
	if row.get("is_error") is True or str(row.get("status", "")).lower() in ("error", "failed", "failure"):
		return True
	stripped = text.lstrip()
	if stripped.startswith("Error"):
		return True
	if not stripped.startswith("{"):
		return False
	try:
		data = json.loads(stripped)
	except ValueError:
		return False
	if not isinstance(data, dict):
		return False
	code = data.get("exit_code")
	return (
		data.get("error") not in (None, "", False, [], {})
		or data.get("success") is False
		or (isinstance(code, int) and not isinstance(code, bool) and code != 0)
	)


def build_digest(payload: dict[str, Any]) -> dict[str, Any] | None:
	"""The TeachDigest (src/teach/types.ts) for a post_llm_call payload, or None when its history has
	fewer than two tool rows. The last 60 turns, each cut to 1500 characters; redaction is observe's job."""
	history = payload.get("conversation_history")
	rows = history if isinstance(history, list) else []
	call_names: dict[str, str] = {}
	turns: list[dict[str, Any]] = []
	for row in rows:
		if not isinstance(row, dict):
			continue
		role = row.get("role")
		text = _content_text(row.get("content")).strip()
		if role == "user":
			if text:
				turns.append({"role": "user", "text": text})
		elif role == "assistant":
			calls = []
			for call in row.get("tool_calls") or []:
				function = call.get("function") if isinstance(call, dict) else None
				if not isinstance(function, dict) or not isinstance(function.get("name"), str):
					continue
				arguments = function.get("arguments")
				arguments = arguments if isinstance(arguments, str) else json.dumps(arguments, default=str)
				calls.append((function["name"], arguments))
				if isinstance(call.get("id"), str):
					call_names[call["id"]] = function["name"]
			if text:
				turns.append({"role": "assistant", "text": text})
			elif calls:
				summary = "; ".join(f"{name}({arguments[:TOOL_CALL_ARGS_CHARS]})" for name, arguments in calls)
				turns.append({"role": "assistant", "text": summary, "tool": calls[0][0]})
		elif role == "tool":
			turn: dict[str, Any] = {"role": "tool", "text": text or "(no output)"}
			name = row.get("name") if isinstance(row.get("name"), str) else call_names.get(str(row.get("tool_call_id")))
			if name:
				turn["tool"] = name
			if _tool_row_failed(row, text):
				turn["isError"] = True
			turns.append(turn)
	response = payload.get("assistant_response")
	if isinstance(response, str) and response.strip():
		last = next((turn for turn in reversed(turns) if turn["role"] == "assistant"), None)
		if last is None or last["text"] != response.strip():
			turns.append({"role": "assistant", "text": response.strip()})
	turns = turns[-DIGEST_MAX_TURNS:]
	for turn in turns:
		turn["text"] = turn["text"][:DIGEST_TURN_CHARS]
	tool_rows = sum(1 for turn in turns if turn["role"] == "tool")
	if tool_rows < DIGEST_MIN_TOOL_ROWS:
		return None
	session_id = payload.get("session_id")
	cwd = payload.get("cwd")
	return {
		"host": "hermes",
		"sessionId": session_id if isinstance(session_id, str) and session_id else "unknown",
		"cwd": cwd if isinstance(cwd, str) and cwd else _cwd(),
		"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
		"turns": turns,
		"toolCalls": tool_rows,
		"outcome": "completed",
	}


def _write_inbox(digest: dict[str, Any], env: dict[str, str] | None) -> Path:
	"""<state dir>/teach/inbox/<epoch>-<8 hex>.json, the directory src/teach/spawn.ts writes to: dirs 0700, file 0600."""
	base = state_dir(env) / "teach"
	inbox = base / "inbox"
	inbox.mkdir(parents=True, exist_ok=True)
	for directory in (base, inbox):
		os.chmod(directory, 0o700)
	path = inbox / f"{int(time.time())}-{os.urandom(4).hex()}.json"
	descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
	with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
		json.dump(digest, handle, ensure_ascii=False)
	return path


def _spawn_detached(args: list[str], env: dict[str, str] | None = None, cwd: str | None = None) -> bool:
	"""Start `bin/ultrathink teach <args>` in its own session with stdio closed, and do not wait for it."""
	try:
		subprocess.Popen(
			[str(CLI), "teach", *args],
			stdin=subprocess.DEVNULL,
			stdout=subprocess.DEVNULL,
			stderr=subprocess.DEVNULL,
			start_new_session=True,
			env=_child_env(env),
			cwd=cwd if cwd and os.path.isdir(cwd) else None,
		)
	except Exception:
		return False
	return True


def observe_turn(payload: dict[str, Any], env: dict[str, str] | None = None) -> str:
	"""post_llm_call: hand the finished turn to a detached `teach observe`. "spawned", or the reason
	nothing ran ("subagent", "cron", "off", "explicit", "short", "throttled", "error"). Never raises."""
	try:
		if payload.get("parent_session_id"):
			return "subagent"
		if payload.get("platform") == "cron":
			return "cron"
		status = teach_status(env)
		if not status.get("enabled"):
			return "off"
		if status.get("capture") == "explicit":
			return "explicit"
		digest = build_digest(payload)
		if digest is None:
			return "short"
		session_id = digest["sessionId"]
		now = _clock()
		with _teach_lock:
			last = _observed_at.get(session_id)
			if last is not None and now - last < TEACH_OBSERVE_INTERVAL_S:
				return "throttled"
			for stale in [key for key, at in _observed_at.items() if now - at >= TEACH_OBSERVE_INTERVAL_S]:
				del _observed_at[stale]
			_observed_at[session_id] = now
		path = _write_inbox(digest, env)
		if not _spawn_detached(["observe", "--file", str(path)], env, digest["cwd"]):
			path.unlink(missing_ok=True)  # the digest holds unredacted turns: do not leave it behind
			return "error"
		return "spawned"
	except Exception:
		return "error"


def sync_outbox(payload: dict[str, Any], env: dict[str, str] | None = None) -> str:
	"""on_session_finalize: start a detached `teach sync`, once per session, when Teachable Moments is on.
	"spawned" or the reason nothing ran. Never raises."""
	try:
		session_id = payload.get("session_id")
		key = session_id if isinstance(session_id, str) else ""
		with _teach_lock:
			if key in _synced:
				return "done"
		if not teach_status(env).get("enabled"):
			return "off"
		with _teach_lock:
			if key in _synced:
				return "done"
			_synced.add(key)
		return "spawned" if _spawn_detached(["sync"], env, _cwd()) else "error"
	except Exception:
		return "error"


def capture_lesson(args: Any, env: dict[str, str] | None = None) -> dict[str, Any]:
	"""Save one lesson through `teach capture --stdin --json`: the CLI's JSON ({"ok": true, "id", "created",
	"retain", "reason"}) or {"ok": False, "error": ...}. Never raises."""
	try:
		if not isinstance(args, dict):
			return {"ok": False, "error": "arguments must be an object with name and body"}
		name, body = args.get("name"), args.get("body")
		if not isinstance(name, str) or not name.strip() or not isinstance(body, str) or not body.strip():
			return {"ok": False, "error": "name and body are required non-empty strings"}
		kind = args.get("kind") or "pattern"
		if kind not in TEACH_KINDS:
			return {"ok": False, "error": f"kind must be one of {', '.join(TEACH_KINDS)}"}
		lesson: dict[str, Any] = {"name": name.strip(), "body": body.strip(), "kind": kind}
		description = args.get("description")
		if isinstance(description, str) and description.strip():
			lesson["description"] = description.strip()
		tags = args.get("tags")
		if isinstance(tags, list):
			lesson["tags"] = [tag.strip() for tag in tags if isinstance(tag, str) and tag.strip()][:TEACH_MAX_TAGS]
		data, detail = _teach_json(["capture", "--stdin", "--json"], TEACH_CAPTURE_TIMEOUT_S, env, json.dumps(lesson))
		if isinstance(data, dict):
			return data
		return {"ok": False, "error": detail or "teach capture gave no answer"}
	except Exception as error:
		return {"ok": False, "error": _one_line(error)}


def recall_lessons(query: str, limit: int | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
	"""Search saved lessons through `teach recall <query> --json`: the CLI's JSON ({"status", "count", "lessons", ...})
	or {"status": "error", "count": 0, "lessons": [], "reason": ...}. Never raises."""
	failed: dict[str, Any] = {"status": "error", "count": 0, "lessons": []}
	try:
		# A leading dash would read as a CLI flag.
		text = query.strip().lstrip("-").strip() if isinstance(query, str) else ""
		if not text:
			return {**failed, "reason": "query is a required non-empty string"}
		args = ["recall", text, "--json"]
		if isinstance(limit, int) and not isinstance(limit, bool):
			args += ["--limit", str(max(1, min(limit, 20)))]
		data, detail = _teach_json(args, TEACH_RECALL_TIMEOUT_S, env)
		if isinstance(data, dict):
			return data
		return {**failed, "reason": detail or "teach recall gave no answer"}
	except Exception as error:
		return {**failed, "reason": _one_line(error)}


def learn(note: str, env: dict[str, str] | None = None) -> str:
	"""/ultrathink-learn <note>: save the note as a "pattern" lesson named by its first sentence."""
	body = (note or "").strip()
	if not body:
		return "Usage: /ultrathink-learn <note>"
	collapsed = " ".join(body.split())
	sentence = re.match(r"(.+?[.!?])(?:\s|$)", collapsed)
	name = (sentence.group(1) if sentence else collapsed)[:LEARN_NAME_CHARS].rstrip()
	result = capture_lesson({"name": name, "body": body, "kind": "pattern"}, env)
	if result.get("ok") is True:
		return f"Saved lesson {result.get('id', '?')} (retain: {result.get('retain', 'unknown')})."
	return f"Could not save the lesson: {_one_line(result.get('error') or 'unknown error')}"


def _lesson_items(data: Any) -> list[dict[str, Any]] | None:
	if isinstance(data, dict):
		data = next((data[key] for key in ("moments", "lessons", "items") if isinstance(data.get(key), list)), None)
	return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else None


def _lesson_line(item: dict[str, Any]) -> str:
	tags = ", ".join(str(item[key]) for key in ("kind", "status") if item.get(key))
	line = f"- {item.get('id', '?')}" + (f" [{tags}]" if tags else "") + f" {item.get('name', '')}"
	description = item.get("description")
	return _one_line(f"{line}: {description}" if description else line, 240)


def _dispatch_failure(result: Any) -> str | None:
	"""Why Hermes' skill_manage refused the skill, or None when its answer reports no failure."""
	if isinstance(result, str):
		try:
			result = json.loads(result)
		except ValueError:
			return None
	if isinstance(result, dict):
		if result.get("success") is False or result.get("error"):
			return _one_line(result.get("error") or result.get("message") or "skill_manage refused the skill")
	return None


def _promote(moment_id: str, dispatch: Callable[..., Any] | None, env: dict[str, str] | None) -> str:
	if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.:-]*", moment_id):
		return "Usage: /ultrathink-lessons promote <id>"
	data, detail = _teach_json(["promote", moment_id, "--target", "hermes", "--json"], CONTROL_TIMEOUT_S, env)
	draft = data.get("draft") if isinstance(data, dict) else None
	if not isinstance(draft, dict) or not isinstance(draft.get("name"), str) or not isinstance(draft.get("content"), str):
		return f"Could not draft a skill from {moment_id}: {detail or _one_line(data.get('error') if isinstance(data, dict) and data.get('error') else 'no draft')}"
	name = draft["name"]
	outcome = data.get("outcome") if isinstance(data, dict) else None
	failure = "this Hermes has no dispatch_tool"
	if callable(dispatch):
		try:
			result = dispatch(
				"skill_manage",
				{"action": "create", "name": name, "category": "ultrathink-lessons", "content": draft["content"]},
			)
			failure = _dispatch_failure(result) or ""
		except Exception as error:
			failure = _one_line(error)
		if not failure:
			marked, mark_reply = control(["teach", "promote", moment_id, "--mark-promoted", "--skill", name, "--target", "hermes"], env)
			note = "" if marked else f" The lesson is not marked promoted yet ({mark_reply})."
			return (
				f"Sent the skill {name} for lesson {moment_id} to Hermes. With skills.write_approval on it is staged: "
				f"review it with /skills pending, then /skills approve <id>.{note}"
			)
	path = outcome.get("path") if isinstance(outcome, dict) else None
	if not isinstance(path, str) or not path:
		installed, _ = _teach_json(["promote", moment_id, "--target", "hermes", "--install", "--json"], CONTROL_TIMEOUT_S, env)
		outcome = installed.get("outcome") if isinstance(installed, dict) else None
		path = outcome.get("path") if isinstance(outcome, dict) else None
	home = Path(os.environ.get("HERMES_HOME", "").strip() or Path.home() / ".hermes")
	where = f"Draft: {path}." if isinstance(path, str) and path else "No draft file was written."
	return (
		f"Could not stage the skill through Hermes ({failure}). {where} Install it by hand: create the skill {name} "
		f"(category ultrathink-lessons) with skill_manage, or copy the draft to {home / 'skills' / 'ultrathink-lessons' / name / 'SKILL.md'}, "
		f"then run `bin/ultrathink teach promote {moment_id} --mark-promoted --skill {name} --target hermes`."
	)


def lessons_command(raw_args: str, dispatch: Callable[..., Any] | None = None, env: dict[str, str] | None = None) -> str:
	"""/ultrathink-lessons [list|recall <query>|promote <id>|status]: one reply text. `dispatch` is ctx.dispatch_tool."""
	verb, _, rest = (raw_args or "").strip().partition(" ")
	verb, rest = (verb or "list").lower(), rest.strip()
	if verb == "status":
		return control(["teach", "status"], env)[1]
	if verb == "list":
		data, detail = _teach_json(["list", "--json"], CONTROL_TIMEOUT_S, env)
		if data is None:
			return f"Could not list lessons: {detail}"
		items = _lesson_items(data)
		if items is None:
			return _one_line(json.dumps(data), 1500)
		return "\n".join(_lesson_line(item) for item in items[:30]) or "No lessons saved yet."
	if verb == "recall":
		if not rest:
			return "Usage: /ultrathink-lessons recall <query>"
		result = recall_lessons(rest, 5, env)
		lessons = _lesson_items(result.get("lessons")) or []
		if not lessons:
			reason = result.get("reason")
			return "No matching lessons." + (f" ({_one_line(reason)})" if reason else "")
		return "\n".join(_lesson_line({**lesson, "status": None}) for lesson in lessons)
	if verb == "promote":
		return _promote(rest.split()[0] if rest else "", dispatch, env)
	return "Usage: /ultrathink-lessons [list|recall <query>|promote <id>|status]"
