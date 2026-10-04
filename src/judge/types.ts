import type { PageState } from "../runtime/page-state.js";

export interface Verdict {
  pass: boolean;
  /** 0..1. For probability-based judges this is P(assertion holds). */
  confidence: number;
  evidence: string;
}

export interface JudgeInput {
  /** The Gherkin assertion, e.g. "Then the reply sounds like a helpful support teammate". */
  assertion: string;
  /** Page snapshot: URL, title, visible text, element list (no screenshot). */
  state: PageState;
}

/**
 * Decides semantic `Then` steps that can't be compiled into structural checks
 * (stored as `judge` in the plan). Default: the configured LLM provider.
 * Set `judge` in the config to use something else, e.g. a local decision model.
 */
export interface Judge {
  readonly name: string;
  judge(input: JudgeInput): Promise<Verdict>;
  /** Called once at the end of the run, to free models or connections. */
  close?(): Promise<void>;
}
