import type { Action } from "../plan/types.js";

export type StepMode = "custom" | "replayed" | "planned" | "healed" | "judged" | "skipped";
export type StepStatus = "passed" | "failed" | "skipped";
export type FailureKind = "failure" | "infra" | "config";

export interface StepResult {
  keyword: string;
  text: string;
  status: StepStatus;
  mode: StepMode;
  durationMs: number;
  llmCalls: number;
  error?: string;
  failureKind?: FailureKind;
  /** Present when the plan for this step was created or replaced in this run. */
  drift?: DriftEntry;
  evidence?: string;
}

export interface DriftEntry {
  feature: string;
  scenario: string;
  step: string;
  kind: "new" | "healed";
  /** Why the old plan was invalidated (healed only). */
  reason?: string;
  oldActions?: Action[];
  newActions: Action[];
}

export interface ScenarioResult {
  feature: string;
  key: string;
  name: string;
  status: StepStatus;
  failureKind?: FailureKind;
  error?: string;
  durationMs: number;
  steps: StepResult[];
  artifacts: string[];
}

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface RunResult {
  exitCode: 0 | 1 | 2 | 3;
  scenarios: ScenarioResult[];
  drift: DriftEntry[];
  plansWritten: string[];
  usage: Usage;
  durationMs: number;
  /** Error that aborted the run before or between scenarios (config/infra). */
  fatal?: string;
}
