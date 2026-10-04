/**
 * Reproducible benchmark for this example: first run (no plans) vs cached run
 * vs a run after the v2 redesign. Writes results/benchmark.{json,md}.
 *
 *   npm run example:bench        (from the repo root)
 *
 * Uses the offline brain, whose token usage is estimated from the real request
 * sizes (see ScriptedProvider). With ANTHROPIC_API_KEY set it uses Claude and
 * reports the API's real usage and latency instead.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { anthropic, resolveConfig, run, type RunResult } from "planwright";
import { layaJudge } from "planwright/judge/laya";

import { startApp } from "./app/server.ts";
import { offlineBrain } from "./offline-brain.ts";

const here = dirname(fileURLToPath(import.meta.url));
const real = !!process.env.ANTHROPIC_API_KEY;
const laya = process.env.PLANWRIGHT_JUDGE === "laya";
const work = mkdtempSync(join(tmpdir(), "planwright-bench-"));
cpSync(join(here, "features"), join(work, "features"), { recursive: true });
for (const f of readdirSync(join(work, "features"))) if (f.endsWith(".plan.json")) rmSync(join(work, "features", f));

interface Row {
  label: string;
  exitCode: number;
  wallMs: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  steps: number;
  llmSteps: number;
  modes: Record<string, number>;
}

async function measure(label: string, ui: "v1" | "v2"): Promise<Row> {
  const app = await startApp({ ui });
  try {
    const llm = real ? anthropic() : offlineBrain();
    const config = resolveConfig(
      { baseURL: app.url, llm, trace: "off", timeouts: { actionMs: 3_000 }, ...(laya ? { judge: { using: layaJudge() } } : {}) },
      work,
    );
    const started = Date.now();
    const result: RunResult = await run({ config, write: () => undefined });
    const steps = result.scenarios.flatMap((s) => s.steps);
    return {
      label,
      exitCode: result.exitCode,
      wallMs: Date.now() - started,
      calls: result.usage.calls,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      steps: steps.length,
      llmSteps: steps.filter((s) => s.llmCalls > 0).length,
      modes: steps.reduce<Record<string, number>>((m, s) => ((m[s.mode] = (m[s.mode] ?? 0) + 1), m), {}),
    };
  } finally {
    await app.close();
  }
}

const rows = [
  await measure("First run (no plans)", "v1"),
  await measure("Cached run", "v1"),
  await measure("After v2 redesign (heal)", "v2"),
  await measure("Cached run on v2", "v2"),
];

const fmt = (n: number) => n.toLocaleString("en-US");
const md = [
  `# Benchmark: examples/agentic-dashboard`,
  "",
  `LLM: ${real ? "Claude via the Anthropic API (real usage and latency)" : "offline brain: token usage estimated from request sizes, no model latency"}.`,
  `Judge for semantic Then steps: ${laya ? "Laya, local (no LLM tokens)" : "the LLM"}.`,
  "",
  "| Run | Steps using the LLM | LLM calls | Input tokens | Output tokens | Wall time | Exit |",
  "|---|---|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r.label} | ${r.llmSteps} of ${r.steps} | ${r.calls} | ${fmt(r.inputTokens)} | ${fmt(r.outputTokens)} | ${(r.wallMs / 1000).toFixed(1)}s | ${r.exitCode} |`,
  ),
  "",
  "Step modes per run:",
  "",
  ...rows.map((r) => `- ${r.label}: ${Object.entries(r.modes).map(([k, v]) => `${v} ${k}`).join(", ")}`),
  "",
  real
    ? ""
    : "Output tokens count tool calls only (no reasoning tokens), and wall time excludes model latency. Run with ANTHROPIC_API_KEY for real numbers.",
  "",
].join("\n");

mkdirSync(join(here, "results"), { recursive: true });
const suffix = laya ? "-laya" : "";
writeFileSync(
  join(here, "results", `benchmark${suffix}.json`),
  JSON.stringify({ llm: real ? "anthropic" : "offline-estimate", judge: laya ? "laya" : "llm", rows }, null, 2) + "\n",
);
writeFileSync(join(here, "results", `benchmark${suffix}.md`), md);
rmSync(work, { recursive: true, force: true });
process.stdout.write(md);
