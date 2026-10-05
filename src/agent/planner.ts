import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { Page, Response } from "playwright";

import { resolveTemplate, toReferences, type TemplateScope } from "../plan/template.js";
import type { Action, Target } from "../plan/types.js";
import { describeAction, executeAction, navigate, type ActionContext } from "../runtime/actions.js";
import { ConfigError, DriftError, InfraError, StepFailedError } from "../runtime/errors.js";
import { candidateLocators, isStatelessPattern, locatorText, recordTarget, statelessTarget } from "../runtime/locators.js";
import { capturePageState, type ElementInfo, type PageState } from "../runtime/page-state.js";
import { PLANNER_SYSTEM, PLANNER_TOOLS, renderPageState } from "./prompts.js";
import type { LlmSession } from "./session.js";

export interface PlannerTurn {
  turn: number;
  url: string;
  tool?: string;
  input?: Record<string, unknown>;
  result: string;
}

/** Structured context attached to each planning request (see LlmRequest.meta). */
export interface PlanRequestMeta {
  kind: "plan";
  goal: string;
  scenario: string;
  healing?: { reason: string; executed: string[] };
  history: { tool: string; input: Record<string, unknown>; result: string }[];
  state: PageState;
  fixtures: string[];
}

export interface PlanStepInput {
  page: Page;
  session: LlmSession;
  goal: string;
  scenarioName: string;
  previousSteps: string[];
  scope: TemplateScope;
  secrets: readonly string[];
  baseURL?: string;
  fixturesDir: string;
  testIdAttribute: string;
  actionTimeoutMs: number;
  maxTurns: number;
  timeoutMs: number;
  /** Set when healing: why the cached plan failed and what already ran for this step. */
  healing?: { reason: string; executed: Action[] };
}

export interface PlanStepOutput {
  actions: Action[];
  summary: string;
  turns: PlannerTurn[];
}

const FIXTURE_IN_TEXT = /["']([^"'\s]+\.[A-Za-z0-9]{2,6})["']/g;

function fixturesFor(goal: string, fixturesDir: string): string[] {
  const out = new Set<string>();
  for (const m of goal.matchAll(FIXTURE_IN_TEXT)) {
    const file = m[1];
    if (file && existsSync(resolve(fixturesDir, file))) out.add(file);
  }
  return [...out];
}

function intArg(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

function strArg(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new DriftError(`Tool argument "${key}" must be a string.`);
  return v;
}

/** Keeps plans env-agnostic: URLs under baseURL are stored as paths. */
function relativeToBase(url: string, baseURL: string | undefined): string {
  if (!baseURL) return url;
  try {
    const base = new URL(baseURL);
    const u = new URL(url, base);
    if (u.origin === base.origin) return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    // keep as typed
  }
  return url;
}

/**
 * Drives the browser with the LLM until the step goal is met, recording each
 * successful action as a replayable Action. Throws StepFailedError when the
 * agent gives up, InfraError when the environment is broken.
 */
export async function planStep(input: PlanStepInput): Promise<PlanStepOutput> {
  const { page, session, goal } = input;
  const actions: Action[] = [];
  const turns: PlannerTurn[] = [];
  const history: PlanRequestMeta["history"] = [];
  const fixtures = fixturesFor(goal, input.fixturesDir);
  const ctx: ActionContext = {
    page,
    scope: input.scope,
    baseURL: input.baseURL,
    fixturesDir: input.fixturesDir,
    actionTimeoutMs: input.actionTimeoutMs,
  };
  const deadline = Date.now() + input.timeoutMs;
  // HTTP status of the current main-frame document, so "done" on an error page can be questioned.
  let documentStatus: { url: string; status: number } | undefined;
  const refusedErrorPages = new Set<string>();
  const onResponse = (response: Response) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      documentStatus = { url: withoutHash(response.url()), status: response.status() };
    }
  };
  const refuseDone = (state: PageState): string | undefined => {
    // Nothing can be achieved on a blank page; a "done" here means the model did not see the state.
    if (state.url === "about:blank" && state.elements.length === 0) {
      return "the page is blank (about:blank); nothing has been done yet. Navigate first.";
    }
    // Usually a guessed URL. Refused once per page, so a step that is about the error page itself still passes.
    const doc = documentStatus;
    if (doc && doc.status >= 400 && doc.url === withoutHash(state.url) && !refusedErrorPages.has(doc.url)) {
      refusedErrorPages.add(doc.url);
      return `this page is an HTTP ${doc.status} error page. Unless the step is about this error page, go back to "/" and use the app's own navigation.`;
    }
    return undefined;
  };
  page.on("response", onResponse);
  try {
    return await planLoop();
  } finally {
    page.off("response", onResponse);
  }

  async function planLoop(): Promise<PlanStepOutput> {
    let textOnlyReplies = 0;

    for (let turn = 1; turn <= input.maxTurns; turn++) {
      if (Date.now() > deadline) break;
      const state = await capturePageState(page, { screenshot: true, testIdAttribute: input.testIdAttribute });
      const meta: PlanRequestMeta = {
        kind: "plan",
        goal,
        scenario: input.scenarioName,
        healing: input.healing && { reason: input.healing.reason, executed: input.healing.executed.map(describeAction) },
        history,
        state,
        fixtures,
      };
      const text = [
        `GOAL: ${goal}`,
        input.baseURL ? `APP BASE URL: ${input.baseURL} (the app's home is "/")` : "",
        `SCENARIO: ${input.scenarioName}`,
        input.previousSteps.length ? `EARLIER STEPS (already done, not yours):\n${input.previousSteps.map((s) => `- ${s}`).join("\n")}` : "",
        meta.healing
          ? `HEALING: a cached plan for this step stopped matching the page (${meta.healing.reason}). Already executed for this step before the failure:\n${meta.healing.executed.map((s) => `- ${s}`).join("\n") || "- (nothing)"}\nContinue from the current page state.`
          : "",
        `AVAILABLE_FIXTURES: ${fixtures.length ? fixtures.join(", ") : "(none)"}`,
        history.length
          ? `YOUR ACTIONS SO FAR FOR THIS STEP:\n${history.map((h, i) => `${i + 1}. ${h.tool} ${JSON.stringify(h.input)} → ${h.result}`).join("\n")}`
          : "YOUR ACTIONS SO FAR FOR THIS STEP: (none)",
        renderPageState(state),
      ]
        .filter(Boolean)
        .join("\n\n");

      const response = await session.complete({
        purpose: "plan",
        system: PLANNER_SYSTEM,
        content: [{ type: "text", text }, ...(state.screenshot ? [{ type: "image" as const, mediaType: "image/jpeg" as const, data: state.screenshot }] : [])],
        tools: PLANNER_TOOLS,
        meta,
      });

      const call = response.toolCall;
      if (!call) {
        textOnlyReplies++;
        turns.push({ turn, url: state.url, result: `no tool call: ${response.text ?? ""}` });
        history.push({ tool: "(none)", input: {}, result: "ERROR: every reply must be exactly one tool call." });
        if (textOnlyReplies >= 2) throw withTurns(new StepFailedError(`Agent stopped calling tools: ${response.text ?? "(empty reply)"}`), turns);
        continue;
      }

      if (call.name === "done") {
        const refusal = refuseDone(state);
        if (refusal) {
          const result = `ERROR: ${refusal}`;
          turns.push({ turn, url: state.url, tool: call.name, input: call.input, result });
          history.push({ tool: call.name, input: call.input, result });
          continue;
        }
        turns.push({ turn, url: state.url, tool: call.name, input: call.input, result: "done" });
        return { actions, summary: String(call.input.summary ?? ""), turns };
      }
      if (call.name === "fail") {
        turns.push({ turn, url: state.url, tool: call.name, input: call.input, result: "fail" });
        throw withTurns(new StepFailedError(`Agent could not achieve "${goal}": ${String(call.input.reason ?? "no reason given")}`), turns);
      }

      let result: string;
      try {
        const action = await performTool(call.name, call.input, state, ctx, input);
        actions.push(action);
        result = `ok (${describeAction(action)})`;
      } catch (err) {
        if (err instanceof InfraError || err instanceof ConfigError) throw err;
        result = `ERROR: ${(err as Error).message}`;
      }
      turns.push({ turn, url: state.url, tool: call.name, input: call.input, result });
      history.push({ tool: call.name, input: call.input, result });
    }
    throw withTurns(new StepFailedError(`Agent did not finish "${goal}" within ${input.maxTurns} turns / ${input.timeoutMs}ms.`), turns);
  }
}

function withoutHash(url: string): string {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
}

function withTurns(err: StepFailedError, turns: PlannerTurn[]): StepFailedError {
  err.turns = turns;
  return err;
}

function elementByRef(state: PageState, input: Record<string, unknown>, key = "ref"): ElementInfo {
  const ref = intArg(input, key);
  const el = ref === undefined ? undefined : state.elements[ref];
  if (!el) throw new DriftError(`Unknown ref ${String(input[key])}; use a ref from the current ELEMENTS list.`);
  return el;
}

async function performTool(
  name: string,
  args: Record<string, unknown>,
  state: PageState,
  ctx: ActionContext,
  input: PlanStepInput,
): Promise<Action> {
  const { page } = ctx;
  const ref = (s: string) => toReferences(s, input.scope, input.secrets);
  const target = async (): Promise<Target> => recordTarget(page, elementByRef(state, args));

  switch (name) {
    case "navigate": {
      const url = relativeToBase(resolveTemplate(strArg(args, "url"), input.scope), input.baseURL);
      await navigate(page, url, input.baseURL);
      return { type: "navigate", url: ref(url) };
    }
    case "click":
      return run(ctx, { type: "click", target: await target() });
    case "fill":
      return run(ctx, { type: "fill", target: await target(), value: ref(strArg(args, "value")) });
    case "select":
      return run(ctx, { type: "select", target: await target(), value: ref(strArg(args, "value")) });
    case "check":
      return run(ctx, { type: "check", target: await target(), checked: args.checked !== false });
    case "press":
      return run(ctx, {
        type: "press",
        key: strArg(args, "key"),
        ...(args.ref !== undefined ? { target: await target() } : {}),
      });
    case "upload": {
      const file = strArg(args, "file");
      if (!fixturesFor(`"${file}"`, input.fixturesDir).length) {
        throw new DriftError(`"${file}" is not in AVAILABLE_FIXTURES.`);
      }
      return run(ctx, { type: "upload", target: await target(), file });
    }
    case "wait_for": {
      const state_ = args.state === "hidden" ? "hidden" : "visible";
      const timeoutMs = intArg(args, "timeout_ms");
      let t: Target;
      if (args.ref !== undefined) {
        // Waits replay on later runs with different data: never key them on an observed value.
        const el = elementByRef(state, args);
        try {
          t = statelessTarget(await recordTarget(page, el), input.goal, el);
        } catch (err) {
          if (!(err instanceof DriftError) || state_ !== "hidden") throw err;
          // The element (a spinner, "Thinking…") vanished between the snapshot and now: the wait
          // is already satisfied. Record it from the captured attributes so replays keep waiting.
          // Positional CSS is excluded: once the element is gone, its position belongs to whatever
          // replaced it (the reply bubble), and a hidden-wait on that would never finish.
          const locators = candidateLocators(el).filter((l) => l.by !== "css" && isStatelessPattern(locatorText(l), input.goal));
          if (locators.length === 0) throw err;
          t = { locators, description: `${el.role ?? el.tag}${el.name ? ` "${el.name}"` : ""}` };
        }
      } else {
        const text = strArg(args, "text");
        if (state_ === "visible" && !input.goal.toLowerCase().includes(text.toLowerCase())) {
          throw new DriftError(
            `wait_for text "${text}" is page content that can differ on the next run. Wait for a loading indicator to be hidden, or for an element by ref, instead.`,
          );
        }
        t = { locators: [{ by: "text", value: text }], description: `text "${text}"` };
      }
      return run(ctx, { type: "waitFor", target: t, state: state_, ...(timeoutMs ? { timeoutMs } : {}) });
    }
    default:
      throw new DriftError(`Unknown tool "${name}".`);
  }
}

async function run(ctx: ActionContext, action: Action): Promise<Action> {
  await executeAction(ctx, action);
  return action;
}
