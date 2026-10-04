/**
 * Failure classes. The split decides whether planwright may re-plan:
 * - DriftError: the page no longer matches the plan → eligible for healing.
 * - InfraError: the environment is broken → never re-plan, exit code 3.
 * - StepFailedError: the agent could not achieve the step → scenario fails.
 */
export class DriftError extends Error {
  override name = "DriftError";
}

export class InfraError extends Error {
  override name = "InfraError";
}

export class StepFailedError extends Error {
  override name = "StepFailedError";
  /** Agent turn log, when the failure came from the planner. */
  turns?: unknown[];
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export class PlanFileError extends ConfigError {
  override name = "PlanFileError";
}

export class BudgetExceededError extends InfraError {
  override name = "BudgetExceededError";
}

const NETWORK_ERROR = /net::ERR_|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|Target page, context or browser has been closed/;

/** Maps a raw Playwright error to a planwright class. Defaults to drift: an element that never became actionable. */
export function classifyPlaywrightError(err: unknown): DriftError | InfraError {
  if (err instanceof DriftError || err instanceof InfraError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (NETWORK_ERROR.test(message)) return new InfraError(message);
  return new DriftError(message);
}
