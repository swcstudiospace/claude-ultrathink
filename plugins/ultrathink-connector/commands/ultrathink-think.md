---
description: Show the Graph of Thought of an ultrathink plan, meaning the diagram, the wave tree and, on request, one node with its steps and conclusion.
argument-hint: "[sessionId] [node]"
---

Show the Graph of Thought of an ultrathink plan. The arguments are: $ARGUMENTS

If that line is blank or still reads `$ARGUMENTS`, use the arguments the user typed after the command name, if any. When there are arguments, the first word is the `sessionId` and the second, optional word is a node id.

1. Call `ultrathink_graph`. With no arguments it uses the newest planned session. Otherwise pass only what was given: `sessionId`, and `node` when a node id was given. Pass no other argument.
2. Show the wave tree from the result first, unchanged, in a code block, and the mermaid diagram too only if your interface renders Mermaid. When a node was asked for, also show that node's question, steps and conclusion.
3. If the result says there is no planned session, say so in one line and stop.

Use only tool results. Never invent a `sessionId`, a node or a diagram. Call no other ultrathink tool.
