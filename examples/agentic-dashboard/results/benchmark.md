# Benchmark: examples/agentic-dashboard

LLM: offline brain: token usage estimated from request sizes, no model latency.

| Run | Steps using the LLM | LLM calls | Input tokens | Output tokens | Wall time | Exit |
|---|---|---|---|---|---|---|
| First run (no plans) | 13 of 13 | 25 | 63,860 | 565 | 8.4s | 0 |
| Cached run | 1 of 13 | 1 | 1,655 | 26 | 3.3s | 0 |
| After v2 redesign (heal) | 8 of 13 | 17 | 43,608 | 319 | 46.4s | 0 |
| Cached run on v2 | 1 of 13 | 1 | 1,674 | 26 | 3.3s | 0 |

Step modes per run:

- First run (no plans): 13 planned
- Cached run: 12 replayed, 1 judged
- After v2 redesign (heal): 7 healed, 5 replayed, 1 judged
- Cached run on v2: 12 replayed, 1 judged

Output tokens count tool calls only (no reasoning tokens), and wall time excludes model latency. Run with ANTHROPIC_API_KEY for real numbers.
