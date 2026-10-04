import type { AssertRequestMeta } from "../agent/asserter.js";
import type { PlanRequestMeta } from "../agent/planner.js";
import type { LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from "./types.js";

export type ScriptedRequestMeta = PlanRequestMeta | AssertRequestMeta;

export type ScriptedHandler = (meta: ScriptedRequestMeta, request: LlmRequest) => LlmToolCall | undefined;

/** Viewport screenshots are 1280×720; image tokens ≈ width × height / 750. */
const IMAGE_TOKENS = Math.round((1280 * 720) / 750);

/**
 * What the same request would roughly cost a real model: text ≈ 4 chars per
 * token, one screenshot ≈ 1.2k tokens. Output counts the tool call only (no
 * reasoning tokens), so real output usage is higher.
 */
function estimateUsage(request: LlmRequest, toolCall: LlmToolCall | undefined) {
  const chars =
    request.system.length +
    JSON.stringify(request.tools).length +
    request.content.reduce((n, c) => n + (c.type === "text" ? c.text.length : 0), 0);
  const images = request.content.filter((c) => c.type === "image").length;
  return {
    inputTokens: Math.round(chars / 4) + images * IMAGE_TOKENS,
    outputTokens: Math.round(JSON.stringify(toolCall ?? "").length / 4),
  };
}

/**
 * Deterministic test double for LlmProvider. The handler receives the
 * structured request context (goal, page elements, history) and returns the
 * tool call the "model" makes. Records every call for assertions and reports
 * estimated token usage (see estimateUsage).
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
    return { ...(toolCall ? { toolCall } : { text: "(no tool call)" }), usage: estimateUsage(request, toolCall) };
  }

  callsFor(goalSubstring: string): number {
    return this.calls.filter((c) => c.goal.includes(goalSubstring)).length;
  }

  reset(): void {
    this.calls.length = 0;
  }
}
