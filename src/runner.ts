import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { chromium, selectors, type Browser, type Page } from "playwright";

import { compileAssertion, judge, type AssertInput } from "./agent/asserter.js";
import { planStep } from "./agent/planner.js";
import { LlmSession } from "./agent/session.js";
import { discoverFeatures, type ResolvedConfig, type ScenarioContext, type ScenarioInfo, type StepDefinition } from "./config.js";
import { matchesTags, parseFeatureFile, type ParsedFeature, type ParsedScenario, type ScenarioStep } from "./gherkin/parse.js";
import { anthropic } from "./llm/anthropic.js";
import { loadPlan, savePlan } from "./plan/store.js";
import type { TemplateScope } from "./plan/template.js";
import type { Action, FeaturePlan, PlannedStep, ScenarioPlan } from "./plan/types.js";
import { ConsoleReporter } from "./report/console.js";
import { writeReports } from "./report/files.js";
import type { DriftEntry, FailureKind, RunResult, ScenarioResult, StepMode, StepResult } from "./report/types.js";
import { describeAction, executeAction, runCheck, type ActionContext } from "./runtime/actions.js";
import { ConfigError, DriftError, InfraError, StepFailedError } from "./runtime/errors.js";

export interface RunOptions {
  config: ResolvedConfig;
  /** Feature files/dirs overriding config.features. */
  paths?: string[];
  /** Tag expression, e.g. "@smoke and not @slow". */
  tags?: string;
  /** CI mode: drift (new or healed plans) exits 2 unless allowDrift. */
  ci?: boolean;
  allowDrift?: boolean;
  /** Never call the LLM for Given/When steps; a missing or drifted plan fails. */
  frozen?: boolean;
  /** Ignore cached plans and plan every step again. */
  replan?: boolean;
  /** Console output sink. Default: process.stdout. Pass a no-op to silence. */
  write?: (text: string) => void;
}

interface StepOutcome {
  result: StepResult;
  /** What to store for this step after the run (undefined = nothing). */
  plan?: PlannedStep;
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "scenario";
}

function failureKindOf(err: unknown): FailureKind {
  if (err instanceof ConfigError) return "config";
  if (err instanceof InfraError) return "infra";
  return "failure";
}

function goalOf(step: ScenarioStep): string {
  return `${step.keyword} ${step.text}${step.argument ? `\n${step.argument}` : ""}`;
}

function matchCustomStep(steps: StepDefinition[], text: string): { def: StepDefinition; args: string[] } | undefined {
  for (const def of steps) {
    if (typeof def.pattern === "string") {
      if (def.pattern === text) return { def, args: [] };
    } else {
      const m = text.match(def.pattern);
      if (m) return { def, args: m.slice(1).map((a) => a ?? "") };
    }
  }
  return undefined;
}

/** Looks up cached plan steps by hash, in order, so inserting a step only invalidates that step. */
function planIndex(plan: ScenarioPlan | undefined) {
  const byHash = new Map<string, PlannedStep[]>();
  for (const s of plan?.steps ?? []) byHash.set(s.hash, [...(byHash.get(s.hash) ?? []), s]);
  return (hash: string) => byHash.get(hash)?.shift();
}

export async function run(options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const { config } = options;
  const write = options.write ?? ((t: string) => process.stdout.write(t));
  const consoleReporter = new ConsoleReporter(write);
  const session = new LlmSession(config.llm ?? anthropic(), config.maxTokens);
  const scenarios: ScenarioResult[] = [];
  const drift: DriftEntry[] = [];
  const plansWritten: string[] = [];
  let fatal: string | undefined;
  let fatalKind: FailureKind | undefined;
  let browser: Browser | undefined;

  mkdirSync(config.outputDir, { recursive: true });
  for (const f of ["drift-report.md", "drift-report.json"]) rmSync(join(config.outputDir, f), { force: true });

  try {
    const featurePaths = discoverFeatures(options.paths?.length ? options.paths : config.features);
    if (featurePaths.length === 0) throw new ConfigError("No .feature files found.");
    const features = featurePaths.map((p) => parseFeatureFile(p, config.rootDir));
    for (const r of config.reporters) await r.onRunStart?.({ features: featurePaths });

    browser = await chromium.launch({ headless: config.headless, ...config.launchOptions });
    selectors.setTestIdAttribute(config.testIdAttribute);
    try {
      await config.hooks.beforeAll?.({ browser, config });
    } catch (err) {
      throw new InfraError(`beforeAll hook failed: ${(err as Error).message}`);
    }

    for (const feature of features) {
      const plan = loadPlan(feature.path);
      const next: FeaturePlan = { ...plan, scenarios: {} };
      const present = new Set(feature.scenarios.map((s) => s.key));
      for (const [key, value] of Object.entries(plan.scenarios)) if (present.has(key)) next.scenarios[key] = value;

      for (const scenario of feature.scenarios) {
        if (!matchesTags(scenario.tags, options.tags)) continue;
        const { result, scenarioPlan } = await runScenario({
          browser,
          config,
          options,
          session,
          feature,
          scenario,
          existing: plan.scenarios[scenario.key],
          consoleReporter,
        });
        scenarios.push(result);
        for (const s of result.steps) if (s.drift) drift.push(s.drift);
        if (scenarioPlan.steps.length) next.scenarios[scenario.key] = scenarioPlan;
        else delete next.scenarios[scenario.key];
      }
      if (savePlan(feature.path, next)) plansWritten.push(relative(config.rootDir, feature.path.replace(/\.feature$/, ".plan.json")));
    }
  } catch (err) {
    fatal = (err as Error).message;
    fatalKind = failureKindOf(err);
  }

  const failed = scenarios.filter((s) => s.status === "failed");
  const infra = fatal !== undefined || failed.some((s) => s.failureKind === "infra" || s.failureKind === "config");
  let exitCode: RunResult["exitCode"] = 0;
  if (infra) exitCode = 3;
  else if (failed.length) exitCode = 1;
  else if (drift.length && options.ci && !options.allowDrift) exitCode = 2;

  const result: RunResult = {
    exitCode,
    scenarios,
    drift,
    plansWritten,
    usage: { ...session.usage },
    durationMs: Date.now() - started,
    ...(fatal !== undefined ? { fatal: `${fatalKind === "config" ? "Config error" : "Infra error"}: ${fatal}` } : {}),
  };

  try {
    await config.hooks.afterAll?.(result);
  } catch (err) {
    result.fatal ??= `afterAll hook failed: ${(err as Error).message}`;
    result.exitCode = 3;
  }
  await browser?.close().catch(() => undefined);
  await config.judge?.close?.().catch(() => undefined);
  writeReports(config, result);
  consoleReporter.runEnd(result, { ci: !!options.ci, allowDrift: !!options.allowDrift, outputDir: config.outputDir });
  for (const r of config.reporters) await r.onRunEnd?.(result);
  return result;
}

interface ScenarioRunInput {
  browser: Browser;
  config: ResolvedConfig;
  options: RunOptions;
  session: LlmSession;
  feature: ParsedFeature;
  scenario: ParsedScenario;
  existing: ScenarioPlan | undefined;
  consoleReporter: ConsoleReporter;
}

async function runScenario(input: ScenarioRunInput): Promise<{ result: ScenarioResult; scenarioPlan: ScenarioPlan }> {
  const { browser, config, session, feature, scenario } = input;
  const started = Date.now();
  const featureName = relative(config.rootDir, feature.path);
  const info: ScenarioInfo = { feature: featureName, key: scenario.key, name: scenario.name, tags: scenario.tags, params: scenario.params };
  const artifactDir = join(config.outputDir, "artifacts", slug(basename(feature.path, ".feature")), slug(scenario.key));
  const artifacts: string[] = [];
  input.consoleReporter.scenarioStart(info);
  for (const r of config.reporters) await r.onScenarioStart?.(info);

  const context = await browser.newContext({ ...config.contextOptions, ...(config.baseURL ? { baseURL: config.baseURL } : {}) });
  if (config.trace !== "off") await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  let serverError: string | undefined;
  page.on("response", (response) => {
    if (response.status() >= 500 && response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      serverError = `HTTP ${response.status()} from ${response.url()}`;
    }
  });

  const ctx: ScenarioContext = { browser, context, page, scenario: info, vars: {}, baseURL: config.baseURL };
  const scope: TemplateScope = { env: process.env, params: scenario.params, vars: ctx.vars };
  const takeCached = planIndex(input.existing);
  const steps: StepResult[] = [];
  const stored: PlannedStep[] = [];
  let failure: { error: string; kind: FailureKind } | undefined;

  try {
    await config.hooks.beforeScenario?.(ctx);
  } catch (err) {
    failure = { error: `beforeScenario hook failed: ${(err as Error).message}`, kind: "infra" };
  }

  const previous: string[] = [];
  for (const step of scenario.steps) {
    const custom = matchCustomStep(config.steps, step.text);
    const cached = custom ? undefined : takeCached(step.hash);
    if (failure) {
      steps.push({ keyword: step.keyword, text: step.text, status: "skipped", mode: "skipped", durationMs: 0, llmCalls: 0 });
      if (cached) stored.push(cached);
      continue;
    }
    serverError = undefined;
    const stepStarted = Date.now();
    const callsBefore = session.usage.calls;
    let outcome: StepOutcome;
    try {
      if (custom) {
        try {
          await custom.def.run(ctx, ...custom.args);
        } catch (err) {
          if (err instanceof InfraError || err instanceof ConfigError) throw err;
          throw new StepFailedError((err as Error).message);
        }
        outcome = { result: stepResult(step, "custom") };
      } else {
        outcome = await runPlannedStep({
          ...input,
          page,
          scope,
          step,
          cached,
          previous,
          artifactDir,
          artifacts,
          serverError: () => serverError,
        });
      }
    } catch (err) {
      const kind = failureKindOf(err);
      const error = (err as Error).message;
      failure = { error, kind };
      outcome = { result: { ...stepResult(step, cached ? "replayed" : "planned"), status: "failed", error, failureKind: kind }, plan: cached };
    }
    outcome.result.durationMs = Date.now() - stepStarted;
    outcome.result.llmCalls = session.usage.calls - callsBefore;
    if (outcome.result.drift) outcome.result.drift.feature = featureName;
    steps.push(outcome.result);
    if (outcome.plan) stored.push(outcome.plan);
    previous.push(`${step.keyword} ${step.text}`);
    input.consoleReporter.stepEnd(outcome.result);
    for (const r of config.reporters) await r.onStepEnd?.(info, outcome.result);
  }

  const result: ScenarioResult = {
    feature: featureName,
    key: scenario.key,
    name: scenario.name,
    status: failure ? "failed" : "passed",
    ...(failure ? { error: failure.error, failureKind: failure.kind } : {}),
    durationMs: 0,
    steps,
    artifacts,
  };

  try {
    await config.hooks.afterScenario?.(ctx, result);
  } catch (err) {
    if (!failure) {
      result.status = "failed";
      result.error = `afterScenario hook failed: ${(err as Error).message}`;
      result.failureKind = "infra";
    }
  }

  if (result.status === "failed") {
    mkdirSync(artifactDir, { recursive: true });
    const shot = join(artifactDir, "failure.png");
    if (await page.screenshot({ path: shot, fullPage: true }).then(() => true, () => false)) artifacts.push(shot);
  }
  if (config.trace === "on" || (config.trace === "retain-on-failure" && result.status === "failed")) {
    mkdirSync(artifactDir, { recursive: true });
    const tracePath = join(artifactDir, "trace.zip");
    await context.tracing.stop({ path: tracePath }).then(() => artifacts.push(tracePath), () => undefined);
  } else if (config.trace !== "off") {
    await context.tracing.stop().catch(() => undefined);
  }
  await context.close().catch(() => undefined);

  result.durationMs = Date.now() - started;
  input.consoleReporter.scenarioEnd(result);
  for (const r of config.reporters) await r.onScenarioEnd?.(result);
  return { result, scenarioPlan: { name: scenario.name, steps: stored } };
}

function stepResult(step: ScenarioStep, mode: StepMode): StepResult {
  return { keyword: step.keyword, text: step.text, status: "passed", mode, durationMs: 0, llmCalls: 0 };
}

interface PlannedStepInput extends ScenarioRunInput {
  page: Page;
  scope: TemplateScope;
  step: ScenarioStep;
  cached: PlannedStep | undefined;
  previous: string[];
  artifactDir: string;
  artifacts: string[];
  serverError: () => string | undefined;
}

const RETRY_TIMEOUT_MS = 1_000;

async function replay(
  actionCtx: ActionContext,
  actions: Action[],
  attempts: number,
): Promise<{ ok: true } | { ok: false; failedAt: number; error: DriftError }> {
  for (const [i, action] of actions.entries()) {
    for (let attempt = 1; ; attempt++) {
      // The first attempt gets the full wait (slow renders); retries only re-check briefly.
      const ctx = attempt === 1 ? actionCtx : { ...actionCtx, actionTimeoutMs: Math.min(actionCtx.actionTimeoutMs, RETRY_TIMEOUT_MS) };
      try {
        if (action.type === "assert") await runCheck(ctx, action.check);
        else await executeAction(ctx, action);
        break;
      } catch (err) {
        if (!(err instanceof DriftError)) throw err;
        // A spinner that never went away is a slow backend, not a changed page. The wait
        // already used its own (long) timeout, so retrying would only multiply it.
        if (action.type === "waitFor" && action.state === "hidden") {
          throw new InfraError(`Known-slow wait timed out: ${err.message}`);
        }
        if (attempt >= attempts) return { ok: false, failedAt: i, error: err };
        await actionCtx.page.waitForTimeout(250 * attempt);
      }
    }
  }
  return { ok: true };
}

function writeAgentLog(input: PlannedStepInput, payload: unknown): void {
  mkdirSync(input.artifactDir, { recursive: true });
  const file = join(input.artifactDir, `agent-${slug(input.step.text)}-${input.step.hash}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  input.artifacts.push(file);
}

async function runPlannedStep(input: PlannedStepInput): Promise<StepOutcome> {
  const { config, options, session, step, cached, page, scope } = input;
  const goal = goalOf(step);
  const identity = session.identity;
  const actionCtx: ActionContext = {
    page,
    scope,
    baseURL: config.baseURL,
    fixturesDir: config.fixturesDir,
    actionTimeoutMs: config.actionTimeoutMs,
  };
  const usable = options.replan ? undefined : cached;
  const makePlan = (actions: Action[], source: PlannedStep["source"]): PlannedStep => ({
    hash: step.hash,
    keyword: step.keyword,
    text: step.text,
    source,
    generatedBy: identity,
    actions,
  });
  /** Returns the outcome for a freshly produced plan, recording drift only if the actions actually changed. */
  const produced = (actions: Action[], mode: "planned" | "healed", reason?: string, evidence?: string): StepOutcome => {
    if (cached && isDeepStrictEqual(cached.actions, actions)) {
      return { result: { ...stepResult(step, "replayed"), evidence }, plan: cached };
    }
    const kind = cached ? "healed" : "new";
    const plan = makePlan(actions, kind === "healed" ? "healed" : "planned");
    return {
      result: {
        ...stepResult(step, kind === "healed" ? "healed" : mode),
        ...(evidence ? { evidence } : {}),
        drift: {
          feature: "",
          scenario: input.scenario.key,
          step: `${step.keyword} ${step.text}`,
          kind,
          ...(reason ? { reason } : {}),
          ...(cached ? { oldActions: cached.actions } : {}),
          newActions: actions,
        },
      },
      plan,
    };
  };
  const infraGuard = (reason: string) => {
    const se = input.serverError();
    if (se) throw new InfraError(`${se} while replaying "${step.text}" (${reason})`);
  };

  if (step.kind === "outcome") {
    const assertInput: AssertInput = {
      page,
      session,
      goal,
      scope,
      testIdAttribute: config.testIdAttribute,
      minConfidence: config.minConfidence,
      baseURL: config.baseURL,
      fixturesDir: config.fixturesDir,
      ...(config.judge ? { judge: config.judge } : {}),
    };
    if (usable) {
      if (usable.actions.length === 1 && usable.actions[0]?.type === "judge") {
        const verdict = await judge(assertInput);
        if (!verdict.pass) throw new StepFailedError(`Assertion does not hold: ${verdict.evidence}`);
        return { result: { ...stepResult(step, "judged"), evidence: verdict.evidence }, plan: usable };
      }
      const replayed = await replay(actionCtx, usable.actions, config.attempts);
      if (replayed.ok) return { result: stepResult(step, "replayed"), plan: usable };
      infraGuard(replayed.error.message);
      // Checks drifted: ask the judge whether the assertion still holds before re-compiling.
      const verdict = await judge(assertInput);
      if (!verdict.pass) {
        throw new StepFailedError(`Assertion does not hold: ${verdict.evidence} (cached check: ${replayed.error.message})`);
      }
      const compiled = await compileAssertion(assertInput, replayed.error.message);
      writeAgentLog(input, { goal, mode: "heal-assertion", reason: replayed.error.message, verdict: compiled.verdict, rejected: compiled.rejected, actions: compiled.actions });
      const actions: Action[] = compiled.verdict.pass ? compiled.actions : [{ type: "judge" }];
      return produced(actions, "healed", replayed.error.message, verdict.evidence);
    }
    const compiled = await compileAssertion(assertInput);
    writeAgentLog(input, { goal, mode: "compile-assertion", verdict: compiled.verdict, rejected: compiled.rejected, actions: compiled.actions });
    if (!compiled.verdict.pass) throw new StepFailedError(`Assertion does not hold: ${compiled.verdict.evidence}`);
    return produced(compiled.actions, "planned", undefined, compiled.verdict.evidence);
  }

  // Given / When: replay the cached action list, heal only this step on drift.
  let healing: { reason: string; executed: Action[] } | undefined;
  if (usable) {
    const replayed = await replay(actionCtx, usable.actions, config.attempts);
    if (replayed.ok) return { result: stepResult(step, "replayed"), plan: usable };
    infraGuard(replayed.error.message);
    if (options.frozen) {
      throw new StepFailedError(`Plan drifted and --frozen forbids re-planning: ${replayed.error.message}`);
    }
    healing = { reason: replayed.error.message, executed: usable.actions.slice(0, replayed.failedAt) };
  } else if (options.frozen) {
    throw new StepFailedError(`No plan for "${step.text}" and --frozen forbids planning. Run without --frozen and commit the plan.`);
  }

  const mode = healing ? "heal" : "plan";
  try {
    const out = await planStep({
      page,
      session,
      goal,
      scenarioName: input.scenario.name,
      previousSteps: input.previous,
      scope,
      secrets: config.secrets,
      baseURL: config.baseURL,
      fixturesDir: config.fixturesDir,
      testIdAttribute: config.testIdAttribute,
      actionTimeoutMs: config.actionTimeoutMs,
      maxTurns: config.maxTurns,
      timeoutMs: config.planStepTimeoutMs,
      ...(healing ? { healing } : {}),
    });
    writeAgentLog(input, {
      goal,
      mode,
      healing: healing && { reason: healing.reason, executed: healing.executed.map(describeAction) },
      turns: out.turns,
      actions: out.actions.map(describeAction),
    });
    return produced([...(healing?.executed ?? []), ...out.actions], healing ? "healed" : "planned", healing?.reason);
  } catch (err) {
    writeAgentLog(input, { goal, mode, error: (err as Error).message, turns: err instanceof StepFailedError ? err.turns : undefined });
    throw err;
  }
}
