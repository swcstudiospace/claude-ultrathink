# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
import importlib.util
import json
import stat
import sys
import tempfile
from collections.abc import Iterator
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
	"""A bun stand-in that echoes the request prompt back as the engine's context."""
	path.parent.mkdir(parents=True, exist_ok=True)
	path.write_text(
		f"#!{sys.executable}\nimport json, sys\nrequest = json.load(sys.stdin)\nprint(json.dumps({{'context': 'planned:' + request['prompt']}}))\n"
	)
	path.chmod(path.stat().st_mode | stat.S_IEXEC)
	return path


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


def fake_ctx(accepts: bool | None = True) -> SimpleNamespace:
	"""A Hermes PluginContext stand-in. accepts=False refuses to inject (the TUI, or a gateway
	without allow_gateway_injection); accepts=None is a Hermes without inject_message."""
	ctx = SimpleNamespace(hooks=[], commands={}, injected=[])
	ctx.register_hook = lambda name, callback: ctx.hooks.append(name)
	ctx.register_command = lambda name, handler, description="", args_hint="": ctx.commands.__setitem__(name, handler)
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
		assert f"Invoke the ultrathink-sync skill now with stateFile={state} and prUrl={PR_URL}" in result
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


def test_registers_every_ultrathink_command_next_to_the_hooks():
	ctx = fake_ctx()
	plugin.register(ctx)
	assert sorted(ctx.commands) == [f"ultrathink-{verb}" for verb in ("off", "on", "quick", "skip", "status", "track")]
	assert ctx.hooks == ["pre_llm_call", "pre_llm_call", "transform_tool_result", "post_tool_call"]

	# A Hermes that rejects the commands still plans every prompt.
	def reject(*_args: object, **_kwargs: object) -> None:
		raise TypeError("register_command() got an unexpected keyword argument 'args_hint'")

	older = fake_ctx()
	older.register_command = reject
	plugin.register(older)
	assert older.hooks == ctx.hooks and older.commands == {}


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
	test_pr_creation_tool_mirrors_pr_detect()
	test_extract_pr_url_reads_gh_output()
	test_tool_result_carries_the_nudge_once_and_only_for_a_planned_session()
	test_next_turn_delivers_a_nudge_no_tool_result_carried_once()
	test_registers_every_ultrathink_command_next_to_the_hooks()
	test_control_commands_run_the_cli_as_hermes_and_return_its_text()
	test_control_failures_come_back_as_one_line()
	test_quick_sends_the_message_once_without_a_plan()
	test_quick_skips_the_next_message_where_hermes_cannot_send_it()
	print("ok")
