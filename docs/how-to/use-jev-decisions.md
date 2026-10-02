# Use Jev decisions

**Jev** is a decision model from TypeSafe, served through OpenRouter's Decisions API. It does not write text: it reads a small state, answers one typed yes/no question with a probability P, and ultrathink turns P into an action with a threshold you can tune. With Jev decisions on, ultrathink asks it at up to six points, always after its own deterministic rules have run and left the action open:

| Point | Question | What Jev can change |
|---|---|---|
| `plan` | Does this message ask for new work that takes several steps, files or decisions? | Skip planning for a message the rules would plan, such as `thanks, that works now`. |
| `ship` | Does the patch fully deliver the request and every acceptance criterion? | Veto an LLM "done" in the ship flow, or, with `ship.autoMerge` off, decide when there is no usable LLM verdict. |
| `knowledge` | Does the cited knowledge-base document support the answer the clarifier settled? | Ask a settled question after all when the document does not support the answer, if a question slot is free. |
| `blocking` | Would going ahead with the default answer cause damage that is hard to undo if it is wrong? | Make a non-blocking clarifying question blocking. |
| `teachable` | Is this candidate a reusable lesson that a future agent on this repository would otherwise have to rediscover? | Drop a candidate before it is stored, when P is below `teachableBelow`. It cannot add a lesson. A failure behaves as with Decisions off. |
| `skillworthy` | Does this lesson describe a repeatable procedure or rule worth a standing skill? | Skip a due promotion (`teach promote --due`, and automatic promotion) when P is below `skillworthyAt`. It cannot block an explicit `teach promote <id>`. A failure behaves as with Decisions off. |

Decisions are **off by default**: a fresh install never contacts OpenRouter, and a repository's project file cannot turn them on. When anything goes wrong (no key, an HTTP error, a timeout, an invalid answer), the point behaves exactly as it does with Decisions off.

The Decisions API endpoint (`https://openrouter.ai/api/alpha/decisions`) is marked **alpha** by OpenRouter, so its shape may change. ultrathink checks every answer strictly and fails open on anything unexpected.

- [1. Check the requirements](#1-check-the-requirements)
- [2. Store the OpenRouter key](#2-store-the-openrouter-key)
- [3. Turn it on](#3-turn-it-on)
- [4. Check it](#4-check-it)
- [See what Jev decided](#see-what-jev-decided)
- [Tune the thresholds on your own cases](#tune-the-thresholds-on-your-own-cases)
- [Pin the model](#pin-the-model)
- [Cost and latency](#cost-and-latency)
- [Security boundary](#security-boundary)
- [Turn it off again](#turn-it-off-again)

## 1. Check the requirements

| You need | Why | Check |
|---|---|---|
| An OpenRouter account with credits and an API key | every decision is a paid OpenRouter request; no TypeSafe account is needed | your OpenRouter account settings |
| Network access to `openrouter.ai` from the machine that runs the host | the requests go from your machine | `<clone>/bin/ultrathink decisions check` ([step 4](#4-check-it)) |
| For the `knowledge` point: the Greptile knowledge base on (`hitl.knowledgeBase: true`) | it checks answers the knowledge base settled; without them there is nothing to check | [Use the Greptile knowledge base](use-greptile-knowledge-base.md) |
| For the `ship` point: ship on (`ship.enabled: true`) | it checks the done assessment of a ship run | [Ship with Greptile](ship-with-greptile.md) |

`<clone>` is the directory you cloned ultrathink into. The `plan` and `blocking` points need nothing else. `teachable` is asked only while `teach observe` is storing candidates (`teach.enabled`, capture `observe` or `auto`). `skillworthy` is asked only by `teach promote --due` and by automatic promotion (`teach.autoPromote`). An explicit `teach promote <id>` does not ask it.

## 2. Store the OpenRouter key

Store the key in ultrathink's credential store, `~/.config/ultrathink/mcp-credentials.json` (mode 0600):

```sh
<clone>/bin/ultrathink-mcp auth set-key openrouter --stdin   # paste the key, then Ctrl-D
```

Or read it from a `NAME=value` line in an env file:

```sh
<clone>/bin/ultrathink-mcp auth set-key openrouter --env-file <path to .env> --var OPENROUTER_API_KEY
```

Either prints only the key's length, `openrouter: api key stored (<n> chars)`. `<clone>/bin/ultrathink-mcp auth status` then shows `openrouter  api_key  ready  api key set (<n> chars)`.

Instead of storing it, you can set `OPENROUTER_API_KEY` in the host's environment. It is used only when no key is stored: **the stored key wins**. `openrouter` is an API-key provider, not an MCP server, so `ultrathink-mcp serve`, `check` and `auth login` refuse it and `scripts/mcp-register.ts` never registers it.

## 3. Turn it on

Add a `decisions` section to your user config file, `~/.config/ultrathink/config.json`:

```json
{ "decisions": { "enabled": true } }
```

That asks Jev at all six points with the default thresholds. To ask it at some points only, list them:

```json
{ "decisions": { "enabled": true, "points": ["plan", "ship"] } }
```

Every key, its type and default: [Configuration: `decisions`](../configuration.md#decisions-jev-decisions-openrouter-decisions-api). Turn Decisions on in a user file: a project file (`<repo>/.claude/ultrathink.json`) can turn them off, drop points, set `zdr` to `true` and change `model`, `timeoutMs` and the thresholds, but it cannot turn them on, add points or turn `zdr` off. No config file can change where the key is sent: the endpoint changes only with the `ULTRATHINK_DECISIONS_URL` environment variable (see [Security boundary](#security-boundary)).

## 4. Check it

From the project directory:

```sh
<clone>/bin/ultrathink status
```

The line after `Knowledge base:` shows the state:

| Line | Meaning |
|---|---|
| `Decisions: on · ~typesafe/jev-latest · plan, ship, knowledge, blocking, teachable, skillworthy · key from store · zdr on` | Ready, with the stored key. `key from OPENROUTER_API_KEY` means the key comes from the environment. The key itself is never shown. |
| `Decisions: on · no OpenRouter key (run bin/ultrathink-mcp auth set-key openrouter --stdin, or set OPENROUTER_API_KEY)` | Turned on, but no key; no point sends a request. Do [step 2](#2-store-the-openrouter-key). |
| `Decisions: off (opt-in: set decisions.enabled)` | Not turned on. A project file's `"enabled": true` does not count; set it in your user file. |
| `Decisions: off (ULTRATHINK_DECISIONS=0)` | `ULTRATHINK_DECISIONS=0` is set in this environment and turns every point off, whatever the config says. Unset it to use Decisions. |

While `ULTRATHINK_DECISIONS_URL` is set, the ready line ends with ` · url <origin and path>` when the value is accepted, or with ` · ULTRATHINK_DECISIONS_URL ignored (must be https://openrouter.ai/… or a loopback URL)` when it is not; requests then go to the default endpoint.

Then prove the live integration end to end with one real decision:

```sh
<clone>/bin/ultrathink decisions check
```

```text
Decisions check: ok · typesafe/jev-1.13-20260917 (requested ~typesafe/jev-latest) · 512 ms · attempts 1 · cost 0.000019 · zdr on · key from store
```

It prints the resolved model, the latency, the attempts, the cost reported by OpenRouter, whether zero data retention was requested and where the key came from, and exits 0. On a failure it prints `Decisions check: error (<kind>) · <message> · …` and exits 1; for example a bad key gives `error (auth)`. `decisions check` ignores `decisions.enabled` and `decisions.points`, so you can run it before you turn Decisions on. With `ULTRATHINK_DECISIONS=0` set, it sends nothing, prints `Decisions check: off (ULTRATHINK_DECISIONS=0)` and exits 1. Every error kind and its fix: [Troubleshooting: Decisions](../troubleshooting.md#decisions).

## See what Jev decided

| Where | What you see |
|---|---|
| The summary after a planned prompt (with `claude.echo` on) | One segment for the prompt's decisions, for example `Decisions · plan 0.97`, `Decisions · plan 0.97 · knowledge 1/2 kept · blocking 1/3 promoted`, or `Decisions · error (credits)`. |
| A message Jev did not plan (with `claude.echo` on) | `Prompt Uplift · not planned: Jev judged this is not new multi-step work (0.04) · start with uplift: to plan it`. Resend with `uplift:` to plan it. |
| The ship assessment | `decision` in the `bin/ultrathink-ship assess` JSON, and a `- Jev:` line at the end of the pull request's `## Assessment`, such as `- Jev: P(complete) 0.94 · typesafe/jev-1.13-20260917`. See [Ship: Jev decision](../ship.md#jev-decision). |
| The session record (`<state dir>/sessions/<id>.json`) | `decisions`: one record per decision of a planned prompt (point, resolved model, P, threshold, action, latency, attempts, cost, error kind), and `decision` in the ship state's `assessment`. Never the message, patch, question, answer or document, and never the key. |
| stderr, with `ULTRATHINK_DEBUG=1` | One line per decision: `[ultrathink] decisions plan · p 0.97 · typesafe/jev-1.13-20260917 · 488ms · attempts 1 · cost 0.000019`, or `[ultrathink] decisions plan · error (timeout) · 3001ms · attempts 1`. |

P is always printed with two decimals, cut rather than rounded, so a printed value never crosses its threshold: a P of 0.199 prints as `0.19`.

## Tune the thresholds on your own cases

The default thresholds were set from live probes on `typesafe/jev-1.13-20260917`. These are the probabilities they were based on:

| Point, threshold | Clear yes | Clear no | Close to the line |
|---|---|---|---|
| `plan`, skip below `planSkipBelow` `0.2` | new feature, research write-up 0.97; refactor 0.95; "go ahead" after a multi-step proposal 0.94; bug report 0.80 | "thanks" and a typo fix 0.03; "explain" 0.04; "run the tests" 0.06; "carry on" mid-migration 0.14 | a two-file rename 0.19; "yes please go ahead" with no proposal before it 0.25 |
| `ship`, veto at or below `shipVetoAtOrBelow` `0.2`, approve at or above `shipApproveAt` `0.7` | a complete patch 0.79 | a stub with a TODO, an unrelated patch 0.01; one of two requested flags 0.03 | |
| `knowledge`, keep at or above `groundedAt` `0.8` | supported answer 0.94 to 0.96 | contradicted 0.03 to 0.04; not covered 0.01; an extra unsupported claim 0.05 | |
| `blocking`, promote at or above `blockingAt` `0.5` | drop a column 0.68; remove a public endpoint 0.67; force-push a shared branch 0.63 | icon library, log level, test runner 0.07; an option name 0.13 | public versus admin surface 0.18 |

The `teachable` and `skillworthy` defaults were not part of that probe table. They come from `src/decisions/types.ts`. A failure at either point behaves as with Decisions off: the candidate is still stored, and a due moment stays on the list.

| Point, threshold | What P does |
|---|---|
| `teachable`, drop below `teachableBelow` `0.3` | P below 0.3 drops the candidate before it is stored. P equal to 0.3 keeps it. |
| `teachable`, auto-confirm at or above `teachableAutoAt` `0.8` | In `auto` capture, a kept candidate is confirmed only when its confidence is at least 0.8 and P is at least 0.8. Below that, Jev holds it as a local candidate. Jev never confirms a lesson the capture mode would not. |
| `skillworthy`, skip below `skillworthyAt` `0.5` | `teach promote --due` and automatic promotion leave the moment out when P is below 0.5. P equal to 0.5 keeps it. `teach promote <id>` does not ask. |

Each threshold trades one mistake for another:

| Threshold | Set it higher and | Set it lower and |
|---|---|---|
| `planSkipBelow` | more messages skip planning; a wrong skip means the prompt reaches the agent unplanned and you resend it with `uplift:` | fewer skips; a wrong plan costs what planning costs without Jev |
| `shipVetoAtOrBelow` | more vetoes; a wrong veto means no PR in gate mode and the work is handed back to you | fewer vetoes; a missed veto is today's behaviour |
| `shipApproveAt` (no LLM verdict and `ship.autoMerge` off only) | fewer Jev-only approvals; a wrong reject means not done, and you run it again | more approvals; a wrong approve opens a PR that still faces the unchanged Greptile merge gate |
| `groundedAt` | more settled answers are taken back; a wrong reject costs one extra question, or drops that answer when no question slot is free | fewer; a wrong keep is today's behaviour |
| `blockingAt` | fewer promotions; a missed one is today's behaviour | more questions asked before work starts; a wrong promote costs one extra question |
| `teachableBelow` | more candidates are dropped before they are stored; a wrong drop loses a lesson the next session can rediscover | fewer drops; a wrong keep is one more candidate to review |
| `teachableAutoAt` | fewer automatic confirms; a wrong hold means a person confirms the candidate | more automatic confirms; a wrong confirm is today's auto behaviour |
| `skillworthyAt` | more due promotions are skipped; a wrong skip means you promote it by hand later | fewer skips; a wrong keep is today's behaviour |

To tune a threshold for your own work:

1. Collect 20 to 50 real cases for one point, and label each with the right answer (`true` = plan it, the patch is complete, the answer is supported, the default is risky). For `teachable`, `true` means the candidate should be kept. For `skillworthy`, `true` means it is worth a skill. Include the close calls, not only the easy ones.
2. Save them as a JSON array. The fields per point: `plan` takes `message` and optionally `recent_conversation`; `ship` takes `request`, `patch` and optionally `acceptance_criteria` (an array of strings); `knowledge` takes `question`, `answer` and `document`; `blocking` takes `task`, `question` and `default`. `teachable` takes `candidate`, an object with non-empty strings `name`, `description`, `body` and `kind`. `skillworthy` takes the same `candidate` plus `occurrences`, an integer of at least 1. The body is cut to 800 characters before it is sent. For `teachable`, a label of `true` means the lesson should stand (probe actions `keep` and `auto-confirm` both agree; `drop` agrees with `false`). For `skillworthy`, `true` agrees with `keep` and `false` agrees with `skip`. For example `plan-cases.json`:

   ```json
   [
     { "message": "thanks, that works now", "label": false },
     { "message": "Add OAuth login with GitHub to the web app", "label": true },
     { "message": "rename getUser to fetchUser in api.ts and its test", "label": false }
   ]
   ```

   A `teachable` file is the same shape with a `candidate` object instead of `message`:

   ```json
   [
     {
       "candidate": {
         "name": "Use import type for type-only imports",
         "description": "tsc rejects a value import of a type.",
         "body": "When a file only needs a type, write import type. A value import fails under verbatimModuleSyntax.",
         "kind": "pitfall"
       },
       "label": true
     }
   ]
   ```

   `skillworthy` adds `"occurrences": 3` inside `candidate`. A missing `candidate`, an empty `name`, `description`, `body` or `kind`, or (for `skillworthy`) an `occurrences` that is not an integer of at least 1, exits 2 before any request, for example `Decisions probe: case #1: "candidate" must be a JSON object`.

3. Run them against the current thresholds:

   ```sh
   <clone>/bin/ultrathink decisions probe plan plan-cases.json
   ```

   Each case prints `#<n> P <P> · <action> · label <true|false> · agree` (or `DISAGREE`), and the last line counts them: `Decisions probe: plan · <model> · cases <n> · labelled <m> · agree <a>/<m> · errors <e>`.

4. Read the `DISAGREE` lines and their P values. Move the threshold in your `decisions` config past the cases you want on the other side, keeping in mind which mistake costs more (table above). Run the probe again to confirm.

`decisions probe` sends one request per case, one after another, so 50 cases take about 25 seconds and cost about $0.001. It reads the model and the thresholds from the config for the current directory and ignores `decisions.enabled` and `decisions.points`. With `ULTRATHINK_DECISIONS=0` set, it checks the file, then prints `Decisions probe: off (ULTRATHINK_DECISIONS=0)` and exits 1 without a request. Every case is checked before the first request; a bad file exits 2 with the reason, for example `Decisions probe: case #3: "message" must be a non-empty string`. Full output reference: [Commands: `bin/ultrathink decisions`](../commands.md#binultrathink-decisions).

## Pin the model

`decisions.model` defaults to the alias `~typesafe/jev-latest`, which follows TypeSafe's newest Jev on OpenRouter without an ultrathink release. An alias can move to a new model, and a new model can shift the probabilities your thresholds were tuned on. The shipped defaults were probed on `typesafe/jev-1.13-20260917`.

To keep your thresholds stable, pin the version:

```json
{ "decisions": { "enabled": true, "model": "typesafe/jev-1.13" } }
```

Whichever you choose, every decision records the model that actually answered (for example `typesafe/jev-1.13-20260917`), and `decisions check` shows it next to the one you asked for: `ok · typesafe/jev-1.13-20260917 (requested ~typesafe/jev-latest)`. When the resolved model changes, run your probe cases again before you trust the old thresholds.

## Cost and latency

- **Price.** At the time of writing, Jev costs $0.042 per million input tokens, and output is free. A typical plan-gate decision is about 450 tokens, about $0.000019. A ship check with a full 24 000-character patch is roughly 6 500 tokens, well under $0.001. A request estimated at over 28 000 tokens is never sent.
- **Requests per prompt.** At most one `plan` decision, one `knowledge` decision per settled question (up to 4) and one `blocking` decision per non-blocking question (up to 4). A knowledge answer that Jev rejects is added as an open question after the clarifier's own questions, only while fewer than `hitl.maxQuestions` are open, and then gets its own `blocking` check in a second round; with no slot left it is dropped and checked no further. Skill invocations (every `/gsd-*` run) and `uplift:` prompts make no `plan` decision, but their clarifying questions can still get `knowledge` and `blocking` decisions. A message the rules skip makes none. Each ship `assess` whose rule checks pass makes one `ship` decision.

- `teachable` and `skillworthy` are not asked while planning a prompt. `observe` asks `teachable` once per distilled candidate (at most 3). `teach promote --due` and automatic promotion ask `skillworthy` once per due moment. A failure at either point behaves as with Decisions off.
- **Latency.** About 500 ms per decision (median, measured from a Linux server). The plan gate runs before planning starts, so it adds that to each prompt the rules would plan (except skill invocations and `uplift:` prompts), and saves the whole planning pass when it skips. The knowledge and blocking checks of one round run at the same time. The ship check runs alongside the LLM judge and adds no wait of its own.
- **Budget.** `decisions.timeoutMs` (default 3000 ms, at most 30000) bounds one decision, its single retry included. Past it, the point goes on as without Jev.

## Security boundary

Decision models can be pushed to confident wrong answers by adversarial or unusual text in their state, such as a patch comment that says "this change is complete". ultrathink is built so that a wrong Jev answer is never the only thing in front of an action you cannot undo:

- **Jev never merges.** The merge gate stays Greptile's: a completed review of the exact PR head at 5/5 with no open threads, and CI neither pending nor failing. A PR that Jev approved faces the same gate. With `ship.autoMerge` on, Jev never stands in for a missing or failed LLM judge, so a Jev verdict alone never leads to a merge.
- **Everything Jev can do is recoverable.** A wrong skip is resent with `uplift:`. A wrong veto hands the work back. A wrong knowledge reject costs one extra question, or leaves that answer out when no question slot is free; it never pushes out one of the clarifier's own questions. A wrong blocking promote costs one extra question. Jev never demotes a blocking question, never turns an LLM "not done" into done and never overrides a rule gap.
- **Jev cannot add a lesson, and it cannot block an explicit promote.** `teachable` only drops or holds a candidate `observe` already produced. `skillworthy` only skips a due listing. `teach promote <id>` does not ask Jev. A failure at either point behaves as with Decisions off.
- **Deterministic rules come first.** Jev is asked only when the rules have left the action open. GSD roadmap and verification signals stay rules and never enter Jev's state.
- **The key stays yours.** It is sent only to `https://openrouter.ai/api/alpha/decisions`, or to `ULTRATHINK_DECISIONS_URL` when you set that in the environment, which is accepted only as an `https://openrouter.ai/…` URL or a loopback URL (`localhost`, `127.0.0.1`, `[::1]`) with no user name or password in it. Requests never follow a redirect. No config file can change the endpoint, so a cloned repository cannot redirect the key; and because ultrathink starts Bun with `--no-env-file`, the repository's `.env*` files cannot set the variable either on Bun 1.3.3 and later (Bun 1.2.x still loads them). The key never appears in output, records or error messages.
- **A repository cannot opt you in.** Its project file can turn Decisions off, drop points and turn `zdr` on, never the reverse, so opening a repository never sends your prompt, patch or knowledge-base text to OpenRouter unless you turned Jev on in your own config.
- **Your data.** Requests ask OpenRouter for zero data retention and `data_collection: "deny"` (`decisions.zdr`, on by default). Each request carries only the small state its question reads; see [Privacy: Jev decisions](../privacy.md#jev-decisions-openrouter).

## Turn it off again

- `"decisions": { "enabled": false }` in config (the default), or remove the key. No point sends a request, and `bin/ultrathink status` shows `Decisions: off (opt-in: set decisions.enabled)`. A project file can do this for its repository.
- `ULTRATHINK_DECISIONS=0` in the host's environment turns every point off for that process, whatever any config file says: no request, no record, no notice, and `decisions check` and `decisions probe` refuse. `bin/ultrathink status` then shows `Decisions: off (ULTRATHINK_DECISIONS=0)`.
- To stop one point only, leave it out of `decisions.points`, for example `"points": ["ship"]`.
- To remove the stored key: `<clone>/bin/ultrathink-mcp auth logout openrouter`, then revoke the key in your OpenRouter account settings.
