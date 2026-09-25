# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
"""Hermes plugin: plans each prompt with the shared ultrathink engine, nudges
ultrathink-sync once a planned session opens a pull request or is about to
finish a coding turn with an unsynced plan, and adds the /ultrathink-<verb>
slash commands."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from .bridge import REPO_ROOT, control, plan, note_subagent, pr_tool_result, queue_pr_nudge, quick, sync_nudge, take_pr_nudges

# Registered as ultrathink-<verb>, the name on every host: verb -> (args hint, description).
COMMANDS: dict[str, tuple[str, str]] = {
	"quick": ("<message>", "Send <message> to the agent as typed: no plan, no Graph of Thought, no Linear/Notion rows"),
	"skip": ("", "Do not plan the next message"),
	"off": ("", "Turn planning off for Hermes on this machine until turned on"),
	"on": ("", "Turn planning back on for Hermes on this machine"),
	"track": ("<on|off>", "Keep planning but stop or start creating Linear/Notion rows"),
	"status": ("", "Show the current ultrathink state"),
}

# Plugin skills stay invisible to the model unless registered; it loads them as ultrathink:<name>.
SKILLS = ("ultrathink-kickoff", "ultrathink-sync", "ultrathink-plan", "ultrathink-ship")


def skill_description(path: Path) -> str:
	"""The `description:` value from the SKILL.md frontmatter, or "" when there is none."""
	lines = path.read_text(encoding="utf-8").splitlines()
	if not lines or lines[0].strip() != "---":
		return ""
	for line in lines[1:]:
		if line.strip() == "---":
			break
		if line.startswith("description:"):
			return line[len("description:") :].strip()
	return ""


def register(ctx: Any) -> None:
	def context(build: Callable[[dict[str, Any]], str]) -> Callable[..., dict[str, str] | None]:
		def on_pre_llm_call(**kwargs: Any) -> dict[str, str] | None:
			try:
				text = build(kwargs)
			except Exception:
				return None
			return {"context": text} if text else None

		return on_pre_llm_call

	def on_transform_tool_result(**kwargs: Any) -> str | None:
		try:
			return pr_tool_result(kwargs)
		except Exception:
			return None

	def on_post_tool_call(**kwargs: Any) -> None:
		try:
			queue_pr_nudge(kwargs)
		except Exception:
			pass

	def on_pre_verify(**kwargs: Any) -> dict[str, str] | None:
		try:
			return sync_nudge(kwargs)
		except Exception:
			return None  # any other return lets the turn finish

	def on_subagent_start(**kwargs: Any) -> None:
		try:
			note_subagent(kwargs)
		except Exception:
			pass

	# Hermes joins pre_llm_call contexts in registration order but spills each
	# one past its size cap to disk separately, so the fallback PR nudge follows
	# the plan without pushing a long plan over the cap or hiding its tail.
	ctx.register_hook("pre_llm_call", context(plan))
	ctx.register_hook("pre_llm_call", context(take_pr_nudges))
	ctx.register_hook("transform_tool_result", on_transform_tool_result)
	ctx.register_hook("post_tool_call", on_post_tool_call)
	ctx.register_hook("pre_verify", on_pre_verify)
	ctx.register_hook("subagent_start", on_subagent_start)

	inject_message = getattr(ctx, "inject_message", None)

	def inject(message: str) -> bool:
		if not callable(inject_message):
			return False  # this Hermes cannot send a message on a command's behalf
		# A gateway routes by the chat's session key, which Hermes binds while a command runs.
		try:
			from gateway.session_context import get_session_env  # type: ignore[import-not-found]

			session_key = get_session_env("HERMES_SESSION_KEY") or None
		except Exception:
			session_key = None
		return bool(inject_message(message, session_key=session_key))

	def command(verb: str) -> Callable[[str], str | None]:
		def handler(raw_args: str = "") -> str | None:
			try:
				if verb == "quick":
					return quick(raw_args or "", inject)
				return control([verb, *(raw_args or "").split()])[1]
			except Exception as error:
				return " ".join(f"Ultrathink {verb} failed: {error}".split())

		return handler

	# Hyphens, not colons: Telegram, Slack and Discord command menus accept only [a-z0-9_-],
	# and one colon name stops Discord from listing every plugin command after it.
	for verb, (args_hint, description) in COMMANDS.items():
		try:
			ctx.register_command(f"ultrathink-{verb}", command(verb), description=description, args_hint=args_hint)
		except Exception:
			pass  # a Hermes without slash commands still plans every prompt

	register_skill = getattr(ctx, "register_skill", None)
	if callable(register_skill):
		for name in SKILLS:
			try:
				path = REPO_ROOT / "skills" / name / "SKILL.md"
				register_skill(name, path, description=skill_description(path))
			except Exception:
				pass  # every instruction naming a skill also carries its SKILL.md path
