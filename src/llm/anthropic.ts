import Anthropic from "@anthropic-ai/sdk";

import { InfraError } from "../runtime/errors.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export interface AnthropicProviderOptions {
  /** Defaults to claude-opus-5-5. */
  model?: string;
  /** Defaults to the SDK's resolution (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, `ant auth login` profile). */
  apiKey?: string;
  baseURL?: string;
  /** Reasoning effort. Defaults to "medium". */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Server-side refusal fallback: if the model declines, the API re-runs the
   * request on a fallback model inside the same call. Defaults to "default".
   * Set false to disable (e.g. when going through a proxy that rejects it).
   */
  fallbacks?: "default" | false;
  maxTokens?: number;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic | undefined;

  constructor(private readonly options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  }

  checkCredentials(): string | null {
    if (this.options.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return null;
    return "ANTHROPIC_API_KEY is not set. Fix: export ANTHROPIC_API_KEY=<key> (or run `ant auth login`, or pass `apiKey` to anthropic()).";
  }

  private getClient(): Anthropic {
    this.client ??= new Anthropic({ apiKey: this.options.apiKey, baseURL: this.options.baseURL });
    return this.client;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = request.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } },
    );
    const fallbacks = this.options.fallbacks ?? "default";
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.getClient().beta.messages.create({
        model: this.model,
        max_tokens: this.options.maxTokens ?? 16000,
        system: request.system,
        messages: [{ role: "user", content }],
        tools: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
        })),
        // Forced tool choice is not accepted by current models; the system prompt requires a tool call.
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        output_config: { effort: this.options.effort ?? "medium" },
        ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks } : {}),
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        throw new InfraError(`Anthropic API error ${err.status ?? ""}: ${err.message}`);
      }
      throw err;
    }
    const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    if (response.stop_reason === "refusal") {
      return { text: "The model declined this request.", usage };
    }
    let text: string | undefined;
    for (const block of response.content) {
      if (block.type === "tool_use") {
        return { toolCall: { name: block.name, input: (block.input ?? {}) as Record<string, unknown> }, usage };
      }
      if (block.type === "text") text = (text ?? "") + block.text;
    }
    return { text, usage };
  }
}

export function anthropic(options?: AnthropicProviderOptions): AnthropicProvider {
  return new AnthropicProvider(options);
}
