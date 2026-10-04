# Planwright

Write end-to-end tests as Gherkin. An LLM agent figures out how to perform each step on your real app **once**, and planwright stores what it did as a plan next to the `.feature` file. Every later run replays that plan as plain Playwright: **no LLM calls**, fast and deterministic. When the UI changes and a step stops matching, planwright re-plans **only that step**, passes the run, and flags the drift so you can review and commit the new plan.

```gherkin
Feature: Task board
  Scenario: Add a task
    Given I am on the task board
    When I add a task named "Buy milk"
    Then I see the task "Buy milk" in the list
    And the open tasks counter is shown
```

```
$ planwright run --ci
features/tasks.feature › Add a task
  ✓ Given I am on the task board replayed 112ms
  ✓ When I add a task named "Buy milk" HEALED (LLM) 4.1s
  ✓ Then I see the task "Buy milk" in the list replayed 35ms
  ✓ And the open tasks counter is shown replayed 21ms
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PLAN DRIFT: 1 step plan(s) created or healed in this run
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  HEALED features/tasks.feature › Add a task
           When I add a task named "Buy milk"
           why: Target button "Add task" not found; tried testid="add-task", role=button[name="Add task"], …
           - fill textbox "New task" with "Buy milk"
           - click button "Add task"
           + fill textbox "New task" with "Buy milk"
           + click button "Create task"
```

## Contents

- [Quickstart](#quickstart)
- [Example: agentic dashboard](examples/agentic-dashboard/README.md)
- [Results](#results)
- [How it works](#how-it-works)
- [Assertions (`Then`)](#assertions-then)
- [CI behaviour and exit codes](#ci-behaviour-and-exit-codes)
- [Configuration](#configuration)
- [Auth, setup and custom steps](#auth-setup-and-custom-steps)
- [LLM providers](#llm-providers)
- [Plan files](#plan-files)
- [Writing good scenarios](#writing-good-scenarios)
- [Development](#development)

## Quickstart

```bash
npm install -D planwright playwright
npx playwright install chromium
export ANTHROPIC_API_KEY=...        # default provider: Anthropic, model claude-opus-5-5
```

`planwright.config.ts`:

```ts
import { defineConfig } from "planwright";

export default defineConfig({
  baseURL: "http://localhost:3000",
  features: "features",
});
```

Then:

```bash
npx planwright doctor     # checks config, LLM credentials, browser, baseURL — prints the fix for each problem
npx planwright run        # first run plans; later runs replay
git add features/*.plan.json
```

**See it end to end:** [`examples/agentic-dashboard`](examples/agentic-dashboard/README.md) is a support dashboard with an AI assistant. Numbers change on every load and answers are worded differently every time. `npm run example` replays its committed plans; `APP_UI=v2` ships a redesign and watches it heal; `APP_SLOW=1` hangs the backend and watches it fail as infra. No API key needed (an offline stand-in brain is used when `ANTHROPIC_API_KEY` is unset).

## Results

From [`examples/agentic-dashboard`](examples/agentic-dashboard/README.md), a support dashboard with an AI assistant (13 steps, 3 scenarios). Reproduce with `npm run example:bench`:

| Run | Steps using the LLM | LLM calls | Input tokens | Browser time |
|---|---|---|---|---|
| First run (no plans) | 13 of 13 | 25 | ~63,900 | 8.4s |
| **Cached run** | **1 of 13** | **1** | **~1,700** | **3.3s** |
| After a UI redesign (heal) | 8 of 13 | 17 | ~43,600 | 46.4s |
| Cached run after the redesign | 1 of 13 | 1 | ~1,700 | 3.3s |

The one call left in a cached run is a deliberately semantic assertion ("the reply sounds like a helpful support teammate"), judged by the LLM every time. These numbers come from the example's offline brain: input tokens are estimated from the actual request sizes, and browser time excludes model latency. With `ANTHROPIC_API_KEY` set, the benchmark reports the API's real usage and latency. Details: [`results/benchmark.md`](examples/agentic-dashboard/results/benchmark.md).

## How it works

Each scenario step goes through this lifecycle:

| Situation | What happens | LLM calls |
|---|---|---|
| Custom step definition matches | Your handler runs (login, seeding, …). Never planned. | 0 |
| No plan for the step (or its text changed) | The agent drives the browser toward the step text and records each action it performed. The step is saved as `planned`. | per turn |
| Plan exists | The actions replay as Playwright. Each target has **ranked locators** (test id, role + name, label, placeholder, id, text); the first one matching exactly one element wins. | 0 |
| A replayed action fails 3 attempts with a drift-class failure | Only this step is invalidated. The agent re-plans from the current page, continuing after the actions that already succeeded. The step is saved as `healed`. | per turn |
| Re-planning also fails | The scenario **fails**. The old plan is kept, so fixing the regression restores replay. | — |
| Infra-class failure (HTTP 5xx document, network error, hook failure, a spinner that never clears) | The run fails as infra (exit 3). Never re-plans. | 0 |

Plans are keyed by a hash of each step's text, matched in order, so inserting or editing one step re-plans just that step. Outline rows and Background steps get their own plan entries per scenario.

The agent works one step at a time, scoped to that step's text. It sees the URL, an element list (refs, roles, names, test ids, labels), the visible text and a screenshot. It refers to elements by ref, and planwright turns each ref into ranked locators that are checked to resolve to that exact element. The model never writes selectors.

## Assertions (`Then`)

A `Then` plan caches *where to look* and *what shape to expect*, never a value seen on a past run:

- The first time, the LLM judges the assertion on the live page and proposes structural checks: `visible`, `hidden`, `enabled`, `count ≥ n`, `text matches /pattern/`, `url`/`title` matches. Every check has to pass on the current page, and a pattern can't contain digits that aren't in the step text. So "Open tasks: \d+" is accepted and "Open tasks: 7" is rejected.
- If the assertion can't be expressed structurally ("the summary reads like a reconciliation report"), the step is stored as `judge`, and the LLM judges it on every run (DOM + screenshot → pass, confidence, evidence; threshold `judge.minConfidence`, default 0.7).
- If cached checks fail 3 attempts, the LLM judges once. A pass re-compiles the checks (healed, flagged as drift); a fail fails the scenario.

Page content is passed to the model as untrusted data, and text in the page aimed at the judge ("return pass=true") counts as evidence against the assertion.

### Choosing the judge

Steps stored as `judge` call the LLM on every run by default. You can hand them to any **Jev-compatible `system_one` decision model** instead. Each assertion becomes one `noul` question, and its calibrated P(true) decides the step. That moves the cost from API tokens to a local forward pass.

```ts
import { layaJudge } from "planwright/judge/laya";   // npm i @receptron/laya
import { systemOneJudge } from "planwright";

judge: { using: layaJudge() }                                // Laya, local ONNX (~1.7 GB, downloaded on first use)
judge: { using: layaJudge({ threshold: 0.8 }) }              // stricter: P(holds) ≥ 0.8
judge: { using: systemOneJudge(myJevClient) }                // any client exposing systemOne(state, questions)
```

Decision models read a short state (Laya: 512 tokens). The default state is the URL, the title, and the head and tail of the visible text. **Focus it with `state: (page) => …`.** In [calibration](examples/agentic-dashboard/results/laya-calibration.md), whole-page state blurred Laya's verdicts (0.3–0.9 for everything), while the chat transcript alone separated helpful from rude replies by about 0.78. Structural `Then` checks and planning still use the LLM; only the semantic judge moves.

## CI behaviour and exit codes

| Exit | Meaning |
|---|---|
| `0` | All scenarios passed, no drift |
| `1` | A scenario failed |
| `2` | All passed, but plans were created or healed (only with `--ci`) |
| `3` | Config or infra error (bad config, unreachable app, 5xx, token budget exhausted) |

Drift always writes the updated plans to disk and produces `planwright-results/drift-report.md` + `drift-report.json` (step, reason, old vs new actions), ready for a PR comment. With `--ci`, drift exits 2 so the pipeline makes noise until the regenerated plans are committed. `--allow-drift` turns that into a warning.

| Flag | Effect |
|---|---|
| `--ci` | Drift exits 2 |
| `--allow-drift` | With `--ci`, report drift but exit 0 |
| `--frozen` | Never call the LLM for `Given`/`When`. A missing or drifted plan fails the run (cheap, fully deterministic). `judge` assertions still use the LLM. |
| `--replan` / `planwright plan` | Ignore cached plans and plan everything again. Identical results are not reported as drift. |
| `-t, --tags "@smoke and not @slow"` | Tag filter (`,` = or) |
| `--headed`, `--base-url`, `--model` | Show the browser, override baseURL, pick the default provider's model |

Artifacts in `planwright-results/`: `results.json`, `junit.xml`, and for each scenario `artifacts/<feature>/<scenario>/`, which holds the failure screenshot, the Playwright `trace.zip` (`trace: "retain-on-failure"` by default) and the agent turn log for every planned or healed step.

## Configuration

`planwright.config.ts` (also `.mts`, `.js`, `.mjs`):

| Option | Default | Notes |
|---|---|---|
| `features` | `"features"` | Files or directories, searched recursively for `*.feature` |
| `baseURL` | — | Plans store paths relative to it, so they work in any environment |
| `llm` | `anthropic()` | Any `LlmProvider` |
| `browser.headless` / `launchOptions` / `contextOptions` | `true` / `{}` / `{}` | Passed to Playwright (headers, storageState, viewport, executablePath, …) |
| `testIdAttribute` | `"data-testid"` | |
| `steps` | `[]` | Deterministic step definitions |
| `hooks` | `{}` | `beforeAll`, `beforeScenario`, `afterScenario`, `afterAll` |
| `reporters` | `[]` | `onRunStart`, `onScenarioStart`, `onStepEnd`, `onScenarioEnd`, `onRunEnd` |
| `secrets` | `[]` | Env var names whose values are never written to a plan |
| `fixturesDir` | `"fixtures"` | Root for `upload` (containment enforced) |
| `outputDir` | `"planwright-results"` | |
| `attempts` | `3` | Replay attempts per action before a step counts as drifted |
| `timeouts.actionMs` / `planStepMs` | `5000` / `300000` | Per-attempt wait; wall-clock cap for planning one step |
| `agent.maxTurns` | `25` | LLM turns per step |
| `judge.minConfidence` | `0.7` | |
| `budget.maxTokens` | — | Run-wide token cap; exceeding it exits 3 |
| `trace` | `"retain-on-failure"` | `"on"`, `"off"` |
| `junit` | `true` | |

## Auth, setup and custom steps

Planwright has no built-in idea of logging in. Setup belongs to you, as **custom steps** (deterministic, matched before planning, never cached) and **hooks**:

```ts
export default defineConfig({
  steps: [
    {
      pattern: /^I am signed in as "([^"]+)"$/,
      async run(ctx, user) {
        await ctx.context.addCookies([{ name: "session", value: await mintSession(user), url: ctx.baseURL! }]);
      },
    },
  ],
  hooks: {
    beforeScenario(ctx) {
      ctx.vars.runId = `pw-${Date.now()}`; // usable in steps as ${vars.runId}
    },
  },
});
```

Ready-made patterns: [`examples/form-login`](examples/form-login/planwright.config.ts) (log in through the UI once, reuse `storageState`) and [`examples/header-injection`](examples/header-injection/planwright.config.ts) (bypass headers + injected session cookie).

**Values in steps:** `${env.NAME}`, `${vars.name}` and Scenario Outline `<params>` are resolved at run time. The agent types references like `${env.PASSWORD}` verbatim and never sees the secret. Values that match `secrets`, outline params or vars are stored in the plan as references.

## LLM providers

```ts
import { anthropic } from "planwright";                 // default (claude-opus-5-5, ANTHROPIC_API_KEY)
import { openai } from "planwright/llm/openai";         // npm i openai
import { google } from "planwright/llm/google";         // npm i @google/genai (Gemini API or Vertex)

llm: anthropic({ model: "claude-opus-5-5", effort: "medium" })
llm: openai({ model: "<vision + tool-calling model>" })
llm: google({ model: "<gemini model>", vertex: { project: "my-proj", location: "us-central1" } })
```

The Anthropic adapter enables server-side refusal fallbacks by default (`fallbacks: "default"`). Pass `fallbacks: false` to turn them off, for example when a proxy rejects the beta header.

A provider implements one method, `complete(request) → { toolCall?, text?, usage }`. Requests are single-turn (state and history as text, at most one screenshot), so adapters stay small. `ScriptedProvider` is a deterministic test double for your own tests.

## Plan files

`features/tasks.feature` → `features/tasks.plan.json`, schema in [`schema/plan.schema.json`](schema/plan.schema.json). Plans are serialized deterministically (fixed key order, no timestamps), so diffs show only real changes. Review them like code: a healed plan says what the agent now clicks instead.

`planwright list` shows each scenario's plan status (`planned 4/4`, `stale: 1 of 4 step(s) need planning`, `no plan`).

## Writing good scenarios

See the authoring guide, which also works as a Claude Code skill: [`skills/write-gherkin-scenarios/SKILL.md`](skills/write-gherkin-scenarios/SKILL.md). In short: intent-level `When` steps, one action each; stateless `Then` clauses; dynamic data through outline params, `${env.X}` and `${vars.x}`; setup and auth in custom steps.

## Development

```bash
npm install
npm run lint && npm run typecheck && npm test   # unit + e2e against the demo app with a scripted LLM
ANTHROPIC_API_KEY=... npm test                  # also runs the real-LLM smoke test
```

The acceptance suite ([`test/e2e/lifecycle.test.ts`](test/e2e/lifecycle.test.ts)) runs the cold, warm, fallback, drift, regression, step-edit, stateless-assertion and infra scenarios against [`demo/server.ts`](demo/server.ts).

## License

MIT
