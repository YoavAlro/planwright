# Laya calibration: "the reply sounds like a helpful support teammate"

Run on an Apple-silicon MacBook Pro with `npm run example:laya-calibrate` (Laya via `@receptron/laya`, ONNX on CPU).
Each cell is Laya's P(true) for the assertion, given that reply in that page state.

Real reply: "42 tickets are open. Most are billing questions."

| state | question | real reply (good) | helpful, other wording (good) | rude (bad) | error | off-topic (bad) |
|---|---|---|---|---|---|---|
| conversation | is it true | **0.850** | **0.908** | **0.072** | 0.886 | **0.045** |
| page (default) | chat judge | 0.821 | 0.898 | 0.815 | 0.828 | 0.876 |
| page (default) | assertion holds | 0.477 | 0.531 | 0.435 | 0.492 | 0.561 |
| last reply only | statement | 0.546 | 0.744 | 0.040 | 0.633 | 0.089 |
| conversation | statement | 0.772 | 0.872 | 0.061 | 0.863 | 0.070 |
| last reply only | is it true | 0.532 | 0.855 | 0.029 | 0.670 | 0.071 |
| page (default) | is it true | 0.377 | 0.773 | 0.444 | 0.517 | 0.546 |
| conversation | chat judge | 0.731 | 0.884 | 0.053 | 0.927 | 0.050 |
| page (default) | statement | 0.298 | 0.608 | 0.448 | 0.439 | 0.533 |
| last reply only | assertion holds | 0.490 | 0.669 | 0.151 | 0.758 | 0.152 |
| conversation | assertion holds | 0.394 | 0.539 | 0.174 | 0.827 | 0.113 |
| last reply only | chat judge | 0.104 | 0.799 | 0.073 | 0.548 | 0.050 |

("assertion holds" was planwright's original question; "is it true" is `Is it true that <assertion>?`.)

## Findings

1. **State matters more than phrasing.** With the whole page (nav, headings, greeting) as state, good and bad replies score alike (0.3–0.9). With just the chat transcript, they separate.
2. **Best setup: conversation + "Is it true that …?"** Good replies score 0.85–0.91 and bad ones 0.05–0.07, a margin of about 0.78. A threshold of 0.5 sits safely in the gap.
3. **An apologetic error reply *sounds* helpful (0.89).** That isn't a Laya mistake: tone is the wrong layer for catching errors. The structural step `the assistant replies with a number of open tickets` fails on it. Keep tone and correctness as separate assertions.

## Applied

- planwright's default `system_one` question is now `Is it true that <assertion>?` (Gherkin keyword stripped).
- The example judges the chat transcript (`judge-state.ts`) with `threshold: 0.5`.
