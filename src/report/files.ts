import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ResolvedConfig } from "../config.js";
import { describeAction } from "../runtime/actions.js";
import type { RunResult } from "./types.js";

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderJUnit(result: RunResult): string {
  const byFeature = new Map<string, RunResult["scenarios"]>();
  for (const s of result.scenarios) byFeature.set(s.feature, [...(byFeature.get(s.feature) ?? []), s]);
  const suites = [...byFeature.entries()].map(([feature, scenarios]) => {
    const failures = scenarios.filter((s) => s.status === "failed").length;
    const cases = scenarios.map((s) => {
      const time = (s.durationMs / 1000).toFixed(3);
      const steps = s.steps.map((st) => `${st.status.padEnd(7)} ${st.keyword} ${st.text} [${st.mode}]`).join("\n");
      const failure = s.status === "failed" ? `<failure message="${xml(s.error ?? "failed")}" type="${s.failureKind ?? "failure"}">${xml(steps)}</failure>` : "";
      return `    <testcase classname="${xml(feature)}" name="${xml(s.key)}" time="${time}">${failure}<system-out>${xml(steps)}</system-out></testcase>`;
    });
    return `  <testsuite name="${xml(feature)}" tests="${scenarios.length}" failures="${failures}">\n${cases.join("\n")}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${result.scenarios.length}">\n${suites.join("\n")}\n</testsuites>\n`;
}

export function renderDriftMarkdown(result: RunResult): string {
  const lines = [
    "# Planwright plan drift",
    "",
    `${result.drift.length} step plan(s) were created or healed. Scenarios passed with the new plans; review the diff and commit the updated plan files.`,
    "",
    `Updated plan files: ${result.plansWritten.map((p) => `\`${p}\``).join(", ") || "(none)"}`,
    "",
  ];
  for (const d of result.drift) {
    lines.push(`## ${d.kind === "healed" ? "Healed" : "New"}: ${d.step}`, "", `- Feature: \`${d.feature}\``, `- Scenario: ${d.scenario}`);
    if (d.reason) lines.push(`- Why the old plan was invalidated: ${d.reason}`);
    lines.push("", "```diff");
    for (const a of d.oldActions ?? []) lines.push(`- ${describeAction(a)}`);
    for (const a of d.newActions) lines.push(`+ ${describeAction(a)}`);
    lines.push("```", "");
  }
  return lines.join("\n");
}

export function writeReports(config: ResolvedConfig, result: RunResult): void {
  mkdirSync(config.outputDir, { recursive: true });
  writeFileSync(join(config.outputDir, "results.json"), JSON.stringify(result, null, 2));
  if (config.junit) writeFileSync(join(config.outputDir, "junit.xml"), renderJUnit(result));
  if (result.drift.length) {
    writeFileSync(join(config.outputDir, "drift-report.md"), renderDriftMarkdown(result));
    writeFileSync(
      join(config.outputDir, "drift-report.json"),
      JSON.stringify({ drift: result.drift, plansWritten: result.plansWritten }, null, 2),
    );
  }
}
