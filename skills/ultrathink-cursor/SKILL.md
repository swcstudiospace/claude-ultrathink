---
name: ultrathink-cursor
description: After an ultrathink plan in Cursor, hand new implementation work to Agent Swarm. Use when the session has an uplifted plan with a Graph ID and .cursor/agents/a01-orchestrator.md is installed. Do not use for questions, short replies, /ultrathink-quick, or when the orchestrator agent is not installed.
---

# ultrathink-cursor

You are in Cursor after ultrathink planned the user's prompt. The plan is already in context. A Graph ID looks like `ut-<base36 time>-<8 hex>`.

## Stay in this session

Do not spawn a subagent when any of these is true:

- The user asked a question, or the message is a short reply.
- The message is `/ultrathink-quick`, or it starts with `raw:`.
- `.cursor/agents/a01-orchestrator.md` is not in this workspace.
- This session is already `a01-orchestrator` or one of `a02-requirements` through `a15-docs`.

Do the work in this session in those cases. Do not run `scripts/swarm_run.py` or `hooks/autonomous_run.py`.

## Hand the unit to the orchestrator

When the plan is new implementation work and `a01-orchestrator` is installed:

1. If tracking is on, run `ultrathink-kickoff` as its own Cursor swarm note says: read the state, finish tracking, ask any HITL questions, set the Implementing status and mark the session kicked off. Stop before its final prompt and its "Proceed as normal" section, because `a01-orchestrator` owns the implementation and would otherwise start the same work twice. When an MCP server named `substrate` is connected, its `graph_register` call uses surface `cursor` (the session record's `host`). Skip that call when the server is not connected.
2. Spawn the Task subagent `a01-orchestrator` once. Give it the Graph ID and the uplifted unit (the spec file, not a truncated copy). Tell it to pass that id to the planner:

   ```bash
   python3 "$SWARM_ROOT/scripts/orch_plan.py" --root <repo> --brief-text "<unit>" --pattern feature --risk-class medium --graph-id <graph-id> --json
   ```

   Use the unit's pattern (`feature`, `hotfix`, or `dependency`) and its risk class. `$SWARM_ROOT` is the pinned agent-swarm checkout. The target repo does not vendor the swarm scripts.

3. Do not spawn `a02-requirements` through `a15-docs` yourself. A01 fans those out. Specialists must not spawn further agents.
4. Do not run `scripts/swarm_run.py` or `hooks/autonomous_run.py`.

A Cursor cloud session stays advisory. Do not set `SUBSTRATE_URL`, `SUBSTRATE_TOKEN`, `SWARM_SIGNING_KEY`, or `SWARM_ED25519_KEY`. A01 ingests with `orch_status.py --ingest --advisory` and stops at a draft pull request. Nothing it records counts as APPROVED.
