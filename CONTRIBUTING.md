# Contributing to ultrathink

Thanks for helping. Bugs and feature requests go through the [issue forms](https://github.com/swcstudiospace/claude-ultrathink/issues/new/choose). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a public issue. Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need [Bun](https://bun.sh) 1.2 or newer, Python 3.10 or newer and git, on Linux or macOS (Windows through WSL).

```bash
git clone https://github.com/swcstudiospace/claude-ultrathink.git
cd claude-ultrathink
bun install
bun run check                          # type check (TypeScript 5.9.3, pinned in package.json)
bun test
python3 hosts/hermes/bridge_test.py    # Hermes bridge tests; prints "ok"
```

CI (`.github/workflows/ci.yml`) runs the same checks on every pull request and on every push to `main`, on Linux and macOS, with Bun 1.2.x (the minimum in `package.json`) and the latest Bun, and Python 3.10.

To try a change in a host, install it from your checkout as [docs/install.md](docs/install.md) shows. For Claude Code, `claude --plugin-dir <checkout>` loads the checkout for one session; disable an installed copy first (`claude plugin disable ultrathink@ultrathink`) so the prompt is not planned twice. TypeScript changes under `hooks/` and `src/` take effect on the next prompt, with these exceptions:

- Muse copies the plugin when you install it, so install it again after a change.
- Omp and Hermes load their entry in-process. Restart them after you change `src/host/omp.ts` (or a module it imports) or `hosts/hermes/*.py`.

While you test:

- `ULTRATHINK_DEBUG=1` makes the prompt hook (`hooks/uplift.ts`) log to stderr what it skipped or did.
- `ULTRATHINK_STATE_DIR=<temp dir>` keeps session state out of your real state directory.
- Each planned prompt creates Linear and Notion rows when tracking is configured. `/ultrathink-track off` keeps planning without creating rows, and `/ultrathink-quick <message>` sends one message without planning it.

## Repository layout

```text
.claude-plugin/    Claude Code plugin manifest and marketplace entry
.muse-plugin/      Muse plugin manifest
.omp-plugin/       Omp marketplace entry (the Omp extension is package.json "omp.extensions")
bin/               sh launchers: run-bun (finds Bun, exits 0 without it), ultrathink,
                   ultrathink-mcp, ultrathink-ship
commands/          slash-command files for the ultrathink-<verb> commands (Claude Code, Grok Build, Muse)
hooks/             host hook entries: uplift.ts (plans the prompt), engine.ts (JSON in, JSON out, for
                   Hermes and Omp), answers.ts (HITL answers), pr-sync.ts and stop.ts (sync and ship
                   nudges), muse-* launchers, and hooks.json (Claude Code hooks; scripts/setup.ts
                   derives Grok's global hook file from it)
hosts/grok/        rule that tells Grok to read the plan carrier (installed by scripts/setup.ts)
hosts/hermes/      Hermes plugin: plugin.yaml, __init__.py, bridge.py (calls hooks/engine.ts),
                   bridge_test.py
scripts/           setup.ts (apply, status, rollback) and mcp-register.ts (registers the MCP gateway
                   in every host)
skills/            ultrathink-plan, ultrathink-kickoff, ultrathink-sync, ultrathink-ship: the
                   agent-side half, shared by every host
src/claude/        Claude hook protocol, the default headless-Claude engine, session and control
                   state, transcripts
src/host/          host ids and detection, state directories, planPrompt, the plan carrier, engine
                   selection, the Omp extension and its TUI
src/mcp/           MCP gateway: the ultrathink-mcp CLI, relay to the hosted Notion, Linear and
                   Greptile servers, OAuth, credential store
src/ship/          ship flow behind bin/ultrathink-ship: assess, PR, Greptile review, merge gate
src/think/         Graph of Thought and per-node Chain of Thought
src/track/         tracking plan, Linear and Notion row creation through the gateway, PR detection
src/uplift/        Prompt Uplift (spec XML), which prompts to skip, skill invocations, and the
                   ultrathink-<verb> commands
src/grok/          optional Grok engine and its transports
src/hitl/          HITL clarification questions and answers
src/substrate/     optional Agent Substrate brief (only when substrate.url or SUBSTRATE_URL is set)
src/config.ts      config files, defaults and merging
```

## Coding conventions

- TypeScript runs on Bun without a build step, with `strict` on (see `tsconfig.json`).
- Indent with tabs in TypeScript, JSON and the Hermes Python.
- Import local modules with their `.ts` extension, and import types with `import type` (`verbatimModuleSyntax` is on).
- Use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => …)`, and don't add one-line wrapper functions.
- Hooks fail open. A missing Bun, an engine error, a timeout or a tracker outage must never block the user's prompt: return no context and exit 0. Log only under `ULTRATHINK_DEBUG=1`.
- Never log or print secrets, and never copy them out of the credential store into state files, PR bodies, error messages or test fixtures.
- Tests use `bun:test` and sit next to the code as `*.test.ts`. They are deterministic: temp directories, fake `fetch` and process runners, no network, no real host or tracker. Test behavior that a user or caller would notice, not wiring or copied strings. `hosts/hermes/bridge_test.py` is a plain script (no pytest) that follows the same rules.

## Adding a host

The engine is shared. A host gets a thin entry that calls it and fails open.

1. **Register the id.** Add it to `HOSTS` in `src/host/types.ts`, and give it a state directory in `stateDirForHost` (`src/host/paths.ts`). State lives under the host's own home, never in the working directory or a `.planning/` tree.
2. **Call the engine.** Choose the entry that matches the host's hook protocol:
   - If the host speaks Claude Code's hook protocol (hook JSON on stdin; `hookSpecificOutput.additionalContext` or `{"decision": "block"}` on stdout), add an sh launcher like `hooks/muse-prompt` that exports `ULTRATHINK_HOST=<id>` and runs `bin/run-bun hooks/uplift.ts`.
   - Otherwise, send `{"host": "<id>", "session_id": …, "prompt": …, "cwd": …}` on stdin to `bin/run-bun hooks/engine.ts` and read one JSON object back: `context`, `specPath`, `statePath` and `carrierPath`, or `skipped`. `hosts/hermes/bridge.py` does this from Python; `spawnEnginePlanner` in `src/host/omp.ts` does it from TypeScript.
3. **Deliver the plan.** Inject `context` into the model's turn. If the host throws hook output away, as Grok Build does, point the model at the carrier file the engine writes, `last-plan.json` in the state directory (`src/host/carrier.ts`), with a rule like `hosts/grok/ultrathink.md`.
4. **Never plan subagents.** A plan creates Linear and Notion rows when tracking is on, so subagent and child sessions must not be planned. Pass `parent_session_id`, set `ULTRATHINK_CHILD=1`, or detect them in the entry, as `src/host/omp-session.ts` does for Omp.
5. **Fail open.** Launch through `bin/run-bun`, which exits 0 when Bun is missing. Stop waiting before the host's hook timeout (Hermes reads its own `plugins.hook_callback_timeout` and kills the engine's process group at min(540 s, cap − 15 s); Omp waits 25 s and delivers a later plan as an aside), and treat an error, a timeout or unreadable output as "no context".
6. **Wire the commands.** Expose the commands `ultrathink-quick`, `ultrathink-skip`, `ultrathink-off`, `ultrathink-on`, `ultrathink-track` and `ultrathink-status`. The control verbs call `bin/ultrathink <verb> [args]` with `ULTRATHINK_HOST=<id>` and show its output; a TypeScript host can call `runControl` from `src/uplift/commands.ts` instead, as Omp does. `ultrathink-quick` hands the message to the agent without planning it; the engine already refuses to plan an ultrathink command (`/ultrathink-<verb>`, and the older `/ultrathink:<verb>` form). A host that reads Claude-style command files can use `commands/`.
7. **Nudge sync and ship.** After a tool call opens a pull request, nudge the agent to run `ultrathink-sync` (`isPrCreationTool` and `extractPrFromOutput` in `src/track/pr-detect.ts`). At the end of a turn, check whether to suggest `ultrathink-ship` the way `hooks/stop.ts` does (`shipApplies`, `shipPrecheck` and `shipNudge` in `src/ship/`).
8. **Register MCP and setup.** Add the host to `scripts/mcp-register.ts` so it gets the shared Notion, Linear and Greptile gateway. If it needs files outside the repository, as Grok Build needs its global hook file and rule, install them from `apply` in `scripts/setup.ts`, report them in `status` and remove them in `rollback`.
9. **Test and document.** Cover the skip rules, delivery and the fail-open paths with fakes. Add the host to the Hosts table in the README and to the host lists in `.github/ISSUE_TEMPLATE/` and `.github/PULL_REQUEST_TEMPLATE.md`.

## Pull requests

- For large or behavior-changing work, open an issue first so the approach is agreed before you build it.
- Branch from `main` and keep each pull request to one change.
- Run the checks from [Development setup](#development-setup); CI must pass.
- Update the README or the affected `skills/*/SKILL.md` for anything a user would notice, and add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- Write commit messages and pull request titles in the `type(scope): summary` form the history uses (`feat`, `fix`, `docs`, `test`, `chore`).

## License

ultrathink is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later). By submitting a contribution, you agree that it is licensed under AGPL-3.0-or-later as well, and that you have the right to license it that way.
