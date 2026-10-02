# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
import importlib.util
import json
import logging
import os
import re
import signal
import stat
import sys
import tempfile
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import bridge  # noqa: E402
from bridge import (  # noqa: E402
	QUICK_FALLBACK,
	extract_pr_url,
	is_pr_creation_tool,
	message_text,
	plan,
	pr_tool_result,
	queue_pr_nudge,
	state_path,
	sync_nudge,
	take_pr_nudges,
)


def load_plugin() -> ModuleType:
	"""Import hosts/hermes as a package, the way Hermes loads a directory plugin. Its
	relative `.bridge` import resolves to this file's `bridge`, so both share state."""
	spec = importlib.util.spec_from_file_location("ultrathink_hermes", HERE / "__init__.py", submodule_search_locations=[str(HERE)])
	assert spec is not None and spec.loader is not None
	module = importlib.util.module_from_spec(spec)
	sys.modules[spec.name] = module
	sys.modules[f"{spec.name}.bridge"] = bridge
	spec.loader.exec_module(module)
	return module


plugin = load_plugin()

PR_URL = "https://github.com/acme/widgets/pull/42"
CAP_FIX = "hermes config set plugins.hook_callback_timeout 600"


def fake_bun(path: Path) -> Path:
	"""A bun stand-in that appends each request prompt to <path>.calls (and the whole
	request to <path>.requests) and echoes the prompt back as the engine's context."""
	path.parent.mkdir(parents=True, exist_ok=True)
	path.write_text(
		f"#!{sys.executable}\nimport json, sys\nrequest = json.load(sys.stdin)\n"
		f"open({str(path) + '.calls'!r}, 'a').write(request['prompt'] + '\\n')\n"
		f"open({str(path) + '.requests'!r}, 'a').write(json.dumps(request) + '\\n')\n"
		"print(json.dumps({'context': 'planned:' + request['prompt']}))\n"
	)
	path.chmod(path.stat().st_mode | stat.S_IEXEC)
	return path


def bun_calls(path: Path) -> list[str]:
	calls = Path(f"{path}.calls")
	return calls.read_text().splitlines() if calls.exists() else []


def bun_requests(path: Path) -> list[dict]:
	requests = Path(f"{path}.requests")
	return [json.loads(line) for line in requests.read_text().splitlines()] if requests.exists() else []


@contextmanager
def hook_cap(cap: float | None) -> Iterator[None]:
	"""Stand in for the plugins.hook_callback_timeout Hermes resolves; None is outside Hermes."""
	saved = bridge.host_hook_cap
	bridge.host_hook_cap = lambda: cap
	try:
		yield
	finally:
		bridge.host_hook_cap = saved


@contextmanager
def bridge_warnings() -> Iterator[list[str]]:
	"""Collect the bridge's log warnings, with its once-per-process warnings re-armed."""
	messages: list[str] = []
	handler = logging.Handler(logging.WARNING)
	handler.emit = lambda record: messages.append(record.getMessage())  # type: ignore[method-assign]
	bridge.logger.addHandler(handler)
	bridge._warned.clear()
	try:
		yield messages
	finally:
		bridge.logger.removeHandler(handler)
		bridge._warned.clear()


@contextmanager
def hermes(resolver: Callable[[], float] | None = None, config: str | None = None, importable: bool = True) -> Iterator[Path]:
	"""Run the bridge as if inside Hermes: a stand-in hermes_cli.plugins whose private
	_resolve_hook_callback_timeout is `resolver` (a Hermes without one when None), and a
	HERMES_HOME whose config.yaml holds `config` (none when None). importable=False is
	outside Hermes, where hermes_cli cannot be imported. Yields the HERMES_HOME."""
	names = ("hermes_cli", "hermes_cli.plugins")
	saved_modules = {name: sys.modules[name] for name in names if name in sys.modules}
	saved_home = os.environ.get("HERMES_HOME")
	with tempfile.TemporaryDirectory() as home:
		if config is not None:
			(Path(home) / "config.yaml").write_text(config)
		os.environ["HERMES_HOME"] = home
		if importable:
			plugins = ModuleType("hermes_cli.plugins")
			if resolver is not None:
				vars(plugins)["_resolve_hook_callback_timeout"] = resolver
			package = ModuleType("hermes_cli")
			vars(package)["plugins"] = plugins
			sys.modules.update({"hermes_cli": package, "hermes_cli.plugins": plugins})
		else:
			for name in names:
				sys.modules[name] = None  # type: ignore[assignment]  # None makes the import fail
		try:
			yield Path(home)
		finally:
			for name in names:
				sys.modules.pop(name, None)
			sys.modules.update(saved_modules)
			if saved_home is None:
				os.environ.pop("HERMES_HOME", None)
			else:
				os.environ["HERMES_HOME"] = saved_home


def exited(pid: int) -> bool:
	"""Whether pid is gone (or a zombie its new parent has yet to reap), polling up to 2s."""
	give_up = time.monotonic() + 2
	while True:
		try:
			os.kill(pid, 0)
		except ProcessLookupError:
			return True
		try:
			if Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "Z":
				return True
		except OSError:
			pass
		if time.monotonic() > give_up:
			return False
		time.sleep(0.05)


def gh_stdout(url: str) -> str:
	return f"Creating pull request for feat/widget into main in acme/widgets\n\n{url}\n"


def gh_pr_create(session_id: str, url: str = PR_URL) -> dict:
	"""A Hermes terminal tool call that ran `gh pr create`; the tool wraps stdout in JSON."""
	return {
		"session_id": session_id,
		"tool_name": "terminal",
		"args": {"command": "git push -u origin HEAD && gh pr create --fill"},
		"result": json.dumps({"output": gh_stdout(url), "exit_code": 0, "error": None}),
	}


def planned_session(home: str, session_id: str) -> Path:
	"""The state file the engine leaves once it has planned a tracked task."""
	path = Path(home) / "ultrathink" / "sessions" / f"{session_id}.json"
	path.parent.mkdir(parents=True, exist_ok=True)
	path.write_text(json.dumps({"sessionId": session_id, "at": 0, "result": {"xml": "<X/>"}, "plan": {"graphId": "g1"}}))
	return path


def tracked_session(home: str, session_id: str, **fields: object) -> Path:
	"""A planned session whose kickoff created the tracker rows; `fields` override the record."""
	path = planned_session(home, session_id)
	record = json.loads(path.read_text())
	rows = {
		"graphId": f"graph-{session_id}",
		"status": "complete",
		"linear": {"nodes": {"n1": {"id": "i1", "identifier": "ENG-1", "url": "https://linear.app/o/issue/ENG-1", "title": "[n1] A"}}, "steps": {}},
		"notion": {"taskUrl": "https://www.notion.so/task", "nodes": {}, "steps": {}},
		"errors": [],
	}
	record.update({"plan": {"graphId": f"graph-{session_id}"}, "tracking": rows, "kickedOff": True}, **fields)
	path.write_text(json.dumps(record))
	return path


def verify(session_id: str, attempt: int = 0) -> dict:
	"""Hermes' pre_verify kwargs for a coding turn about to finish."""
	return {
		"session_id": session_id,
		"platform": "cli",
		"model": "m",
		"coding": True,
		"attempt": attempt,
		"final_response": "Done.",
		"changed_paths": ["src/app.ts"],
	}


SYNC_SKILL = HERE.parents[1] / "skills" / "ultrathink-sync" / "SKILL.md"


def fake_ctx(accepts: bool | None = True) -> SimpleNamespace:
	"""A Hermes PluginContext stand-in. accepts=False refuses to inject (the TUI, or a gateway
	without allow_gateway_injection); accepts=None is a Hermes without inject_message."""
	ctx = SimpleNamespace(hooks=[], callbacks={}, commands={}, injected=[], skills={}, tools={})

	def register_hook(name: str, callback: Callable[..., object]) -> None:
		ctx.hooks.append(name)
		ctx.callbacks[name] = callback

	ctx.register_hook = register_hook
	ctx.register_command = lambda name, handler, description="", args_hint="": ctx.commands.__setitem__(name, handler)
	ctx.register_skill = lambda name, path, description="", frontmatter=None: ctx.skills.__setitem__(name, (path, description))
	ctx.register_tool = lambda name, toolset, schema, handler, check_fn=None, **extra: ctx.tools.__setitem__(
		name, SimpleNamespace(toolset=toolset, schema=schema, handler=handler, check_fn=check_fn)
	)
	if accepts is not None:

		def inject_message(content: str, role: str = "user", *, session_key: str | None = None) -> bool:
			ctx.injected.append(content)
			return accepts

		ctx.inject_message = inject_message
	return ctx


def fake_cli(directory: Path, prelude: str = "") -> Path:
	"""A bin/ultrathink stand-in: logs its arguments to <directory>/calls and prints the host
	and state directory it runs with, then the arguments."""
	path = directory / "ultrathink"
	path.write_text(
		f"#!{sys.executable}\nimport os, sys\n{prelude}\n"
		f"open({str(directory / 'calls')!r}, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n"
		"print(os.environ.get('ULTRATHINK_HOST'), os.environ.get('ULTRATHINK_STATE_DIR'), *sys.argv[1:])\n"
	)
	path.chmod(path.stat().st_mode | stat.S_IEXEC)
	return path


@contextmanager
def cli(path: Path, timeout: int | None = None) -> Iterator[None]:
	"""Point the slash commands at `path` instead of bin/ultrathink."""
	saved = bridge.CLI, bridge.CONTROL_TIMEOUT_S
	bridge.CLI = path
	bridge.CONTROL_TIMEOUT_S = timeout or saved[1]
	try:
		yield
	finally:
		bridge.CLI, bridge.CONTROL_TIMEOUT_S = saved


def test_message_text_reads_string_and_dict():
	assert message_text("hello") == "hello"
	assert message_text({"text": "from text"}) == "from text"
	assert message_text({"nope": 1}) == ""


def test_skips_child_cron_and_empty_without_spawning():
	assert plan({"parent_session_id": "child", "user_message": "do work"}) == ""
	assert plan({"platform": "cron", "user_message": "tick"}) == ""
	assert plan({"user_message": "   "}) == ""


def test_skill_scaffold_reaches_the_engine():
	with tempfile.TemporaryDirectory() as tmp:
		fake = fake_bun(Path(tmp) / "bun")
		prompt = '[IMPORTANT: The user has invoked the "gsd-quick" skill, indicating they want you to follow its instructions.]'
		assert plan({"user_message": prompt, "session_id": "s1"}, env={"BUN": str(fake)}) == f"planned:{prompt}"


def test_engine_is_found_off_path_when_bun_is_unset():
	# Hermes gateways often run without bun on PATH; bin/run-bun still finds $BUN_INSTALL/bin/bun.
	with tempfile.TemporaryDirectory() as tmp:
		fake_bun(Path(tmp) / "bin" / "bun")
		env = {"BUN": "", "BUN_INSTALL": tmp, "PATH": str(Path(tmp) / "no-bun-here")}
		assert plan({"user_message": "add a widget", "session_id": "s1"}, env=env) == "planned:add a widget"


def test_engine_failure_returns_empty():
	# No pytest fixture: call plan with a bun binary that exits immediately and prints junk.
	context = plan(
		{"user_message": "add a widget", "session_id": "s1"},
		env={"BUN": "/bin/false"},
	)
	assert context == ""


def test_a_jev_skip_from_the_engine_returns_empty():
	# A Jev plan skip: no context, the skip reason, and the notice in summary. The bridge reads only context.
	with tempfile.TemporaryDirectory() as tmp, hook_cap(None):
		fake = Path(tmp) / "bun"
		skip = {
			"context": "",
			"skipped": "jev-skip",
			"summary": "Prompt Uplift · not planned: Jev judged this is not new multi-step work (0.04) · start with uplift: to plan it",
		}
		fake.write_text(
			f"#!{sys.executable}\nimport json, sys\nrequest = json.load(sys.stdin)\n"
			f"open({str(fake) + '.calls'!r}, 'a').write(request['prompt'] + '\\n')\n"
			f"print(json.dumps({skip!r}))\n",
			encoding="utf-8",
		)
		fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
		assert plan({"user_message": "thanks, that works now", "session_id": "s1"}, env={"BUN": str(fake)}) == ""
		assert bun_calls(fake) == ["thanks, that works now"]


def test_slash_commands_and_uplifted_xml_never_start_bun():
	with tempfile.TemporaryDirectory() as tmp, hook_cap(None):
		fake = fake_bun(Path(tmp) / "bun")
		engine = {"BUN": str(fake)}
		for prompt in (
			"/foo bar",
			"  /ultrathink-status",
			"<BUILD_PROMPT><task>add a widget</task></BUILD_PROMPT>",
			"\n<fix_prompt>\n<goal>x</goal>\n</fix_prompt>",
			'<ultrathink graph="ut-1-abcdef12"/>',
			"<Uplifted_Prompt>",
			"UPLIFTED",
		):
			assert plan({"user_message": prompt, "session_id": "s1"}, env=engine) == "", prompt
		assert bun_calls(fake) == []
		# Near misses are ordinary prompts: other tags, longer names, a slash mid-sentence.
		for prompt in ("<BUILD_PROMPTS> add a widget", "<div>fix the layout</div>", "fix the /tmp cleanup"):
			assert plan({"user_message": prompt, "session_id": "s1"}, env=engine) == f"planned:{prompt}", prompt
		assert bun_calls(fake) == ["<BUILD_PROMPTS> add a widget", "<div>fix the layout</div>", "fix the /tmp cleanup"]


def test_only_the_senders_own_tag_is_stripped_and_it_never_defeats_the_skips():
	saved = bridge.session_sender
	with tempfile.TemporaryDirectory() as tmp, hook_cap(None):
		fake = fake_bun(Path(tmp) / "bun")
		engine = {"BUN": str(fake)}
		try:
			# A shared multi-user gateway session prefixes each message with its sender's name.
			bridge.session_sender = lambda: "Alice"
			for prompt in (
				"[Alice] /model x",
				"[Alice] <BUILD_PROMPT><task>add a widget</task></BUILD_PROMPT>",
				'[Alice] <ultrathink graph="ut-1-abcdef12"/>',
				"[Alice] ",
			):
				assert plan({"user_message": prompt, "session_id": "s1"}, env=engine) == "", prompt
			bridge.session_sender = lambda: "Bob"
			assert plan({"user_message": "[Bob | Slack user <@U1>]   /ultrathink-status", "session_id": "s1"}, env=engine) == ""
			assert bun_calls(fake) == []
			# The engine sees the text without the sender's tag, so its own skips (acks, raw:) apply.
			bridge.session_sender = lambda: "Alice"
			assert plan({"user_message": "[Alice] ok", "session_id": "s1"}, env=engine) == "planned:ok"
			assert plan({"user_message": "[Alice] add a widget", "session_id": "s1"}, env=engine) == "planned:add a widget"
			# A label the user typed is part of the request, with or without a gateway sender.
			assert plan({"user_message": "[backend] update the guide", "session_id": "s1"}, env=engine) == "planned:[backend] update the guide"
			bridge.session_sender = lambda: ""
			assert plan({"user_message": "[Alice] add a widget", "session_id": "s1"}, env=engine) == "planned:[Alice] add a widget"
			# Hermes' skill scaffold opens with a bracket too, and reaches the engine whole.
			scaffold = '[IMPORTANT: The user has invoked the "gsd-quick" skill, indicating they want you to follow its instructions.] fix it'
			assert plan({"user_message": scaffold, "session_id": "s1"}, env=engine) == f"planned:{scaffold}"
			assert bun_calls(fake) == ["ok", "add a widget", "[backend] update the guide", "[Alice] add a widget", scaffold]
		finally:
			bridge.session_sender = saved


def test_the_planner_runs_in_the_terminal_cwd_hermes_tools_use():
	with tempfile.TemporaryDirectory() as tmp, hook_cap(None):
		fake = fake_bun(Path(tmp) / "bun")
		repo = str(Path(tmp) / "repo")
		payload = {"user_message": "add a widget", "session_id": "s1"}
		plan(payload, env={"BUN": str(fake), "TERMINAL_CWD": repo})
		plan({**payload, "cwd": "/from/payload"}, env={"BUN": str(fake), "TERMINAL_CWD": repo})
		plan(payload, env={"BUN": str(fake), "TERMINAL_CWD": "  "})
		assert [request["cwd"] for request in bun_requests(fake)] == [repo, "/from/payload", os.getcwd()]



def test_deadline_ends_fifteen_seconds_inside_the_hermes_cap():
	saved = os.environ.pop("ULTRATHINK_HERMES_TIMEOUT", None)
	try:
		# 0 runs the hook inline with no cap; None is outside Hermes. Under 90s nothing runs.
		for cap, deadline in ((600, 540), (300, 285), (105, 90), (104.9, None), (30, None), (0, 540), (None, 540)):
			with hook_cap(cap):
				assert bridge.plan_deadline() == deadline, cap
		# ULTRATHINK_HERMES_TIMEOUT still shortens the deadline, but never past the cap.
		os.environ["ULTRATHINK_HERMES_TIMEOUT"] = "120"
		for cap, deadline in ((600, 120), (120, 105), (0, 120)):
			with hook_cap(cap):
				assert bridge.plan_deadline() == deadline, cap
	finally:
		os.environ.pop("ULTRATHINK_HERMES_TIMEOUT", None)
		if saved is not None:
			os.environ["ULTRATHINK_HERMES_TIMEOUT"] = saved


def test_short_hook_cap_never_starts_bun_and_warns_once():
	with tempfile.TemporaryDirectory() as tmp, hook_cap(30), bridge_warnings() as warnings:
		fake = fake_bun(Path(tmp) / "bun")
		for _ in range(2):
			assert plan({"user_message": "add a widget", "session_id": "s1"}, env={"BUN": str(fake)}) == ""
		assert bun_calls(fake) == []
		assert len(warnings) == 1
		assert "30" in warnings[0] and "hermes config set plugins.hook_callback_timeout 600" in warnings[0]
	with tempfile.TemporaryDirectory() as tmp, hook_cap(105), bridge_warnings() as warnings:
		fake = fake_bun(Path(tmp) / "bun")
		assert plan({"user_message": "add a widget", "session_id": "s1"}, env={"BUN": str(fake)}) == "planned:add a widget"
		assert warnings == []


def test_inside_hermes_its_own_cap_resolver_wins_and_outside_there_is_no_cap():
	# config.yaml is only the fallback: neither Hermes' own resolver nor a process outside Hermes reads it.
	config = "plugins:\n  hook_callback_timeout: 30\n"
	with hermes(lambda: 300, config), bridge_warnings() as inside:
		assert bridge.host_hook_cap() == 300
	with hermes(config=config, importable=False), bridge_warnings() as outside:
		assert bridge.host_hook_cap() is None
	assert inside == outside == []


def test_a_hermes_without_its_cap_resolver_uses_the_config_yaml_cap_and_warns_once():
	# Only the plugins: block's own key counts: not a comment, another section's key, or a plugin's setting.
	config = (
		"# hook_callback_timeout: 5\n"
		"agent:\n  hook_callback_timeout: 5\n"
		"plugins:\n"
		"  enabled:\n  - ultrathink\n"
		"  entries:\n    other:\n      hook_callback_timeout: 5\n"
		"  # hook_callback_timeout: 5\n"
		"  hook_callback_timeout: 600  # ten minutes\n"
		"hooks:\n  hook_callback_timeout: 5\n"
	)

	def failing() -> float:
		raise RuntimeError("config cache busy")

	for resolver in (None, failing):  # a Hermes version without the private resolver, or one where it fails
		with tempfile.TemporaryDirectory() as tmp, hermes(resolver, config) as home, bridge_warnings() as warnings:
			fake = fake_bun(Path(tmp) / "bun")
			assert bridge.host_hook_cap() == 600, resolver
			assert plan({"user_message": "add a widget", "session_id": "s1"}, env={"BUN": str(fake)}) == "planned:add a widget"
			assert len(warnings) == 1, warnings
			assert str(home / "config.yaml") in warnings[0] and CAP_FIX in warnings[0]


def test_the_config_yaml_cap_counts_the_way_hermes_counts_it():
	# A quoted number counts and 0 is no cap; over 600 is clamped; negative, non-numeric or empty is the 30s default.
	for value, cap in (("120", 120), ("'300'", 300), ("0", 0), ("1000", 600), ("-5", 30), ("soon", 30), ("", 30)):
		with hermes(config=f"plugins:\n  hook_callback_timeout: {value}\n"), bridge_warnings():
			assert bridge.host_hook_cap() == cap, value


def test_a_hermes_without_its_cap_resolver_reads_the_active_profiles_config_yaml():
	# The root config.yaml sets no cap; the active profile's does, and that is what Hermes enforces.
	with hermes(config="plugins:\n  enabled: []\n") as home, bridge_warnings() as warnings:
		profile = home / "profiles" / "work"
		profile.mkdir(parents=True)
		(profile / "config.yaml").write_text("plugins:\n  hook_callback_timeout: 600\n")
		(home / "active_profile").write_text("work\n")
		assert bridge.host_hook_cap() == 600
		assert len(warnings) == 1 and str(profile / "config.yaml") in warnings[0], warnings
		# A HERMES_HOME that already is a profile directory is used as is, whatever active_profile names.
		other = home / "profiles" / "other"
		other.mkdir()
		(other / "config.yaml").write_text("plugins:\n  hook_callback_timeout: 300\n")
		os.environ["HERMES_HOME"] = str(other)
		assert bridge.host_hook_cap() == 300
		# An active profile without a directory is one Hermes refuses to run with: assume its 30s default.
		os.environ["HERMES_HOME"] = str(home)
		(home / "active_profile").write_text("gone\n")
		assert bridge.host_hook_cap() == 30


def test_a_hermes_without_its_cap_resolver_or_a_configured_cap_assumes_30s_and_never_starts_bun():
	with tempfile.TemporaryDirectory() as tmp, hermes() as home, bridge_warnings() as warnings:
		fake = fake_bun(Path(tmp) / "bun")
		assert bridge.host_hook_cap() == 30
		for _ in range(2):
			assert plan({"user_message": "add a widget", "session_id": "s1"}, env={"BUN": str(fake)}) == ""
		assert bun_calls(fake) == []
		assert len(warnings) == 1, warnings
		assert str(home / "config.yaml") in warnings[0] and CAP_FIX in warnings[0]


def test_a_plugin_directory_without_its_engine_warns_once_and_never_starts_bun():
	# Hermes loaded a copy of hosts/hermes instead of a symlink into a clone: nothing to run is beside it.
	saved = bridge.ENGINE, bridge.RUN_BUN
	with tempfile.TemporaryDirectory() as tmp, hook_cap(None):
		fake = fake_bun(Path(tmp) / "bun")
		try:
			bridge.ENGINE = Path(tmp) / "hooks" / "engine.ts"
			with bridge_warnings() as warnings:
				for _ in range(2):
					assert plan({"user_message": "add a widget", "session_id": "s1"}, env={"BUN": str(fake)}) == ""
			assert bun_calls(fake) == []
			assert len(warnings) == 1 and str(bridge.ENGINE) in warnings[0], warnings
			assert "docs/install.md#hermes-agent" in warnings[0]
			# Without a BUN override the engine starts through bin/run-bun, which must be there too.
			bridge.ENGINE, bridge.RUN_BUN = saved[0], Path(tmp) / "bin" / "run-bun"
			with bridge_warnings() as warnings:
				assert plan({"user_message": "add a widget", "session_id": "s1"}, env={"BUN": ""}) == ""
			assert len(warnings) == 1 and str(bridge.RUN_BUN) in warnings[0], warnings
		finally:
			bridge.ENGINE, bridge.RUN_BUN = saved


def test_deadline_kills_bun_and_everything_it_spawned():
	with tempfile.TemporaryDirectory() as tmp:
		pid_file = Path(tmp) / "grandchild.pid"
		fake = Path(tmp) / "bun"
		# The grandchild holds Bun's stdout open, so killing only Bun would still hang for 60s.
		fake.write_text(
			f"#!{sys.executable}\nimport pathlib, subprocess, time\n"
			"child = subprocess.Popen(['sleep', '60'])\n"
			f"pathlib.Path({str(pid_file)!r}).write_text(str(child.pid))\n"
			"time.sleep(60)\n"
		)
		fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
		saved = bridge.plan_deadline
		bridge.plan_deadline = lambda: 1.0
		started = time.monotonic()
		try:
			assert plan({"user_message": "add a widget", "session_id": "s1"}, env={"BUN": str(fake)}) == ""
		finally:
			bridge.plan_deadline = saved
		assert time.monotonic() - started < 5
		grandchild = int(pid_file.read_text())
		try:
			assert exited(grandchild)
		finally:
			if not exited(grandchild):
				os.kill(grandchild, signal.SIGKILL)


def test_pr_creation_tool_mirrors_pr_detect():
	for command in ("gh pr create --fill", "cd x && gh pr create", "  gh   pr   create"):
		assert is_pr_creation_tool("terminal", command), command
	for tool in ("run_terminal_cmd", "run_terminal_command"):
		assert is_pr_creation_tool(tool, "gh pr create --fill"), tool
		assert not is_pr_creation_tool(tool, "gh pr list"), tool
	# Substring rule, as in pr-detect.ts: a mere mention counts (a spare nudge, never a missed one).
	assert is_pr_creation_tool("terminal", "echo gh pr create")
	for command in ("gh pr list", "gh pr view 5", "gh issue create", "xgh pr create", "gh pr created", ""):
		assert not is_pr_creation_tool("terminal", command), command
	assert is_pr_creation_tool("mcp__acme__github_create_pull_request", "")
	assert is_pr_creation_tool("createPullRequest", "")
	assert not is_pr_creation_tool("mcp__github__list_pull_requests", "")
	# The name must end in the verb, as in pr-detect.ts: reviewing a PR or handing one to Copilot opens none.
	for tool in ("mcp__github__create_pull_request_review", "mcp__github__create_pull_request_with_copilot"):
		assert not is_pr_creation_tool(tool, ""), tool
	# Any other tool is judged by its name, never by a command it happens to carry.
	assert not is_pr_creation_tool("write_file", "gh pr create")
	assert not is_pr_creation_tool("", "gh pr create")


def test_extract_pr_url_reads_gh_output():
	assert extract_pr_url(gh_stdout(PR_URL)) == PR_URL
	assert extract_pr_url(json.dumps({"output": gh_stdout(PR_URL), "exit_code": 0})) == PR_URL
	assert extract_pr_url(f"See {PR_URL} (superseded by https://github.com/acme/widgets/pull/43)") == PR_URL
	assert extract_pr_url("no url here") == ""


def test_tool_result_carries_the_nudge_once_and_only_for_a_planned_session():
	with tempfile.TemporaryDirectory() as home:
		env = {"HERMES_HOME": home, "ULTRATHINK_STATE_DIR": ""}
		call = gh_pr_create("pr-result")
		assert pr_tool_result(call, env=env) is None
		queue_pr_nudge(call, env=env)
		assert take_pr_nudges({"session_id": "pr-result"}) == ""

		state = planned_session(home, "pr-result")
		assert pr_tool_result({**call, "args": {"command": "gh pr view 42"}}, env=env) is None
		result = pr_tool_result(call, env=env)
		assert result is not None and result.startswith(call["result"] + "\n\n")
		assert f'Invoke the ultrathink-sync skill (load it with skill_view name="ultrathink:ultrathink-sync", or read {SYNC_SKILL}) now with stateFile={state}, graphId=g1 and prUrl={PR_URL}' in result
		assert f"(graph g1, {PR_URL})" in result
		assert "do not create new Notion rows or Linear issues" in result
		assert pr_tool_result(call, env=env) is None
		# The sequential executor fires post_tool_call after the transform, with the delivered result.
		queue_pr_nudge({**call, "result": result}, env=env)
		assert take_pr_nudges({"session_id": "pr-result"}) == ""


def test_next_turn_delivers_a_nudge_no_tool_result_carried_once():
	with tempfile.TemporaryDirectory() as home:
		env = {"HERMES_HOME": home, "ULTRATHINK_STATE_DIR": ""}
		planned_session(home, "pr-turn")
		queue_pr_nudge(gh_pr_create("pr-turn"), env=env)
		queue_pr_nudge(gh_pr_create("pr-turn"), env=env)
		assert take_pr_nudges({"session_id": "another-session"}) == ""
		context = take_pr_nudges({"session_id": "pr-turn"})
		assert context.count("Invoke the ultrathink-sync skill") == 1 and f"prUrl={PR_URL}" in context
		assert take_pr_nudges({"session_id": "pr-turn"}) == ""
		assert pr_tool_result(gh_pr_create("pr-turn"), env=env) is None

		# The concurrent executor fires post_tool_call before the transform delivers.
		second = "https://github.com/acme/widgets/pull/43"
		queue_pr_nudge(gh_pr_create("pr-turn", second), env=env)
		assert f"prUrl={second}" in (pr_tool_result(gh_pr_create("pr-turn", second), env=env) or "")
		assert take_pr_nudges({"session_id": "pr-turn"}) == ""


def test_a_pr_a_subagent_really_opened_nudges_the_parent_and_a_cited_one_does_not():
	with tempfile.TemporaryDirectory() as home:
		env = {"HERMES_HOME": home, "ULTRATHINK_STATE_DIR": ""}
		state = planned_session(home, "parent")
		bridge.note_subagent({"parent_session_id": "parent", "child_session_id": "child-1", "child_role": "coder"})
		# A subagent's summary that only cites a PR (a review, a failed attempt) is no proof one was opened.
		cite = {"session_id": "parent", "tool_name": "delegate_task", "args": {"goal": "review"}, "result": json.dumps({"results": [{"summary": f"Reviewed {PR_URL}; nothing to change."}]})}
		assert pr_tool_result(cite, env=env) is None
		queue_pr_nudge(cite, env=env)
		assert take_pr_nudges({"session_id": "parent"}) == ""
		# The child's own `gh pr create` fires the tool hooks with the child's session id: that is the proof.
		child_call = {**gh_pr_create("child-1"), "result": f"Creating pull request...\n{PR_URL}\n"}
		assert pr_tool_result(child_call, env=env) is None  # the child's result stays untouched; the parent owns the task
		queue_pr_nudge(child_call, env=env)
		# The parent's delegate_task result naming that PR carries the nudge once, with the parent's graph.
		opened = {**cite, "result": json.dumps({"results": [{"summary": f"Opened {PR_URL} for the widget."}]})}
		result = pr_tool_result(opened, env=env)
		assert result is not None and f"stateFile={state}, graphId=g1 and prUrl={PR_URL}" in result
		assert pr_tool_result(opened, env=env) is None
		assert take_pr_nudges({"session_id": "parent"}) == ""
		# A child PR the delegate result never names still reaches the parent on its next turn.
		other = "https://github.com/acme/widgets/pull/99"
		queue_pr_nudge({**child_call, "result": f"{other}\n"}, env=env)
		assert other in take_pr_nudges({"session_id": "parent"})
		assert take_pr_nudges({"session_id": "parent"}) == ""
		# Another session's delegate result citing that URL gets nothing: the proof belongs to this parent.
		planned_session(home, "other")
		assert pr_tool_result({**opened, "session_id": "other"}, env=env) is None
		# After a new plan replaces the graph, a delegate result citing the old plan's PR proves nothing for the new one,
		# and the old PR does not become the new plan's latest PR for the end-of-turn nudge.
		record = json.loads(state.read_text())
		record["plan"] = {"graphId": "g2"}
		state.write_text(json.dumps(record))
		assert pr_tool_result(opened, env=env) is None
		queue_pr_nudge(opened, env=env)
		assert take_pr_nudges({"session_id": "parent"}) == ""
		assert ("parent", "g2") not in bridge._pr_latest


def test_finishing_a_tracked_unsynced_turn_continues_once_with_a_sync_nudge():
	with tempfile.TemporaryDirectory() as home:
		env = {"HERMES_HOME": home, "ULTRATHINK_STATE_DIR": ""}
		state = tracked_session(home, "sync-once")
		assert state == state_path("sync-once", env)
		# Hermes re-fires pre_verify after each nudge; a later attempt never nudges.
		assert sync_nudge(verify("sync-once", attempt=1), env=env) is None
		nudge = sync_nudge(verify("sync-once"), env=env)
		assert nudge is not None and nudge["action"] == "continue"
		message = nudge["message"]
		assert SYNC_SKILL.is_absolute() and SYNC_SKILL.is_file()
		assert "graph graph-sync-once" in message and f"stateFile={state}, graphId=graph-sync-once." in message and "prUrl=" not in message
		assert f'skill_view name="ultrathink:ultrathink-sync", or read {SYNC_SKILL}' in message
		assert "never creates rows" in message and "one line" in message
		assert sync_nudge(verify("sync-once"), env=env) is None


def test_no_sync_nudge_without_rows_after_sync_or_with_tracking_off():
	with tempfile.TemporaryDirectory() as home:
		env = {"HERMES_HOME": home, "ULTRATHINK_STATE_DIR": ""}
		assert sync_nudge(verify("no-state"), env=env) is None
		assert sync_nudge({**verify("no-state"), "session_id": ""}, env=env) is None
		planned_session(home, "no-rows")
		assert sync_nudge(verify("no-rows"), env=env) is None
		tracked_session(home, "synced", synced=True)
		assert sync_nudge(verify("synced"), env=env) is None
		tracked_session(home, "no-plan", plan=None)
		assert sync_nudge(verify("no-plan"), env=env) is None
		broken = state_path("broken", env)
		broken.write_text("{not json")
		assert sync_nudge(verify("broken"), env=env) is None

		tracked_session(home, "track-off")
		control = Path(home) / "ultrathink" / "control.json"
		control.write_text(json.dumps({"trackEnabled": False}))
		assert sync_nudge(verify("track-off"), env=env) is None
		# Turning tracking back on still nudges: the refusal above did not use up the session's nudge.
		control.write_text(json.dumps({"trackEnabled": True}))
		assert sync_nudge(verify("track-off"), env=env) is not None


def test_sync_nudge_names_the_pr_the_session_opened():
	with tempfile.TemporaryDirectory() as home:
		env = {"HERMES_HOME": home, "ULTRATHINK_STATE_DIR": ""}
		tracked_session(home, "sync-pr")
		second = "https://github.com/acme/widgets/pull/43"
		assert pr_tool_result(gh_pr_create("sync-pr"), env=env) is not None
		assert pr_tool_result(gh_pr_create("sync-pr", second), env=env) is not None
		assert pr_tool_result(gh_pr_create("another-session"), env=env) is None
		nudge = sync_nudge(verify("sync-pr"), env=env)
		assert nudge is not None and nudge["message"].count("prUrl=") == 1 and f"prUrl={second}." in nudge["message"]

		# A PR only queued for the next turn (no tool result carried it) counts too.
		tracked_session(home, "sync-queued")
		queue_pr_nudge(gh_pr_create("sync-queued"), env=env)
		nudge = sync_nudge(verify("sync-queued"), env=env)
		assert nudge is not None and f"prUrl={PR_URL}." in nudge["message"]


def test_a_new_plan_in_the_session_gets_its_own_nudge_and_never_the_old_pr():
	with tempfile.TemporaryDirectory() as home:
		env = {"HERMES_HOME": home, "ULTRATHINK_STATE_DIR": ""}
		tracked_session(home, "replanned")
		assert pr_tool_result(gh_pr_create("replanned"), env=env) is not None
		assert sync_nudge(verify("replanned"), env=env) is not None
		# The session's next planned prompt writes a new graph (new Graph ID, new rows, synced false).
		tracked_session(home, "replanned", plan={"graphId": "graph-second"})
		nudge = sync_nudge(verify("replanned"), env=env)
		assert nudge is not None and "graph graph-second" in nudge["message"]
		assert "prUrl=" not in nudge["message"]
		assert sync_nudge(verify("replanned"), env=env) is None


def test_tracking_refs_with_no_created_rows_do_not_use_up_the_nudge():
	with tempfile.TemporaryDirectory() as home:
		env = {"HERMES_HOME": home, "ULTRATHINK_STATE_DIR": ""}
		empty = {"graphId": "graph-empty", "status": "failed", "linear": {"nodes": {}, "steps": {}}, "notion": {"nodes": {}, "steps": {}}, "errors": ["notion: login required"]}
		tracked_session(home, "empty", tracking=empty)
		assert sync_nudge(verify("empty"), env=env) is None
		# Once a retried kickoff creates rows, the same plan still gets its nudge.
		tracked_session(home, "empty")
		assert sync_nudge(verify("empty"), env=env) is not None


def test_pre_verify_hook_fails_open():
	ctx = fake_ctx()
	plugin.register(ctx)
	hook = ctx.callbacks["pre_verify"]
	saved = plugin.sync_nudge

	def explode(_payload: dict) -> None:
		raise RuntimeError("state directory vanished")

	setattr(plugin, "sync_nudge", explode)  # noqa: B010 - the hook looks the name up in the plugin module
	try:
		assert hook(**verify("fails-open")) is None
	finally:
		setattr(plugin, "sync_nudge", saved)  # noqa: B010
	saved_env = {key: os.environ.get(key) for key in ("HERMES_HOME", "ULTRATHINK_STATE_DIR")}
	with tempfile.TemporaryDirectory() as home:
		os.environ["HERMES_HOME"] = home
		os.environ.pop("ULTRATHINK_STATE_DIR", None)
		try:
			tracked_session(home, "hooked")
			assert hook(**verify("hooked"))["action"] == "continue"
		finally:
			for key, value in saved_env.items():
				if value is None:
					os.environ.pop(key, None)
				else:
					os.environ[key] = value


def test_registers_every_ultrathink_command_next_to_the_hooks():
	ctx = fake_ctx()
	plugin.register(ctx)
	assert sorted(ctx.commands) == [f"ultrathink-{verb}" for verb in ("learn", "lessons", "off", "on", "quick", "skip", "status", "track")]
	assert ctx.hooks == [
		"pre_llm_call",
		"pre_llm_call",
		"transform_tool_result",
		"post_tool_call",
		"pre_verify",
		"subagent_start",
		"post_llm_call",
		"on_session_finalize",
	]
	assert sorted(ctx.tools) == ["ultrathink_lesson_recall", "ultrathink_lesson_save"]

	# A Hermes that rejects the commands still plans every prompt.
	def reject(*_args: object, **_kwargs: object) -> None:
		raise TypeError("register_command() got an unexpected keyword argument 'args_hint'")

	older = fake_ctx()
	older.register_command = reject
	plugin.register(older)
	assert older.hooks == ctx.hooks and older.commands == {}


def test_registers_the_five_ultrathink_skills_with_their_descriptions():
	ctx = fake_ctx()
	plugin.register(ctx)
	assert sorted(ctx.skills) == ["ultrathink-kickoff", "ultrathink-plan", "ultrathink-ship", "ultrathink-sync", "ultrathink-teach"]
	for name, (path, description) in ctx.skills.items():
		assert path.is_absolute() and path.is_file() and path.as_posix().endswith(f"skills/{name}/SKILL.md"), path
		frontmatter = path.read_text(encoding="utf-8").split("---")[1]
		expected = next(line for line in frontmatter.splitlines() if line.startswith("description:"))
		assert description and description == expected[len("description:") :].strip(), (name, description)


def test_skill_registration_failures_leave_hooks_and_commands_registered():
	ctx = fake_ctx()
	plugin.register(ctx)

	def reject(*_args: object, **_kwargs: object) -> None:
		raise ValueError("Invalid skill name")

	failing = fake_ctx()
	failing.register_skill = reject
	plugin.register(failing)
	assert failing.hooks == ctx.hooks and sorted(failing.commands) == sorted(ctx.commands)

	older = fake_ctx()
	del older.register_skill  # a Hermes before register_skill
	plugin.register(older)
	assert older.hooks == ctx.hooks and sorted(older.commands) == sorted(ctx.commands)


def test_skill_description_is_empty_without_frontmatter():
	with tempfile.TemporaryDirectory() as tmp:
		path = Path(tmp) / "SKILL.md"
		path.write_text("# No frontmatter\ndescription: body text\n")
		assert plugin.skill_description(path) == ""
		path.write_text("---\nname: x\n---\ndescription: body text\n")
		assert plugin.skill_description(path) == ""


def test_control_commands_run_the_cli_as_hermes_and_return_its_text():
	with tempfile.TemporaryDirectory() as tmp:
		ctx = fake_ctx()
		plugin.register(ctx)
		with cli(fake_cli(Path(tmp))):
			# Same state directory as the engine, so the planner sees what the command set.
			assert ctx.commands["ultrathink-track"]("  off ") == f"hermes {bridge.state_dir()} track off"
			assert ctx.commands["ultrathink-status"]("") == f"hermes {bridge.state_dir()} status"


def test_control_failures_come_back_as_one_line():
	with tempfile.TemporaryDirectory() as tmp:
		ctx = fake_ctx()
		plugin.register(ctx)
		off = ctx.commands["ultrathink-off"]
		with cli(Path(tmp) / "missing"):
			reply = off("")
			assert reply.startswith("Ultrathink off: ") and "\n" not in reply, reply
		# Without bun, bin/ultrathink exits 127 with an install hint on stderr.
		hint = "ultrathink: bun not found. Install Bun 1.2 or later (https://bun.sh) or set BUN=/path/to/bun"
		with cli(fake_cli(Path(tmp), f"sys.stderr.write({hint!r} + '\\n'); sys.exit(127)")):
			assert off("") == f"Ultrathink off failed: {hint}"
		with cli(fake_cli(Path(tmp), "import time; time.sleep(10)"), timeout=1):
			assert off("") == "Ultrathink off: no answer after 1s"


def test_quick_sends_the_message_once_without_a_plan():
	with tempfile.TemporaryDirectory() as tmp:
		engine = {"BUN": str(fake_bun(Path(tmp) / "bun"))}
		ctx = fake_ctx(accepts=True)
		plugin.register(ctx)
		assert ctx.commands["ultrathink-quick"]("  fix the typo  ") is None
		assert ctx.injected == ["fix the typo"]
		# A turn queued ahead of it is still planned; the quick message is not, exactly once.
		assert plan({"user_message": "add a widget", "session_id": "q1"}, env=engine) == "planned:add a widget"
		assert plan({"user_message": "fix the typo", "session_id": "q1"}, env=engine) == ""
		assert plan({"user_message": "fix the typo", "session_id": "q1"}, env=engine) == "planned:fix the typo"
		# A shared gateway session hands the turn over as "[Alice] fix the typo".
		assert ctx.commands["ultrathink-quick"]("fix the typo") is None
		assert plan({"user_message": "[Alice] fix the typo", "session_id": "q1"}, env=engine) == ""
		# Outside a gateway turn there is no sender to match, so the tagged text is planned as written.
		assert plan({"user_message": "[Alice] fix the typo", "session_id": "q1"}, env=engine) == "planned:[Alice] fix the typo"


def test_quick_skips_the_next_message_where_hermes_cannot_send_it():
	with tempfile.TemporaryDirectory() as tmp:
		engine = {"BUN": str(fake_bun(Path(tmp) / "bun"))}
		refused, older, bare = fake_ctx(accepts=False), fake_ctx(accepts=None), fake_ctx(accepts=True)
		with cli(fake_cli(Path(tmp))):
			for ctx, message in ((refused, "fix the typo"), (older, "fix the typo"), (bare, "  ")):
				plugin.register(ctx)
				assert ctx.commands["ultrathink-quick"](message) == QUICK_FALLBACK
		assert (Path(tmp) / "calls").read_text().splitlines() == ["skip", "skip", "skip"]
		assert refused.injected == ["fix the typo"] and bare.injected == []
		# The bridge holds no marker then: the engine's one-shot skip decides the next message.
		assert plan({"user_message": "fix the typo", "session_id": "q2"}, env=engine) == "planned:fix the typo"
		# A skip that could not be set says so rather than promising it.
		with cli(Path(tmp) / "missing"):
			assert refused.commands["ultrathink-quick"]("fix the typo").startswith("Ultrathink skip: ")


STATUS_ON = {"match": ["status", "--json"], "stdout": json.dumps({"enabled": True, "capture": "observe", "recall": True})}
STATUS_EXPLICIT = {"match": ["status", "--json"], "stdout": json.dumps({"enabled": True, "capture": "explicit"})}
STATUS_OFF = {"match": ["status", "--json"], "stdout": json.dumps({"enabled": False})}
TEACH_STUB = """#!@PYTHON@
import json, os, sys, time
here = @HERE@
args = sys.argv[1:]
stdin = sys.stdin.read() if "--stdin" in args else ""
with open(here + "/calls.jsonl", "a") as log:
	log.write(json.dumps({"argv": args, "stdin": stdin, "host": os.environ.get("ULTRATHINK_HOST"), "state": os.environ.get("ULTRATHINK_STATE_DIR"), "cwd": os.getcwd(), "pid": os.getpid(), "sid": os.getsid(0)}) + "\\n")
for rule in json.load(open(here + "/rules.json")):
	if all(token in args for token in rule["match"]):
		time.sleep(rule.get("sleep", 0))
		sys.stdout.write(rule.get("stdout", ""))
		sys.stderr.write(rule.get("stderr", ""))
		sys.exit(rule.get("code", 0))
sys.stderr.write("error: no rule\\n")
sys.exit(1)
"""


def teach_cli(directory: Path, rules: list[dict]) -> Path:
	"""A bin/ultrathink stand-in: logs argv, stdin, host, state dir, cwd, pid and session id of every run to
	<directory>/calls.jsonl, then answers with the first rule whose `match` tokens are all in argv (stdout, stderr,
	code, sleep seconds); no rule means exit 1."""
	directory.mkdir(parents=True, exist_ok=True)
	set_rules(directory, rules)
	path = directory / "ultrathink"
	path.write_text(TEACH_STUB.replace("@PYTHON@", sys.executable).replace("@HERE@", repr(str(directory))))
	path.chmod(path.stat().st_mode | stat.S_IEXEC)
	return path


def set_rules(directory: Path, rules: list[dict]) -> None:
	(directory / "rules.json").write_text(json.dumps(rules))


def teach_calls(directory: Path, verb: str | None = None, count: int = 0) -> list[dict]:
	"""The stub's logged runs (of `teach <verb>` only when given), waiting up to 10s for `count` of them: detached runs are asynchronous."""
	give_up = time.monotonic() + 10
	while True:
		log = directory / "calls.jsonl"
		calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
		calls = [call for call in calls if verb is None or call["argv"][1:2] == [verb]]
		if len(calls) >= count or time.monotonic() > give_up:
			return calls
		time.sleep(0.05)


def reset_teach_state() -> None:
	with bridge._teach_lock:
		bridge._teach_status_cache.clear()
		bridge._observed_at.clear()
		bridge._synced.clear()


@contextmanager
def teach_env(rules: list[dict]) -> Iterator[Path]:
	"""A temporary HERMES_HOME and the stub CLI standing in for bin/ultrathink, with the bridge's
	Teachable Moments state reset. Yields the stub's directory."""
	saved = {key: os.environ.get(key) for key in ("HERMES_HOME", "ULTRATHINK_STATE_DIR")}
	saved_cli = bridge.CLI
	with tempfile.TemporaryDirectory() as tmp:
		os.environ["HERMES_HOME"] = str(Path(tmp) / "home")
		os.environ.pop("ULTRATHINK_STATE_DIR", None)
		bridge.CLI = teach_cli(Path(tmp) / "bin", rules)
		reset_teach_state()
		try:
			yield Path(tmp) / "bin"
		finally:
			bridge.CLI = saved_cli
			reset_teach_state()
			for key, value in saved.items():
				if value is None:
					os.environ.pop(key, None)
				else:
					os.environ[key] = value


@contextmanager
def fake_clock(start: float = 1000.0) -> Iterator[list[float]]:
	"""The bridge's monotonic clock as a list holding the current time."""
	now = [start]
	saved = bridge._clock
	bridge._clock = lambda: now[0]
	try:
		yield now
	finally:
		bridge._clock = saved


def tool_history(tool_rows: int = 3) -> list[dict]:
	rows: list[dict] = [{"role": "user", "content": "fix the build"}]
	for index in range(tool_rows):
		call = {"id": f"c{index}", "type": "function", "function": {"name": "terminal", "arguments": json.dumps({"command": f"step {index}"})}}
		rows.append({"role": "assistant", "content": None, "tool_calls": [call]})
		rows.append({"role": "tool", "tool_call_id": f"c{index}", "content": json.dumps({"output": "ok", "exit_code": 0})})
	rows.append({"role": "assistant", "content": "Done."})
	return rows


def finished_turn(session: str = "s1", **extra: object) -> dict:
	"""The kwargs Hermes passes post_llm_call after a turn with three tool calls."""
	return {
		"session_id": session,
		"user_message": "fix the build",
		"assistant_response": "Done.",
		"conversation_history": tool_history(),
		"platform": "cli",
		**extra,
	}


def test_registers_the_teach_hooks_tools_commands_and_skill_next_to_the_old_ones():
	ctx = fake_ctx()
	plugin.register(ctx)
	assert {"post_llm_call", "on_session_finalize"} <= set(ctx.hooks) and "pre_llm_call" in ctx.hooks
	assert "ultrathink-teach" in ctx.skills and {"ultrathink-learn", "ultrathink-lessons", "ultrathink-quick"} <= set(ctx.commands)
	save, recall = ctx.tools["ultrathink_lesson_save"], ctx.tools["ultrathink_lesson_recall"]
	assert save.toolset == recall.toolset == "ultrathink"
	assert save.schema["name"] == "ultrathink_lesson_save" and save.schema["parameters"]["required"] == ["name", "body"]
	assert save.schema["parameters"]["properties"]["kind"]["enum"] == ["bug", "pitfall", "pattern", "decision", "playbook"]
	assert save.schema["parameters"]["properties"]["tags"]["type"] == "array"
	assert recall.schema["parameters"]["required"] == ["query"] and "limit" in recall.schema["parameters"]["properties"]
	assert callable(save.check_fn) and callable(recall.check_fn)


def test_registration_tolerates_a_ctx_missing_teach_methods_and_warns_once_per_piece():
	reference = fake_ctx()
	plugin.register(reference)
	records: list[logging.LogRecord] = []

	class Collect(logging.Handler):
		def emit(self, record: logging.LogRecord) -> None:
			records.append(record)

	handler = Collect(logging.WARNING)
	plugin.logger.addHandler(handler)
	try:
		bare = fake_ctx()
		for attribute in ("register_tool", "register_command", "dispatch_tool", "register_skill", "inject_message"):
			if hasattr(bare, attribute):
				delattr(bare, attribute)
		plugin.register(bare)
		assert bare.hooks == reference.hooks and bare.tools == {} and bare.commands == {} and bare.skills == {}
		assert len(records) == 4, [record.getMessage() for record in records]  # two tools, learn and lessons: one warning each
		assert sum("ultrathink_lesson" in record.getMessage() for record in records) == 2

		records.clear()
		partial = fake_ctx()
		original = partial.register_hook

		def no_post_llm_call(name: str, callback: Callable[..., object]) -> None:
			if name == "post_llm_call":
				raise ValueError("unknown hook")
			original(name, callback)

		partial.register_hook = no_post_llm_call
		plugin.register(partial)
		assert "post_llm_call" not in partial.hooks and "on_session_finalize" in partial.hooks
		assert sorted(partial.tools) == sorted(reference.tools) and sorted(partial.commands) == sorted(reference.commands)
		assert len(records) == 1 and "post_llm_call" in records[0].getMessage()
	finally:
		plugin.logger.removeHandler(handler)


def test_init_has_none_of_the_marker_strings_hermes_scans_for_in_its_first_8192_chars():
	head = (HERE / "__init__.py").read_text(encoding="utf-8")[:8192]
	for marker in ("register_memory_provider", "MemoryProvider", "CronScheduler", "register_provider", "ProviderProfile"):
		assert marker not in head, marker


def test_teach_status_is_cached_for_ten_minutes_and_a_failure_for_one():
	with teach_env([STATUS_ON]) as directory, fake_clock() as now:
		first = bridge.teach_status()
		assert first == {"enabled": True, "capture": "observe", "recall": True}
		assert bridge.teach_status() == first
		calls = teach_calls(directory, "status")
		assert len(calls) == 1 and calls[0]["argv"] == ["teach", "status", "--json"]
		# The CLI runs as Hermes against the engine's own state directory.
		assert calls[0]["host"] == "hermes" and calls[0]["state"] == str(bridge.state_dir())
		now[0] += 599
		bridge.teach_status()
		assert len(teach_calls(directory, "status")) == 1
		now[0] += 2
		bridge.teach_status()
		assert len(teach_calls(directory, "status")) == 2

	for rules in ([], [{"match": ["status"], "stdout": "not json"}], [{"match": ["status"], "stdout": "{\"hello\": 1}"}], [{"match": ["status"], "code": 1}]):
		with teach_env(rules) as directory, fake_clock() as now:
			assert bridge.teach_status() == {"enabled": False}
			now[0] += 59
			assert bridge.teach_status() == {"enabled": False}
			assert len(teach_calls(directory, "status")) == 1
			set_rules(directory, [STATUS_ON])
			now[0] += 2
			assert bridge.teach_status()["enabled"] is True
			assert len(teach_calls(directory, "status")) == 2

	with teach_env([]) as directory:
		bridge.CLI = directory / "missing"
		assert bridge.teach_status() == {"enabled": False}


def test_build_digest_reads_hermes_history_rows_and_flags_failed_tool_results():
	history = [
		{"role": "system", "content": "be helpful"},
		{"role": "user", "content": [{"type": "text", "text": "fix it"}, {"type": "text", "text": "now"}]},
		{"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "function": {"name": "terminal", "arguments": '{"command": "make"}'}}]},
		{"role": "tool", "tool_call_id": "c1", "content": '{"output": "boom", "exit_code": 2}'},
		{"role": "tool", "name": "read_file", "content": "Error: no such file"},
		{"role": "tool", "name": "web", "content": '{"success": false}'},
		{"role": "tool", "name": "web", "content": '{"error": "timeout"}'},
		{"role": "tool", "name": "fine1", "content": '{"error": null, "success": true, "exit_code": 0}'},
		{"role": "tool", "name": "fine2", "content": "all good, Error handling docs"},
		{"role": "tool", "name": "flagged", "content": "fine", "status": "error"},
		{"role": "tool", "name": "empty", "content": None},
		{"role": "assistant", "content": "Fixed."},
	]
	digest = bridge.build_digest({"session_id": "s9", "cwd": "/work/x", "conversation_history": history, "assistant_response": "Fixed."})
	assert digest is not None
	assert digest["host"] == "hermes" and digest["sessionId"] == "s9" and digest["cwd"] == "/work/x" and digest["outcome"] == "completed"
	assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", digest["at"]), digest["at"]
	turns = digest["turns"]
	assert turns[0] == {"role": "user", "text": "fix it\nnow"}
	assert turns[1] == {"role": "assistant", "text": 'terminal({"command": "make"})', "tool": "terminal"}
	tools = turns[2:10]
	assert [turn["role"] for turn in tools] == ["tool"] * 8 and digest["toolCalls"] == 8
	assert [turn.get("tool") for turn in tools] == ["terminal", "read_file", "web", "web", "fine1", "fine2", "flagged", "empty"]
	assert [turn.get("isError", False) for turn in tools] == [True, True, True, True, False, False, True, False]
	assert tools[7]["text"] == "(no output)"
	assert turns[10] == {"role": "assistant", "text": "Fixed."} and len(turns) == 11  # the system row and the duplicate reply are gone
	# A reply the history lacks is appended; without a payload cwd it is the process cwd.
	later = bridge.build_digest({"session_id": "s9", "conversation_history": history, "assistant_response": "All set."})
	assert later is not None and later["turns"][-1] == {"role": "assistant", "text": "All set."} and later["cwd"] == os.getcwd()


def test_build_digest_keeps_the_last_sixty_turns_cut_to_1500_chars_and_needs_two_tool_rows():
	rows = [{"role": "user", "content": "go"}] + [{"role": "tool", "name": f"t{index}", "content": "x" * 5000} for index in range(100)]
	digest = bridge.build_digest({"session_id": "s", "conversation_history": rows})
	assert digest is not None and len(digest["turns"]) == 60 and digest["toolCalls"] == 60
	assert all(turn["role"] == "tool" and len(turn["text"]) == 1500 for turn in digest["turns"])
	assert digest["turns"][-1]["tool"] == "t99"

	one_tool = [{"role": "user", "content": "go"}, {"role": "tool", "name": "t", "content": "ok"}, {"role": "assistant", "content": "Done."}]
	assert bridge.build_digest({"session_id": "s", "conversation_history": one_tool, "assistant_response": "Done."}) is None
	assert bridge.build_digest({"session_id": "s", "conversation_history": one_tool + [{"role": "tool", "content": "ok"}]}) is not None
	for history in (None, [], "text", [None, 3, {"role": "tool"}]):
		assert bridge.build_digest({"session_id": "s", "conversation_history": history}) is None


def test_observe_turn_skips_subagents_cron_off_explicit_and_short_turns_without_spawning():
	with teach_env([STATUS_ON, {"match": ["observe"]}]) as directory:
		assert bridge.observe_turn(finished_turn(parent_session_id="parent")) == "subagent"
		assert bridge.observe_turn(finished_turn(platform="cron")) == "cron"
		assert teach_calls(directory) == []  # not even a status check
		short = finished_turn()
		short["conversation_history"] = tool_history(1)
		assert bridge.observe_turn(short) == "short"

		reset_teach_state()
		set_rules(directory, [STATUS_OFF, {"match": ["observe"]}])
		assert bridge.observe_turn(finished_turn()) == "off"
		reset_teach_state()
		set_rules(directory, [STATUS_EXPLICIT, {"match": ["observe"]}])
		assert bridge.observe_turn(finished_turn()) == "explicit"
		assert teach_calls(directory, "observe") == []
		assert not (bridge.state_dir() / "teach").exists()  # no inbox file for a skipped turn


def test_observe_turn_starts_one_observe_per_session_every_thirty_seconds():
	with teach_env([STATUS_ON, {"match": ["observe"]}]) as directory, fake_clock() as now:
		assert bridge.observe_turn(finished_turn("a")) == "spawned"
		assert bridge.observe_turn(finished_turn("a")) == "throttled"
		assert bridge.observe_turn(finished_turn("b")) == "spawned"
		now[0] += 29
		assert bridge.observe_turn(finished_turn("a")) == "throttled"
		now[0] += 2
		assert bridge.observe_turn(finished_turn("a")) == "spawned"
		assert len(teach_calls(directory, "observe", 3)) == 3


def test_observe_turn_writes_a_private_inbox_file_and_starts_the_cli_detached_without_waiting():
	with teach_env([STATUS_ON, {"match": ["observe"], "sleep": 1.5}]) as directory:
		started = time.monotonic()
		assert bridge.observe_turn(finished_turn("detached"), env={"ULTRATHINK_TEST": "1"}) == "spawned"
		assert time.monotonic() - started < 1.2  # the CLI sleeps 1.5s: nothing waited for it
		(call,) = teach_calls(directory, "observe", 1)
		assert call["argv"][:3] == ["teach", "observe", "--file"] and len(call["argv"]) == 4
		path = Path(call["argv"][3])
		inbox = bridge.state_dir() / "teach" / "inbox"
		assert path.parent == inbox and re.fullmatch(r"\d+-[0-9a-f]{8}\.json", path.name), path
		assert stat.S_IMODE(path.stat().st_mode) == 0o600
		assert stat.S_IMODE(inbox.stat().st_mode) == 0o700 and stat.S_IMODE(inbox.parent.stat().st_mode) == 0o700
		digest = json.loads(path.read_text(encoding="utf-8"))
		assert digest["host"] == "hermes" and digest["sessionId"] == "detached" and digest["toolCalls"] == 3
		assert call["host"] == "hermes" and call["state"] == str(bridge.state_dir())
		assert call["sid"] == call["pid"]  # its own session: it outlives the hook
		assert exited(call["pid"])

	# A CLI that cannot start leaves no unredacted digest behind.
	with teach_env([STATUS_ON]) as directory:
		assert bridge.observe_turn(finished_turn("first")) == "spawned"  # the stub runs, so the first digest stays in the inbox
		bridge.CLI = directory / "missing"
		reset_teach_state()
		bridge._teach_status_cache[bridge._cwd()] = (bridge._clock(), 600.0, {"enabled": True, "capture": "observe"})
		leftovers = set((bridge.state_dir() / "teach" / "inbox").iterdir())
		assert bridge.observe_turn(finished_turn("second")) == "error"
		assert set((bridge.state_dir() / "teach" / "inbox").iterdir()) == leftovers
		teach_calls(directory, "observe", 1)


def test_sync_outbox_starts_one_detached_sync_per_session_when_enabled():
	with teach_env([STATUS_ON, {"match": ["sync"]}]) as directory:
		assert bridge.sync_outbox({"session_id": "a", "platform": "cli"}) == "spawned"
		assert bridge.sync_outbox({"session_id": "a"}) == "done"
		assert bridge.sync_outbox({"session_id": None}) == "spawned"
		calls = teach_calls(directory, "sync", 2)
		assert [call["argv"] for call in calls] == [["teach", "sync"]] * 2 and calls[0]["host"] == "hermes"
		assert calls[0]["sid"] == calls[0]["pid"]
	with teach_env([STATUS_OFF, {"match": ["sync"]}]) as directory:
		assert bridge.sync_outbox({"session_id": "a"}) == "off"
		assert teach_calls(directory, "sync") == []


def test_the_post_llm_call_and_finalize_hooks_fail_open():
	ctx = fake_ctx()
	plugin.register(ctx)

	def explode(_payload: dict) -> None:
		raise RuntimeError("disk full")

	saved = plugin.observe_turn, plugin.sync_outbox
	setattr(plugin, "observe_turn", explode)  # noqa: B010 - the hook looks the name up in the plugin module
	setattr(plugin, "sync_outbox", explode)  # noqa: B010
	try:
		assert ctx.callbacks["post_llm_call"](**finished_turn()) is None
		assert ctx.callbacks["on_session_finalize"](session_id=None, platform="cli") is None
	finally:
		setattr(plugin, "observe_turn", saved[0])  # noqa: B010
		setattr(plugin, "sync_outbox", saved[1])  # noqa: B010
	with teach_env([STATUS_ON, {"match": ["observe"]}, {"match": ["sync"]}]) as directory:
		assert ctx.callbacks["post_llm_call"](**finished_turn("hooked"), model="m", telemetry_schema_version=1) is None
		ctx.callbacks["on_session_finalize"](session_id="hooked", platform="cli")
		assert len(teach_calls(directory, "observe", 1)) == 1 and len(teach_calls(directory, "sync", 1)) == 1


def test_lesson_save_tool_sends_the_lesson_and_always_answers_with_json():
	saved_ok = '{"ok": true, "id": "m1", "created": true, "retain": "queued"}'
	with teach_env([STATUS_ON, {"match": ["capture"], "stdout": saved_ok}]) as directory:
		ctx = fake_ctx()
		plugin.register(ctx)
		save = ctx.tools["ultrathink_lesson_save"]
		assert save.check_fn() is True
		args = {"name": " Run bun test from the root ", "body": "It fails in src/.", "kind": "pitfall", "description": "d", "tags": ["bun", " ", 3, "ci"]}
		assert json.loads(save.handler(args, task_id="t1", session_id="s1")) == json.loads(saved_ok)
		(call,) = teach_calls(directory, "capture")
		assert call["argv"] == ["teach", "capture", "--stdin", "--json"]
		assert json.loads(call["stdin"]) == {"name": "Run bun test from the root", "body": "It fails in src/.", "kind": "pitfall", "description": "d", "tags": ["bun", "ci"]}
		# The kind defaults to pattern.
		save.handler({"name": "n", "body": "b"})
		assert json.loads(teach_calls(directory, "capture")[1]["stdin"])["kind"] == "pattern"

		# Bad arguments never reach the CLI.
		before = len(teach_calls(directory))
		for bad in (None, "text", {}, {"name": "n"}, {"name": " ", "body": "b"}, {"name": "n", "body": 4}, {"name": "n", "body": "b", "kind": "weird"}):
			reply = json.loads(save.handler(bad))
			assert reply["ok"] is False and reply["error"], bad
		assert len(teach_calls(directory)) == before

		# The CLI's own refusal comes back as it printed it.
		set_rules(directory, [{"match": ["capture"], "stdout": '{"ok": false, "error": "name is empty"}', "code": 2}])
		assert json.loads(save.handler({"name": "n", "body": "b"})) == {"ok": False, "error": "name is empty"}
		# Without bun the CLI prints a hint on stderr, and the body never appears in the error.
		set_rules(directory, [{"match": ["capture"], "stderr": "ultrathink: bun not found\n", "code": 127}])
		assert json.loads(save.handler({"name": "n", "body": "secret body"})) == {"ok": False, "error": "ultrathink: bun not found"}
		bridge.CLI = directory / "missing"
		reply = json.loads(save.handler({"name": "n", "body": "secret body"}))
		assert reply["ok"] is False and "secret body" not in reply["error"]


def test_lesson_recall_tool_passes_the_query_and_limit_and_answers_with_json():
	found = {"status": "used", "source": "local", "count": 1, "lessons": [{"id": "m1", "name": "N", "description": "D", "body": "B", "kind": "bug"}]}
	with teach_env([STATUS_ON, {"match": ["recall"], "stdout": json.dumps(found)}]) as directory:
		ctx = fake_ctx()
		plugin.register(ctx)
		recall = ctx.tools["ultrathink_lesson_recall"]
		assert json.loads(recall.handler({"query": "bun test", "limit": 3}, task_id="t")) == found
		assert teach_calls(directory, "recall")[0]["argv"] == ["teach", "recall", "bun test", "--json", "--limit", "3"]
		recall.handler({"query": "bun test", "limit": "abc"})
		recall.handler({"query": "-rf cleanup", "limit": 99})
		argvs = [call["argv"] for call in teach_calls(directory, "recall")]
		assert argvs[1] == ["teach", "recall", "bun test", "--json"]
		assert argvs[2] == ["teach", "recall", "rf cleanup", "--json", "--limit", "20"]

		before = len(teach_calls(directory))
		for bad in (None, {}, {"query": 7}, {"query": "  "}):
			reply = json.loads(recall.handler(bad))
			assert reply["status"] == "error" and reply["lessons"] == [] and reply["reason"], bad
		assert len(teach_calls(directory)) == before

		set_rules(directory, [{"match": ["recall"], "stderr": "error: hindsight is down\n", "code": 1}])
		assert json.loads(recall.handler({"query": "q"}))["reason"] == "error: hindsight is down"
		set_rules(directory, [{"match": ["recall"], "sleep": 10}])
		saved_timeout = bridge.TEACH_RECALL_TIMEOUT_S
		bridge.TEACH_RECALL_TIMEOUT_S = 1
		try:
			assert json.loads(recall.handler({"query": "q"}))["reason"] == "no answer after 1s"
		finally:
			bridge.TEACH_RECALL_TIMEOUT_S = saved_timeout
		bridge.CLI = directory / "missing"
		assert json.loads(recall.handler({"query": "q"}))["status"] == "error"


def test_the_lesson_tools_are_hidden_while_teachable_moments_is_off():
	ctx = fake_ctx()
	plugin.register(ctx)
	for rules in ([STATUS_OFF], []):
		with teach_env(rules):
			assert [tool.check_fn() for tool in ctx.tools.values()] == [False, False]
	with teach_env([STATUS_ON]):
		assert [tool.check_fn() for tool in ctx.tools.values()] == [True, True]


def test_learn_saves_the_note_as_a_pattern_named_by_its_first_sentence():
	saved_ok = '{"ok": true, "id": "m7", "created": true, "retain": "retained"}'
	with teach_env([STATUS_ON, {"match": ["capture"], "stdout": saved_ok}]) as directory:
		ctx = fake_ctx()
		plugin.register(ctx)
		learn = ctx.commands["ultrathink-learn"]
		note = "Run bun test from the repo root. It fails from src/ because the preload is relative."
		assert learn(note) == "Saved lesson m7 (retain: retained)."
		sent = json.loads(teach_calls(directory, "capture")[0]["stdin"])
		assert sent == {"name": "Run bun test from the repo root.", "body": note, "kind": "pattern"}
		long_note = "word " * 40
		learn(long_note)
		second = json.loads(teach_calls(directory, "capture")[1]["stdin"])
		assert len(second["name"]) <= 80 and second["name"] == long_note.strip()[:80].rstrip() and second["body"] == long_note.strip()
		assert learn("   ") == "Usage: /ultrathink-learn <note>" and len(teach_calls(directory, "capture")) == 2
		set_rules(directory, [{"match": ["capture"], "stdout": '{"ok": false, "error": "body too long"}', "code": 2}])
		assert learn("x") == "Could not save the lesson: body too long"
		bridge.CLI = directory / "missing"
		assert learn("x").startswith("Could not save the lesson: ")


def test_lessons_command_lists_recalls_and_shows_status():
	listing = {"moments": [{"id": "m1", "name": "Run bun test from root", "kind": "pitfall", "status": "confirmed"}, {"id": "m2", "name": "Bare"}]}
	found = {"status": "used", "count": 1, "lessons": [{"id": "m1", "name": "N", "description": "D", "kind": "bug"}]}
	rules = [
		STATUS_ON,
		{"match": ["status"], "stdout": "Teach: on, capture observe\n"},
		{"match": ["list"], "stdout": json.dumps(listing)},
		{"match": ["recall"], "stdout": json.dumps(found)},
	]
	with teach_env(rules) as directory:
		ctx = fake_ctx()
		plugin.register(ctx)
		lessons = ctx.commands["ultrathink-lessons"]
		expected = "- m1 [pitfall, confirmed] Run bun test from root\n- m2 Bare"
		assert lessons("") == expected and lessons("list") == expected
		assert lessons("recall bun test") == "- m1 [bug] N: D"
		assert teach_calls(directory, "recall")[0]["argv"] == ["teach", "recall", "bun test", "--json", "--limit", "5"]
		assert lessons("status") == "Teach: on, capture observe"
		assert lessons("recall") == "Usage: /ultrathink-lessons recall <query>"
		assert lessons("frobnicate").startswith("Usage: /ultrathink-lessons ")
		set_rules(directory, [{"match": ["list"], "stdout": "[]"}, {"match": ["recall"], "stdout": '{"status": "none", "count": 0, "lessons": [], "reason": "no match"}'}])
		assert lessons("list") == "No lessons saved yet." and lessons("recall zzz") == "No matching lessons. (no match)"
		set_rules(directory, [{"match": ["list"], "stderr": "error: store unreadable\n", "code": 1}])
		assert lessons("list") == "Could not list lessons: error: store unreadable"


PROMOTE_DRAFT = {
	"name": "bun-test-root",
	"description": "Run bun test from the repo root.",
	"content": "---\nname: bun-test-root\ndescription: Run bun test from the repo root.\n---\nRun it from the root.\n",
	"warnings": [],
}
PROMOTE_RULES = [
	{"match": ["--mark-promoted"], "stdout": "Marked 1 moment promoted.\n"},
	{"match": ["--install"], "stdout": json.dumps({"draft": PROMOTE_DRAFT, "outcome": {"target": "hermes", "path": "/tmp/drafts/bun-test-root.md", "action": "drafted"}})},
	{"match": ["promote"], "stdout": json.dumps({"draft": PROMOTE_DRAFT, "outcome": None})},
]


def test_promote_stages_the_skill_through_skill_manage_then_marks_the_lesson_promoted():
	with teach_env(PROMOTE_RULES) as directory:
		ctx = fake_ctx()
		plugin.register(ctx)
		dispatched: list[tuple[str, dict]] = []

		def dispatch_tool(tool_name: str, args: dict, **kwargs: object) -> str:
			dispatched.append((tool_name, args))
			return '{"success": true, "staged": true}'

		ctx.dispatch_tool = dispatch_tool
		reply = ctx.commands["ultrathink-lessons"]("promote m1")
		assert dispatched == [
			("skill_manage", {"action": "create", "name": "bun-test-root", "category": "ultrathink-lessons", "content": PROMOTE_DRAFT["content"]})
		]
		assert "bun-test-root" in reply and "/skills pending" in reply, reply
		assert [call["argv"] for call in teach_calls(directory)] == [
			["teach", "promote", "m1", "--target", "hermes", "--json"],
			["teach", "promote", "m1", "--mark-promoted", "--skill", "bun-test-root", "--target", "hermes"],
		]


def test_promote_without_a_working_dispatch_returns_the_draft_path_and_marks_nothing():
	def refuses(tool_name: str, args: dict, **kwargs: object) -> str:
		return '{"success": false, "error": "a skill with that name exists"}'

	def raises(tool_name: str, args: dict, **kwargs: object) -> str:
		raise RuntimeError("no such tool")

	for dispatch, reason in ((None, "no dispatch_tool"), (refuses, "a skill with that name exists"), (raises, "no such tool")):
		with teach_env(PROMOTE_RULES) as directory:
			ctx = fake_ctx()
			plugin.register(ctx)
			if dispatch is not None:
				ctx.dispatch_tool = dispatch
			reply = ctx.commands["ultrathink-lessons"]("promote m1")
			assert "Could not stage the skill through Hermes" in reply and reason in reply, reply
			assert "/tmp/drafts/bun-test-root.md" in reply and "ultrathink-lessons" in reply and "SKILL.md" in reply
			argvs = [call["argv"] for call in teach_calls(directory)]
			assert argvs[0] == ["teach", "promote", "m1", "--target", "hermes", "--json"]
			assert argvs[1] == ["teach", "promote", "m1", "--target", "hermes", "--install", "--json"]
			assert not any("--mark-promoted" in argv for argv in argvs)

	with teach_env([{"match": ["promote"], "stdout": '{"error": "unknown moment"}', "code": 2}]) as directory:
		ctx = fake_ctx()
		plugin.register(ctx)
		assert ctx.commands["ultrathink-lessons"]("promote nope").startswith("Could not draft a skill from nope: ")
		assert ctx.commands["ultrathink-lessons"]("promote").startswith("Usage: /ultrathink-lessons promote")
		assert ctx.commands["ultrathink-lessons"]("promote --target").startswith("Usage: ")
		assert len(teach_calls(directory)) == 1


def test_no_teach_path_creates_a_planning_directory_in_the_cwd():
	saved = os.getcwd()
	with tempfile.TemporaryDirectory() as work, teach_env([STATUS_ON, {"match": ["capture"], "stdout": '{"ok": true, "id": "m1", "retain": "local-only"}'}, {"match": ["observe"]}, {"match": ["sync"]}]) as directory:
		os.chdir(work)
		try:
			reset_teach_state()
			assert bridge.observe_turn(finished_turn("cwd")) == "spawned"
			assert bridge.sync_outbox({"session_id": "cwd"}) == "spawned"
			assert bridge.capture_lesson({"name": "n", "body": "b"})["ok"] is True
			teach_calls(directory, "observe", 1)
			teach_calls(directory, "sync", 1)
		finally:
			os.chdir(saved)
		assert list(Path(work).iterdir()) == []


if __name__ == "__main__":
	test_message_text_reads_string_and_dict()
	test_skips_child_cron_and_empty_without_spawning()
	test_skill_scaffold_reaches_the_engine()
	test_engine_is_found_off_path_when_bun_is_unset()
	test_engine_failure_returns_empty()
	test_a_jev_skip_from_the_engine_returns_empty()
	test_slash_commands_and_uplifted_xml_never_start_bun()
	test_only_the_senders_own_tag_is_stripped_and_it_never_defeats_the_skips()
	test_the_planner_runs_in_the_terminal_cwd_hermes_tools_use()
	test_deadline_ends_fifteen_seconds_inside_the_hermes_cap()
	test_short_hook_cap_never_starts_bun_and_warns_once()
	test_inside_hermes_its_own_cap_resolver_wins_and_outside_there_is_no_cap()
	test_a_hermes_without_its_cap_resolver_uses_the_config_yaml_cap_and_warns_once()
	test_the_config_yaml_cap_counts_the_way_hermes_counts_it()
	test_a_hermes_without_its_cap_resolver_reads_the_active_profiles_config_yaml()
	test_a_hermes_without_its_cap_resolver_or_a_configured_cap_assumes_30s_and_never_starts_bun()
	test_a_plugin_directory_without_its_engine_warns_once_and_never_starts_bun()
	test_deadline_kills_bun_and_everything_it_spawned()
	test_pr_creation_tool_mirrors_pr_detect()
	test_extract_pr_url_reads_gh_output()
	test_tool_result_carries_the_nudge_once_and_only_for_a_planned_session()
	test_next_turn_delivers_a_nudge_no_tool_result_carried_once()
	test_a_pr_a_subagent_really_opened_nudges_the_parent_and_a_cited_one_does_not()
	test_finishing_a_tracked_unsynced_turn_continues_once_with_a_sync_nudge()
	test_no_sync_nudge_without_rows_after_sync_or_with_tracking_off()
	test_sync_nudge_names_the_pr_the_session_opened()
	test_a_new_plan_in_the_session_gets_its_own_nudge_and_never_the_old_pr()
	test_tracking_refs_with_no_created_rows_do_not_use_up_the_nudge()
	test_pre_verify_hook_fails_open()
	test_registers_every_ultrathink_command_next_to_the_hooks()
	test_registers_the_five_ultrathink_skills_with_their_descriptions()
	test_skill_registration_failures_leave_hooks_and_commands_registered()
	test_skill_description_is_empty_without_frontmatter()
	test_control_commands_run_the_cli_as_hermes_and_return_its_text()
	test_control_failures_come_back_as_one_line()
	test_quick_sends_the_message_once_without_a_plan()
	test_quick_skips_the_next_message_where_hermes_cannot_send_it()
	test_registers_the_teach_hooks_tools_commands_and_skill_next_to_the_old_ones()
	test_registration_tolerates_a_ctx_missing_teach_methods_and_warns_once_per_piece()
	test_init_has_none_of_the_marker_strings_hermes_scans_for_in_its_first_8192_chars()
	test_teach_status_is_cached_for_ten_minutes_and_a_failure_for_one()
	test_build_digest_reads_hermes_history_rows_and_flags_failed_tool_results()
	test_build_digest_keeps_the_last_sixty_turns_cut_to_1500_chars_and_needs_two_tool_rows()
	test_observe_turn_skips_subagents_cron_off_explicit_and_short_turns_without_spawning()
	test_observe_turn_starts_one_observe_per_session_every_thirty_seconds()
	test_observe_turn_writes_a_private_inbox_file_and_starts_the_cli_detached_without_waiting()
	test_sync_outbox_starts_one_detached_sync_per_session_when_enabled()
	test_the_post_llm_call_and_finalize_hooks_fail_open()
	test_lesson_save_tool_sends_the_lesson_and_always_answers_with_json()
	test_lesson_recall_tool_passes_the_query_and_limit_and_answers_with_json()
	test_the_lesson_tools_are_hidden_while_teachable_moments_is_off()
	test_learn_saves_the_note_as_a_pattern_named_by_its_first_sentence()
	test_lessons_command_lists_recalls_and_shows_status()
	test_promote_stages_the_skill_through_skill_manage_then_marks_the_lesson_promoted()
	test_promote_without_a_working_dispatch_returns_the_draft_path_and_marks_nothing()
	test_no_teach_path_creates_a_planning_directory_in_the_cwd()
	print("ok")
