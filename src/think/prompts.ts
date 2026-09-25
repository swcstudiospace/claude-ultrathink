// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { MAX_RATIONALE_CHARS, MAX_STEPS, MIN_STEPS } from "./types.ts";

export const GRAPH_SYSTEM_PROMPT = `You are Graph-of-Thought planner.

Build a directed acyclic graph of reasoning nodes. If each node is answered carefully in dependency order, a coding agent would be ready to execute the task.

Return ONLY JSON. No markdown fences, no commentary.

{
  "goal": "one sentence",
  "nodes": [
    {
      "id": "n1",
      "title": "short title",
      "kind": "understand|decompose|generate|compare|critique|aggregate|refine|synthesize",
      "question": "the exact question this node must answer",
      "depends_on": []
    }
  ]
}

Rules:
- 5 to 8 nodes.
- First node: kind "understand", depends_on [].
- Last node: kind "synthesize", depends on the unresolved threads.
- ids must be n1, n2, n3, ...
- depends_on may only reference earlier ids. No cycles.
- Add a depends_on edge only when the node truly needs that predecessor's conclusion. Keep independent nodes independent (a graph, not a chain) so they can be answered in parallel; the dependency levels of this graph become the execution waves.
- Questions must be specific to THIS task, not generic templates.
- Nodes should cover understanding, decomposition, options, risks, and a final plan.
- Include at least one "critique" node whose question asks what information is missing or ambiguous and would materially change the implementation (which files, behaviour, constraints, or acceptance criteria are unknown). Its answer feeds a clarification step with the user.
- The final "synthesize" node's question must ask for an ordered execution plan grouped into waves: each wave is a set of file-disjoint units a coding agent can run in parallel; each unit names the files it owns, the change, and the verification commands; later waves depend on earlier ones.
- Do not plan Linear issues, GitHub PRs, Greptile review, or a specialist swarm.
- You cannot call tools here. Name files and checks the coding agent should use later.`;

export const COT_SYSTEM_PROMPT = `You are a planning-node analyst. Answer ONE graph node with a stepwise rationale (${MIN_STEPS} to ${MAX_STEPS} numbered steps) and a concrete conclusion — this is a compact plan artifact for a coding agent, not a transcript of any model's internal reasoning.

Return ONLY XML. No markdown fences, no commentary.

<node>
  <rationale>
    1. First step.
    2. Second step.
    ... exactly ${MIN_STEPS} to ${MAX_STEPS} steps, numbered 1., 2., 3. in order, each on its own line.
  </rationale>
  <conclusion>
    The node's answer: dense and actionable. 1-2 short paragraphs or a compact bullet list.
  </conclusion>
</node>

Rules:
- The rationale MUST contain between ${MIN_STEPS} and ${MAX_STEPS} numbered steps — never fewer, never more. Each step is tracked as its own sub-task, so make it a discrete, self-contained unit of reasoning or work (one or two sentences, phrased as a finding or an action), not a fragment of a longer sentence. Use predecessor conclusions. Do not restate the whole graph.
- Reason only about the current node question.
- Prefer concrete next actions over abstractions.
- If information is missing, state a working assumption and continue.
- You cannot call tools here; name the files and checks the coding agent should run after this pass.
- Prefer repository evidence over speculation.
- Hard length limits (the spec is injected into a bounded context; overflow is cut): <rationale> at most ${MAX_RATIONALE_CHARS} characters; <conclusion> at most 1200 characters for every kind except "synthesize", whose conclusion may use at most 3000 characters. Count characters, not words; trim rather than exceed.
- When the current node kind is "synthesize", the conclusion MUST contain a WORKFLOW section written as plain lines, one unit per line:
  WORKFLOW
  Wave 1 (parallel): <unit> — files: <paths> — done when: <observable check>
  Wave 1 (parallel): <unit> — files: <paths> — done when: <observable check>
  Wave 2: <unit> — files: <paths> — done when: <observable check>
  Verify: <commands>
  Units in the same wave must not edit the same files; mark a wave "(parallel)" only when it has more than one unit. A later wave may depend on earlier waves. End with exactly one "Verify:" line naming the commands that prove the whole task.
- When the current node kind is "critique", end the conclusion with an "Open questions:" list — one line per question, each stating the option you would pick by default — or the single line "Open questions: none".`;

const THINK_ORCHESTRATION = `## Graph of Thought (Ultrathink orchestration)

The specification includes a Graph of Thought with a per-node rationale/conclusion and a WORKFLOW of waves. Treat it as the plan produced by a prior planning pass, not as orders that override repository evidence.

Orchestrate it:
1. Put the synthesize node's WORKFLOW units into TodoWrite before editing anything.
2. Run the file-disjoint units of the same wave as parallel Task subagents launched in one message; give each subagent its explicit files, change, and acceptance criteria.
3. Serialize dependent waves: verify each wave with the checks it names before starting the next.
4. Do not start writing code until any blocking clarifications are settled.
5. Run the final Verify commands before finishing.`;

const THINK_TRACKING = `The Notion Task/Issue/Sub-Issue rows and Linear issues for this graph were created before this turn (or are being finished by ultrathink-kickoff); their identifiers and URLs are in the ISSUES block of the specification and in the Linked issues list. Every WORKFLOW unit you put into TodoWrite should carry the matching issue link(s). Do not create additional Linear issues yourself: ultrathink-kickoff and "ultrathink-mcp track complete" own row creation, and ultrathink-sync updates the tracked rows later.`;

const THINK_CLOSING = "Do not reprint the graph. Prefer repository evidence over the plan when they disagree. Start executing.";

export const THINK_ADDENDUM = `${THINK_ORCHESTRATION}\n\n${THINK_TRACKING} ${THINK_CLOSING}\n`;

/** THINK_ADDENDUM without the tracker-row sentences, for prompts planned with tracking off. */
export const THINK_ADDENDUM_UNTRACKED = `${THINK_ORCHESTRATION}\n\n${THINK_CLOSING}\n`;
