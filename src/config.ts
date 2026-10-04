import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import { createJiti } from "jiti";
import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions, Page } from "playwright";

import type { LlmProvider } from "./llm/types.js";
import type { RunResult, ScenarioResult, StepResult } from "./report/types.js";
import { ConfigError } from "./runtime/errors.js";

export interface ScenarioInfo {
  feature: string;
  key: string;
  name: string;
  tags: string[];
  params: Record<string, string>;
}

/** Passed to hooks and custom step handlers. */
export interface ScenarioContext {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  scenario: ScenarioInfo;
  /** Runtime variables. Referenced from steps/plans as ${vars.name}. */
  vars: Record<string, unknown>;
  baseURL?: string;
}

export interface StepDefinition {
  /** A string matches the whole step text exactly; a RegExp passes its capture groups as args. */
  pattern: string | RegExp;
  run(ctx: ScenarioContext, ...args: string[]): Promise<void> | void;
}

export interface Hooks {
  beforeAll?(info: { browser: Browser; config: ResolvedConfig }): Promise<void> | void;
  beforeScenario?(ctx: ScenarioContext): Promise<void> | void;
  afterScenario?(ctx: ScenarioContext, result: ScenarioResult): Promise<void> | void;
  afterAll?(result: RunResult): Promise<void> | void;
}

export interface Reporter {
  onRunStart?(info: { features: string[] }): void | Promise<void>;
  onScenarioStart?(scenario: ScenarioInfo): void | Promise<void>;
  onStepEnd?(scenario: ScenarioInfo, step: StepResult): void | Promise<void>;
  onScenarioEnd?(result: ScenarioResult): void | Promise<void>;
  onRunEnd?(result: RunResult): void | Promise<void>;
}

export interface PlanwrightConfig {
  /** Feature files or directories (searched recursively for *.feature). Default: ["features"]. */
  features?: string | string[];
  baseURL?: string;
  /** LLM provider. Default: anthropic() (claude-opus-5-5, ANTHROPIC_API_KEY). */
  llm?: LlmProvider;
  browser?: {
    headless?: boolean;
    launchOptions?: LaunchOptions;
    contextOptions?: BrowserContextOptions;
  };
  /** Attribute used for `testid` locators. Default: "data-testid". */
  testIdAttribute?: string;
  hooks?: Hooks;
  /** Deterministic step definitions. Matched before planning; never planned or cached. */
  steps?: StepDefinition[];
  reporters?: Reporter[];
  /** Run artifacts and reports. Default: "planwright-results". */
  outputDir?: string;
  /** Root for `upload` fixtures. Default: "fixtures". */
  fixturesDir?: string;
  /** Env var names whose values must never be stored in a plan (stored as ${env.NAME}). */
  secrets?: string[];
  timeouts?: {
    /** Wait for a target to resolve / an assertion to hold, per attempt. Default 5000. */
    actionMs?: number;
    /** Wall-clock cap for the agent planning one step. Default 300000. */
    planStepMs?: number;
  };
  /** Replay attempts per action before a step counts as drifted. Default 3. */
  attempts?: number;
  agent?: {
    /** Max LLM turns when planning one step. Default 25. */
    maxTurns?: number;
  };
  judge?: {
    /** Minimum confidence for an LLM verdict to pass. Default 0.7. */
    minConfidence?: number;
  };
  /** Optional run-wide token budget (input + output). Exceeding it aborts the run with exit code 3. */
  budget?: { maxTokens?: number };
  /** Playwright tracing. Default "retain-on-failure". */
  trace?: "on" | "off" | "retain-on-failure";
  /** Also write junit.xml. Default true. */
  junit?: boolean;
}

export interface ResolvedConfig {
  rootDir: string;
  features: string[];
  baseURL?: string;
  llm?: LlmProvider;
  headless: boolean;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
  testIdAttribute: string;
  hooks: Hooks;
  steps: StepDefinition[];
  reporters: Reporter[];
  outputDir: string;
  fixturesDir: string;
  secrets: string[];
  actionTimeoutMs: number;
  planStepTimeoutMs: number;
  attempts: number;
  maxTurns: number;
  minConfidence: number;
  maxTokens?: number;
  trace: "on" | "off" | "retain-on-failure";
  junit: boolean;
}

export function defineConfig(config: PlanwrightConfig): PlanwrightConfig {
  return config;
}

const CONFIG_NAMES = ["planwright.config.ts", "planwright.config.mts", "planwright.config.js", "planwright.config.mjs"];

export function findConfigFile(cwd: string): string | undefined {
  return CONFIG_NAMES.map((n) => join(cwd, n)).find((p) => existsSync(p));
}

export async function loadConfigFile(path: string): Promise<PlanwrightConfig> {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const mod = (await jiti.import(resolve(path))) as PlanwrightConfig | { default: PlanwrightConfig };
  const config = "default" in mod ? mod.default : mod;
  if (!config || typeof config !== "object") throw new ConfigError(`${path} must export a config object (export default defineConfig({...})).`);
  return config;
}

export function resolveConfig(config: PlanwrightConfig, rootDir: string): ResolvedConfig {
  const features = (Array.isArray(config.features) ? config.features : [config.features ?? "features"]).map((f) => resolve(rootDir, f));
  const attempts = config.attempts ?? 3;
  if (attempts < 1) throw new ConfigError("attempts must be >= 1");
  return {
    rootDir,
    features,
    baseURL: config.baseURL,
    llm: config.llm,
    headless: config.browser?.headless ?? true,
    launchOptions: config.browser?.launchOptions ?? {},
    contextOptions: config.browser?.contextOptions ?? {},
    testIdAttribute: config.testIdAttribute ?? "data-testid",
    hooks: config.hooks ?? {},
    steps: config.steps ?? [],
    reporters: config.reporters ?? [],
    outputDir: resolve(rootDir, config.outputDir ?? "planwright-results"),
    fixturesDir: resolve(rootDir, config.fixturesDir ?? "fixtures"),
    secrets: config.secrets ?? [],
    actionTimeoutMs: config.timeouts?.actionMs ?? 5_000,
    planStepTimeoutMs: config.timeouts?.planStepMs ?? 300_000,
    attempts,
    maxTurns: config.agent?.maxTurns ?? 25,
    minConfidence: config.judge?.minConfidence ?? 0.7,
    maxTokens: config.budget?.maxTokens,
    trace: config.trace ?? "retain-on-failure",
    junit: config.junit ?? true,
  };
}

export async function loadConfig(options: { cwd: string; configPath?: string }): Promise<ResolvedConfig> {
  const path = options.configPath ? resolve(options.cwd, options.configPath) : findConfigFile(options.cwd);
  if (options.configPath && !existsSync(path!)) throw new ConfigError(`Config file not found: ${path}`);
  const config = path ? await loadConfigFile(path) : {};
  return resolveConfig(config, path ? dirname(path) : options.cwd);
}

/** Expands files/directories into a sorted list of .feature files. */
export function discoverFeatures(paths: string[]): string[] {
  const out = new Set<string>();
  const walk = (p: string) => {
    if (!existsSync(p)) throw new ConfigError(`Feature path not found: ${p}`);
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        walk(join(p, entry));
      }
    } else if (extname(p) === ".feature") {
      out.add(p);
    }
  };
  for (const p of paths) walk(p);
  return [...out].sort();
}
