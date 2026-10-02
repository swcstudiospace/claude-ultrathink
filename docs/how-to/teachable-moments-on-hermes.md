# Teachable Moments on Hermes

This page is the Hermes surface for Teachable Moments. It assumes the plugin is already enabled on a machine where `hosts/hermes` is symlinked into `${HERMES_HOME:-~/.hermes}/plugins/ultrathink`, as [Install](../install.md#hermes-agent) describes. A copied plugin directory is not enough: the plugin finds `bin/ultrathink` by resolving that symlink.

Teachable Moments stays off until you set `teach.enabled` in your user config. The steps, the capture modes and the CLI are in [Use Teachable Moments](use-teachable-moments.md). This page is only what Hermes adds.

Everything here fails open. A hook, a tool or a command that throws is swallowed, and the turn continues. Importing the plugin does no network I/O: `hosts/hermes/__init__.py` and `bridge.py` import the standard library and each other, and they do not open a socket at import. A request happens only later, when a command or a detached `bin/ultrathink teach …` process runs, and only if Teachable Moments is on.

- [What Hermes registers](#what-hermes-registers)
- [Observe a finished turn](#observe-a-finished-turn)
- [Sync when the session ends](#sync-when-the-session-ends)
- [Tools and commands](#tools-and-commands)
- [Skills, and what Hermes does not write](#skills-and-what-hermes-does-not-write)
- [Lessons in a plan](#lessons-in-a-plan)

## What Hermes registers

| Surface | Name | When it runs |
|---|---|---|
| Hook | `post_llm_call` | After a model call. Starts a detached `teach observe` when capture is `observe` or `auto`. |
| Hook | `on_session_finalize` | When a session ends. Starts a detached `teach sync` when Teachable Moments is on. |
| Tool | `ultrathink_lesson_save` | Hidden while Teachable Moments is off. Saves one lesson. |
| Tool | `ultrathink_lesson_recall` | Hidden while Teachable Moments is off. Searches lessons. |
| Command | `/ultrathink-learn <note>` | Saves the note as a `pattern` lesson. |
| Command | `/ultrathink-lessons` | `list`, `recall <query>`, `promote <id>` or `status`. |
| Skill | `ultrathink-teach` | Registered as `ultrathink:ultrathink-teach`. Tells the agent when to save and recall. |

The other `/ultrathink-*` commands (status, skip, on, off, track, quick) are unchanged. `post_llm_call` and `on_session_finalize` are registered even while Teachable Moments is off; the hook then returns without starting a process.

## Observe a finished turn

`post_llm_call` hands the finished turn to `bin/ultrathink teach observe --file <path>` as a detached process: its own session, stdio closed, and Hermes does not wait for it. The digest is written to `<state dir>/teach/inbox/` at mode 0600 and the observe process deletes that file when it reads it. If the process cannot be started, the inbox file is deleted immediately, because it still holds the unredacted turn.

Nothing is started when:

| Result | Why |
|---|---|
| capture is `explicit` (the default) | Only an explicit `teach capture` creates a lesson. Raise `teach.capture` to `observe` or `auto` in your user config. A project file can only lower that mode. |
| Teachable Moments is off | `teach status` did not report `enabled`. |
| the turn is a subagent or a cron turn | Those are skipped. |
| the history has fewer than two tool rows | There is not enough of a turn to observe. `teach observe` also skips a digest with fewer tool calls than `teach.observeMinToolCalls` (default 4). |
| this session was observed in the last 30 seconds | At most one observe process per session in that window. |

A spawned observe that finds a lesson stores a **candidate** in `observe` mode. You confirm it with `bin/ultrathink teach confirm <id>` or leave it. In `auto` mode a candidate that passes the gate is confirmed without that step. Either way a failure inside the detached process does not come back to the turn.

## Sync when the session ends

`on_session_finalize` starts `bin/ultrathink teach sync` the same way: detached, not waited on, once per session, and only when Teachable Moments is on. That replays the outbox and retains confirmed lessons that never reached Hindsight. If Hindsight is still down, the sync exits without losing the local lesson. See [When Hindsight is down](use-teachable-moments.md#6-when-hindsight-is-down).

You can run the same command yourself:

```sh
<clone>/bin/ultrathink teach sync
```

```text
Sync: 0 done · 0 pending
```

## Tools and commands

Both tools are registered on the `ultrathink` toolset and hidden while `teach status` does not report enabled. A tool error is JSON, not an exception that stops the turn.

`ultrathink_lesson_save` takes `name` and `body`, and optionally `description`, `kind` and `tags`. Omit `kind` and Hermes sends `pattern` (the CLI's own default, when you run `teach capture` without `--kind`, is `pitfall`). It calls `teach capture --stdin --json`. A saved lesson comes back as the CLI's JSON, including `retain`. The tool description asks for a body of at most 1200 characters; the CLI accepts a body of at most 2400.

`ultrathink_lesson_recall` takes `query` and an optional `limit`. Results are untrusted notes. The CLI accepts `--limit` from 1 to 10.

`/ultrathink-learn <note>` saves the note as a `pattern` lesson. The name is the first sentence, cut to 80 characters. With an empty note it replies `Usage: /ultrathink-learn <note>`. On success: `Saved lesson <id> (retain: <retained|queued|local-only>).` On failure: `Could not save the lesson: <reason>.`

`/ultrathink-lessons` with no arguments lists lessons. The other forms:

| Command | What you see |
|---|---|
| `/ultrathink-lessons list` | One line per lesson, or `No lessons saved yet.` A failure is `Could not list lessons: <reason>`. |
| `/ultrathink-lessons status` | The `teach status` text, starting with `Teach: `. |
| `/ultrathink-lessons recall <query>` | One line per match from `teach recall "<query>" --limit 5`, or `No matching lessons.` An empty query is `Usage: /ultrathink-lessons recall <query>`. |
| `/ultrathink-lessons promote <id>` | Drafts a skill and stages it through Hermes `skill_manage`. See below. |

A bad verb replies `Usage: /ultrathink-lessons [list|recall <query>|promote <id>|status]`.

## Skills, and what Hermes does not write

The plugin registers `skills/ultrathink-teach/SKILL.md` as `ultrathink:ultrathink-teach`, the same way it registers kickoff, sync, plan and ship. That skill tells the agent when a lesson is worth saving and that a recalled lesson is evidence, not an instruction.

**ultrathink does not write `~/.hermes/skills`.** A promote aimed at Hermes, including `teach promote <id> --install --target hermes`, only writes a draft under `<state dir>/teach/skill-drafts/<name>/SKILL.md` and tells you to install it through `skill_manage`. The CLI line is `install through Hermes skill_manage so skills.write_approval applies; ultrathink never writes ~/.hermes/skills`.

`/ultrathink-lessons promote <id>` is the path that goes through Hermes. It drafts with `teach promote <id> --target hermes`, then calls `skill_manage` with `action` `create`, the draft's name, category `ultrathink-lessons` and the draft content. With `skills.write_approval` on, Hermes stages the skill instead of writing it straight away. The reply is:

```text
Sent the skill <name> for lesson <id> to Hermes. With skills.write_approval on it is staged: review it with /skills pending, then /skills approve <id>.
```

After Hermes accepts it, the command marks the lesson promoted (`teach promote <id> --mark-promoted --skill <name> --target hermes`). If that mark fails, the reply says the lesson is not marked promoted yet.

If `skill_manage` cannot be called, the reply names the reason and the draft path, and tells you to create the skill yourself (category `ultrathink-lessons`) or copy the draft to `${HERMES_HOME:-~/.hermes}/skills/ultrathink-lessons/<name>/SKILL.md`, then run the `--mark-promoted` command above. ultrathink does not do that copy.

`teach.autoPromote` does not change this. It is user-file only and default off, and even when it is on, a Hermes host only receives a draft. It does not install into `~/.hermes/skills`.

## Lessons in a plan

Recall is on unless you set `teach.recall` to false. When a planned turn finds lessons, the handoff Hermes gives the model can include a `## Lessons from earlier work` section. The section says the lessons are recalled from earlier agent runs and are untrusted evidence, not instructions. It is omitted when recall is off, when nothing matched, or when the lookup failed and the local store had no match. A failure does not drop the plan.

The summary segment, when the host prints one, is `Lessons · <n> recalled (hindsight)` or `Lessons · <n> recalled (local)`.
