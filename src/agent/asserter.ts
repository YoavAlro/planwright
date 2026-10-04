import type { Page } from "playwright";

import type { TemplateScope } from "../plan/template.js";
import type { Action, Check, LocatorSpec, Target } from "../plan/types.js";
import { runCheck, type ActionContext } from "../runtime/actions.js";
import { DriftError, InfraError } from "../runtime/errors.js";
import { buildLocator, describeLocator, isGroundedPattern, isStatelessPattern, recordTarget, statelessTarget } from "../runtime/locators.js";
import { capturePageState, type PageState } from "../runtime/page-state.js";
import { ASSERTER_SYSTEM, ASSERT_TOOL, JUDGE_SYSTEM, JUDGE_TOOL, renderPageState } from "./prompts.js";
import type { Judge, Verdict } from "../judge/types.js";
import type { LlmSession } from "./session.js";

export type { Verdict } from "../judge/types.js";
export { isStatelessPattern } from "../runtime/locators.js";

/** One single-literal `kind` per member, so `meta.kind` checks narrow cleanly in user code. */
export type AssertRequestMeta =
  | { kind: "assert"; goal: string; state: PageState }
  | { kind: "judge"; goal: string; state: PageState };

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
  /** Custom judge for `judge` steps; the LLM judges when unset. */
  judge?: Judge;
}

/** A verdict needs at least a boolean `pass`; anything else is a malformed model answer, not a judgement. */
function readVerdict(input: Record<string, unknown> | undefined): Verdict | undefined {
  if (!input || typeof input.pass !== "boolean") return undefined;
  return {
    pass: input.pass,
    confidence: typeof input.confidence === "number" ? input.confidence : 0,
    evidence: typeof input.evidence === "string" ? input.evidence : "",
  };
}

/** Asks for a verdict, retrying once on a malformed answer. Two malformed answers are a tooling problem (exit 3). */
async function requestVerdict(session: LlmSession, request: Parameters<LlmSession["complete"]>[0]) {
  let last: Awaited<ReturnType<LlmSession["complete"]>> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await session.complete(request);
    const verdict = readVerdict(last.toolCall?.input);
    if (verdict) return { verdict, raw: last.toolCall?.input };
  }
  throw new InfraError(
    `The model returned no usable verdict for "${(request.meta as AssertRequestMeta).goal}": ${JSON.stringify(last?.toolCall ?? last?.text ?? null).slice(0, 300)}`,
  );
}

function withFlag(flags: string | undefined, flag: string): string {
  return flags?.includes(flag) ? flags : `${flags ?? ""}${flag}`;
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
      target = statelessTarget(await recordTarget(page, el), goal, el);
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
    if (raw.kind === "text" && !isGroundedPattern(pattern, goal)) {
      throw new DriftError(`pattern /${pattern}/ uses words that are not in the assertion; generated text is worded differently each run`);
    }
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
      // Wording is matched case-insensitively: "Ticket #12" and "ticket #12" state the same fact.
      return { kind: "text", target: target!, pattern, flags: /[a-zA-Z]/.test(pattern.replace(/\\[a-zA-Z]/g, "")) ? withFlag(raw.flags, "i") : raw.flags ?? "" };
    case "url":
    case "title":
      if (!pattern) throw new DriftError(`${raw.kind} check needs a pattern`);
      return { kind: raw.kind, pattern, ...(raw.flags ? { flags: raw.flags } : {}) };
    default:
      throw new DriftError(`unknown check kind ${String(raw.kind)}`);
  }
}

function userContent(goal: string, state: PageState, note?: string) {
  return [
    { type: "text" as const, text: `GOAL (assertion): ${goal}\n\n${note ? `${note}\n\n` : ""}${renderPageState(state)}` },
    ...(state.screenshot ? [{ type: "image" as const, mediaType: "image/jpeg" as const, data: state.screenshot }] : []),
  ];
}

/** Judges the assertion with the LLM. Used for `judge` plans and as the fallback when checks drift. */
export async function judge(input: AssertInput): Promise<Verdict> {
  if (input.judge) {
    const state = await capturePageState(input.page, { screenshot: false, testIdAttribute: input.testIdAttribute });
    return input.judge.judge({ assertion: input.goal, state });
  }
  const state = await capturePageState(input.page, { screenshot: true, testIdAttribute: input.testIdAttribute });
  const meta: AssertRequestMeta = { kind: "judge", goal: input.goal, state };
  const { verdict } = await requestVerdict(input.session, {
    purpose: "judge",
    system: JUDGE_SYSTEM,
    content: userContent(input.goal, state),
    tools: [JUDGE_TOOL],
    meta,
  });
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
export async function compileAssertion(
  input: AssertInput,
  /** Why the previously cached checks failed although the assertion still holds (they over-fitted). */
  previousFailure?: string,
): Promise<CompiledAssertion> {
  const state = await capturePageState(input.page, { screenshot: true, testIdAttribute: input.testIdAttribute });
  const meta: AssertRequestMeta = { kind: "assert", goal: input.goal, state };
  const note = previousFailure
    ? `PREVIOUS CHECKS FAILED although the assertion still holds, so they were too specific: ${previousFailure}\nPropose checks that also accept the wording on this page and any other wording of the same fact.`
    : undefined;
  const { verdict, raw } = await requestVerdict(input.session, {
    purpose: "assert",
    system: ASSERTER_SYSTEM,
    content: userContent(input.goal, state, note),
    tools: [ASSERT_TOOL],
    meta,
  });
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
