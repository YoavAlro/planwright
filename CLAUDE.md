# Planwright — contributor guide

Gherkin → Playwright runner: an LLM plans each step once, plans are committed as `*.plan.json`, replay is pure Playwright, and only drifted steps are re-planned. Product spec: [docs/goal.md](docs/goal.md). User docs: [README.md](README.md).

## Layout

| Path | What |
|---|---|
| `src/runner.ts` | Run orchestration: scenario loop, replay → heal → regression guard, exit codes |
| `src/agent/planner.ts` | LLM loop for `Given`/`When` steps; records actions with ranked locators |
| `src/agent/asserter.ts` | `Then` compile (structural checks), stateless guard, LLM judge |
| `src/agent/prompts.ts` | System prompts + tool schemas |
| `src/runtime/` | Page capture, locators, deterministic action executor, error classes |
| `src/plan/` | Plan types, deterministic store, `${env/param/vars}` templating, step hashing |
| `src/llm/` | `LlmProvider` interface, Anthropic (default), OpenAI, Google, `ScriptedProvider` |
| `src/gherkin/parse.ts` | Feature → scenarios (pickles), scenario keys, tag filter |
| `demo/server.ts` | Demo app with variants (drift, regression, 5xx) used by tests |
| `test/e2e/` | Acceptance tests with a scripted LLM (`test/support/brain.ts`) |

## Invariants

- Error classes drive behaviour: `DriftError` → eligible for healing; `InfraError` → exit 3, never re-plan; `StepFailedError` → scenario failure; `ConfigError` → exit 3.
- Plans never contain secrets, outline values or runtime vars (only `${...}` references), and never contain observed values in `Then` checks.
- Plan serialization must stay byte-stable (`src/plan/store.ts`); bump `PLAN_SCHEMA_VERSION` and `schema/plan.schema.json` together on shape changes.
- No vendor/company-specific code in `src/`. Auth and environment quirks belong in user config (`examples/`).

## Commands

```bash
npm run lint && npm run typecheck && npm test
npm run build
```
