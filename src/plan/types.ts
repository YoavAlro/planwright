/** Bump when the on-disk plan shape changes incompatibly. */
export const PLAN_SCHEMA_VERSION = 1;

/** One way of finding an element. A target carries several, ranked best-first. */
export type LocatorSpec =
  | { by: "testid"; value: string }
  | { by: "role"; role: string; name: string }
  | { by: "label"; value: string }
  | { by: "placeholder"; value: string }
  | { by: "id"; value: string }
  | { by: "text"; value: string }
  | { by: "css"; value: string };

export interface Target {
  /** Ranked best-first. Replay uses the first one that resolves to exactly one element. */
  locators: LocatorSpec[];
  /** Human-readable description, only for reports and diffs. */
  description?: string;
}

/**
 * A structural assertion. Never holds a value observed on a previous run;
 * `pattern` is derived from the step wording (see guard in agent/asserter.ts).
 */
export type Check =
  | { kind: "visible"; target: Target }
  | { kind: "hidden"; target: Target }
  | { kind: "enabled"; target: Target }
  | { kind: "count"; target: Target; min: number }
  | { kind: "text"; target: Target; pattern: string; flags?: string }
  | { kind: "url"; pattern: string; flags?: string }
  | { kind: "title"; pattern: string; flags?: string };

export type Action =
  | { type: "navigate"; url: string }
  | { type: "click"; target: Target }
  | { type: "fill"; target: Target; value: string }
  | { type: "select"; target: Target; value: string }
  | { type: "press"; key: string; target?: Target }
  | { type: "check"; target: Target; checked: boolean }
  | { type: "upload"; target: Target; file: string }
  | { type: "waitFor"; target: Target; state: "visible" | "hidden"; timeoutMs?: number }
  | { type: "assert"; check: Check }
  /** Semantic `Then` that cannot be compiled: judged by the LLM on every run. */
  | { type: "judge" };

export type StepSource = "planned" | "healed";

export interface PlannedStep {
  /** Hash of keyword type + step text (+ argument). Changing the text invalidates the step. */
  hash: string;
  keyword: string;
  text: string;
  source: StepSource;
  generatedBy: { provider: string; model: string };
  actions: Action[];
}

export interface ScenarioPlan {
  name: string;
  steps: PlannedStep[];
}

export interface FeaturePlan {
  $schema?: string;
  version: number;
  feature: string;
  /** Keyed by scenario key (see gherkin/parse.ts). */
  scenarios: Record<string, ScenarioPlan>;
}
