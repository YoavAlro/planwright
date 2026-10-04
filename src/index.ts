export { defineConfig, loadConfig, resolveConfig, discoverFeatures } from "./config.js";
export type {
  PlanwrightConfig,
  ResolvedConfig,
  Hooks,
  Reporter,
  ScenarioContext,
  ScenarioInfo,
  StepDefinition,
} from "./config.js";

export { run } from "./runner.js";
export { doctor, list } from "./commands.js";
export type { RunOptions } from "./runner.js";

export { anthropic, AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./llm/anthropic.js";
export type { AnthropicProviderOptions } from "./llm/anthropic.js";
export { ScriptedProvider } from "./llm/scripted.js";
export { systemOneJudge, defaultJudgeState } from "./judge/system-one.js";
export type { SystemOneClient, SystemOneJudgeOptions } from "./judge/system-one.js";
export type { Judge, JudgeInput, Verdict } from "./judge/types.js";
export type { ScriptedHandler, ScriptedRequestMeta } from "./llm/scripted.js";
export type { LlmProvider, LlmRequest, LlmResponse, LlmTool, LlmToolCall, LlmContentPart, LlmUsage } from "./llm/types.js";

export { parseFeatureFile, parseFeatureSource, matchesTags } from "./gherkin/parse.js";
export type { ParsedFeature, ParsedScenario, ScenarioStep } from "./gherkin/parse.js";

export { loadPlan, savePlan, serializePlan, planPathFor } from "./plan/store.js";
export { PLAN_SCHEMA_VERSION } from "./plan/types.js";
export type { Action, Check, FeaturePlan, LocatorSpec, PlannedStep, ScenarioPlan, Target } from "./plan/types.js";

export type { DriftEntry, RunResult, ScenarioResult, StepResult, Usage } from "./report/types.js";
export { ConfigError, DriftError, InfraError, StepFailedError } from "./runtime/errors.js";
export type { ElementInfo, PageState } from "./runtime/page-state.js";
