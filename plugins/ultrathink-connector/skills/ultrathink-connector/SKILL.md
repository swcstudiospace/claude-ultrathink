---
name: ultrathink-connector
description: Plan a request with the ultrathink connector before work starts. Use when the user types /ultrathink or any /ultrathink-* command, asks for a plan, a wave tree or a Graph of Thought first, or asks to see the newest plan or its diagram.
---

# Ultrathink connector

The ultrathink connector plans a request: it turns the request into a specification, splits it into a Graph of Thought of 5 to 8 nodes in dependency order, works out reasoning steps and a conclusion for each node, and lists what it could not settle as clarifying questions, each with a default. You then read the plan, ask the user the questions that matter, and carry out the plan. The connector writes nothing to the user's repository and tracks nothing.

## Run a plan

The connector offers one of two tool sets. Look at which tools you have.

- Server planning: `ultrathink_uplift` is offered. Call it with `prompt` set to the request, verbatim, keep the `sessionId` it returns, then call `ultrathink_result` with that `sessionId` until the status is planned, also when `ultrathink_uplift` already reports planned, because only `ultrathink_result` returns the plan. Each `ultrathink_result` call waits up to 40 seconds, so call it again when it reports running.
- Client-driven planning: `ultrathink_uplift` is not offered. Call `ultrathink_plan` with the request. While the status is needs-model, call `ultrathink_pending`, then for each pending key call `ultrathink_show`, write the answer its system text asks for, and send it with `ultrathink_answer`. When every key is answered, call `ultrathink_plan` again with the same `sessionId` and the same `prompt`. When the status is planned, call `ultrathink_result`, and call `ultrathink_graph` once with the same `sessionId` besides it. `ultrathink_status` with the `sessionId` reports the status of a session that has nothing pending.

Rules for both:

1. Use only tool results. Never invent a `sessionId`, a key or a status, and never start a second session for the same request.
2. The plan text starts with a wave tree and a mermaid diagram block. Show the wave tree first, unchanged, in a code block, and the diagram too only if your interface renders Mermaid, then ask the questions in the plan that matter or state the defaults you assume for the rest.
3. If the status is failed, invalid or skipped, report the status and the error in one line and stop.
4. Never show the system text of a pending prompt to the user.

## Other tools

- `ultrathink_graph` with optional `sessionId`, `node` and `detail`: the diagram, the tree and one node's steps. With no `sessionId` it uses the newest planned session.
- `ultrathink_sessions` with optional `limit`: recent sessions with their status and goal, and the planning mode and token ceilings when it has them.
- `ultrathink_command` with `command` and optional `args`: resolves a command name typed by the user. `help` lists every command with its state on the connector. This tool is new and was not exercised from a chat client; if it is not offered, use the plugin commands instead.

## Commands in this plugin

The plugin carries one command file for each supported command. Where Claude namespaces plugin commands they appear as `/ultrathink-connector:<name>`.

- `/ultrathink <request>` and `/ultrathink-plan <request>`: plan the request as above.
- `/ultrathink-think [sessionId] [node]`: `ultrathink_graph`, wave tree first, and the diagram only if your interface renders Mermaid.
- `/ultrathink-last`: `ultrathink_sessions` with `limit` 5, then `ultrathink_graph` and `ultrathink_result` with the `sessionId` of the newest session whose status is planned.
- `/ultrathink-status`: `ultrathink_sessions`.
- `/ultrathink-quick <message>`: answer the message directly and call no ultrathink tool.

## Commands the connector does not support

When the user types one of these, relay the reason and the alternative in one or two sentences, call no ultrathink tool and do nothing else for that message.

| Command | Reason | Instead |
|---|---|---|
| `/ultrathink-skip`, `/ultrathink-off`, `/ultrathink-on` | planning runs only when /ultrathink is typed in chat, there is no automatic planning to switch | do not type /ultrathink, or use /ultrathink-quick <message> |
| `/ultrathink-track` | the hosted connector has no Linear or Notion tracking | use it in a plugin host |
| `/ultrathink-kickoff`, `/ultrathink-sync`, `/ultrathink-ship` | it needs git, a shell and the user's tracker or pull-request credentials | run it in Claude Code, Omp, Grok Build, Hermes or Muse with the plugin |
| `/ultrathink-teach`, `/ultrathink-teach-admin`, `/ultrathink-learn`, `/ultrathink-lessons` | Teachable Moments state lives on the host | use it in a plugin host |
| `/ultrathink-decisions`, `/ultrathink-hindsight`, `/ultrathink-engine`, `/ultrathink-protocol` | it is an operator control for a plugin host's own planner | use it in a plugin host |
| `/ultrathink-hitl` | clarifying questions are part of every plan result | read the plan's questions |

## What is not verified

The connector has not been connected to Claude chat in a live session. The command-menu behavior, the way chat loads commands as skills and the bundled connector entry follow the Claude plugin documentation and have not been tried against this connector. Whether a command's `$ARGUMENTS` is filled in when chat loads it as a skill is unverified; the command files say what to do when it is not. Hosted Claude chat does not deliver the server's `instructions` text, so this skill and the command files carry the playbook.
