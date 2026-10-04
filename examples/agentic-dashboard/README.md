# Example: Support Ops (dashboard + AI assistant)

A small but realistic app to watch planwright work: a support dashboard whose numbers change on every load, and an AI assistant whose answers are worded differently every time. It shows the full lifecycle: plan → replay → heal after a redesign → fail on a real outage.

```
examples/agentic-dashboard/
  app/server.ts            the app (no dependencies; the assistant is a scripted fake, no API key needed)
  features/*.feature       the scenarios
  features/*.plan.json     committed plans, what planwright replays
  planwright.config.ts     starts the app in beforeAll, picks the LLM
  offline-brain.ts         offline stand-in for the LLM (used when ANTHROPIC_API_KEY is unset)
```

## Run it

From the repo root:

```bash
npm install
npm run example                          # build planwright, then `planwright run` in this folder
```

Or from this folder, after `npm run build` at the root: `npx planwright run`.

With `ANTHROPIC_API_KEY` set, the config uses the real default provider (Claude). Without it, it uses [`offline-brain.ts`](offline-brain.ts), a scripted stand-in that only knows this app. It sees exactly what a real model sees (step goal, element list, page text, what it already did), so planwright runs the same code either way. The committed plans were generated with it (`"generatedBy": {"provider": "scripted"}`). Run `npx planwright plan` with a key to regenerate them with Claude.

## The tour

### 1. Replay: no LLM

```bash
npx planwright run --ci
```

```
features/assistant.feature › Ask about the backlog
  ✓ Given I open the assistant replayed 131ms
  ✓ When I ask the assistant "How many open tickets do we have?" replayed 1171ms
  ✓ Then the assistant replies with a number of open tickets replayed 37ms
  ✓ And the reply sounds like a helpful support teammate judged (LLM) 345ms
...
3 passed · LLM: 1 call(s) · 3.0s · exit 0
```

Every step replays from the plan. The one LLM call is the **tone** assertion: "sounds like a helpful support teammate" can't be checked structurally, so it is judged on every run. The factual assertions are compiled into stateless checks:

| Step | Stored check | Why it survives changing data |
|---|---|---|
| `the assistant replies with a number of open tickets` | text of `.msg.assistant` matches `(?=.*\d)(?=.*\bopen\b)` | any count, any wording |
| `I see the open tickets KPI with a number` | text of the KPI card matches `Open tickets \d+` | the value changes every load |
| `I see customer satisfaction as a percentage` | text matches `\d+%` | |
| `the recent tickets table lists at least one ticket` | count of `#recent-tickets tbody tr` ≥ 1 | |
| `the recent tickets table shows "login page timing out"` | table text matches `login page timing out` | the literal came from the step itself |

### First run vs cached run

Measured on this example (13 steps, 3 scenarios). The first run starts with no plans; the second replays them:

| | First run (planning) | Second run (cached plans) |
|---|---|---|
| LLM calls | 25 (18 planning turns, 7 assertion compiles) | **1** (the tone judge) |
| Input tokens | ~64,000 | **~1,700** |
| Browser time | 9.1s | **3.4s** |
| Steps using the LLM | 13 of 13 | 1 of 13 |

Where the numbers come from:

- **Tokens** are estimated from the actual requests (≈4 characters per token, ≈1.2k tokens per 1280×720 screenshot). Every planning turn sends the element list, page text and a screenshot, so a turn costs ~2.5k input tokens. The offline brain reports these estimates. With a real provider, the usage the API returns is what's reported.
- **Browser time** leaves out model latency, because the offline brain answers instantly. With a real model, add roughly 25 × per-call latency to the first run (minutes) and 1 × to the second (seconds).
- **Cost at Claude Opus 5.5 rates ($4 / $20 per MTok):** the first run is about $0.25 of input plus output that depends on reasoning length. A cached run is under $0.02, almost all of it the tone judge. Drop or rephrase that one semantic `Then` and a cached run makes zero LLM calls.
- Most of the cached run's 3.4s is the app itself: the assistant takes 0.5–1.5s to answer, twice.

After that, every run costs what the second run costs, until the UI changes. Then only the changed steps pay planning prices again (section 2: 7 healed steps, 17 calls).

### 2. Ship a redesign: healing

`APP_UI=v2` ships "Support Ops 2.0": nav links renamed (Assistant → AI Assistant, Dashboard → Overview), the Send button becomes **Ask** with a new test id, the message box gets a new label, and the KPI test ids change.

```bash
APP_UI=v2 npx planwright run --ci
```

```
  ✓ Given I open the assistant HEALED (LLM)
  ✓ When I ask the assistant "How many open tickets do we have?" HEALED (LLM)
  ...
  HEALED features/assistant.feature › Ask about the backlog
           When I ask the assistant "How many open tickets do we have?"
           why: Target button "Send" not found; tried testid="send", role=button[name="Send"], text="Send".
           - fill textbox "Message" with "How many open tickets do we have?"
           - click button "Send"
           - wait for text "Thinking…" to be hidden
           + fill textbox "Message" with "How many open tickets do we have?"
           + click button "Ask"
           + wait for text "Thinking…" to be hidden
...
3 passed · exit 2
```

Things to notice:

- **Only broken steps are re-planned.** The message box kept its placeholder, so its ranked locators still found it with no LLM. Only the click on "Send" drifted, and the agent continued from there.
- **Assertions heal too.** The KPI checks failed on the old test ids. The judge confirmed the KPIs are still there, then the checks were re-compiled against the new ids.
- **Exit 2** in CI: everything passed, but the plans changed. Review `planwright-results/drift-report.md` and the `*.plan.json` diff, then commit. The next v2 run replays with no LLM calls.

`git checkout features/*.plan.json` resets the tour.

### 3. Break the backend: infra, not drift

```bash
APP_SLOW=1 npx planwright run --ci
```

```
  ✗ When I ask the assistant "How many open tickets do we have?"
      Known-slow wait timed out: text "Thinking…" still visible after 20000ms.
...
1 passed, 2 failed · LLM: no calls · exit 3
```

The assistant never answers. Planwright recognizes a stuck "Thinking…" indicator as a slow backend, not a changed page. It doesn't re-plan, doesn't touch the plan, and exits 3.

### 4. Remove a feature: a real failure

Delete the Ask/Send button from `app/server.ts` and run again. The cached plan drifts, re-planning finds no way to send a message, the scenario **fails** (exit 1) and the old plan is kept. Healing never papers over a missing feature.

## What makes these scenarios plan well

- `When` steps are single intents ("I ask the assistant …"), not click paths.
- `Then` steps describe shape, not values: "a number of open tickets", never "37 open tickets".
- Tone and helpfulness are separate `Then`s, so only they pay for an LLM call per run.
- The mutating scenario is tagged `@mutating`, so a read-only production smoke run can skip it: `-t "not @mutating"`.

Full guide: [`skills/write-gherkin-scenarios/SKILL.md`](../../skills/write-gherkin-scenarios/SKILL.md).
