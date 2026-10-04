---
name: write-gherkin-scenarios
description: Write or review Gherkin .feature scenarios for planwright (LLM-planned, Playwright-replayed E2E tests). Use when adding a scenario, turning a manual test or bug report into a feature file, or when a scenario keeps drifting, judging, or failing for unclear reasons.
---

# Writing scenarios for planwright

Planwright plans each step once with an LLM, stores the actions in `<name>.plan.json`, and replays them deterministically afterwards. Scenarios that follow these rules plan reliably, replay with zero LLM calls, and fail only when the product is actually broken.

## 1. One intent per `When` step

The agent works on one step at a time and stops as soon as that step's goal is met. Write each `When` as a single user intent, phrased the way a user would say it:

```gherkin
# Good
When I add a task named "Buy milk"
And I mark the task "Buy milk" as done

# Bad: two intents in one step; the plan boundary and the failure point are ambiguous
When I add a task named "Buy milk" and mark it as done

# Bad: selector-level; it breaks on every redesign and that is not the point of planwright
When I click "#form > div:nth-child(2) > button"
```

Name the thing being acted on precisely ("the task 'Buy milk'", "the Save button in the billing dialog") when the page has several candidates.

## 2. Stateless `Then` steps

Plans for `Then` steps are replayed on later runs where the data is different. Assert what has to be true every time, not what happened to be on screen once:

```gherkin
# Good
Then I see the task "Buy milk" in the list
And the open tasks counter is shown
And the URL is the tasks page
And at least one invoice row is listed

# Bad: pins an observed value; the next run has 8 tasks
Then the counter says "Open tasks: 7"
```

Literal values belong in a `Then` only when the scenario itself produced them (the name you typed in a `When`, an outline param). Planwright rejects compiled checks with digits that aren't in the step text, and falls back to an LLM judge on every run, which is slower and costs tokens.

Semantic assertions ("the summary explains why the invoice was rejected") are allowed. They are judged by the LLM on every run, so keep them few.

## 3. Dynamic data and secrets

| Need | Write | Stored in the plan as |
|---|---|---|
| Per-row variants | `Scenario Outline` + `Examples`, `"<name>"` in steps | `${param.name}` |
| Secrets (passwords, tokens) | `"${env.APP_PASSWORD}"` in the step, and list the var under `secrets` in the config | `${env.APP_PASSWORD}` |
| Unique per-run values | set `ctx.vars.runId` in a `beforeScenario` hook, write `"${vars.runId}"` | `${vars.runId}` |

The agent types `${env.X}` references verbatim and never sees the value. Never put a real secret in a `.feature` file.

Scenarios that create data should give it a recognizable, unique name (`"[pw] Buy milk ${vars.runId}"`). That way replays don't collide with leftovers from earlier runs, and test data is easy to clean up.

## 4. Setup and auth are custom steps, not agent steps

Logging in, seeding data and minting sessions are deterministic code. Register them as `steps` in `planwright.config.ts` and use them as `Given` steps:

```gherkin
Given I am signed in as "ada"        # custom step: cookie / storageState, never planned
When I open my account page          # planned by the agent
```

Custom steps are matched before planning and never cached. Put shared setup in `Background:`. It runs, and is planned, per scenario.

## 5. Read-only vs mutating

Keep read-only scenarios (navigation, dashboards, search) separate from mutating ones (create, upload, delete), for example with tags: `@readonly`, `@mutating`. Run mutating scenarios only against environments where test data is acceptable (`planwright run -t "not @mutating"` for production smoke runs).

## 6. Tags

Use tags for selection, not meaning: `@smoke`, `@slow`, `@mutating`, `@team-billing`. Filter with `-t "@smoke and not @slow"` or `-t "@a,@b"`.

## When a scenario misbehaves

| Symptom | Likely cause | Fix |
|---|---|---|
| A step is re-planned on every run | The step text includes changing data, or the agent's actions differ run to run | Remove dynamic data from the step, or make the element names unique |
| A `Then` shows `judged (LLM)` every run | The assertion pins a value, or is semantic | Rephrase it statelessly (section 2) |
| Healing "succeeds" on a broken feature | The `When` was vague enough that a different flow satisfied it | Make the intent specific (section 1) |
| The step fails with "Agent could not achieve" | The feature is missing or the wording doesn't match the UI | Check the agent log in `planwright-results/artifacts/...` |
| Exit 3 | Infra: 5xx, unreachable app, hook failure, a spinner that never cleared | Fix the environment; planwright never re-plans on infra |

Review `*.plan.json` diffs in PRs like code. A healed step shows exactly what the agent now clicks instead.
