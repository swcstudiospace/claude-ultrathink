# Use the Greptile knowledge base

Greptile publishes a **knowledge base** for each repository it has indexed: markdown documents it synthesizes from the code, with an `index.md` that routes topics to documents. With `hitl.knowledgeBase` on, the planner reads the documents that match your request before it writes the clarifying questions. A question those documents already answer is recorded as settled instead of asked. The feature is **off by default**: a fresh install never contacts Greptile while planning.

This guide turns it on and shows how to check what it did. [Ship with Greptile](ship-with-greptile.md) covers Greptile's other use, pull request review, which is a separate switch.

- [1. Check the requirements](#1-check-the-requirements)
- [2. Store a Greptile credential](#2-store-a-greptile-credential)
- [3. Turn it on](#3-turn-it-on)
- [4. Check it](#4-check-it)
- [What the planner does with it](#what-the-planner-does-with-it)
- [Turn it off again](#turn-it-off-again)

## 1. Check the requirements

| You need | Why | Check |
|---|---|---|
| A Greptile account in which the repository is indexed and its knowledge base is published | the planner reads that knowledge base; a repository Greptile doesn't list, or one with no published documents, gives nothing to read | the knowledge base in your Greptile account |
| A git repository whose `origin` remote names the same `owner/repo` as in Greptile | the knowledge base is found by that slug | `git remote get-url origin` |
| A Greptile credential in the ultrathink credential store | every knowledge-base call | [step 2](#2-store-a-greptile-credential) |
| Clarifying questions on (`hitl.enabled`, or `bin/ultrathink hitl on`) | the knowledge base is read only for the clarify step | `<clone>/bin/ultrathink status` |

`<clone>` is the directory you cloned ultrathink into.

## 2. Store a Greptile credential

Store a Greptile API key (from your Greptile account settings), or log in with OAuth:

```sh
<clone>/bin/ultrathink-mcp auth set-key greptile --stdin   # paste the key, then Ctrl-D
# or
<clone>/bin/ultrathink-mcp auth login greptile
```

The Greptile CLI login (`greptile login`) is not used here. See [Register the MCP gateway](register-mcp-gateway.md) for the credential store.

**Several Greptile organizations.** If your Greptile account belongs to more than one organization, Greptile refuses the calls until one is chosen. Put the organization's id or handle in `ship.greptileOrganization` ([step 3](#3-turn-it-on)); it is sent with every knowledge-base call, whether or not ship is on. Leave it `""` for a single-organization account.

## 3. Turn it on

Add the key to a config file: your user file `~/.config/ultrathink/config.json` for yourself, or `<repo>/.claude/ultrathink.json` to share it with everyone who works in that repository (see [Team and project config](team-and-project-config.md)).

```json
{
  "hitl": { "knowledgeBase": true },
  "ship": { "greptileOrganization": "" }
}
```

`hitl.knowledgeBase` is a boolean and defaults to `false`; any other value counts as `false`. The `ship` line is needed only for a multi-organization account.

## 4. Check it

From the project directory:

```sh
<clone>/bin/ultrathink status
```

The line after `Ship:` shows what the planner will do:

| Line | Meaning |
|---|---|
| `Knowledge base: on · Greptile` | Ready. ` · organization <org>` follows when `ship.greptileOrganization` is set. |
| `Knowledge base: on · no Greptile credential (run bin/ultrathink-mcp auth login greptile)` | No usable credential is stored; do [step 2](#2-store-a-greptile-credential). |
| `Knowledge base: on · not read while HITL is off` | Clarifying questions are off, so nothing is read. |
| `Knowledge base: off (opt-in: set hitl.knowledgeBase)` | The key is not set. |

Then send a prompt that gets planned. The one-line summary after the plan (shown while `claude.echo` is on) reports the lookup after the Substrate bit:

| Summary bit | Meaning |
|---|---|
| `Knowledge · 3 docs · 1 settled` | Documents were read and passed to the clarifier; one question was settled from them. ` · <n> settled` appears only when at least one was. |
| `Knowledge · none` | No repository slug, the repository isn't in the knowledge-base list, or it has no published documents. |
| `Knowledge · off (no Greptile login)` | No usable Greptile credential; nothing was contacted. |
| `Knowledge · error` | A Greptile or network error, the organization choice above, a timeout, or a cancelled plan. The questions are the same as with the feature off. |

For the reason and timing, run the host with `ULTRATHINK_DEBUG=1` (Claude Code, Grok Build and Muse; see [Configuration](../configuration.md#environment-variables)). The prompt hook writes one line per lookup to stderr: `greptile knowledge base: <outcome>`, then the documents read or the reason, then the elapsed time. For example:

```text
[ultrathink] greptile knowledge base: used · index.md, docs/shipping-workflow.md · 2140ms
```

Every host also records the lookup as `knowledge` in the session record (`<state dir>/sessions/<id>.json`, and `last.json`): outcome, repository, documents read, digest length, elapsed time, reason and the number of settled questions. On Omp the status bar shows a `kb` segment before `clarify` while a lookup runs and after it ends.

## What the planner does with it

1. While the uplift runs, the planner finds the repository's knowledge base by the `origin` remote's `owner/repo`, lists its documents and reads `index.md`.
2. After the Graph of Thought, it picks up to 3 documents from the index's routing table that match the request and reads them.
3. At most 24 000 characters of those documents go to the clarifier, marked as untrusted evidence. Each Greptile stage has a 20-second budget.
4. The clarifier may mark a question as settled only by citing one of the documents it was given, with a one-sentence answer. A settled question is not asked. A claim that cites a document that was not read, has an empty or overlong answer, or goes past the limit of 4 settled questions is asked as an ordinary question, never dropped. Product decisions (what you want, as opposed to how the repository works) are still asked.

Settled questions show up:

- in the plan's clarifications in their own **Settled from the Greptile knowledge base** subsection, after **Answered**, as `- [k1] <question> → <answer> (Greptile knowledge base: docs/shipping-workflow.md)`. The subsection marks them as untrusted evidence, not your decisions: the agent checks them against the repository and asks you when the repository disagrees. **Answered** lists only your answers and assumed defaults;
- in the spec's `CLARIFICATIONS` block as `<ANSWER source="knowledge" evidence="docs/shipping-workflow.md">…</ANSWER>`;
- in a `## Greptile knowledge base` section of the context the agent sees, which names the documents read and says they are Greptile-synthesized summaries to check against the repository itself.

Settled answers are not carried to the next prompt in the session; your own answers are. If a document is wrong, answer the question yourself in a later prompt or turn the feature off.

Everything fails open: without a credential, with no knowledge base, on an error or after a timeout, the planner asks exactly the questions it would ask with the feature off.

Only list and read calls go to Greptile (organization, knowledge-base id, document paths). Nothing from your prompt or your code is sent to Greptile. The documents read go to the planning engine inside the clarify call. See [Privacy](../privacy.md).

## Turn it off again

- `"hitl": { "knowledgeBase": false }` in config, or remove the key.
- `bin/ultrathink hitl off` (or `hitl.enabled: false`) turns off the clarifying questions and, with them, the knowledge-base read.

`bin/ultrathink status` then shows `Knowledge base: off (opt-in: set hitl.knowledgeBase)` or `Knowledge base: on · not read while HITL is off`.
