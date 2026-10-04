/**
 * Provider-agnostic LLM surface. Planwright only ever sends single-turn
 * requests (one user message carrying the full state + history as text and at
 * most one screenshot) and expects at most one tool call back, so adapters stay
 * a thin mapping onto each SDK.
 */
export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/jpeg" | "image/png"; data: string };

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input (type: object). */
  parameters: Record<string, unknown>;
}

export type LlmPurpose = "plan" | "assert" | "judge";

export interface LlmRequest {
  purpose: LlmPurpose;
  system: string;
  content: LlmContentPart[];
  tools: LlmTool[];
  /**
   * Structured copy of the request context. Real providers ignore it; test
   * doubles (see ScriptedProvider) use it to answer without parsing prompts.
   */
  meta?: unknown;
}

export interface LlmToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  toolCall?: LlmToolCall;
  text?: string;
  usage: LlmUsage;
}

export interface LlmProvider {
  /** Short provider id, recorded in plans (e.g. "anthropic"). */
  readonly name: string;
  /** Model id, recorded in plans. */
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
  /** Optional credential check used by `planwright doctor`. Returns a problem description or null. */
  checkCredentials?(): string | null;
}
