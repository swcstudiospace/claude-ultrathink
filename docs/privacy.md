# Privacy and data flow

ultrathink has no server of its own. It sends no telemetry, no analytics and no update checks. Data leaves your machine only to services you already use and have set up: the model behind your `claude` (or `grok`) login, and, if you configure them, Notion, Linear, Greptile, GitHub, OpenRouter (Jev decisions), Hindsight, RAGFlow and an Agent Substrate server.

This page lists every destination, what it receives, when, and how to turn it off. It is derived from the code; file names are given so you can check. For the credential store and how to report a vulnerability, see [SECURITY.md](../SECURITY.md). For how the pieces fit together, see [Architecture](architecture.md#services-and-trust-boundaries).

- [What leaves your machine](#what-leaves-your-machine)
- [Details per destination](#details-per-destination)
- [What stays local](#what-stays-local)
- [Turning things off](#turning-things-off)

## What leaves your machine

On a fresh install, only your host's engine row applies: tracking, ship, the Greptile knowledge base, Jev decisions, Hindsight, RAGFlow, Teachable Moments, the shunt gateway, Agent Substrate and Tailscale are all off until you configure them. Two exceptions reach xAI or the hosted trackers without ultrathink's own tracking: `bin/ultrathink status` may refresh an expired Grok login (see [Planning engine](#planning-engine)), and `bun scripts/setup.ts apply` registers the hosted Notion and Linear MCP servers in Claude Code (see [Claude Code's own MCP entries](#claude-codes-own-mcp-entries)).

| Destination | Data sent | When | How to turn it off |
|---|---|---|---|
| **Planning engine: Anthropic**, through your `claude` CLI (default on Claude Code, Hermes and Omp) | Your prompt; up to 3 500 characters of recent conversation; when you invoke a skill, its name and up to 600 characters from its `SKILL.md` or command file; the spec, graph and your earlier clarification answers in the follow-up calls; with `hitl.knowledgeBase` on, up to 24 000 characters of Greptile knowledge-base documents in the clarification call. No source files. | When Claude is the engine (the default on Claude Code, Hermes and Omp): every prompt that is planned means one spec call, one graph call, one call per node, one clarification call. A prompt over `uplift.maxChars` (20 000) skips only the spec call; the graph, node and clarification calls still send it in full unless you turn them off. | `/ultrathink-off`, `uplift.enabled: false`, `ULTRATHINK_UPLIFT=0`, or a `raw:` prefix or `/ultrathink-skip` for one prompt. `bin/ultrathink think off` and `bin/ultrathink hitl off` drop the graph and clarification calls. |
| **Planning engine: xAI Grok** (default on Grok Build) | The same as above. | When Grok is the engine: the default on Grok Build, or anywhere with `think.engine` set to `"grok"` or the control engine set to Grok for this host. The command's choice beats the config key and is stored per host (set `ULTRATHINK_HOST` to change another host from a shell). | Set `think.engine` to another engine, and `bin/ultrathink grok engine …` on each host where you switched. |
| **Planning engine: Muse** (default on Muse Code) | The same as above. | When Muse is the engine: the default on Muse Code, or anywhere with `think.engine` set to `"muse"` or the control engine set to Muse for this host. | Set `think.engine` to another engine, and `bin/ultrathink grok engine …` on each host where you switched. |
| **Your Anthropic-compatible gateway** (opt-in) | The same as above. | Only with `grok.transport: "shunt"` and `grok.shuntBaseUrl` set. | Unset `grok.shuntBaseUrl` or use another transport. |
| **Notion**, through its hosted MCP server | A Task row per plan (title, your full prompt, the first 1 900 characters of the spec, host id such as `claude-code` or `grok-build`, repository and branch, Graph ID), one row per plan node (title and conclusion), one row per reasoning step (step text). Later the sync skill adds PR URL, number, branch, state, checks and reviewers. | When `notion.dataSourceUrl` is set, you are logged in, and tracking is on: at planning time (on Hermes, when `ultrathink-kickoff` runs), then when a PR is opened or the turn ends. | `/ultrathink-track off` (stops all rows), or leave `notion.dataSourceUrl` empty. |
| **Linear**, through its hosted MCP server | One issue per plan node (title, conclusion, a footer with the Graph ID, `blockedBy` links), one sub-issue per reasoning step (step text). Later the sync skill moves issue states and attaches the PR link. | When `linear.team` is set, you are logged in, and tracking is on. Same timing as Notion. | `/ultrathink-track off`, or leave `linear.team` empty. |
| **Planning engine, again: done check** (ship flow) | Your original prompt, the first 6 000 characters of the spec and of the plan's workflow, the graph goal, the clarifications, a GSD summary when the repository has a GSD roadmap (state status, phase counts, latest verification), git signals (branch, base, repository slug), the diff stat (which names the changed files) and commit log (8 000 characters each) and the patch against the base branch, capped at 24 000 characters (lockfiles excluded). **This is the one place your code goes to the engine.** | When the ship flow runs `assess` and the rule checks pass. | Leave `ship.enabled` off (the default), or set `ULTRATHINK_SHIP=0`. |
| **GitHub**, through your `gh` login and plain `git` with your credentials for `origin` (ship flow) | A fetch of the base branch; a push of your branch; a pull request whose title and body come from the plan (goal or first prompt line, the done-check summary or your full prompt, tracker links, assessment gaps), with local paths scrubbed; a PR comment if the flow stops; the merge, remote branch deletion and `git pull` only if you enabled them. | When the ship flow runs. | Leave `ship.enabled` off; `ship.autoMerge` and `ship.deleteBranch` are off by default too. |
| **Greptile** (ship flow) | PR review: the repository name and PR number through Greptile's hosted MCP server; Greptile then reads the PR itself. CLI review: the `greptile` CLI reviews your local branch against the base, and what it uploads is decided by that CLI. | When the ship flow runs `review`. PR review is used when a Greptile credential is stored and Greptile lists the repository, otherwise CLI review. | Leave `ship.enabled` off. |
| **Greptile knowledge base**, through Greptile's hosted MCP server `https://api.greptile.com/mcp` (opt-in) | Only list and read calls: the organization (`ship.greptileOrganization`, when set), the knowledge-base namespace id, and the document paths to read. **Nothing from your prompt or your code is sent to Greptile.** Greptile returns the list of repositories with a knowledge base, the repository's document paths, and the documents' markdown (`index.md` plus up to 3 more). | Every planned prompt with clarifying questions on, only when `hitl.knowledgeBase` is `true` and a Greptile credential is stored. | Leave `hitl.knowledgeBase` off (the default), or turn clarifying questions off. |
| **OpenRouter Decisions API** `https://openrouter.ai/api/alpha/decisions` (Jev, opt-in) | One small state per yes/no question, plus the fixed question text, the model, provider preferences (`zdr: true`, `data_collection: "deny"` by default), the host session id and a trace name (`ultrathink` and the point). Plan gate: the message (first 4 000 characters) and the last assistant turn (last 2 000 characters). Ship: your original prompt, up to 20 acceptance criteria from the spec (500 characters each) and the patch (lockfiles excluded, 24 000 characters). Knowledge: a settled question, its answer and the cited knowledge-base document (12 000 characters). Blocking: your original prompt (4 000 characters), the question and its default answer. Teachable: a candidate's name, description, the first 800 characters of the body, and kind. Skillworthy: those fields plus `occurrences`. Your OpenRouter key, as a bearer token. See [Jev decisions (OpenRouter)](#jev-decisions-openrouter). | Only with `decisions.enabled: true` in your own config (a project file cannot turn it on), an OpenRouter key (stored or `OPENROUTER_API_KEY`) and no `ULTRATHINK_DECISIONS=0`, at the points listed in `decisions.points`: a prompt the rules would plan (not a skill invocation or `uplift:`), each ship `assess` whose rule checks pass, each settled knowledge-base question and each non-blocking clarifying question (skill runs and `uplift:` prompts included). Also one `teachable` decision per observe candidate, and one `skillworthy` decision per due moment on `teach promote --due` and automatic promotion. Also when you run `bin/ultrathink decisions check` or `probe`. | Leave `decisions.enabled` false (the default), set `ULTRATHINK_DECISIONS=0`, or remove points from `decisions.points`. |
| **Hindsight** (opt-in) | On retain: the lesson text (`# name`, description and body, at most 3 000 characters), the fixed context `ultrathink teachable moment`, tags from `tagsFor`, string metadata, and document id `tm:<id>`. On recall: the recall query (your prompt, at most 1 500 characters) and the filter tags. The key is sent only on `/v1/**`, not on `GET /health` or `GET /version`. | When Teachable Moments retains, recalls, syncs or forgets a lesson and Hindsight is on and ready. Candidates are not retained. | Leave `hindsight.enabled` false (the default), or set `ULTRATHINK_HINDSIGHT=0`. |
| **RAGFlow** (opt-in) | The grounding query (your prompt, at most 1 500 characters) and the dataset ids (`ragflow.datasetIds`, or every dataset the key can list when that list is empty). Excerpts come back and are added to the plan as untrusted evidence, capped by `ragflow.groundChars`. | A planned prompt, only when `ragflow.enabled` and `ragflow.ground` are on and RAGFlow is ready. The client never calls `/system/healthz`. | Leave `ragflow.ground` false (the default), or set `ULTRATHINK_RAGFLOW=0`. |
| **Agent Substrate server: brief** (opt-in) | `POST <url>/brief` with repository slug, branch and host id (`claude-code`, `grok-build`, …); bearer token from `SUBSTRATE_TOKEN` if set. | Every planned prompt, only when `substrate.url` or `SUBSTRATE_URL` is set. | Leave both unset, or set `SUBSTRATE_DISABLED=1`. |
| **Agent Substrate server: graph registration** (opt-in) | A `graph_register` call with the Graph ID, the Notion Task page, repository and branch, host id, task status, and for each node and step its Linear issue id, identifier and URL and its Notion page. | When `ultrathink-kickoff` runs and your host has an MCP server named `substrate` with a `graph_register` tool connected (`skills/ultrathink-kickoff/SKILL.md`, step 3). | Don't connect an MCP server named `substrate`. |
| **Tailscale** (opt-in) | Nothing is sent to a third party: `tailscale serve` exposes the local OAuth callback listener on your tailnet (not the public internet) at the path `/ultrathink-oauth`, then removes it. | Only during `ultrathink-mcp auth login` with `--tailscale` or `ULTRATHINK_OAUTH_TAILSCALE=1`, on a remote session. | Don't pass the flag; the default is a `127.0.0.1` callback. |
| **Notion, Linear, Greptile OAuth servers** | Discovery requests, a dynamic client registration (client name `ultrathink`, the callback URL), then the PKCE code exchange and token refreshes. | During `ultrathink-mcp auth login`, and when a token is within 60 s of expiry. | Use an API key (`auth set-key`, Linear and Greptile only), or don't log in. |

## Details per destination

### Planning engine

- The Claude engine runs `claude -p` with `--tools ""` and `--setting-sources ""`, so the child model cannot read files or run commands (`src/claude/complete.ts`). It uses your existing Claude Code login; ultrathink stores no Anthropic key.
- The Muse engine runs `muse exec --json` with `--disable-shell --disable-write --disable-web-tools --max-model-steps 1`, so the child cannot run commands, write files or use the web (`src/muse/complete.ts`). It uses your existing Muse login; ultrathink stores no Muse key.
- The recent-conversation excerpt comes from the host's transcript file when the host passes one (Claude Code, Grok Build and Muse do; Hermes and Omp don't). It keeps at most 8 user and assistant text messages, 600 characters each, 3 500 characters in total, and leaves out tool calls, tool results and injected system text (`src/claude/transcript.ts`). These limits are fixed.
- The graph and per-node calls get your prompt and the spec, not the conversation. The clarification call gets the spec, the node conclusions, the conversation excerpt and questions you already answered, and, with `hitl.knowledgeBase` on, the knowledge-base documents read (see [Greptile knowledge base](#greptile-knowledge-base)).
- The Grok `http` transport posts to `grok.baseUrl` (default `https://cli-chat-proxy.grok.com/v1`) with the token from your `grok login`. The `cli` transport runs `grok` with tools, web search and subagents disabled, in a private temporary directory that is removed afterwards (`src/grok/complete.ts`).
- The Agent Substrate brief is not sent to the engine. It is added to the context your agent sees.
- When you invoke a skill, the engine gets the skill's name and a summary of up to 600 characters from its `SKILL.md` or command file (frontmatter description, `<objective>` or first paragraph). For a bare invocation with no text, that summary is what gets planned, so it also becomes the Notion Task row's title and description (`src/uplift/skill.ts`).
- `grok.baseUrl` receives your Grok login token. Any config file can set it, including `<project>/.claude/ultrathink.json` in a repository you open, so check a project file before using Grok's `http` transport in an untrusted repository.
- `bin/ultrathink status` (and `/ultrathink-status`) checks your Grok login even when Claude is the engine, unless `grok.transport` is `"shunt"`. If `${GROK_HOME:-~/.grok}/auth.json` (or `grok.home`) holds an expired session with a refresh token, it runs `grok models`, which contacts xAI to refresh it.

### Notion and Linear

- A plan whose spec is the fallback (the spec call failed) is never tracked. If only the graph call fails, a generic 5-node fallback graph is used and is tracked like any other plan.
- A provider that is not configured is never contacted, and a configured provider without a stored credential is skipped (`src/track/gateway.ts`).
- When `ultrathink-mcp track complete` runs for a session that already has tracker rows recorded, it looks them up by Graph ID before creating anything, so it sends a search query too. The planner itself doesn't search.
- `ULTRATHINK_TRACK=0` and `track.enabled: false` stop only the planner's own row creation. `ultrathink-kickoff` can still create the rows when it runs `ultrathink-mcp track complete`. To stop all rows, use `/ultrathink-track off`.
- The MCP gateway (`bin/ultrathink-mcp serve`) also relays calls your agent makes on its own through the registered `notion`, `linear` and `greptile` servers. Those calls are chosen by your agent, not by ultrathink.

### Greptile knowledge base

- The planner finds the knowledge base by the `origin` remote's `owner/repo`, reads `index.md`, then picks up to 3 documents from its routing table that match the request. The matching happens on your machine: the request itself never goes to Greptile.
- The documents read, at most 24 000 characters, go to the planning engine inside the clarification call, marked as untrusted Greptile-synthesized evidence. They are also named (paths only) in the context your agent sees.
- The session record keeps the lookup's outcome, repository, namespace id, version, document paths, digest length and timing, not the document text. A question the documents settled is kept with the clarifications, with its one-sentence answer and the document it cites.
- Without a stored credential nothing is contacted. Each Greptile stage has a 20-second budget, and any failure means the clarification call runs exactly as with the feature off. That includes a single selected document that fails to read or times out: none of the documents then go to the planning engine.

### Jev decisions (OpenRouter)

Jev is a decision model: it reads a small state and answers one typed yes/no question with a probability. It writes no text. ultrathink calls it through OpenRouter's Decisions API with plain `fetch` (`src/decisions/client.ts`); no SDK is involved.

- **What is sent, per point** (`src/decisions/questions.ts`). Each request carries exactly one question and only the state fields that question reads:

  | Point | State sent | Caps |
  |---|---|---|
  | `plan` | `message`: the text to be planned; `recent_conversation`: the last assistant turn from the conversation excerpt, `""` on Hermes and Omp, which pass no transcript | `message` first 4 000 characters; `recent_conversation` last 2 000 characters |
  | `ship` | `request`: your original prompt; `acceptance_criteria`: the items of the spec's `ACCEPTANCE_CRITERIA` element; `patch`: the patch against the base branch, lockfiles excluded. No GSD roadmap or verification signals, no git signals, no diff stat or log. | 20 criteria of 500 characters each; `patch` 24 000 characters |
  | `knowledge` | `question` and `answer`: one question the Greptile knowledge base settled and its answer; `document`: the text of the cited document, taken from the documents already read | `document` first 12 000 characters |
  | `blocking` | `task`: your original prompt; `question`: one non-blocking clarifying question; `default`: its recommended default answer and description | `task` first 4 000 characters |
  | `teachable` | `name`, `description`, `body` (cut to the first 800 characters), `kind`. No ids, paths or project names. | `body` first 800 characters |
  | `skillworthy` | the same fields as `teachable`, plus `occurrences` | `body` first 800 characters |

- A request whose estimated size (characters of the state and question divided by 4) is over 28 000 tokens is never sent; that point fails open.
- **Privacy default.** With `decisions.zdr: true` (the default) every request carries `provider: {"zdr": true, "data_collection": "deny"}`, so OpenRouter routes it only to zero-data-retention endpoints and the provider may not collect it. If routing fails because of it, the decision fails open and the error is visible. `decisions.zdr: false` sends no provider preferences; only a user file can set it, because a project file's `false` is ignored.
- **Observability fields.** `session_id` is the host's session id (at most 256 characters, left out when unknown); OpenRouter uses it to group requests and does not send it to the model provider. `trace` is `{"trace_name": "ultrathink", "span_name": "<point>"}`. `bin/ultrathink decisions check` sends a fixed test message (`Add a --verbose flag to the export command`) and no session id; `decisions probe` sends the cases from your file.
- **Where the key goes.** Your OpenRouter key is sent only as `Authorization: Bearer <key>` to `https://openrouter.ai/api/alpha/decisions`, or to `ULTRATHINK_DECISIONS_URL` when you set that environment variable. That variable is accepted only as an `https://openrouter.ai/…` URL or an `http://` or `https://` URL on `localhost`, `127.0.0.1` or `[::1]`, with no user name or password in it; any other value is ignored and the default endpoint is used; the `Decisions:` status line (when Decisions are on with a key) and the `decisions check` line then end with ` · ULTRATHINK_DECISIONS_URL ignored (must be https://openrouter.ai/… or a loopback URL)`. Only the URL's origin and path are used or printed. A redirect is never followed. No config file can change the endpoint, so a repository's `<project>/.claude/ultrathink.json` cannot redirect the key.
- **Who can turn it on.** Only you, in a user file. In `<project>/.claude/ultrathink.json`, `decisions.enabled` can only turn Jev off, `decisions.zdr` can only turn zero data retention on, and `decisions.points` can only drop points; `model`, `timeoutMs` and the thresholds merge as usual. A repository you open therefore never sends your prompt, patch or knowledge-base text to OpenRouter unless you turned Jev on in your own config, and it cannot turn zero data retention off. `ULTRATHINK_DECISIONS=0` in the environment turns Jev off for that process, whatever any file says.
- **A repository's `.env` files.** ultrathink starts Bun with `--no-env-file` (`bin/run-bun`), so on Bun 1.3.3 and later a repository's `.env*` files are not loaded into ultrathink and cannot set `OPENROUTER_API_KEY`, `ULTRATHINK_DECISIONS_URL` or any other variable it reads. Bun 1.2.x ignores the flag and still loads them.
- **Fail open.** Every failure (no key, HTTP error, timeout, invalid answer) leaves the point exactly as it is with Decisions off. Error messages are cut to one line of at most 200 characters, with the key and anything that looks like a token replaced by `[redacted]`.

- **Teachable Moments points.** `teachable` can drop a candidate before it is stored, when P is below `teachableBelow` (0.3). It cannot add a lesson: it only sees candidates `observe` already distilled. `skillworthy` can skip a due promotion (`teach promote --due`, and `promoteDue` when `teach.autoPromote` is on) when P is below `skillworthyAt` (0.5). It cannot block an explicit `teach promote <id>`: that command does not ask Jev. A failure at either point behaves as with Decisions off (the candidate is still stored; a due moment stays listed). Redaction (`src/teach/redact.ts`) runs before a moment is retained and before this state is built. `Bearer` followed by a short word is not redacted; a credential-shaped Bearer value is (16 or more characters, or 6 or more that include a digit, ignoring a trailing run of dots).

### Hindsight

Hindsight is off unless `hindsight.enabled` is set in a user file. A project file can only turn it off. `ULTRATHINK_HINDSIGHT=0` turns it off for the process. Nothing is contacted while it is off or not ready.

The client is `src/hindsight/client.ts`, against the 0.9.1 HTTP API. Teachable Moments uses it as follows (`src/teach/capture.ts`, `src/teach/recall.ts`, `src/teach/mapping.ts`):

- **Retain** posts one item to `/v1/default/banks/<bank>/memories`. The body is the lesson text from `contentFor`: `# <name>`, a blank line, the description, a blank line, the body, hard-capped at 3 000 characters. With it go the fixed context `ultrathink teachable moment`, the tags from `tagsFor`, the string metadata from `metadataFor` (id, schema `tm/2`, name, kind, status, origin, project, host, confidence, occurrences, timestamps, source phase, source artifacts, related ids), the document id `tm:<id>`, and `update_mode: "replace"`. The request sets `async: false`. Before the first retain, `ensureBank` creates the bank if needed and sets `retain_extraction_mode` to `chunks`.
- **Recall** posts the recall query to `/v1/default/banks/<bank>/memories/recall`. The planner's query is your own prompt, trimmed, at most 1 500 characters. The filter tags are `ultrathink`, `teachable`, and `project:<project>` (the project tag is omitted when the request asks for every project). `tags_match` is `all_strict`.
- **Forget and tag updates** call `DELETE` or `PATCH` on `/v1/default/banks/<bank>/documents/tm:<id>`. A failure is queued locally and retried by `teach sync`; it does not block the caller.

The key comes from the credential store, provider `hindsight` (`ultrathink-mcp auth set-key hindsight`). A stored key wins over `HINDSIGHT_API_KEY`, which wins over `HINDSIGHT_API_TOKEN`. It is sent only as `Authorization: Bearer <key>` on `/v1/**`. `GET /health` and `GET /version` are called with no key and no body. The key is not printed: status names the source only.

A candidate is not retained. Only a confirmed or promoted moment is sent. Lesson text is redacted before it is hashed, written or retained.

### RAGFlow

RAGFlow grounding is off unless `ragflow.enabled` and `ragflow.ground` are set in a user file. A project file can only turn `enabled` and `ground` off. `ULTRATHINK_RAGFLOW=0` turns it off for the process. `groundDocs` (`src/ragflow/ground.ts`) never throws. While off, not ready, or given an empty query, it makes no retrieval request and the plan is unchanged.

When it runs, the planner sends your prompt (the same 1 500-character cut as the lessons lookup) as `question`, and the dataset ids, to `POST /api/v1/retrieval`. Dataset ids are `ragflow.datasetIds` when that list is non-empty; otherwise the client lists datasets and searches every id the key can see. The key comes from the credential store, provider `ragflow`, else `RAGFLOW_API_KEY`; the stored key wins. It is sent as `Authorization: Bearer <key>`.

Excerpts come back as chunks. They are flattened to one line each, stripped of closing-tag lookalikes, capped by `ragflow.groundChars` (default 3 000), and introduced as untrusted evidence, not instructions (`## Documents (RAGFlow)`). The session record keeps counts and timing, not the excerpt text. The client never requests `/v1/system/healthz` or `/api/v1/system/healthz`. Its health probe is `GET /api/v1/datasets?page=1&page_size=1`.

### Teachable Moments files

Lessons that have not been retained, and every moment before Hindsight answers, stay on disk under the host state directory, never under `<cwd>/.planning`:

| Path | What | Mode |
|---|---|---|
| `<stateDir>/teach/moments/<id>.json` | One schema-2 moment. Redacted before write. | file `0600`, directory `0700` |
| `<stateDir>/teach/outbox/<id>.json` | A pending retain, delete or tag update. Backoff starts at 1 minute and doubles, capped at 6 hours. The error line is redacted. | file `0600`, directory `0700` |
| `<stateDir>/teach/skill-drafts/<name>/SKILL.md` | A promotion draft. Not sent anywhere by ultrathink. | file `0600`, directories `0700` |
| `<stateDir>/teach/inbox/<id>.json` | The digest a host hands to detached `teach observe`. Written before redaction; `teach observe --file` deletes it after reading when the path is under this inbox. Hermes deletes it if the spawn fails. | file `0600`, directory `0700` |

`ULTRATHINK_TEACH=0` turns Teachable Moments off. A project file can only turn `teach.enabled`, `teach.recall` and `teach.autoPromote` off, or lower `teach.capture`.

### GitHub and pull request bodies

- The pull request title and body are built in `src/ship/pr-body.ts`. Before they are sent, absolute local paths under `/home/`, `/Users/`, `/root/`, `/tmp/`, `/var/` and `/private/`, and Windows drive paths such as `C:\…`, are replaced with `<local path>`, and ASCII control characters are removed.
- Nothing else is redacted from the body. If your prompt contains a secret, it can end up in the PR through the `## Summary` section, so don't paste secrets into prompts you plan to ship.
- Running `bin/ultrathink-ship` by hand does not check `ship.enabled`: that setting decides whether the flow is suggested and started automatically.

### Claude Code's own MCP entries

`bun scripts/setup.ts apply`, when the `claude` CLI is present, adds `notion` (`https://mcp.notion.com/mcp`) and `linear` (`https://mcp.linear.app/mcp`) HTTP MCP servers to Claude Code's user config if servers with those names are missing. Claude Code then connects to them itself, with its own login and outside ultrathink's gateway and credential store. `bun scripts/setup.ts rollback` removes the entries it added. `scripts/mcp-register.ts` is different: its entries run the local gateway.

### Hosts' own traffic

Your coding agent sends the injected plan to its own model provider as part of your conversation, the same way it sends everything else you type. That traffic is between you and your host.

## What stays local

| Where | What | Protection |
|---|---|---|
| Credential store: `${XDG_CONFIG_HOME:-~/.config}/ultrathink/mcp-credentials.json`, or `ULTRATHINK_MCP_STORE` | OAuth tokens and API keys for Notion, Linear and Greptile, the OpenRouter API key, and the Hindsight and RAGFlow API keys. | File `0600`, in a directory created with mode `0700` (an existing directory keeps its mode); written atomically; refreshes serialized with a lock. Never printed: `auth status` shows readiness only, and `bin/ultrathink status` shows only where a key came from (`key from store` or the environment variable name). |
| State directory (per host; see [Architecture](architecture.md#state-directory)) | `control.json`, `sessions/<id>.json` (your prompt, the spec, graph, clarifications and answers, the knowledge-base lookup, the lessons lookup, tracker refs, ship state, Jev decision records), `sessions/<id>.xml`, `last.json`, `last-plan.json`, `claims/`, and `<stateDir>/teach/` (moments, outbox, inbox, skill drafts). | Session files are written with your default file permissions. Teach files are mode `0600`. Never inside your repository, never in `.planning/`. |
| Config files: `${XDG_CONFIG_HOME:-~/.config}/ultrathink/config.json`, `${CLAUDE_CONFIG_DIR:-~/.claude}/ultrathink.json`, `<project>/.claude/ultrathink.json` | Your settings, including tracker ids. | Your default permissions. The project file is in your repository, so don't commit anything you don't want to share. |
| Temporary files | The Grok `cli` transport's prompt file under `$TMPDIR/ultrathink-grok-*`, and the Muse engine's prompt file (`prompt.txt`, mode `0600`) under `$TMPDIR/ultrathink-muse-*`. | Private directory (`0700`), removed after the call; the Grok directory is also removed on exit. |

A Jev decision record (`DecisionRecord`, in the session record's `decisions` field and the ship assessment's `decision`) holds the point, the outcome, the resolved model, OpenRouter's request id, the probability, the threshold, the action taken, latency, attempts, cost and the error kind. It never holds the state that was sent (no message, patch, question, answer or document text) and never the key. A plan-gate decision that skips planning is not written to disk at all; it is shown only in the notice and the debug line. The assess JSON and the pull request's `- Jev:` line carry only P, the model and the action (or the error kind).

There are no log files. `ULTRATHINK_DEBUG=1` and `ULTRATHINK_MCP_DEBUG=1` print diagnostics to stderr only; the gateway's debug lines never include tokens or request bodies.

## Turning things off

| To stop | Do this |
|---|---|
| All planning, for this host | `/ultrathink-off` (undo with `/ultrathink-on`) |
| Planning for one prompt | Prefix it with `raw:`, or run `/ultrathink-skip` first, or send it with `/ultrathink-quick <message>` |
| Planning in one shell or process | `ULTRATHINK_UPLIFT=0` |
| All Notion and Linear rows | `/ultrathink-track off` |
| Grok | `bin/ultrathink grok engine claude` |
| Ship (push, PR, review, merge) | Leave `ship.enabled` false (the default), or set `ULTRATHINK_SHIP=0` |
| Greptile knowledge-base reads | Leave `hitl.knowledgeBase: false` (the default) |
| Jev decisions (OpenRouter) | Leave `decisions.enabled: false` (the default), or set `ULTRATHINK_DECISIONS=0` in the environment to turn every point off for that process whatever the config says; to keep it on but stop one point, remove that point from `decisions.points` |
| Hindsight | Leave `hindsight.enabled` false (the default), or set `ULTRATHINK_HINDSIGHT=0` |
| RAGFlow grounding | Leave `ragflow.ground` false (the default), or set `ULTRATHINK_RAGFLOW=0` |
| Teachable Moments (local files and Hindsight retain) | Leave `teach.enabled` false (the default), or set `ULTRATHINK_TEACH=0` |
| Agent Substrate | Leave `substrate.url` and `SUBSTRATE_URL` unset, or set `SUBSTRATE_DISABLED=1`, and don't connect an MCP server named `substrate` |
| A provider's stored credential | `ultrathink-mcp auth logout <provider>`, then revoke the token or key in that provider's settings |
| Everything | Uninstall: see [Uninstall](how-to/uninstall.md) |

The exact effect of each switch and key is in [Commands](commands.md) and [Configuration](configuration.md).
