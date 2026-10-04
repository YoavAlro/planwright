# Benchmark: examples/agentic-dashboard

LLM: Claude via the Claude Code CLI (real usage and latency; input includes cached tokens).
Judge for semantic Then steps: the LLM.

| Run | Steps using the LLM | LLM calls | Input tokens | Output tokens | Wall time | Exit |
|---|---|---|---|---|---|---|
| First run (no plans) | 13 of 13 | 25 | 208,911 | 4,204 | 105.9s | 0 |
| Cached run | 2 of 13 | 2 | 7,058 | 305 | 10.2s | 0 |
| After v2 redesign (heal) | 9 of 13 | 18 | 131,778 | 2,719 | 111.8s | 0 |
| Cached run on v2 | 2 of 13 | 2 | 7,094 | 329 | 11.2s | 0 |

Step modes per run:

- First run (no plans): 13 planned
- Cached run: 11 replayed, 2 judged
- After v2 redesign (heal): 7 healed, 2 judged, 4 replayed
- Cached run on v2: 11 replayed, 2 judged

Healed steps in cached runs (should be none):

- none



