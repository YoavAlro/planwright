import type { Page } from "playwright";

import type { TemplateScope } from "../plan/template.js";
import type { Action, Check, LocatorSpec, Target } from "../plan/types.js";
import { runCheck, type ActionContext } from "../runtime/actions.js";
import { DriftError } from "../runtime/errors.js";
import { buildLocator, describeLocator, recordTarget } from "../runtime/locators.js";
import { capturePageState, type PageState } from "../runtime/page-state.js";
import { ASSERTER_SYSTEM, ASSERT_TOOL, JUDGE_SYSTEM, JUDGE_TOOL, renderPageState } from "./prompts.js";
import type { LlmSession } from "./session.js";

export interface Verdict {
  pass: boolean;
  confidence: number;
  evidence: string;
}

export interface AssertRequestMeta {
  kind: "assert" | "judge";
  goal: string;
  state: PageState;
}

interface ProposedCheck {
  kind?: string;
  ref?: number;
  locator?: { by?: string; value?: string; role?: string; name?: string };
  pattern?: string;
  flags?: string;
  min?: number;
}

export interface AssertInput {
  page: Page;
  session: LlmSession;
  goal: string;
  scope: TemplateScope;
  testIdAttribute: string;
  minConfidence: number;
  baseURL?: string;
  fixturesDir: string;
}

function readVerdict(input: Record<string, unknown> | undefined, text: string | undefined): Verdict {
  if (!input) return { pass: false, confidence: 0, evidence: `No verdict returned: ${text ?? "(empty)"}` };
  return {
    pass: input.pass === true,
    confidence: typeof input.confidence === "number" ? input.confidence : 0,
    evidence: typeof input.evidence === "string" ? input.evidence : "",
  };
}

/**
 * A stored pattern must not pin a value observed on the page. Any digit run in
 * the pattern (outside regex quantifiers/escapes) must appear in the step text.
 */
export function isStatelessPattern(pattern: string, stepText: string): boolean {
  const stripped = pattern
    .replace(/\\[dDwWsSbB]/g, "")
    .replace(/\{\d+(,\d*)?\}/g, "")
    .replace(/\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/g, "");
  const allowed = new Set(stepText.match(/\d+/g) ?? []);
  return (stripped.match(/\d+/g) ?? []).every((d) => allowed.has(d));
}

function locatorText(spec: LocatorSpec): string {
  return spec.by === "role" ? spec.name : spec.value;
}

/**
 * Assertion targets are replayed against changing data, so drop locators that
 * embed an observed value (e.g. text "Open tasks: 7") and keep the description neutral.
 */
function statelessTarget(target: Target, goal: string, hook: string | undefined): Target {
  const locators = target.locators.filter((spec) => spec.by === "css" || isStatelessPattern(locatorText(spec), goal));
  if (locators.length === 0) throw new DriftError("every locator for this element embeds an observed value");
  const first = locators[0]!;
  return { locators, description: hook ?? describeLocator(first) };
}

function toLocatorSpec(raw: ProposedCheck["locator"]): LocatorSpec | undefined {
  if (!raw?.by) return undefined;
  switch (raw.by) {
    case "role":
      return raw.role && raw.name ? { by: "role", role: raw.role, name: raw.name } : raw.role ? { by: "css", value: `[role="${raw.role}"]` } : undefined;
    case "testid":
    case "label":
    case "placeholder":
    case "id":
    case "text":
    case "css":
      return raw.value ? ({ by: raw.by, value: raw.value } as LocatorSpec) : undefined;
    default:
      return undefined;
  }
}

async function compileCheck(page: Page, state: PageState, raw: ProposedCheck, goal: string): Promise<Check> {
  const needsTarget = !["url", "title"].includes(raw.kind ?? "");
  let target: Target | undefined;
  if (needsTarget) {
    if (raw.ref !== undefined && raw.kind !== "count") {
      const el = state.elements[raw.ref];
      if (!el) throw new DriftError(`unknown ref ${raw.ref}`);
      target = statelessTarget(await recordTarget(page, el), goal, el.testid ?? el.id);
    } else {
      const spec = toLocatorSpec(raw.locator);
      if (!spec) throw new DriftError("check needs a ref or a valid locator");
      if ((await buildLocator(page, spec).count()) === 0) throw new DriftError(`locator ${describeLocator(spec)} matches nothing`);
      target = { locators: [spec], description: describeLocator(spec) };
    }
  }
  const pattern = raw.pattern;
  if (pattern !== undefined) {
    try {
      new RegExp(pattern, raw.flags);
    } catch {
      throw new DriftError(`invalid regex /${pattern}/`);
    }
    if (!isStatelessPattern(pattern, goal)) throw new DriftError(`pattern /${pattern}/ pins an observed value`);
  }
  switch (raw.kind) {
    case "visible":
    case "hidden":
    case "enabled":
      return { kind: raw.kind, target: target! };
    case "count":
      return { kind: "count", target: target!, min: raw.min ?? 1 };
    case "text":
      if (!pattern) throw new DriftError("text check needs a pattern");
      return { kind: "text", target: target!, pattern, ...(raw.flags ? { flags: raw.flags } : {}) };
    case "url":
    case "title":
      if (!pattern) throw new DriftError(`${raw.kind} check needs a pattern`);
      return { kind: raw.kind, pattern, ...(raw.flags ? { flags: raw.flags } : {}) };
    default:
      throw new DriftError(`unknown check kind ${String(raw.kind)}`);
  }
}

function userContent(goal: string, state: PageState) {
  return [
    { type: "text" as const, text: `GOAL (assertion): ${goal}\n\n${renderPageState(state)}` },
    ...(state.screenshot ? [{ type: "image" as const, mediaType: "image/jpeg" as const, data: state.screenshot }] : []),
  ];
}

/** Judges the assertion with the LLM. Used for `judge` plans and as the fallback when checks drift. */
export async function judge(input: AssertInput): Promise<Verdict> {
  const state = await capturePageState(input.page, { screenshot: true, testIdAttribute: input.testIdAttribute });
  const meta: AssertRequestMeta = { kind: "judge", goal: input.goal, state };
  const response = await input.session.complete({
    purpose: "judge",
    system: JUDGE_SYSTEM,
    content: userContent(input.goal, state),
    tools: [JUDGE_TOOL],
    meta,
  });
  const verdict = readVerdict(response.toolCall?.input, response.text);
  return { ...verdict, pass: verdict.pass && verdict.confidence >= input.minConfidence };
}

export interface CompiledAssertion {
  verdict: Verdict;
  /** Assert actions, or a single judge action when the assertion can't be compiled. */
  actions: Action[];
  rejected: string[];
}

/**
 * Judges the assertion once and, when it holds, compiles the LLM's proposed
 * checks into stateless assert actions. Every check must pass on the current
 * page and must not pin observed values; otherwise the step is stored as judge.
 */
export async function compileAssertion(input: AssertInput): Promise<CompiledAssertion> {
  const state = await capturePageState(input.page, { screenshot: true, testIdAttribute: input.testIdAttribute });
  const meta: AssertRequestMeta = { kind: "assert", goal: input.goal, state };
  const response = await input.session.complete({
    purpose: "assert",
    system: ASSERTER_SYSTEM,
    content: userContent(input.goal, state),
    tools: [ASSERT_TOOL],
    meta,
  });
  const raw = response.toolCall?.input;
  const verdict = readVerdict(raw, response.text);
  if (!verdict.pass || verdict.confidence < input.minConfidence) {
    return { verdict: { ...verdict, pass: false }, actions: [], rejected: [] };
  }

  const proposals = Array.isArray(raw?.checks) ? (raw.checks as ProposedCheck[]) : [];
  const rejected: string[] = [];
  const checks: Check[] = [];
  const ctx: ActionContext = {
    page: input.page,
    scope: input.scope,
    baseURL: input.baseURL,
    fixturesDir: input.fixturesDir,
    actionTimeoutMs: 1_000,
  };
  for (const proposal of proposals) {
    try {
      const check = await compileCheck(input.page, state, proposal, input.goal);
      await runCheck(ctx, check);
      checks.push(check);
    } catch (err) {
      rejected.push(`${JSON.stringify(proposal)}: ${(err as Error).message}`);
    }
  }
  // All-or-nothing: a partially compiled assertion would silently weaken the test.
  const actions: Action[] =
    checks.length > 0 && rejected.length === 0 ? checks.map((check) => ({ type: "assert", check })) : [{ type: "judge" }];
  return { verdict, actions, rejected };
}
