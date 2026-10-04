import type { PageState } from "../runtime/page-state.js";
import type { Judge, JudgeInput, Verdict } from "./types.js";

/**
 * The subset of the Jev `system_one` API a judge needs: answer typed questions
 * about a state in one pass. Laya (`@receptron/laya`) implements it locally;
 * a client for a hosted Jev-compatible service can implement it too.
 */
export interface SystemOneClient {
  systemOne(
    state: unknown,
    questions: Record<string, { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }>,
  ): Promise<{ model?: string; answers: Record<string, { noul?: number }> }>;
  close?(): Promise<void>;
}

export interface SystemOneQuestion {
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface SystemOneJudgeOptions {
  /** Minimum P(true) for the assertion to pass. Default 0.7. */
  threshold?: number;
  /**
   * Builds the state sent to the model from the page. Default: URL, title and visible text (head + tail).
   * Focus it on the region the assertion is about when you can: whole-page text with navigation and
   * boilerplate measurably blurs the model's judgement.
   */
  state?: (page: PageState) => unknown;
  /** Builds the noul question from the assertion (Gherkin keyword already stripped). Default: defaultJudgeQuestion. */
  question?: (assertion: string) => SystemOneQuestion;
  /** Name shown in reports. Default "system_one". */
  name?: string;
}

/** "And the reply is polite" → "the reply is polite": the keyword is Gherkin syntax, not meaning. */
export function stripGherkinKeyword(assertion: string): string {
  return assertion.replace(/^\s*(Given|When|Then|And|But|\*)\s+/i, "").trim();
}

/**
 * "Is it true that <assertion>?" — the phrasing that separated good from bad
 * best when calibrated with Laya (examples/agentic-dashboard/results/laya-calibration.md).
 */
export function defaultJudgeQuestion(assertion: string): SystemOneQuestion {
  return { instructions: `Is it true that ${assertion}?` };
}

/** Decision models have a short context (Laya: 512 tokens), so keep both ends of long pages. */
const TEXT_BUDGET = 1600;

export function defaultJudgeState(page: PageState): unknown {
  const text = page.text.replace(/\s+/g, " ").trim();
  const half = TEXT_BUDGET / 2;
  return {
    url: page.url,
    title: page.title,
    text: text.length > TEXT_BUDGET ? `${text.slice(0, half)} … ${text.slice(-half)}` : text,
  };
}

/**
 * A Judge backed by a Jev-compatible `system_one` model: each judged assertion
 * becomes one `noul` question, and the calibrated P(true) decides it.
 * Pass the client, or a function that loads it on first use.
 */
export function systemOneJudge(
  client: SystemOneClient | (() => Promise<SystemOneClient>),
  options: SystemOneJudgeOptions = {},
): Judge {
  const threshold = options.threshold ?? 0.7;
  const buildState = options.state ?? defaultJudgeState;
  let loaded: Promise<SystemOneClient> | undefined;
  const get = () => (loaded ??= typeof client === "function" ? client() : Promise.resolve(client));

  return {
    name: options.name ?? "system_one",
    async judge({ assertion, state }: JudgeInput): Promise<Verdict> {
      const model = await get();
      const question = (options.question ?? defaultJudgeQuestion)(stripGherkinKeyword(assertion));
      const result = await model.systemOne(buildState(state), { holds: { type: "noul", ...question } });
      const p = result.answers.holds?.noul;
      if (typeof p !== "number") throw new Error(`${options.name ?? "system_one"} returned no noul answer`);
      return {
        pass: p >= threshold,
        confidence: p,
        evidence: `P(holds) = ${p.toFixed(3)} (threshold ${threshold}${result.model ? `, ${result.model}` : ""})`,
      };
    },
    async close() {
      if (loaded) await (await loaded).close?.();
    },
  };
}
