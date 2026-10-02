# Configuration

ultrathink reads JSON config files, a small per-host control file written by the `/ultrathink-*` commands and `bin/ultrathink`, and some environment variables. All of them are optional. With no config at all, ultrathink plans every non-trivial prompt with Claude and contacts nothing except the engine: it creates no Linear or Notion rows, requests no Agent Substrate brief, reads no Greptile knowledge base, asks no Jev decision, stores no lessons, contacts no Hindsight or RAGFlow server, and never pushes, opens a pull request or merges.

Terms used on this page:

- **Host**: the coding agent ultrathink runs inside: Claude Code, Grok Build, Hermes Agent, Muse Code or Omp.
- **Engine**: the model that writes the plan: Claude (through the `claude` CLI) by default, or Grok.
- **Graph of Thought**: the 5 to 8 reasoning nodes the engine builds for each prompt. Each node is filled with numbered rationale steps.
- **HITL** (human in the loop): the clarifying questions the plan asks before work starts.
- **Tracker**: Notion and/or Linear, where the plan becomes rows and issues.
- **Ship**: the optional flow that opens a pull request, has Greptile review it and can merge it. See [Ship](ship.md).
- **State directory**: the per-host directory where ultrathink keeps its control file and session records. See [State directories](#state-directories).
- **Hindsight**: an optional memory server that stores confirmed lessons. Off until you opt in.
- **RAGFlow**: an optional document search that can add excerpts to a plan. Off until you opt in.
- **Teachable Moments**: optional lessons captured from a session and recalled into a later plan. Off until you opt in. State lives under the host state directory's `teach/`, never under `<cwd>/.planning`.

Contents:

- [Config files](#config-files)
- [Key reference](#key-reference)
- [Full example](#full-example)
- [Environment variables](#environment-variables)
- [State directories](#state-directories)
- [Control state versus config](#control-state-versus-config)

## Config files

Every host reads the same three files. They are merged in this order, and a later file wins:

| Order | File | Notes |
|---|---|---|
| 1 | `~/.config/ultrathink/config.json` | Host-neutral user config. Uses `$XDG_CONFIG_HOME/ultrathink/config.json` when `XDG_CONFIG_HOME` is set. `bin/ultrathink-mcp notion init --write-config` writes here. |
| 2 | `~/.claude/ultrathink.json` | Claude user config. Uses `$CLAUDE_CONFIG_DIR/ultrathink.json` when `CLAUDE_CONFIG_DIR` is set. Read on every host, not only Claude Code. |
| 3 | `<project>/.claude/ultrathink.json` | Project config, read from the working directory of the session. |

How the merge works (`src/config.ts`):

- Merging is per key inside each section. A project file that sets only `{"hitl": {"maxQuestions": 2}}` changes that one key and keeps everything else.
- A missing file, a file that is not valid JSON, or a file whose top level is not an object is skipped.
- Unknown sections and keys are ignored.
- A value with the wrong type or outside its allowed range is ignored, and the value from the earlier file (or the default) stays.
- Some string keys only accept a non-empty value, so an empty string in a later file does not clear a value an earlier file set: `notion.dataSourceUrl`, `linear.team`, `grok.baseUrl`, `grok.model`, `grok.bin`, `grok.shuntModel`, `claude.bin`, `decisions.model`, `hindsight.url`, `hindsight.bank`, `ragflow.url`, and the URL keys `grok.shuntBaseUrl` and `substrate.url`. To stop row creation, use `/ultrathink-track off` (see [Turning tracking off](tracking.md#turning-tracking-off)). To turn the Agent Substrate brief off, set `SUBSTRATE_DISABLED=1`.
- The URL keys `grok.shuntBaseUrl` and `substrate.url` must be `http://` or `https://` URLs. Trailing slashes are removed.
- The project file can only make Jev decisions more restrictive: there, `decisions.enabled` can only turn them off (a `true` is ignored), `decisions.zdr` can only turn zero data retention on (a `false` is ignored), and `decisions.points` can only drop points (it is intersected with the list from the earlier files, or the default). The other `decisions` keys (`model`, `timeoutMs` and the thresholds) merge as usual, and the two user files merge every key as usual. See [`decisions`](#decisions-jev-decisions-openrouter-decisions-api).
- The project file can only tighten Hindsight, RAGFlow and Teachable Moments. For `hindsight`, only `enabled: false` counts; `url`, `bank` and the timeouts are ignored, so a repository cannot point memory traffic at its own host. For `ragflow`, only `enabled: false` and `ground: false` count; `url`, `datasetIds` and the other keys are ignored. For `teach`, `enabled`, `recall` and `autoPromote` can only turn off, and `capture` can only go down (`auto` to `observe` to `explicit`); the other `teach` keys are ignored. The two user files merge every key as usual. See [`hindsight`](#hindsight-memory-server), [`ragflow`](#ragflow-document-search) and [`teach`](#teach-teachable-moments).

`bin/ultrathink status`, run from the project directory, prints the merged result for the parts most people change. See [Commands](commands.md#binultrathink) for its output.

## Key reference

Types: "integer" means a whole JSON number; "number" allows fractions. Ranges are inclusive.

### `uplift`: prompt uplift

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Plan prompts. When `false`, only prompts that start with `uplift:` are planned. `/ultrathink-off` and `/ultrathink-on` override this per host. |
| `skipTrivial` | boolean | `true` | Skip trivial acknowledgements such as `ok` or `lgtm`. |
| `maxChars` | number, >= 0 | `20000` | Prompts longer than this are not sent to the engine; they get the conservative fallback spec, and no rows are created. |
| `echo` | boolean | `true` | Accepted but not read. The one-line summary after each plan is controlled by `claude.echo`. |

### `think`: Graph of Thought

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Build the Graph of Thought. `bin/ultrathink think on\|off` overrides this per host. |
| `minNodes` | integer, >= 1 | `5` | Fewest graph nodes. Clamped to `maxNodes`. |
| `maxNodes` | integer, >= `minNodes` | `8` | Most graph nodes. Values above 8 are capped at 8. |
| `engine` | `"claude"` or `"grok"` | `"claude"` | Engine for the uplift, the graph, the per-node fills, the HITL questions and the ship judge. `bin/ultrathink grok engine grok\|claude` overrides this per host. |

Each node gets 4 to 8 numbered rationale steps. That range is fixed in code, not configurable. Each step becomes one sub-issue when tracking is on.

### `hitl`: clarifying questions

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Generate clarifying questions. `bin/ultrathink hitl on\|off` overrides this per host. |
| `maxQuestions` | integer, 1 to 4 | `4` | Most questions per prompt. |
| `knowledgeBase` | boolean | `false` | Opt-in. Before the clarifying questions, read the repository's Greptile knowledge base and let the clarifier settle questions it answers instead of asking them. Needs HITL on and a stored Greptile credential (`bin/ultrathink-mcp auth login greptile`, or `bin/ultrathink-mcp auth set-key greptile --stdin`). When `ship.greptileOrganization` is set, it is sent as the organization; an account in several organizations needs it. |

How the knowledge-base read works when `knowledgeBase` is `true` (see [Use the Greptile knowledge base](how-to/use-greptile-knowledge-base.md) for a walk-through):

- While the prompt is uplifted, ultrathink finds the repository's knowledge base on Greptile by the git remote's `owner/repo`, lists its documents and reads `index.md`.
- After the Graph of Thought, it picks up to 3 documents from the routing table in `index.md` that match the request and reads them. At most 24,000 characters go to the clarifier, marked as untrusted evidence, not instructions.
- Each stage has a 20-second budget. Any failure (no credential, no knowledge base for the repository, a Greptile error, a timeout) fails open: you get exactly the questions you would get with the key off.
- Only list and read calls go to Greptile's hosted MCP (`https://api.greptile.com/mcp`): the organization, the knowledge-base namespace id and document paths. Nothing from your prompt or your code is sent to Greptile. The documents read go to the planning engine inside the clarify call.
- Questions the knowledge base settled are not asked. They appear in their own `### Settled from the Greptile knowledge base` subsection of the Clarifications (HITL) block as `(Greptile knowledge base: <document>)`, marked as untrusted evidence the agent checks against the repository (asking you when the repository disagrees), not as your decisions, and in the spec's `CLARIFICATIONS` block as `<ANSWER source="knowledge" evidence="…">`. They are not carried to the next prompt. A claim that cites a document that was not read, or is otherwise invalid, is asked as an ordinary question. Product decisions are still asked.
- Each lookup is shown in the summary (`Knowledge · 3 docs · 1 settled`, `Knowledge · none`, `Knowledge · off (no Greptile login)` or `Knowledge · error`), in the session record's `knowledge` field, in a `## Greptile knowledge base` section of the plan context when documents were used, in the `ULTRATHINK_DEBUG=1` log as `greptile knowledge base: …`, and as a `kb` segment in the Omp status bar. `bin/ultrathink status` shows the `Knowledge base:` line. See [Troubleshooting](troubleshooting.md#greptile-knowledge-base) when it does not read what you expect.

### `claude`: the Claude engine

The Claude engine runs the `claude` CLI headless. It uses your existing Claude Code login.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `bin` | string | `"claude"` | The `claude` binary. |
| `model` | string | `"sonnet"` | Model alias or name for the planning calls. `""` uses the CLI's default model. |
| `thinking` | boolean | `false` | Allow extended thinking in the planning calls. Slower. When `false`, the child calls run with `MAX_THINKING_TOKENS=0`. |
| `settingSources` | string | `""` | Passed as `--setting-sources` to the planning calls. `""` loads none, which is fastest and keeps other hooks out of the child calls. |
| `callTimeoutMs` | number, >= 0 | `0` | Timeout for one planning call. `0` means no timer. |
| `budgetMs` | number, >= 0 | `0` | Budget for the whole planning pass. `0` means run until the host's hook timeout. |
| `concurrency` | number, > 0 | `3` | Node fills that run in parallel within one dependency level. Rounded down, at least 1. |
| `echo` | boolean | `true` | Show a one-line summary to the user after each plan. |

### `grok`: the Grok engine

Used only when `think.engine` is `"grok"` (or `bin/ultrathink grok engine grok` was run on that host). See [Choose an engine](how-to/choose-engine.md).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | When `false`, the Claude engine is used even if `think.engine` is `"grok"`. |
| `transport` | `"http"`, `"cli"` or `"shunt"` | `"http"` | `http`: POST `{baseUrl}/responses` with your `grok login` token. `cli`: run the `grok` binary. `shunt`: POST `{shuntBaseUrl}/v1/messages` on an Anthropic-compatible gateway that you run, with no auth. |
| `baseUrl` | string | `"https://cli-chat-proxy.grok.com/v1"` | Base URL for the `http` transport. Trailing slashes are removed. |
| `model` | string | `"grok-4.7"` | Model for `http` and `cli`, and for `shunt` when `shuntModel` is empty. |
| `reasoningEffort` | `"low"`, `"medium"`, `"high"` or `"xhigh"` | `"xhigh"` | Reasoning effort for `http` and `cli`. |
| `bin` | string | `"grok"` | The `grok` binary. |
| `home` | string | `""` | Grok home directory, used to find the `grok login` session. `""` means `$GROK_HOME`, else `~/.grok`. |
| `callTimeoutMs` | number, >= 0 | `0` | Timeout for one call. `0` means no timer; the host's hook timeout is the limit. |
| `fallbackToClaude` | boolean | `false` | When the Grok login is missing or expired (`http` and `cli` transports), plan with Claude instead. When `false`, the prompt is not planned and the hook reports ``Prompt Uplift skipped · Grok 4.7 login required (run `grok login`)``. |
| `shuntBaseUrl` | http(s) URL | `""` | Base URL of your gateway for `shunt`; `/v1/messages` is appended. There is no built-in gateway: with `transport: "shunt"` and this key empty, every engine call fails with an error that names `grok.shuntBaseUrl`. The prompt then gets the conservative fallback spec and no rows are created. Claude is not used instead: `fallbackToClaude` only applies to a missing Grok login. |
| `shuntModel` | string | `""` | Model name sent to the gateway. `""` sends `model`. |
| `shuntMaxTokens` | integer, > 0 | `8192` | `max_tokens` for `shunt` calls. |

The `http` and `cli` transports need `grok login`. `shunt` does not; the gateway owns the upstream credentials.

### `notion`: Notion tracking

| Key | Type | Default | Meaning |
|---|---|---|---|
| `dataSourceUrl` | string | `""` | The `collection://<data source id>` data source of the tracking database. `""` means Notion tracking is not configured and Notion is never contacted. See [Set up Notion](how-to/set-up-notion.md). |

### `linear`: Linear tracking

| Key | Type | Default | Meaning |
|---|---|---|---|
| `team` | string | `""` | The Linear team that issues and sub-issues are created in. `""` means Linear tracking is not configured and Linear is never contacted. See [Set up Linear](how-to/set-up-linear.md). |

### `track`: row creation by the planner

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | The planner creates the Linear and Notion rows before the agent sees the prompt. When `false`, the planner creates none and the `ultrathink-kickoff` skill creates them instead. On Hermes the planner never creates rows, whatever this says; kickoff creates them all. `/ultrathink-track off\|on` overrides this per host. Has no effect when neither tracker is configured. |
| `budgetMs` | number, > 0 | `60000` | Time limit for the planner's whole row-creation run, including credential lookup. Rows not created in time are left for kickoff. |
| `concurrency` | number, >= 1 | `6` | Row-creation calls that run in parallel. Rounded down. |

### `ship`: PR, review and merge

Ship is opt-in. With the defaults, no skill run ever pushes a branch, opens a pull request or merges. See [Ship](ship.md) for the flow and [Ship with Greptile](how-to/ship-with-greptile.md) for setup.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Tell the agent to run `ultrathink-ship` after a matching skill run: the plan gets a Ship section and the end-of-run nudge fires. `bin/ultrathink-ship` still works when you run it by hand with this off. |
| `autoMerge` | boolean | `false` | Allow `bin/ultrathink-ship merge`. When `false`, `merge` refuses (`autoMerge disabled`) and `run` stops once the PR is ready, with `next: "autoMerge disabled: merge manually"`. When `true` and `judge` is `"gate"`, the done assessment also requires an engine judge. |
| `judge` | `"gate"` or `"advisory"` | `"gate"` | What the LLM done judge decides. `"gate"`: the judge must say done with a confidence of at least 0.7 before `pr` opens a PR. `"advisory"`: only the deterministic rules gate `done`; the judge's verdict is recorded in the assessment and shown in the PR body, and a failed or missing judge never blocks. Either way the merge gate below is unchanged. See [Done assessment](ship.md#done-assessment). |
| `skills` | array of non-empty strings | `["gsd-"]` | Skill name prefixes that trigger ship. `[]` matches every skill run, and every planned prompt gets the ship instruction. |
| `minScore` | number, 1 to 5 | `5` | Lowest Greptile confidence score that may merge. 5 is Greptile's maximum ("5/5"). |
| `requireNoComments` | boolean | `true` | Refuse to merge while the head review has open comments. |
| `maxRounds` | number, >= 1 | `5` | Completed Greptile reviews below `minScore` or with open threads before the ship is blocked. Failed and timed-out reviews don't count (see `reviewRetries`). Rounded down. |
| `mergeMethod` | `"squash"`, `"merge"` or `"rebase"` | `"squash"` | Merge method. When the repository does not allow it, the first allowed method is used and the output says so. |
| `deleteBranch` | boolean | `false` | After the merge, delete the remote branch, check out and fast-forward the base branch, then delete the local branch. When `false`, branches are left alone. |
| `greptileOrganization` | string | `""` | Greptile organization id or handle, passed as `organization` on every Greptile MCP call. `""` lets Greptile pick, which works for accounts in one organization. An account in several organizations needs it: without it, the review is `blocked` with a reason that names this key and the candidates. |
| `reviewTimeoutMs` | number, >= 1 | `1200000` | How long a review of one head commit may stay pending before it counts as timed out (20 minutes). A timed-out review is re-triggered like a failed one (see `reviewRetries`). Rounded down. |
| `reviewRetries` | integer, >= 0 | `3` | A failed Greptile review (Greptile FAILED/ERROR/SKIPPED, no score, CLI failure) or one pending past `reviewTimeoutMs` is re-triggered on the next `review` call, up to this many times per head commit; then the ship blocks with a PR comment. These never count toward `maxRounds`. `0` blocks on the first failure. Rounded down. |
| `pollMs` | number, >= 1 | `20000` | First interval between review and merge status checks. It grows by 1.5 times per check, up to 60 seconds. Rounded down. |
| `waitMs` | number, >= 1 | `100000` | Longest one `review` or `merge` call blocks before it returns `pending` or `waiting: true` (100 seconds). `run` merges within what is left of its own `waitMs` after the review. Rounded down. |
| `mergeTimeoutMs` | integer, >= 1 (ms) | `3600000` | After the head's review passed, `merge` keeps retrying (pending CI, mergeability not computed, unreadable PR state or threads, transient GitHub errors) within each call up to `waitMs`, returning `waiting: true` and `next: "run merge again: …"` when the call's time runs out; the agent runs `merge` again. Past `mergeTimeoutMs` (60 minutes) on one head commit, or on a terminal GitHub refusal (missing permission, requested changes, a closed PR; a branch-protection hold such as a missing approval is retried until the bound instead), the ship blocks and the PR comment lists the attempt history. Conflicts, failing CI, a moved head or a review below 5/5 go back to the agent (`next`), never merge. Rounded down. |

`ULTRATHINK_SHIP=0` turns the ship instruction and nudge off for one process whatever `ship.enabled` says.

The merge gate never weakens, and `judge: "advisory"` does not change it: a completed Greptile review of the exact PR head with a score of at least `minScore` (default 5, Greptile's maximum) and no open threads, an open mergeable PR, and CI neither pending nor failing. A PR merged outside the flow without such a review is reported blocked, never recorded as a ship merge; agents must never merge any other way (no `gh pr merge`, no web UI). Every review result and merge outcome is recorded in `ship.attempts` in the session record (newest 50), shown by `bin/ultrathink-ship status`.

### `substrate`: Agent Substrate brief

Agent Substrate is an optional service that tells the planner what other agents already did in the repository. ultrathink asks it for a brief before it builds the Graph of Thought, and adds the answer to the plan under `## Agent Substrate brief`. Nothing is requested unless a URL is set.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `url` | http(s) URL | `""` | Base URL of your Agent Substrate server. ultrathink sends `POST <url>/brief` with the repository (`owner/repo`), the branch and the host name. `""` means the service is never contacted. `SUBSTRATE_URL` wins over this key, and `SUBSTRATE_DISABLED=1` turns both off. |

The request times out after 1.5 seconds (`SUBSTRATE_TIMEOUT_MS` changes that). A missing, slow or failing server never blocks a prompt: the plan is built without the brief. `bin/ultrathink status` shows the `Substrate:` line with the URL in use and where it came from.

### `decisions`: Jev decisions (OpenRouter Decisions API)

Decisions are opt-in. With `enabled: true` and an OpenRouter key, ultrathink asks Jev, a decision model from TypeSafe served through OpenRouter's Decisions API (`https://openrouter.ai/api/alpha/decisions`, marked alpha by OpenRouter), one yes/no question at each active decision point. Jev answers with a probability P, and the thresholds below turn P into an action. Jev is asked only after every deterministic rule has run and left the action open, and it never merges, never demotes a blocking question and never overrides a rule gap. Any failure fails open: the point behaves exactly as it does with Decisions off. See [Use Jev decisions](how-to/use-jev-decisions.md) for a walk-through and [What leaves your machine](privacy.md#jev-decisions-openrouter) for what is sent.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Opt-in master switch. When `false`, no point sends a request and nothing is recorded. Only a user file can set it to `true`: in the project file only `false` counts. `ULTRATHINK_DECISIONS=0` in the environment turns every point off whatever this says. |
| `model` | non-empty string | `"~typesafe/jev-latest"` | Decisions model id or alias. The alias follows OpenRouter's latest Jev; set `"typesafe/jev-1.13"` to pin the version the default thresholds were probed on. Every decision records the resolved model, for example `typesafe/jev-1.13-20260917`. |
| `points` | array of `"plan"`, `"ship"`, `"knowledge"`, `"blocking"`, `"teachable"`, `"skillworthy"` | `["plan", "ship", "knowledge", "blocking", "teachable", "skillworthy"]` | Which decision points ask Jev. Unknown names and repeats are dropped; `[]` means none. The project file can only remove points: its list is intersected with the one from the earlier files. |
| `timeoutMs` | number, > 0 and <= 30000 | `3000` | Total budget for one decision in milliseconds, the retry included. |
| `zdr` | boolean | `true` | Send `provider: {"zdr": true, "data_collection": "deny"}`, so OpenRouter routes only to zero-data-retention endpoints and denies data collection. `false` sends no provider preferences. In the project file only `true` counts. |
| `planSkipBelow` | number, 0 to 1 | `0.2` | Plan gate: a message is not planned when P(`plan_worthy`) is below this. |
| `shipVetoAtOrBelow` | number, 0 to 1 | `0.2` | Ship veto: in gate mode, an LLM "done" becomes not done when P(`complete`) is at or below this and the patch Jev saw was not truncated. In advisory mode nothing is blocked: a P(`complete`) at or below this on an untruncated patch is recorded as `advise-veto`, whatever the judge said. |
| `shipApproveAt` | number, 0 to 1 | `0.7` | Ship verdict when there is no usable LLM verdict (gate mode with `ship.autoMerge` off): done when P(`complete`) is at or above this, not done below it. With `ship.autoMerge` on, Jev never stands in for the LLM judge. |
| `groundedAt` | number, 0 to 1 | `0.8` | Knowledge check: a question the Greptile knowledge base settled stays settled when P(`supported`) is at or above this; below it, the question is asked after the clarifier's own questions while fewer than `hitl.maxQuestions` are open, and dropped when no slot is left. |
| `blockingAt` | number, 0 to 1 | `0.5` | Blocking check: a non-blocking question becomes blocking when P(`risky`) is at or above this. A blocking question is never made non-blocking. |
| `teachableBelow` | number, 0 to 1 | `0.3` | Teachable lesson: a candidate is dropped before it is stored when P(`teachable`) is below this. P equal to this keeps it. |
| `teachableAutoAt` | number, 0 to 1 | `0.8` | Auto capture confirms a candidate only when P(`teachable`) is at or above this, and only when the candidate's own confidence is also at least 0.8. Below this, the candidate stays for a human to confirm. Jev never confirms a lesson the confidence bar would have held. |
| `skillworthyAt` | number, 0 to 1 | `0.5` | `promote --due` and automatic promotion skip a lesson when P(`skillworthy`) is below this. An explicit `teach promote <id>` does not ask this point. |

How Decisions work when `enabled` is `true`:

- `ULTRATHINK_DECISIONS=0` in the environment turns every point off for that process, whatever the config says: no request, no record, no plan-skip notice and no `Decisions ·` segment. `bin/ultrathink status` then shows `Decisions: off (ULTRATHINK_DECISIONS=0)`.
- Only your own config turns Decisions on. The project file can turn them off, drop points, set `zdr` to `true`, and change `model`, `timeoutMs` and the thresholds, but it cannot turn them on, add points or turn `zdr` off. A repository you open therefore never sends your prompt, patch or knowledge-base text to OpenRouter unless you enabled Jev in your own config.
- The key comes from the credential store (`bin/ultrathink-mcp auth set-key openrouter --stdin`), else from `OPENROUTER_API_KEY`. The stored key wins. Without either, no point sends a request, and `bin/ultrathink status` says so.
- There is no config key for the endpoint. Any other key under `decisions` (a `url` or `endpoint`, for example) is ignored, so a project file cannot send your OpenRouter key anywhere else. Only `ULTRATHINK_DECISIONS_URL` in the environment changes the endpoint, and only to an `https://openrouter.ai/…` URL or a loopback URL (see [Environment variables](#environment-variables)). A request never follows an HTTP redirect.
- `teachable` asks "Is this candidate a reusable lesson that a future agent on this repository would otherwise have to rediscover?" It runs when `observe` distills candidates and Decisions are on. Below `teachableBelow` the candidate is not stored. In `auto` capture, confirmation also needs P at or above `teachableAutoAt`. `skillworthy` asks "Does this lesson describe a repeatable procedure or rule worth a standing skill?" `promote --due` and automatic promotion leave a moment out when P is below `skillworthyAt`. Any failure of either point behaves as with that point off: the candidate is kept, and auto confirmation follows the confidence bar alone.
- The other four points: `plan` can skip planning for a message the rules would plan; `ship` can veto an LLM "done", or decide when there is no usable LLM verdict and `ship.autoMerge` is off; `knowledge` can take back a question the knowledge base settled, which is then asked if a question slot is free; `blocking` can make a non-blocking question blocking. A skill invocation (every `/gsd-*` run included) and a message that starts with `uplift:` make no `plan` decision, but their clarifying questions can still get `knowledge` and `blocking` decisions, and each ship `assess` whose rule checks pass makes one `ship` decision, GSD runs included. A message the deterministic rules skip makes none.
- The six questions, as sent (`type: "noul"`): `plan` asks whether `message`, read with `recent_conversation`, starts new multi-step engineering work; `ship` asks whether `patch` fully delivers `request` and every item in `acceptance_criteria`; `knowledge` asks whether `answer` is a correct answer to `question` according to `document`; `blocking` asks whether a wrong `default` for `question` while doing `task` would cause damage that is hard to undo; `teachable` and `skillworthy` are the two sentences above.
- One decision makes at most one retry, only for a network error or HTTP 408, 429, 500, 502, 503, 524 or 529, and only when at least 500 ms of `timeoutMs` remain. It honours `Retry-After` when that fits the budget.
- A request whose estimated size is over 28 000 tokens is not sent; it fails locally as `too-large`.
- Each decision is recorded without any of the state it was asked about: point, resolved model, probability, threshold, action, latency, attempts, cost and error kind. You see it in the summary (`Decisions · plan 0.97`, with `claude.echo` on), the plan-skip notice, the session record's `decisions` field, the ship assessment's `decision`, the pull request's `- Jev:` line and, with `ULTRATHINK_DEBUG=1`, one stderr line per decision. `bin/ultrathink status` shows the `Decisions:` line.

The default thresholds were set from probes on `typesafe/jev-1.13-20260917`. Tune them on your own cases with `bin/ultrathink decisions probe` (see [Commands](commands.md#binultrathink-decisions)).

### `hindsight`: Hindsight memory server

Hindsight is opt-in storage for confirmed Teachable Moments. With the defaults, nothing is contacted. See [Connect Hindsight](how-to/connect-hindsight.md) (`docs/how-to/connect-hindsight.md`).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Opt-in. When `false`, no request is made. Only a user file can set it to `true`: in the project file only `false` counts. `ULTRATHINK_HINDSIGHT=0` (the exact string) turns it off whatever this says, and is checked before `enabled`. |
| `url` | string | `""` | Base URL of the Hindsight API. User files only. Empty falls back to `HINDSIGHT_API_URL`. An empty string does not clear a URL an earlier file set. A value is kept as written; a bad one is reported on the status line, not silently dropped. |
| `bank` | string | `"ultrathink"` | Bank that holds ultrathink's records. User files only. Must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; anything else is ignored and the earlier value stays. |
| `timeoutMs` | integer, 1 to 120000 | `5000` | Budget in milliseconds for health, bank, document and recall requests. |
| `retainTimeoutMs` | integer, 1 to 120000 | `15000` | Budget in milliseconds for one retain. |

The key is not a config key. It comes from the credential store, provider `hindsight` (`bin/ultrathink-mcp auth set-key hindsight --stdin`), else `HINDSIGHT_API_KEY`, else `HINDSIGHT_API_TOKEN`. The stored key wins. `hindsight` is an API-key provider, not an MCP server: `serve`, `check` and `auth login` refuse it and name `auth set-key hindsight --stdin`.

A URL is accepted only as `https`, or as `http` on `localhost`, `127.0.0.1`, `[::1]`, a name ending in `.ts.net`, or an address in `100.64.0.0/10`. A user name, password, query or fragment is refused. The status line shows the origin only, never a path and never the key. The key is sent only on `/v1/**`, and only to a URL that passed that check. A request never follows a redirect.

The client keeps the bank in `chunks` extraction mode (`retain_extraction_mode: chunks`). That stores lesson text as written and does not call a server-side LLM. Do not switch the bank to another mode, and do not enable verbatim or reflect: a server with no LLM cannot retain in those modes, and the client sets `chunks` itself on `ensureBank`.

`bin/ultrathink status` prints a line that starts with `Hindsight: `:

- `Hindsight: off (ULTRATHINK_HINDSIGHT=0)`
- `Hindsight: off (opt-in: set hindsight.enabled)`
- `Hindsight: on · no URL (set hindsight.url or HINDSIGHT_API_URL)`
- `Hindsight: on · bad URL (<reason>)`
- `Hindsight: on · no key (run bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY)`
- `Hindsight: on · <origin> · bank <bank> · key from <store|HINDSIGHT_API_KEY|HINDSIGHT_API_TOKEN>`

The no-key line names `HINDSIGHT_API_KEY`. `HINDSIGHT_API_TOKEN` is also accepted, after the stored key and `HINDSIGHT_API_KEY`, and the ready line then says `key from HINDSIGHT_API_TOKEN`.

### `ragflow`: RAGFlow document search

RAGFlow is opt-in. With the defaults, nothing is contacted. When `ground` is on and the service is ready, excerpts from the configured datasets are added to the plan as untrusted evidence, bounded by `groundChars`, fail-open, and recorded on the session. The section starts with `## Documents (RAGFlow)`. See [Connect RAGFlow](how-to/connect-ragflow.md) (`docs/how-to/connect-ragflow.md`).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Opt-in. When `false`, no request is made. Only a user file can set it to `true`: in the project file only `false` counts. `ULTRATHINK_RAGFLOW=0` (after trim) turns it off whatever this says, and is checked before `enabled`. |
| `url` | string | `""` | Base URL of the RAGFlow origin. User files only. Empty falls back to `RAGFLOW_URL`. An empty string does not clear a URL an earlier file set. A bad URL is kept as written and reported, not silently dropped. |
| `datasetIds` | array of non-empty strings, at most 20 | `[]` | Datasets to search. User files only. Empty means every dataset the key can see. Every element must be a non-empty string, or the whole array is ignored. Duplicates are dropped. |
| `topK` | integer, 1 to 20 | `5` | Chunks returned per search (`page_size`). |
| `similarityThreshold` | number, 0 to 1 | `0.2` | RAGFlow `similarity_threshold`. |
| `timeoutMs` | integer, 1 to 120000 | `8000` | Budget in milliseconds for one request. |
| `ground` | boolean | `false` | Add retrieved excerpts to the planner's context. A project file can only turn this off. Off means no request, even when `enabled` is true. |
| `groundChars` | integer, 500 to 8000 | `3000` | Cap on the characters of excerpts added to the planner's context. |

The key is not a config key. It comes from the credential store, provider `ragflow` (`bin/ultrathink-mcp auth set-key ragflow --stdin`), else `RAGFLOW_API_KEY`. The stored key wins. `ragflow` is an API-key provider, not an MCP server: `serve`, `check` and `auth login` refuse it and name `auth set-key ragflow --stdin`.

The URL rules are the same as [`hindsight`](#hindsight-memory-server): `https`, or `http` only for loopback, `*.ts.net` and `100.64.0.0/10`, with no user name, password, query or fragment. The status line shows the origin only.

Health is a one-row dataset listing, `GET /api/v1/datasets?page=1&page_size=1`. Never request `/system/healthz`, `/v1/system/healthz` or `/api/v1/system/healthz`: on a deployment whose object storage is down, that route can block the API worker. `bin/ultrathink ragflow check` uses the datasets probe. The CLI ignores `ragflow.ground`, so the connection can be proven before grounding is turned on.

`bin/ultrathink status` prints a line that starts with `RAGFlow: `:

- `RAGFlow: off (ULTRATHINK_RAGFLOW=0)`
- `RAGFlow: off (opt-in: set ragflow.enabled)`
- `RAGFlow: on · no URL (set ragflow.url or RAGFLOW_URL)`
- `RAGFlow: on · bad URL (<reason>)`
- `RAGFlow: on · no key (run bin/ultrathink-mcp auth set-key ragflow --stdin, or set RAGFLOW_API_KEY)`
- `RAGFlow: on · <origin> · key from <store|RAGFLOW_API_KEY> · grounding on|off · <n> dataset(s) pinned` when `datasetIds` is non-empty, or `· all datasets` when it is empty

### `teach`: Teachable Moments

Teachable Moments are opt-in. With `enabled: false`, nothing is stored and nothing is recalled. See [Use Teachable Moments](how-to/use-teachable-moments.md) (`docs/how-to/use-teachable-moments.md`) and, on Hermes, [Teachable Moments on Hermes](how-to/teachable-moments-on-hermes.md) (`docs/how-to/teachable-moments-on-hermes.md`).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Opt-in master switch. Only a user file can set it to `true`: in the project file only `false` counts. `ULTRATHINK_TEACH=0` (the exact string) turns it off for the process when this is `true`. |
| `capture` | `"explicit"`, `"observe"` or `"auto"` | `"explicit"` | `explicit`: only `teach capture` (CLI, agent tool or slash command) creates moments. `observe`: hosts also hand finished turns to a detached `teach observe`, which stores local candidates. `auto`: a candidate whose confidence is at least 0.8 is confirmed and retained without a human step, unless Jev holds it (see `teachableAutoAt`). A project file can only lower the mode (`auto` to `observe` to `explicit`). |
| `recall` | boolean | `true` | Inject recalled lessons into plans. Does nothing while `enabled` is false. A project file can only turn it off. The section starts with `## Lessons from earlier work` and is framed as untrusted evidence. |
| `recallLimit` | integer, 1 to 10 | `5` | Lessons per plan. |
| `recallChars` | integer, 500 to 8000 | `3000` | Cap on the characters of the lessons section. |
| `promoteAfter` | integer, 2 to 20 | `3` | Occurrences before a confirmed moment is offered as a skill. A confirmed `playbook` is offered without waiting for this count. |
| `autoPromote` | boolean | `false` | Install a due moment for the host that captured it, without a human step. User files only; a project file can only turn it off. Hermes and unknown hosts still only get a draft. Off is report-only: `teach promote --due` lists them. |
| `observeMinToolCalls` | integer, 0 to 50 | `4` | `observe` skips a turn with fewer tool calls than this. |
| `timeoutMs` | integer, 500 to 30000 | `2500` | Budget in milliseconds for the recall inside the planner. |

`ULTRATHINK_TEACH=0` is checked after `enabled`. While `enabled` is false the status line says `Teach: off (opt-in: set teach.enabled)` even if the variable is set. When `enabled` is true and the variable is `0`, the line is `Teach: off (ULTRATHINK_TEACH=0)`.

Lessons are written under the host state directory, `<stateDir>/teach/`: one JSON file per moment in `moments/`, pending Hindsight writes in `outbox/`, observe digests in `inbox/`, and skill drafts in `skill-drafts/<name>/SKILL.md`. `ULTRATHINK_STATE_DIR` is honored, and a path inside `.planning` is ignored. Nothing is written into `<cwd>/.planning` or a repository working tree. A Hindsight failure queues an outbox entry (backoff 1 minute, doubling, capped at 6 hours) and does not block the caller. `teach sync` drains the outbox.

Before anything is stored or sent, text is redacted. `Bearer` followed by a short English word is left alone (`the Bearer key`, `Bearer token rotation`). `Bearer` followed by a token is replaced with `[redacted]` when the token is at least 16 characters, or at least 6 characters and contains a digit. Trailing dots stay. See [Troubleshooting](troubleshooting.md#redaction).

`bin/ultrathink status` prints a line that starts with `Teach: `:

- `Teach: off (opt-in: set teach.enabled)`
- `Teach: off (ULTRATHINK_TEACH=0)`
- `Teach: on · capture <explicit|observe|auto> · recall on|off · <n> confirmed, <m> candidate · Hindsight <ready|off|no URL|bad URL|no key> · outbox <k>`

The confirmed/candidate counts and the outbox count are included when the status command knows the state directory, which `bin/ultrathink status` does. `Hindsight` here is the readiness word, not the `Hindsight:` line.

## Full example

All keys are optional; write only the ones you change. This file shows every key. The values are the defaults, with these exceptions:

- `notion.dataSourceUrl` and `linear.team` hold placeholders. Replace them with your own values, or leave them `""` to keep tracking unconfigured.
- `grok.shuntBaseUrl`, `grok.shuntModel` and `substrate.url` are `""`, which is the default and means off. Set them only if you run those services.
- `ship.enabled`, `ship.autoMerge`, `ship.deleteBranch`, `hitl.knowledgeBase`, `decisions.enabled`, `hindsight.enabled`, `ragflow.enabled`, `ragflow.ground`, `teach.enabled` and `teach.autoPromote` are `false`, the opt-in defaults. `hindsight.url` and `ragflow.url` are `""`, which means those services are not contacted.

```json
{
  "uplift": { "enabled": true, "skipTrivial": true, "maxChars": 20000, "echo": true },
  "think": { "enabled": true, "minNodes": 5, "maxNodes": 8, "engine": "claude" },
  "hitl": { "enabled": true, "maxQuestions": 4, "knowledgeBase": false },
  "claude": {
    "bin": "claude",
    "model": "sonnet",
    "thinking": false,
    "settingSources": "",
    "callTimeoutMs": 0,
    "budgetMs": 0,
    "concurrency": 3,
    "echo": true
  },
  "grok": {
    "enabled": true,
    "transport": "http",
    "baseUrl": "https://cli-chat-proxy.grok.com/v1",
    "model": "grok-4.7",
    "reasoningEffort": "xhigh",
    "bin": "grok",
    "home": "",
    "callTimeoutMs": 0,
    "fallbackToClaude": false,
    "shuntBaseUrl": "",
    "shuntModel": "",
    "shuntMaxTokens": 8192
  },
  "notion": { "dataSourceUrl": "collection://<data source id>" },
  "linear": { "team": "<your Linear team>" },
  "track": { "enabled": true, "budgetMs": 60000, "concurrency": 6 },
  "ship": {
    "enabled": false,
    "autoMerge": false,
    "judge": "gate",
    "skills": ["gsd-"],
    "minScore": 5,
    "requireNoComments": true,
    "maxRounds": 5,
    "mergeMethod": "squash",
    "deleteBranch": false,
    "greptileOrganization": "",
    "reviewTimeoutMs": 1200000,
    "reviewRetries": 3,
    "pollMs": 20000,
    "waitMs": 100000,
    "mergeTimeoutMs": 3600000
  },
  "substrate": { "url": "" },
  "decisions": {
    "enabled": false,
    "model": "~typesafe/jev-latest",
    "points": ["plan", "ship", "knowledge", "blocking", "teachable", "skillworthy"],
    "timeoutMs": 3000,
    "zdr": true,
    "planSkipBelow": 0.2,
    "shipVetoAtOrBelow": 0.2,
    "shipApproveAt": 0.7,
    "groundedAt": 0.8,
    "blockingAt": 0.5,
    "teachableBelow": 0.3,
    "teachableAutoAt": 0.8,
    "skillworthyAt": 0.5
  },
  "hindsight": {
    "enabled": false,
    "url": "",
    "bank": "ultrathink",
    "timeoutMs": 5000,
    "retainTimeoutMs": 15000
  },
  "ragflow": {
    "enabled": false,
    "url": "",
    "datasetIds": [],
    "topK": 5,
    "similarityThreshold": 0.2,
    "timeoutMs": 8000,
    "ground": false,
    "groundChars": 3000
  },
  "teach": {
    "enabled": false,
    "capture": "explicit",
    "recall": true,
    "recallLimit": 5,
    "recallChars": 3000,
    "promoteAfter": 3,
    "autoPromote": false,
    "observeMinToolCalls": 4,
    "timeoutMs": 2500
  }
}
```

Optional integrations, one small file each:

Plan with Grok through an Anthropic-compatible gateway you run:

```json
{
  "think": { "engine": "grok" },
  "grok": { "transport": "shunt", "shuntBaseUrl": "https://<your gateway host>", "shuntModel": "<model name your gateway expects>" }
}
```

Turn ship on, with merging and branch cleanup (all three are off by default):

```json
{ "ship": { "enabled": true, "autoMerge": true, "deleteBranch": true, "greptileOrganization": "<your Greptile organization>" } }
```

Ask an Agent Substrate server for a brief before each plan:

```json
{ "substrate": { "url": "https://<your substrate host>" } }
```

Read the repository's Greptile knowledge base before the clarifying questions. Store a Greptile credential first with `bin/ultrathink-mcp auth login greptile` (or `bin/ultrathink-mcp auth set-key greptile --stdin`); set `ship.greptileOrganization` only if your Greptile account is in several organizations:

```json
{ "hitl": { "knowledgeBase": true }, "ship": { "greptileOrganization": "<your Greptile organization>" } }
```

Ask Jev at the six decision points. Put this in a user file such as `~/.config/ultrathink/config.json`: the project file cannot turn Jev on. Store an OpenRouter key first with `bin/ultrathink-mcp auth set-key openrouter --stdin` (or set `OPENROUTER_API_KEY`); `"model": "typesafe/jev-1.13"` pins the version the default thresholds were probed on:

```json
{ "decisions": { "enabled": true, "model": "typesafe/jev-1.13" } }
```

Store confirmed lessons in Hindsight. Put `url` and `bank` in a user file; the project file cannot set them. Store the key with `bin/ultrathink-mcp auth set-key hindsight --stdin` (or set `HINDSIGHT_API_KEY`). Do not put a production URL in a repository file. See [Connect Hindsight](how-to/connect-hindsight.md) (`docs/how-to/connect-hindsight.md`):

```json
{ "hindsight": { "enabled": true, "url": "https://<your hindsight host>", "bank": "ultrathink" }, "teach": { "enabled": true } }
```

Ground plans with RAGFlow excerpts. `ground` sends the prompt to RAGFlow, so only a user file can turn it on. Store the key with `bin/ultrathink-mcp auth set-key ragflow --stdin` (or set `RAGFLOW_API_KEY`). See [Connect RAGFlow](how-to/connect-ragflow.md) (`docs/how-to/connect-ragflow.md`):

```json
{ "ragflow": { "enabled": true, "url": "https://<your ragflow host>", "ground": true } }
```

## Environment variables

Every variable ultrathink reads, grouped by who sets it. Variables that expect `1` or `0` compare the exact string: `ULTRATHINK_SHIP=false` does nothing.

### Variables you may set

| Variable | Effect |
|---|---|
| `ULTRATHINK_UPLIFT=0` | Do not plan any prompt in this process. The `uplift:` prefix does not override it. Useful for automation and `claude -p` runs. |
| `ULTRATHINK_TRACK=0` | The planner creates no rows in this process. The `ultrathink-kickoff` skill still creates them through `track complete`. To stop all rows, use `/ultrathink-track off`. |
| `ULTRATHINK_SHIP=0` | No ship instruction in the plan and no ship nudge at the end of a run, even with `ship.enabled: true`. `bin/ultrathink-ship` still works when you run it yourself. |
| `ULTRATHINK_DECISIONS=0` | No Jev decision at any point in this process, even with `decisions.enabled: true`: no request to OpenRouter, no decision record, no plan-skip notice and no `Decisions ·` summary segment. It is checked before `decisions.enabled`: `bin/ultrathink status` shows `Decisions: off (ULTRATHINK_DECISIONS=0)`, and `bin/ultrathink decisions check` and `decisions probe` print `Decisions check: off (ULTRATHINK_DECISIONS=0)` or `Decisions probe: off (ULTRATHINK_DECISIONS=0)` and exit 1 without a request. |
| `ULTRATHINK_HOST` | Which host's state directory to use: `claude-code`, `grok-build`, `hermes`, `muse` or `omp`. Any other value is ignored. Without it the host is detected from its environment, and Claude Code is the fallback. Set it for `bin/ultrathink` to change another host's control state, for example `ULTRATHINK_HOST=omp bin/ultrathink off`. The Grok hook file, the Muse hook wrappers, the Hermes plugin and the Omp extension set it for their own processes. |
| `ULTRATHINK_STATE_DIR` | Use this directory instead of the host's state directory. Give an absolute path: a relative one is resolved against the session's working directory on Claude Code, Grok Build, Muse and Omp, but against the ultrathink checkout on Hermes. It is ignored when the path is inside a `.planning` directory. Teachable Moments state is `<this directory>/teach/`, never `<cwd>/.planning`. The Hermes plugin sets it for its own control commands. |
| `ULTRATHINK_HINDSIGHT=0` | No Hindsight request in this process, even with `hindsight.enabled: true`. The exact string `0`. `bin/ultrathink status` shows `Hindsight: off (ULTRATHINK_HINDSIGHT=0)`, and `bin/ultrathink hindsight check` exits 1 without a request. |
| `ULTRATHINK_RAGFLOW=0` | No RAGFlow request in this process, even with `ragflow.enabled: true`. Whitespace around `0` is trimmed. `bin/ultrathink status` shows `RAGFlow: off (ULTRATHINK_RAGFLOW=0)`, and `bin/ultrathink ragflow` exits 1 without a request. |
| `ULTRATHINK_TEACH=0` | Teachable Moments off for this process when `teach.enabled` is true: no capture, no recall, no promote. The exact string `0`. While `teach.enabled` is false the status line still says `Teach: off (opt-in: set teach.enabled)`. When enabled, it says `Teach: off (ULTRATHINK_TEACH=0)`. Mutating `teach` subcommands exit 1. |
| `HINDSIGHT_API_URL` | Hindsight base URL, used only when `hindsight.url` is empty. Same URL rules as `hindsight.url`. |
| `HINDSIGHT_API_KEY` | Hindsight API key, used when no `hindsight` key is stored. The stored key wins. The status line names this variable when the key is missing. |
| `HINDSIGHT_API_TOKEN` | Hindsight API key, used only when no `hindsight` key is stored and `HINDSIGHT_API_KEY` is empty. The ready status line then says `key from HINDSIGHT_API_TOKEN`. |
| `RAGFLOW_URL` | RAGFlow base URL, used only when `ragflow.url` is empty. Same URL rules as `ragflow.url`. |
| `RAGFLOW_API_KEY` | RAGFlow API key, used when no `ragflow` key is stored. The stored key wins. The status line names this variable when the key is missing. |
| `ULTRATHINK_MCP_STORE` | Path of the credential store. Default `~/.config/ultrathink/mcp-credentials.json` (under `$XDG_CONFIG_HOME` when set). |
| `ULTRATHINK_OAUTH_REDIRECT` | OAuth callback URL for `bin/ultrathink-mcp auth login`. Must be https, or http on `127.0.0.1`, `localhost` or `[::1]`. The `--redirect` flag wins over it. |
| `ULTRATHINK_OAUTH_TAILSCALE=1` | Same as `auth login --tailscale`: on a remote (SSH) session, receive the OAuth callback through `tailscale serve`. Without it, ultrathink never runs `tailscale`. Only the exact value `1` opts in. See [Commands](commands.md#binultrathink-mcp). |
| `ULTRATHINK_DEBUG=1` | The prompt hook (`hooks/uplift.ts`, used by Claude Code, Grok Build and Muse) writes `[ultrathink]` log lines to stderr. With Decisions on, every process that asks Jev (the prompt hook, the Hermes and Omp engine, `bin/ultrathink-ship`) also writes one `[ultrathink] decisions …` line per decision: the point, P or the error kind, the model, latency, attempts and cost. Never the message, the state or the key. |
| `ULTRATHINK_MCP_DEBUG=1` | `bin/ultrathink-mcp serve` writes relay log lines to stderr. |
| `ULTRATHINK_HERMES_TIMEOUT` | Hermes only. Longest time in seconds the Hermes plugin lets one plan run. A positive integer; anything else means the default, `540`. The plugin stops the plan at min(this, cap − 15) seconds, where the cap is Hermes' `plugins.hook_callback_timeout`, and does not start planning when that leaves less than 90 seconds. See the note below the table. |
| `SUBSTRATE_URL` | Agent Substrate base URL. Wins over `substrate.url`. |
| `SUBSTRATE_TOKEN` | Sent as `Authorization: Bearer <token>` on Agent Substrate requests. |
| `SUBSTRATE_TIMEOUT_MS` | Timeout for one Agent Substrate request, in milliseconds. A positive number; default `1500`. |
| `SUBSTRATE_DISABLED=1` | Never contact Agent Substrate, even when `SUBSTRATE_URL` or `substrate.url` is set. |
| `GSD_TOOLS` | Path of `gsd-tools.cjs`, which the ship assessment runs to read a GSD roadmap. See [GSD tools lookup](#gsd-tools-lookup). |
| `BUN` | Path of the `bun` binary. See [Finding Bun](#finding-bun). |
| `OPENROUTER_API_KEY` | OpenRouter API key for Jev decisions, used only when no `openrouter` key is stored with `bin/ultrathink-mcp auth set-key openrouter`. The stored key wins. Empty or whitespace-only counts as unset. `bin/ultrathink status` shows `key from OPENROUTER_API_KEY` when it is the one in use, never the key. |
| `ULTRATHINK_DECISIONS_URL` | Replaces the Decisions endpoint (`https://openrouter.ai/api/alpha/decisions`), for a local proxy or a test server. It is accepted only as an `https://` URL on `openrouter.ai`, or an `http://` or `https://` URL on `localhost`, `127.0.0.1` or `[::1]`, and never with a user name or password in it; any other value is ignored and the default endpoint is used. Only its origin and path are used and printed: a query or fragment is dropped. Environment only: there is no config key for it, so a project file cannot redirect your OpenRouter key. When it is in effect, the `Decisions:` status line (when Decisions are on with a key) and the `decisions check` line end with ` · url <origin and path>`; when it is set but ignored, they end with ` · ULTRATHINK_DECISIONS_URL ignored (must be https://openrouter.ai/… or a loopback URL)`. |

About the Hermes hook cap: Hermes abandons a plugin hook that runs longer than its `plugins.hook_callback_timeout` (30 seconds unless you change it). A plan needs at least 90 seconds, so the cap must be at least 105 seconds; 600 is recommended. It is a global Hermes setting that affects every plugin, and nothing in ultrathink changes it. Set it yourself:

```sh
hermes config set plugins.hook_callback_timeout 600
```

The plugin asks Hermes for the cap it enforces. When that Hermes does not report it, the plugin reads `plugins.hook_callback_timeout` from the active Hermes profile's `config.yaml`, else assumes 30 seconds, and logs one warning naming the command above. That file is `$HERMES_HOME/config.yaml` (`~/.hermes/config.yaml` when `HERMES_HOME` is unset), or `<Hermes home>/profiles/<name>/config.yaml` when `active_profile` names a profile other than `default` or `HERMES_HOME` points at a profile directory.

#### GSD tools lookup

GSD (Get Shit Done) is a planning workflow that keeps a roadmap in `.planning/ROADMAP.md`. When a repository has one, `bin/ultrathink-ship assess` runs `gsd-tools.cjs` with `node` to read it, so Node.js must be on `PATH`. It looks for `gsd-tools.cjs` in this order, and the first match wins:

1. `$GSD_TOOLS`, when set.
2. `<repo>/gsd-core/bin/gsd-tools.cjs`, then `gsd-core/bin/gsd-tools.cjs` under `<repo>/.claude` and `<repo>/.codex`, then the legacy `<repo>/.claude/get-shit-done/bin/gsd-tools.cjs`.
3. `$CLAUDE_CONFIG_DIR/gsd-core/bin/gsd-tools.cjs`, when `CLAUDE_CONFIG_DIR` is set.
4. `gsd-core/bin/gsd-tools.cjs` under `~/.claude`, `~/.agents`, `$HERMES_HOME` (else `~/.hermes`), `$CODEX_HOME` (else `~/.codex`), `$GEMINI_CONFIG_DIR` (else `~/.gemini`), `~/.cursor` and `$XDG_CONFIG_HOME/opencode` (else `~/.config/opencode`), in that order.
5. The legacy `~/.claude/get-shit-done/bin/gsd-tools.cjs`.

When a roadmap exists and none of these is found, the assessment reports the gap `GSD roadmap found but gsd-tools.cjs was not found; set GSD_TOOLS or rerun assess with --ignore-gsd`. When the tools are found but `node` is not on `PATH`, it reports `GSD roadmap found but node is not on PATH, so gsd-tools.cjs could not run; install Node.js or rerun assess with --ignore-gsd`.

#### Finding Bun

The launcher `bin/run-bun` looks for `bun` in this order: `$BUN`, `PATH`, `$BUN_INSTALL/bin/bun`, `~/.bun/bin/bun`, `/usr/local/bin/bun`, `/opt/homebrew/bin/bun`, then `~/.local/share/*/bun/bin/bun`. It adds the directory it found to `PATH` for everything Bun starts, and starts Bun with `--no-env-file`, so Bun 1.3.3 and later load no `.env*` files from the working directory (your repository) into ultrathink; Bun 1.2.x ignores the flag and still loads them. When there is no Bun, it prints `ultrathink: bun not found. Install Bun 1.2 or later (https://bun.sh) or set BUN=/path/to/bun`; the hooks then exit 0 so the prompt still goes through, and the three CLIs exit 127. The Hermes plugin runs `$BUN` directly when it is set, else `bin/run-bun`, both from the ultrathink clone, so a repository's `.env*` files never reach it.

### Internal variables

ultrathink sets these itself. Do not set them.

| Variable | Purpose |
|---|---|
| `ULTRATHINK_CHILD` | Set to `1` on the headless `claude` calls the engine makes, so the hooks do not plan or track them. A process that has it set to `1` is never planned. |
| `ULTRATHINK_PROGRESS_FD` | File descriptor (3 or higher) the Omp extension reads planning progress from. |
| `ULTRATHINK_BUN_REQUIRED` | Set to `1` by `bin/ultrathink`, `bin/ultrathink-mcp` and `bin/ultrathink-ship` so `bin/run-bun` exits 127 when Bun is missing. `bin/run-bun` removes it before starting Bun. |
| `MAX_THINKING_TOKENS` | Set to `0` on the headless `claude` calls when `claude.thinking` is `false`. |
| `GROK_SUBAGENTS`, `GROK_MEMORY`, `GROK_WEB_FETCH` | Set to `0` on the `grok` process the `cli` transport starts. `GROK_HOME` is set there too when `grok.home` is not empty. |

### Variables ultrathink reads from your system or host

| Variable | Used for |
|---|---|
| `HOME` | Default locations of the config files, the credential store and the host directories. |
| `XDG_CONFIG_HOME` | User config, credential store, the Muse state directory and Muse's `settings.json` for `mcp-register`. |
| `CLAUDE_CONFIG_DIR` | Claude user config, the Claude Code state directory, the `CLAUDE.md` that `scripts/setup.ts` edits, and the Claude config file `mcp-register` backs up. |
| `GROK_HOME` | Grok home: the `grok login` lookup when `grok.home` is empty, the Grok Build state directory when `GROK_PLUGIN_DATA` is unset, and where `scripts/setup.ts` installs the Grok rule and hook file. |
| `GROK_PLUGIN_DATA` | Grok Build state directory. |
| `HERMES_HOME` | Hermes state directory, Hermes' `config.yaml`, and the plugin path `scripts/setup.ts` prints. |
| `PI_CODING_AGENT_DIR` | Omp state directory and Omp's `mcp.json` for `mcp-register`. |
| `GROK_PLUGIN_ROOT`, `GROK_HOOK_EVENT`, `GROK_SESSION_ID` | Any of them set means the process runs under Grok Build. |
| `MUSE_TOOL_USE_ID`, `MUSE_PLUGIN_ID` | Either set means the process runs under Muse Code, so `bin/ultrathink` run from Muse's shell tool changes the Muse state. |
| `CLAUDE_PLUGIN_ROOT` | Set by the host for plugin hooks and commands. `hooks/hooks.json` and the command files in `commands/` use it to find the checkout. |
| `TERMINAL_CWD` | Hermes only: the working directory for planning when Hermes passes none. |
| `HERMES_SESSION_USER_NAME`, `HERMES_SESSION_KEY` | Hermes gateway session values (read through Hermes' session context, not the process environment): the sender name whose `[Name] ` tag is stripped from shared-session messages, and the chat that `/ultrathink-quick` sends its message to. |
| `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY` | Any of them set marks a remote session, so `auth login` prints port-forwarding hints (and uses the Tailscale route when you opted in). |
| `USER`, `LOGNAME` | The user name in the printed `ssh -L` command. |
| `PATH`, `BUN_INSTALL` | Finding `bun`, and finding the `claude`, `grok` and `hermes` CLIs for `mcp-register`. |
| `CODEX_HOME`, `GEMINI_CONFIG_DIR` | Two of the [GSD tools](#gsd-tools-lookup) locations. |

## State directories

Each host keeps its own state. Planning never writes `.planning/` into the working directory.

| Host | State directory |
|---|---|
| Claude Code | `~/.claude/ultrathink` (`$CLAUDE_CONFIG_DIR/ultrathink` when set) |
| Grok Build | `$GROK_PLUGIN_DATA/ultrathink` when set, else `~/.grok/plugin-data/ultrathink` (`$GROK_HOME/plugin-data/ultrathink` when `GROK_HOME` is set) |
| Hermes Agent | `~/.hermes/ultrathink` (`$HERMES_HOME/ultrathink` when set) |
| Muse Code | `~/.config/muse/ultrathink` (`$XDG_CONFIG_HOME/muse/ultrathink` when set) |
| Omp | `~/.omp/agent/ultrathink` (`$PI_CODING_AGENT_DIR/ultrathink` when set) |

Empty or whitespace-only values count as unset. `ULTRATHINK_STATE_DIR` replaces the directory for every host, as long as it is not inside `.planning`. Use an absolute path for it: a relative path resolves against the session's working directory on most hosts, but against the ultrathink checkout on Hermes.

What a state directory holds:

| Path | Contents |
|---|---|
| `control.json` | The per-host control state, described in the next section. |
| `sessions/<session-id>.json` | The session record: the spec, the graph, the clarifications, the tracking plan, the created row links, the ship progress and, with Decisions on, the Jev decision records (`decisions`, and the ship assessment's `decision`). The kickoff, sync and ship skills take this file as `stateFile`. |
| `sessions/<session-id>.xml` | The full uplifted spec. |
| `last.json` | A copy of the latest session record. `bin/ultrathink last` reads it. |
| `last-plan.json` | The plan carrier for hosts that do not read hook output directly, such as Grok Build. |
| `teach/moments/<id>.json` | One Teachable Moments file. Written only when `teach.enabled` is on. |
| `teach/outbox/<id>.json` | A pending Hindsight retain, delete or tag update. |
| `teach/inbox/<id>.json` | A finished-turn digest waiting for `teach observe`. `teach observe --file` deletes the file afterwards, and only when the path resolved to a file under this directory. A refused path is left alone. |
| `teach/skill-drafts/<name>/SKILL.md` | A rendered skill draft. Hermes installs from here through `skill_manage`; ultrathink never writes `~/.hermes/skills`. |

## Control state versus config

There are two layers:

- **Config files** are shared by every host and are edited by hand (or by `notion init --write-config`).
- **Control state** is `control.json` in one host's state directory. The `/ultrathink-*` commands in an agent and `bin/ultrathink` on the command line write it. It only affects that host.

A value in the control state beats the config value until you change it again:

| Command | Control field | Overrides |
|---|---|---|
| `/ultrathink-off`, `/ultrathink-on`, `bin/ultrathink off`, `bin/ultrathink on` | `enabled` | `uplift.enabled` |
| `/ultrathink-skip`, `bin/ultrathink skip` | `skipOnce` | Skips the next prompt once, then clears itself. |
| `/ultrathink-track off`, `/ultrathink-track on`, `bin/ultrathink track off`, `bin/ultrathink track on` | `trackEnabled` | `track.enabled`. `off` also stops the kickoff skill and `track complete` from creating rows. |
| `bin/ultrathink think on`, `bin/ultrathink think off` | `thinkEnabled` | `think.enabled` |
| `bin/ultrathink hitl on`, `bin/ultrathink hitl off` | `hitlEnabled` | `hitl.enabled` |
| `bin/ultrathink grok engine grok`, `bin/ultrathink grok engine claude` | `engine` | `think.engine` |

`ULTRATHINK_TRACK=0` beats both the control state and the config, for the planner's own row creation. `ULTRATHINK_UPLIFT=0` and `ULTRATHINK_SHIP=0` likewise beat both for planning and ship.

`bin/ultrathink` picks the state directory from `ULTRATHINK_HOST`, else from the detected host: Grok Build when `GROK_PLUGIN_ROOT`, `GROK_HOOK_EVENT` or `GROK_SESSION_ID` is set, Muse when `MUSE_TOOL_USE_ID` or `MUSE_PLUGIN_ID` is set, and Claude Code otherwise. Run from a plain shell, it changes the Claude Code state. See [Commands](commands.md) for every command and how each host shows the reply.
