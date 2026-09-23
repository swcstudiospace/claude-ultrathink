# Requirements: Ultrathink on Hermes

**Defined:** 2026-09-24
**Core Value:** Every non-trivial Hermes prompt is planned by the TypeScript ultrathink engine, then tracked in Notion and Linear, before the agent does the work.

## v1 Requirements

Requirements for the Hermes bridge. Each maps to roadmap phases.

### Bridge

- [ ] **BRIDGE-01**: A non-trivial Hermes prompt is planned by the TypeScript engine, and the session file is written under `$HERMES_HOME/ultrathink/sessions/`, not in the working directory and not under `~/.claude/ultrathink/sessions/`
- [ ] **BRIDGE-02**: The hook appends a short handoff beside the user message — the absolute session-file path and the skill instruction — and does not replace the user bubble or put the full graph in the prompt
- [ ] **BRIDGE-03**: If Bun is missing, the engine fails, stdout is not one envelope, or the subprocess deadline fires, the original prompt still runs and no tracker rows are created
- [ ] **BRIDGE-04**: Slash commands, trivial acknowledgements, already-uplifted XML, skill-preamble turns, cron turns, and child sessions do not spawn the engine
- [ ] **BRIDGE-05**: The bridge kills the Bun subprocess before the host hook cap. The host backstop is 600 seconds. The subprocess kill is shorter

### Kickoff

- [ ] **KICK-01**: A Hermes skill creates or updates one Notion task and the matching Linear issue, found by Graph ID, before other work
- [ ] **KICK-02**: That skill creates one issue per graph node and one sub-issue per Chain-of-Thought step, on the existing Notion data source and Linear team
- [ ] **KICK-03**: Blocking questions go out as one `clarify` batch before other work. If that tool is unavailable, the skill uses defaults and says so
- [ ] **KICK-04**: The turn hands the agent an issues block that names the rows that were created or updated
- [ ] **KICK-05**: If the plan is missing, or Notion or Linear is down, the skill does not create rows and the prompt still proceeds

### Sync

- [ ] **SYNC-01**: The sync skill updates PR URL, PR number, and status on the existing task and Linear issue, and never creates a row
- [ ] **SYNC-02**: A pull request created in the turn, or a coding turn about to finish with an unsynced plan, nudges the agent to sync by Graph ID
- [ ] **SYNC-03**: A down Notion or Linear during sync does not block the turn that created the pull request
- [ ] **SYNC-04**: Sync looks up by Graph ID only, never by branch, and does not clear the PR URL when the turn has no pull request

### Cleanup

- [ ] **CLEAN-01**: The Python plugin no longer creates Hermes Kanban cards, and `/issues` is gone
- [ ] **CLEAN-02**: The Python plugin no longer writes a GSD milestone into the working directory, and `/gsd` is gone
- [ ] **CLEAN-03**: Running the hook with the working directory on a repo that already has a roadmap does not modify that repo's `.planning/`

## v2 Requirements

Deferred. Not in the current roadmap.

### Operator extras

- **EXTRA-01**: A status command pings Notion and Linear, from a slash command or the skill, never from the hook
- **EXTRA-02**: If the model skips sync, a forced follow-up turn runs sync and is not re-planned
- **EXTRA-03**: Gateway buttons ask HITL questions on Telegram or Slack when typed defaults are not acceptable
- **EXTRA-04**: Live node-status is mirrored during the turn, beyond PR URL and status

### Cross-host

- **HOST-01**: The operator can resume a Graph ID that was started on the other agent, as an explicit command
- **HOST-02**: A third tracker, or a GitHub-issues export, can receive the same plan
- **HOST-03**: The bridge dispatches graph waves itself. v1 leaves execution to the agent

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Python rewrite of the uplift, graph, HITL, or track-plan engine | TypeScript stays the source of truth |
| Native TypeScript Hermes plugin | Hermes plugins load as Python |
| Hermes Kanban cards, even behind a flag | Notion and Linear are the only tracker. A flag is how the clobber shipped |
| Plugin writing `.planning/` into the working directory | That write is the bug this milestone removes |
| Full uplift XML and graph injected into the prompt | The host spills at 10,000 characters. The session file is the payload |
| Notion or Linear calls from the hook | Hooks do not call MCP. The skill does |
| `hook_callback_timeout` set to 0 | That hangs the turn. 600 is the host backstop; the subprocess dies sooner |
| Forced sync via a new injected message in v1 | A session that ends with no further message stays unsynced. Accepted gap |
| omp / pi TUI, Tissue, ktui, AgentSwarm | Already stripped from ultrathink |
| Changing Claude Code hook behavior beyond a callable engine entry | Claude Code keeps the existing plugin |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| BRIDGE-01 | — | Pending |
| BRIDGE-02 | — | Pending |
| BRIDGE-03 | — | Pending |
| BRIDGE-04 | — | Pending |
| BRIDGE-05 | — | Pending |
| KICK-01 | — | Pending |
| KICK-02 | — | Pending |
| KICK-03 | — | Pending |
| KICK-04 | — | Pending |
| KICK-05 | — | Pending |
| SYNC-01 | — | Pending |
| SYNC-02 | — | Pending |
| SYNC-03 | — | Pending |
| SYNC-04 | — | Pending |
| CLEAN-01 | — | Pending |
| CLEAN-02 | — | Pending |
| CLEAN-03 | — | Pending |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 0
- Unmapped: 17 ⚠️

---
*Requirements defined: 2026-09-24*
*Last updated: 2026-09-24 after initial definition*
