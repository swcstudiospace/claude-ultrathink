# Roadmap: Ultrathink on Hermes

## Overview

Every non-trivial Hermes prompt is planned by the TypeScript ultrathink engine, then tracked in Notion and Linear, before the agent does the work. Three coarse slices deliver that in order: the prompt is planned and the working tree is untouched; the plan is tracked before the agent works; PR URL and status land on the existing rows. Kanban and the cwd GSD write are deleted in the first slice, not deferred. Sync updates and never creates.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: A Hermes prompt is planned, and the repo is untouched** - TypeScript plans the prompt; Kanban and the cwd GSD write are gone
- [ ] **Phase 2: The plan is tracked before the agent works** - Full kickoff parity in Notion and Linear, before other work
- [ ] **Phase 3: PR URL and status land on the existing rows** - Sync updates those rows and never creates one

## Phase Details

### Phase 1: A Hermes prompt is planned, and the repo is untouched
**Goal:** A non-trivial Hermes prompt is planned by the TypeScript engine, the working tree stays untouched, and Kanban plus the cwd GSD write are gone, with no kickoff sentence yet.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: BRIDGE-01, BRIDGE-03, BRIDGE-04, BRIDGE-05, CLEAN-01, CLEAN-02, CLEAN-03
**Success Criteria** (what must be TRUE):
  1. A non-trivial Hermes prompt is planned by the TypeScript engine, and the session file is written under `$HERMES_HOME/ultrathink/sessions/`, not in the working directory and not under `~/.claude/ultrathink/sessions/`.
  2. If Bun is missing, the engine fails, stdout is not one envelope, or the subprocess deadline fires, the original prompt still runs and no tracker rows are created.
  3. Slash commands, trivial acknowledgements, already-uplifted XML, skill-preamble turns, cron turns, and child sessions do not spawn the engine.
  4. The bridge kills the Bun subprocess before the 600-second host backstop, and the hook returns before Hermes abandons the callback.
  5. The Python plugin no longer creates Hermes Kanban cards or writes a GSD milestone into the working directory; `/issues` and `/gsd` are gone, and running the hook on a repo that already has a roadmap does not modify that repo's `.planning/`.
**Plans**: TBD

### Phase 2: The plan is tracked before the agent works
**Goal:** The plan is tracked in Notion and Linear before the agent does the work, at full kickoff parity.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: BRIDGE-02, KICK-01, KICK-02, KICK-03, KICK-04, KICK-05
**Success Criteria** (what must be TRUE):
  1. The hook appends a short handoff beside the user message — the absolute session-file path and the skill instruction — and does not replace the user bubble or put the full graph in the prompt.
  2. Before other work, a Hermes skill creates or updates one Notion task and the matching Linear issue, found by Graph ID, plus one issue per graph node and one sub-issue per Chain-of-Thought step, on the existing Notion data source and Linear team.
  3. Blocking questions go out as one clarify batch before other work; if that tool is unavailable, the skill uses defaults and says so.
  4. The turn hands the agent an issues block that names the rows that were created or updated.
  5. If the plan is missing, or Notion or Linear is down, the skill does not create rows and the prompt still proceeds.
**Plans**: TBD

### Phase 3: PR URL and status land on the existing rows
**Goal:** PR URL and status land on the existing Notion and Linear rows, and sync updates without creating a row.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: SYNC-01, SYNC-02, SYNC-03, SYNC-04
**Success Criteria** (what must be TRUE):
  1. The sync skill updates PR URL, PR number, and status on the existing task and Linear issue, and never creates a row.
  2. A pull request created in the turn, or a coding turn about to finish with an unsynced plan, nudges the agent to sync by Graph ID.
  3. A down Notion or Linear during sync does not block the turn that created the pull request.
  4. Sync looks up by Graph ID only, never by branch, and does not clear the PR URL when the turn has no pull request.
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. A Hermes prompt is planned, and the repo is untouched | 0/TBD | Not started | - |
| 2. The plan is tracked before the agent works | 0/TBD | Not started | - |
| 3. PR URL and status land on the existing rows | 0/TBD | Not started | - |
