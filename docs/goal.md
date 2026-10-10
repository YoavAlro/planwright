# Planwright — design goals

## Context
Agentic E2E runners (Gherkin steps driven by an LLM through Playwright tool calls, `Then` steps
judged by an LLM from DOM + screenshot) are flexible but slow, costly and flaky, because the LLM
runs on every turn of every run. Planwright turns this into a "plan once, replay
deterministically, re-plan only when the page drifts" tool. It stays generic: no company-specific
code, endpoints or auth; those plug in through config (custom steps, hooks, context options).

## Repo & packaging
- New public GitHub repo: `YoavAlro/planwright`. License: MIT. npm package `planwright-e2e` (npm reserves `planwright` as too close to `playwright`); the CLI is still `planwright`.
- TypeScript, ESM, strict types, Node LTS. `playwright` as a peer dependency.
- Standalone CLI is the primary surface: `planwright run`, `planwright plan`,
  `planwright list`, `planwright doctor`. No Playwright Test integration in v1.

## Core concept
1. The CLI parses `.feature` files with `@cucumber/gherkin`. v1 supports Feature, Rule,
   Background, Scenario, Scenario Outline + Examples, tags (`--tags` filter), data tables
   and doc strings (passed to the agent as part of the step's goal).
2. Each scenario (each Examples row for outlines) has its own committed **plan**: an ordered
   action list per step.
3. **Replay**: if a valid plan exists, the step runs as pure Playwright with zero LLM calls.
4. **Planning**: if there is no plan, or the step text changed (keyed by a hash of normalized
   step text + resolved params), the LLM drives the browser toward the step goal, scoped
   strictly to that step. The successful action sequence becomes that step's plan.
5. **Self-healing**: if a replayed step fails 3 attempts in one run with a *drift-class*
   failure (locator not found / not actionable, assertion target missing, unexpected page
   shape), invalidate **only that step**, re-plan it with the LLM from the current page state,
   and continue. Infra-class failures (navigation error, 5xx, network, auth hook failure,
   timeout on a known-slow wait) never trigger re-planning; they fail the run as infra.
6. **Regression guard**: if re-planning also fails, the scenario fails. A healed step means
   the scenario passes but is flagged as drifted (see CI behaviour).

## Plan format
- One plan file per feature, next to it (`<name>.feature` → `<name>.plan.json`), committed to
  git. Deterministic serialization (stable key order, no timestamps or run IDs inside the
  plan) so diffs are reviewable. Schema-versioned, with a published JSON Schema.
- Env-agnostic: navigation is relative to `baseURL`.
- Per step: `stepHash`, `stepText`, `actions[]`, and metadata on how the step was produced
  (`planned` | `healed`), plus model/provider used. Custom steps are never stored.
- Actions: navigate, click, fill, select, press, check, upload, waitFor (visible/hidden with
  timeout), assert.
- Locators: a ranked list (role+name, testid, label, id, text). Replay tries them in order
  before counting an attempt as failed. This is cheap healing with no LLM.
- Secrets and dynamic values are never stored literally: plans reference
  `${env.NAME}`, `${param.name}` (outline params), `${vars.name}` (runtime vars such as a
  generated unique id). Planning must replace literals that match a known secret/param with
  the reference.

## `Then` semantics (stateless assertions)
- A `Then` plan caches **how to locate** the asserted thing and a **structural** check
  (visible, enabled, count >= n, text matches a pattern derived from the clause wording,
  URL matches). Never a literal value observed on a previous run.
- If a clause can't be compiled to a structural check (purely semantic, e.g. "the summary
  reads as a reconciliation report"), the plan marks it `judge: llm`, and the LLM judge
  evaluates it on every run (DOM + screenshot → `{pass, confidence, evidence}`, threshold
  configurable). The judge's system prompt treats page content as untrusted data
  (prompt-injection hardening).
- Compiled-assertion failure after 3 attempts → fall back to the LLM judge once. If the
  judge passes, re-compile the step (healed, flagged). If it fails, the scenario fails.

## Extensibility (where environment-specific concerns plug in)
`planwright.config.ts` via `defineConfig({...})`:
- `baseURL`, browser/context options (headers, storageState, viewport), timeouts, retries.
- `llm`: provider adapter. Defaults to the Anthropic adapter.
- `hooks`: `beforeAll`, `beforeScenario(ctx)`, `afterScenario(ctx, result)`, `afterAll`.
  `ctx` exposes the Playwright `browser`/`context`/`page`, scenario metadata, tags and `vars`.
- `steps`: custom deterministic step definitions (`pattern → handler(ctx, ...args)`). They are
  matched before planning and never planned or cached. This is where a consumer's login lives
  (e.g. `Given I am logged in as …`).
- `reporters`: built-in console, JSON and JUnit, plus a custom reporter interface (run/scenario/
  step lifecycle events, artifacts, usage). This is how an external system (e.g. a DB or admin UI)
  would ingest results.
- Ship an `examples/` folder with a generic auth adapter (form login → storageState reuse)
  and a header-injection example. Nothing vendor- or company-specific.

## LLM adapters
- A small `LlmProvider` interface: multimodal chat with tool calling + token usage reporting.
- **Default: Anthropic** (`@anthropic-ai/sdk` as a regular dependency, `ANTHROPIC_API_KEY`,
  current Claude model, overridable via config/`--model`).
- Also ship adapters for OpenAI and Google (Gemini API + Vertex) as optional peer deps.
- Guardrails: max turns per step, wall-clock cap per step, optional token budget per run.
  Usage is aggregated in the report.

## CI behaviour
- `--ci` mode. Exit codes: `0` all passed with no drift; `1` scenario failure; `2` all passed
  but plans were created or healed (drift); `3` config/infra error. `--allow-drift` downgrades
  2 → 0 (warning only).
- Drift always writes the updated plan files to disk, prints a loud summary (which step,
  why it was invalidated, old vs new actions), and writes `drift-report.md` + JSON so CI can
  post or annotate it. The developer commits the regenerated plans.
- `--frozen`: never call the LLM for `When` steps. A missing or broken plan is a failure
  (for cheap, deterministic runs).
- Artifacts per run: Playwright trace, screenshots on failure, the agent turn log for planned
  or healed steps.

## Authoring skill
Ship a Claude Code skill + doc (`skills/write-gherkin-scenarios/SKILL.md`) on writing
scenarios for Planwright:
- Intent-level `When` steps, scoped to one action each.
- Stateless `Then` clauses (assert presence, shape, patterns; never values that change between
  runs).
- Dynamic data via outline params / env / vars, never literal secrets.
- Use of tags, Background, and custom deterministic steps for setup/auth.
- Read-only vs mutating scenarios, and naming test-created data.

## Acceptance criteria
Proven by the library's own test suite against a small demo web app included in the repo, using
a scripted fake `LlmProvider` (deterministic, counts calls):
1. Cold run: no plan → scenario passes, plan file written, CI exit code 2.
2. Warm run: plan present → scenario passes with **zero** LLM calls, exit code 0.
3. Locator fallback: primary locator removed but a ranked fallback still matches → pass,
   zero LLM calls, no drift.
4. UI drift: rename/restructure an element so all locators fail → that step fails 3
   attempts, only that step is re-planned, the rest replay, pass, exit 2, drift report lists
   exactly that step.
5. Real regression: remove the feature → re-plan fails → scenario fails, exit 1.
6. Step text edit: only the edited step is re-planned.
7. Stateless `Then`: a value that changes between runs (e.g. a counter) does not break a
   compiled assertion.
8. Infra failure (server returns 500) does not trigger re-planning; exit 3.
9. Outline with 2 Examples rows → 2 independent plans; secrets/params stored as references.
10. Custom step definitions and hooks run, and are never planned.
11. `planwright doctor` reports a missing `ANTHROPIC_API_KEY` (or the configured provider's
    credentials) with the exact fix.

Also: one optional real-LLM smoke test against the demo app with the default Anthropic adapter
(skipped without an API key); lint/typecheck/tests green in GitHub Actions; README covering
quickstart, config, plan format, CI behaviour and exit codes.

## Non-goals (v1)
- Migrating existing in-house runners (they become consumers with their own adapters).
- Playwright Test integration, parallel workers, multi-browser matrix, visual regression.
- A hosted service or plan storage other than git.
