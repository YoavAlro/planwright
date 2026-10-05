import pc from "picocolors";

import type { ScenarioInfo } from "../config.js";
import { describeAction } from "../runtime/actions.js";
import type { RunResult, ScenarioResult, StepResult } from "./types.js";

const MODE_LABEL: Record<StepResult["mode"], string> = {
  custom: "custom",
  replayed: "replayed",
  planned: "planned (LLM)",
  healed: "HEALED (LLM)",
  judged: "judged",
  skipped: "skipped",
};

export class ConsoleReporter {
  constructor(private readonly write: (text: string) => void) {}

  scenarioStart(info: ScenarioInfo): void {
    this.write(`\n${pc.bold(info.feature)} › ${info.key}\n`);
  }

  stepEnd(step: StepResult): void {
    const icon = step.status === "passed" ? pc.green("✓") : step.status === "failed" ? pc.red("✗") : pc.dim("-");
    const mode =
      step.status === "failed" ? "" : step.mode === "healed" ? pc.yellow(MODE_LABEL[step.mode]) : pc.dim(MODE_LABEL[step.mode]);
    this.write(`  ${icon} ${step.keyword} ${step.text} ${mode}${step.status !== "skipped" ? pc.dim(` ${step.durationMs}ms`) : ""}\n`);
    if (step.error) this.write(`      ${pc.red(step.error)}\n`);
  }

  scenarioEnd(result: ScenarioResult): void {
    if (result.status === "failed" && result.error && !result.steps.some((s) => s.error)) {
      this.write(`  ${pc.red(result.error)}\n`);
    }
  }

  runEnd(result: RunResult, opts: { ci: boolean; allowDrift: boolean; outputDir: string; noCache?: boolean }): void {
    const passed = result.scenarios.filter((s) => s.status === "passed").length;
    const failed = result.scenarios.length - passed;
    if (result.fatal) this.write(`\n${pc.red(pc.bold(result.fatal))}\n`);

    if (result.drift.length) {
      const bar = pc.yellow("━".repeat(72));
      this.write(`\n${bar}\n${pc.yellow(pc.bold(`  PLAN DRIFT: ${result.drift.length} step plan(s) created or healed in this run`))}\n${bar}\n`);
      for (const d of result.drift) {
        this.write(`  ${pc.yellow(d.kind === "healed" ? "HEALED" : "NEW   ")} ${d.feature} › ${d.scenario}\n           ${d.step}\n`);
        if (d.reason) this.write(`           ${pc.dim(`why: ${d.reason}`)}\n`);
        for (const a of d.oldActions ?? []) this.write(`           ${pc.red(`- ${describeAction(a)}`)}\n`);
        for (const a of d.newActions) this.write(`           ${pc.green(`+ ${describeAction(a)}`)}\n`);
      }
      this.write(
        `  Updated plans: ${result.plansWritten.join(", ") || "(none)"}\n  Review and commit them. Report: ${opts.outputDir}/drift-report.md\n${bar}\n`,
      );
    }

    if (opts.noCache) this.write(pc.dim("\n--no-cache: every step was planned from scratch; no plan files were read or written.\n"));
    const usage = result.usage.calls
      ? `LLM: ${result.usage.calls} call(s), ${result.usage.inputTokens + result.usage.outputTokens} tokens`
      : "LLM: no calls";
    this.write(
      `\n${pc.bold(`${passed} passed`)}${failed ? pc.red(pc.bold(`, ${failed} failed`)) : ""} · ${usage} · ${(result.durationMs / 1000).toFixed(1)}s · exit ${result.exitCode}\n`,
    );
    if (result.exitCode === 2) this.write(pc.yellow("Exit 2: scenarios passed but plans drifted (--ci). Commit the updated plans or pass --allow-drift.\n"));
    else if (opts.ci && opts.allowDrift && result.drift.length) this.write(pc.yellow("Warning: plans drifted (allowed by --allow-drift).\n"));
  }
}
