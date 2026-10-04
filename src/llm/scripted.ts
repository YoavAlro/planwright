import type { AssertRequestMeta } from "../agent/asserter.js";
import type { PlanRequestMeta } from "../agent/planner.js";
import type { LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from "./types.js";

export type ScriptedRequestMeta = PlanRequestMeta | AssertRequestMeta;

export type ScriptedHandler = (meta: ScriptedRequestMeta, request: LlmRequest) => LlmToolCall | undefined;

/**
 * Deterministic test double for LlmProvider. The handler receives the
 * structured request context (goal, page elements, history) and returns the
 * tool call the "model" makes. Records every call for assertions.
 */
export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  readonly calls: { purpose: LlmRequest["purpose"]; goal: string }[] = [];

  constructor(
    private readonly handler: ScriptedHandler,
    readonly model = "scripted-model",
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const meta = request.meta as ScriptedRequestMeta;
    this.calls.push({ purpose: request.purpose, goal: meta.goal });
    const toolCall = this.handler(meta, request);
    return { ...(toolCall ? { toolCall } : { text: "(no tool call)" }), usage: { inputTokens: 100, outputTokens: 10 } };
  }

  callsFor(goalSubstring: string): number {
    return this.calls.filter((c) => c.goal.includes(goalSubstring)).length;
  }

  reset(): void {
    this.calls.length = 0;
  }
}
