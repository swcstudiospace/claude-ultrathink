# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
import importlib.util
import json
import logging
import os
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


def fake_bun(path: Path) -> Path:
	"""A bun stand-in that appends each request prompt to <path>.calls and echoes it back
	as the engine's context."""
	path.parent.mkdir(parents=True, exist_ok=True)
	path.write_text(
		f"#!{sys.executable}\nimport json, sys\nrequest = json.load(sys.stdin)\n"
		f"open({str(path) + '.calls'!r}, 'a').write(request['prompt'] + '\\n')\n"
		"print(json.dumps({'context': 'planned:' + request['prompt']}))\n"
	)
	path.chmod(path.stat().st_mode | stat.S_IEXEC)
	return path


def bun_calls(path: Path) -> list[str]:
	calls = Path(f"{path}.calls")
	return calls.read_text().splitlines() if calls.exists() else []


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
	"""Collect the bridge's log warnings, with the once-per-process short-cap warning re-armed."""
	messages: list[str] = []
	handler = logging.Handler(logging.WARNING)
	handler.emit = lambda record: messages.append(record.getMessage())  # type: ignore[method-assign]
	bridge.logger.addHandler(handler)
	bridge._cap_warned = False
	try:
		yield messages
	finally:
		bridge.logger.removeHandler(handler)
		bridge._cap_warned = False


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
	record.update({"plan": {"graphId": f"graph-{session_id}"}, "tracking": {"notionTaskPageId": "page-1"}, "kickedOff": True}, **fields)
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
	ctx = SimpleNamespace(hooks=[], callbacks={}, commands={}, injected=[], skills={})

	def register_hook(name: str, callback: Callable[..., object]) -> None:
		ctx.hooks.append(name)
		ctx.callbacks[name] = callback

	ctx.register_hook = register_hook
	ctx.register_command = lambda name, handler, description="", args_hint="": ctx.commands.__setitem__(name, handler)
	ctx.register_skill = lambda name, path, description="", frontmatter=None: ctx.skills.__setitem__(name, (path, description))
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
	# Substring rule, as in pr-detect.ts: a mere mention counts (a spare nudge, never a missed one).
	assert is_pr_creation_tool("terminal", "echo gh pr create")
	for command in ("gh pr list", "gh pr view 5", "gh issue create", "xgh pr create", "gh pr created", ""):
		assert not is_pr_creation_tool("terminal", command), command
	assert is_pr_creation_tool("mcp__aio__github_create_pull_request", "")
	assert is_pr_creation_tool("createPullRequest", "")
	assert not is_pr_creation_tool("mcp__github__list_pull_requests", "")
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
		assert f'Invoke the ultrathink-sync skill (load it with skill_view name="ultrathink:ultrathink-sync", or read {SYNC_SKILL}) now with stateFile={state} and prUrl={PR_URL}' in result
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
		assert "graph graph-sync-once" in message and f"stateFile={state}" in message and "prUrl=" not in message
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
	assert sorted(ctx.commands) == [f"ultrathink-{verb}" for verb in ("off", "on", "quick", "skip", "status", "track")]
	assert ctx.hooks == ["pre_llm_call", "pre_llm_call", "transform_tool_result", "post_tool_call", "pre_verify"]

	# A Hermes that rejects the commands still plans every prompt.
	def reject(*_args: object, **_kwargs: object) -> None:
		raise TypeError("register_command() got an unexpected keyword argument 'args_hint'")

	older = fake_ctx()
	older.register_command = reject
	plugin.register(older)
	assert older.hooks == ctx.hooks and older.commands == {}


def test_registers_the_four_ultrathink_skills_with_their_descriptions():
	ctx = fake_ctx()
	plugin.register(ctx)
	assert sorted(ctx.skills) == ["ultrathink-kickoff", "ultrathink-plan", "ultrathink-ship", "ultrathink-sync"]
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
		# bin/run-bun exits 0 without output when bun is missing.
		with cli(fake_cli(Path(tmp), "sys.stderr.write('ultrathink: bun not found\\n'); sys.exit(0)")):
			assert off("") == "Ultrathink off failed: ultrathink: bun not found"
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


if __name__ == "__main__":
	test_message_text_reads_string_and_dict()
	test_skips_child_cron_and_empty_without_spawning()
	test_skill_scaffold_reaches_the_engine()
	test_engine_is_found_off_path_when_bun_is_unset()
	test_engine_failure_returns_empty()
	test_slash_commands_and_uplifted_xml_never_start_bun()
	test_deadline_ends_fifteen_seconds_inside_the_hermes_cap()
	test_short_hook_cap_never_starts_bun_and_warns_once()
	test_deadline_kills_bun_and_everything_it_spawned()
	test_pr_creation_tool_mirrors_pr_detect()
	test_extract_pr_url_reads_gh_output()
	test_tool_result_carries_the_nudge_once_and_only_for_a_planned_session()
	test_next_turn_delivers_a_nudge_no_tool_result_carried_once()
	test_finishing_a_tracked_unsynced_turn_continues_once_with_a_sync_nudge()
	test_no_sync_nudge_without_rows_after_sync_or_with_tracking_off()
	test_sync_nudge_names_the_pr_the_session_opened()
	test_pre_verify_hook_fails_open()
	test_registers_every_ultrathink_command_next_to_the_hooks()
	test_registers_the_four_ultrathink_skills_with_their_descriptions()
	test_skill_registration_failures_leave_hooks_and_commands_registered()
	test_skill_description_is_empty_without_frontmatter()
	test_control_commands_run_the_cli_as_hermes_and_return_its_text()
	test_control_failures_come_back_as_one_line()
	test_quick_sends_the_message_once_without_a_plan()
	test_quick_skips_the_next_message_where_hermes_cannot_send_it()
	print("ok")
