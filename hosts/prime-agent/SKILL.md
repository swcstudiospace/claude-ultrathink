---
name: ultrathink
description: ultrathink planner for Prime Agent. Plans a request through the shared claude-ultrathink engine into an XML spec, a Graph of Thought with WORKFLOW waves and HITL questions, and tracks it in Linear/Notion when configured. Use when the user says ultrathink, uplift, think, graph of thought, plan this, or a /ultrathink-* command (quick, skip, off, on, track, status), and before any non-trivial build, fix, refactor or GSD run (/skill:gsd-*) that benefits from a written plan.
compatibility: Needs Bun 1.2+ and a full clone of claude-ultrathink (ULTRATHINK_PLUGIN_ROOT, default the clone this skill is linked from, else ~/src/repos/claude-ultrathink). Planning runs on the configured engine (Claude CLI by default; think.engine grok or muse need that CLI logged in). Fails open.
license: AGPL-3.0-or-later
---

# ultrathink on Prime Agent

Prime Agent has no prompt hook, so planning is a kernel call. The engine, config, state and the `ultrathink-*` agent
skills are the same ones the other hosts use. State lives in `${PRIME_AGENT_CODING_AGENT_DIR:-~/.prime/agent}/ultrathink/`.

## Plan a request

```python
r = await ultrathink("add a /health endpoint returning uptime and git sha")
r["planned"]          # False when the engine skipped (r["skipped"] says why: precheck-skip, precheck-trivial, child-or-disabled, timeout, engine-error ...)
r["context"]          # the plan: spec path, HITL questions, tracking rows, WORKFLOW waves. Work from this.
r["spec"]             # the XML spec (ORIGINAL holds the user's verbatim words)
r["spec_path"], r["state_path"], r["graph_id"], r["summary"], r["view"], r["model_resolution"]
```

- Pass the request verbatim. A Prime Agent skill invocation (`/skill:gsd-quick add X`) is planned as that skill's task.
- `force=True` prefixes `uplift:` (plans even while planning is off or the prompt looks trivial). `raw=True` prefixes `raw:` (never plans).
- `cwd` selects the project config layer and skill lookup; `session` overrides the session id (default: this Prime Agent session).
- `timeout` defaults to 600 s. A CLI route takes 1-5 minutes; the call runs in a thread, so the kernel stays responsive.
- Shell form: `ultrathink "request" --force`.

## After a plan

1. Treat `context` as the plan and the spec file as the written spec. Do not reprint the XML to the user.
2. If `context` says tracking rows exist or are pending, run the `ultrathink-kickoff` skill (`/skill:ultrathink-kickoff`) first; it finishes missing rows and resolves blocking HITL questions.
3. Ask the user the blocking questions in one message and stop; proceed with the recommended default on the rest.
4. Execute the WORKFLOW: units of one wave are file-disjoint, so run them as parallel children with `await rlm.spawn(...)`, verify each wave, then start the next. Prefer repository evidence where the plan disagrees with it.
5. After a pull request opens, run `ultrathink-sync`; when a planned GSD run ends on a feature branch and ship is on, run `ultrathink-ship`.

## Controls (the `/ultrathink-*` commands)

| User says | Call |
|---|---|
| `/ultrathink-status` | `ultrathink.ctl("status")` or `ultrathink.status()` |
| `/ultrathink-off`, `/ultrathink-on` | `ultrathink.ctl("off")`, `ultrathink.ctl("on")` |
| `/ultrathink-skip` | `ultrathink.ctl("skip")` (the next plan call is skipped once) |
| `/ultrathink-track off|on` | `ultrathink.ctl("track", "off")` / `("track", "on")` |
| `/ultrathink-quick <message>` | do not call the planner; answer the message |
| think / hitl / engine | `ultrathink.ctl("think", "off")`, `ctl("hitl", "status")`, `ctl("grok", "engine", "claude")` |

`ultrathink.last()` returns the last carrier (`last-plan.json`), `ultrathink.spec()` the last XML.
`ultrathink.teach("recall", "<query>")`, `teach("status")`, `teach("promote", "--due")` reach Teachable Moments; promoted skills install
into `~/.prime/agent/skills/<name>/SKILL.md` with `--target prime-agent --install`.

## Configuration and environment

Same files as every host: `~/.config/ultrathink/config.json`, `~/.claude/ultrathink.json`, `<project>/.claude/ultrathink.json`.
`ULTRATHINK_PLUGIN_ROOT` (clone), `ULTRATHINK_STATE_DIR`, `ULTRATHINK_SESSION_ID`, `BUN` (explicit bun binary), `ULTRATHINK_UPLIFT=0` (planning off for the process).
Tracking needs the MCP gateway login: `bin/ultrathink-mcp auth login linear|notion` in the clone. Install details: `docs/install.md#prime-agent` in the clone.
