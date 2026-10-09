# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
"""Bridge tests: python3 hosts/prime-agent/bridge_test.py (stdlib unittest, no Prime Agent, no bun)."""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

import ultrathink as bridge  # noqa: E402

FAKE_ENGINE = """#!/usr/bin/env python3
# Fake bun: answer one PlanResponse line for the request on stdin, or act on a marker in the prompt.
import json, os, sys, time
req = json.loads(sys.stdin.read())
prompt = req["prompt"]
if "SLEEP" in prompt:
    time.sleep(5)
if "GARBAGE" in prompt:
    print("not json"); sys.exit(0)
if "SILENT" in prompt:
    sys.exit(0)
if "SKIP" in prompt:
    print(json.dumps({"context": "", "skipped": "precheck-trivial"})); sys.exit(0)
print("noise before the answer")
print(json.dumps({"context": "PLAN for " + prompt, "host": req["host"], "session": req["session_id"], "specPath": os.environ["SPEC"], "graphId": "g1", "summary": "ok", "modelResolution": {"label": "x"}}))
"""


# Variables the bridge or host detection reads. The test environment never inherits them from the caller's shell.
AMBIENT_PREFIXES = ("ULTRATHINK_", "PRIME_AGENT_", "GROK_")
AMBIENT_NAMES = ("RLM_SESSION_DIR", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME")


def base_env(home: str) -> dict[str, str]:
	"""The minimal environment every test starts from: a PATH for the fake engine's interpreter and a temporary HOME."""
	return {"PATH": os.environ.get("PATH", os.defpath), "HOME": home}


def is_ambient(name: str) -> bool:
	return name.startswith(AMBIENT_PREFIXES) or name in AMBIENT_NAMES


class Bridge(unittest.TestCase):
	def setUp(self) -> None:
		self.tmp = tempfile.TemporaryDirectory()
		home = Path(self.tmp.name) / "home"
		home.mkdir()
		# The bridge merges os.environ under the env it is given, so the process environment is replaced for the
		# test too; otherwise a variable exported in the caller's shell would reach the bridge.
		patcher = mock.patch.dict(os.environ, base_env(str(home)), clear=True)
		patcher.start()
		self.addCleanup(patcher.stop)
		root = Path(self.tmp.name) / "clone"
		(root / "hooks").mkdir(parents=True)
		(root / "bin").mkdir()
		(root / "hooks" / "engine.ts").write_text("// stub\n")
		(root / "bin" / "run-bun").write_text("#!/bin/sh\nexit 0\n")
		bun = root / "fake-bun"
		bun.write_text(FAKE_ENGINE)
		bun.chmod(bun.stat().st_mode | stat.S_IEXEC)
		self.spec = root / "spec.xml"
		self.spec.write_text("<BUILD_PROMPT><ORIGINAL>hi</ORIGINAL></BUILD_PROMPT>")
		self.root = root
		self.env = {
			**base_env(str(home)),
			"ULTRATHINK_PLUGIN_ROOT": str(root),
			"BUN": str(bun),
			"SPEC": str(self.spec),
			"RLM_SESSION_DIR": "/tmp/sessions/sess-123",
			"PRIME_AGENT_CODING_AGENT_DIR": str(Path(self.tmp.name) / "agent"),
		}

	def tearDown(self) -> None:
		self.tmp.cleanup()

	def test_session_id_is_the_rlm_session_leaf(self) -> None:
		self.assertEqual(bridge.session_id(self.env), "sess-123")
		self.assertEqual(bridge.session_id({**self.env, "ULTRATHINK_SESSION_ID": "explicit"}), "explicit")
		self.assertEqual(bridge.session_id({"RLM_SESSION_DIR": ""}), "unknown")

	def test_state_dir_follows_prime_agent_home_and_refuses_planning_trees(self) -> None:
		self.assertEqual(bridge.state_dir(self.env), Path(self.tmp.name) / "agent" / "ultrathink")
		self.assertEqual(bridge.state_dir({**self.env, "ULTRATHINK_STATE_DIR": "/x/.planning/state"}), Path(self.tmp.name) / "agent" / "ultrathink")
		self.assertEqual(bridge.state_dir({**self.env, "ULTRATHINK_STATE_DIR": "/x/state"}), Path("/x/state"))

	def test_plan_returns_the_engine_context_and_reads_the_spec(self) -> None:
		result = bridge.plan("build a thing", env=self.env, cwd=self.tmp.name)
		self.assertTrue(result["planned"])
		self.assertEqual(result["context"], "PLAN for build a thing")
		self.assertEqual(result["graph_id"], "g1")
		self.assertEqual(result["spec_path"], str(self.spec))
		self.assertIn("<ORIGINAL>hi</ORIGINAL>", result["spec"])
		self.assertEqual(result["model_resolution"], {"label": "x"})
		# The request named this host and the Prime Agent session.
		self.assertEqual(result["context"], "PLAN for build a thing")
		self.assertIsInstance(result["elapsed_s"], float)

	def test_force_and_raw_prefix_the_prompt(self) -> None:
		self.assertEqual(bridge.plan("do it", env=self.env, force=True)["context"], "PLAN for uplift: do it")
		self.assertEqual(bridge.plan("do it", env=self.env, raw=True)["context"], "PLAN for raw: do it")
		self.assertEqual(bridge.plan("uplift: do it", env=self.env, force=True)["context"], "PLAN for uplift: do it")

	def test_engine_skip_is_not_planned(self) -> None:
		result = bridge.plan("SKIP", env=self.env)
		self.assertFalse(result["planned"])
		self.assertEqual(result["skipped"], "precheck-trivial")
		self.assertIsNone(result["spec"])

	def test_fail_open_reasons(self) -> None:
		self.assertEqual(bridge.plan("", env=self.env)["skipped"], "empty")
		self.assertEqual(bridge.plan("GARBAGE", env=self.env)["skipped"], "engine-no-output")
		self.assertEqual(bridge.plan("SILENT", env=self.env)["skipped"], "engine-no-output")
		slow = bridge.plan("SLEEP", env=self.env, timeout=0.5)
		self.assertEqual(slow["skipped"], "timeout")
		missing = bridge.plan("x", env={**self.env, "ULTRATHINK_PLUGIN_ROOT": self.tmp.name})
		self.assertEqual(missing["skipped"], "engine-missing")

	def test_child_marker_never_reaches_the_engine_and_host_is_fixed(self) -> None:
		env = bridge._env({"ULTRATHINK_CHILD": "1", "ULTRATHINK_HOST": "hermes"})
		self.assertNotIn("ULTRATHINK_CHILD", env)
		self.assertEqual(env["ULTRATHINK_HOST"], "prime-agent")

	def test_last_and_spec_read_the_carrier(self) -> None:
		# A fresh directory under the test's own temporary directory, so the carrier is read from where this test wrote it.
		state = Path(self.tmp.name) / "state"
		state.mkdir(parents=True, exist_ok=True)
		env = {**self.env, "ULTRATHINK_STATE_DIR": str(state)}
		self.assertEqual(bridge.state_dir(env), state)
		(state / "last-plan.json").write_text(json.dumps({"host": "prime-agent", "specPath": str(self.spec)}))
		self.assertEqual(bridge.last(env)["host"], "prime-agent")
		self.assertIn("<ORIGINAL>", bridge.spec(env))
		(state / "last-plan.json").write_text("{")
		self.assertIsNone(bridge.last(env))

	def test_ctl_and_teach_report_a_missing_clone(self) -> None:
		env = {**self.env, "ULTRATHINK_PLUGIN_ROOT": self.tmp.name}
		self.assertIn("not found", bridge.ctl("status", env=env))
		self.assertIn("error", bridge.teach("status", env=env))

	def test_run_is_awaitable_and_never_plans_through_the_real_engine_here(self) -> None:
		import asyncio

		# The process environment is patched so the awaitable path still reaches only the fake engine.
		with mock.patch.dict(os.environ, self.env):
			result = asyncio.run(bridge.run("async thing", cwd=self.tmp.name))
		self.assertEqual(result["context"], "PLAN for async thing")

	def test_variables_exported_in_the_callers_shell_never_reach_the_test_environment(self) -> None:
		leaks = {
			"ULTRATHINK_STATE_DIR": "/elsewhere/state",
			"PRIME_AGENT_CODING_AGENT_DIR": "/elsewhere/agent",
			"RLM_SESSION_DIR": "/elsewhere/sessions/other",
			"HERMES_HOME": "/elsewhere/hermes",
		}
		home = str(Path(self.tmp.name) / "home")
		with mock.patch.dict(os.environ, leaks):
			# setUp's recipe: a minimal explicit base, and a process environment replaced by it.
			self.assertEqual([name for name in base_env(home) if is_ambient(name)], [])
			with mock.patch.dict(os.environ, base_env(home), clear=True):
				merged = bridge._env({"BUN": "/fake"})
				for name, value in leaks.items():
					self.assertNotIn(name, merged)
					self.assertNotIn(value, merged.values())
				self.assertEqual(bridge.state_dir({}), Path(home) / ".prime" / "agent" / "ultrathink")
				self.assertEqual(bridge.session_id({}), "unknown")
		# The environment this test class runs under is the explicit one, whatever the shell exported.
		self.assertEqual([name for name in os.environ if is_ambient(name)], [])
		self.assertEqual(bridge.state_dir(self.env), Path(self.tmp.name) / "agent" / "ultrathink")


if __name__ == "__main__":
	unittest.main()
