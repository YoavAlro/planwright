import OpenAI from "openai";

import { InfraError } from "../runtime/errors.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

export interface OpenAIProviderOptions {
  /** Required: model id, e.g. a current vision + tool-calling model. */
  model: string;
  apiKey?: string;
  baseURL?: string;
}

/** OpenAI Chat Completions adapter. Requires the optional `openai` peer dependency. */
export class OpenAIProvider implements LlmProvider {
  readonly name = "openai";
  readonly model: string;
  private client: OpenAI | undefined;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.model = options.model;
  }

  checkCredentials(): string | null {
    if (this.options.apiKey || process.env.OPENAI_API_KEY) return null;
    return "OPENAI_API_KEY is not set. Fix: export OPENAI_API_KEY=<key> (or pass `apiKey` to openai()).";
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.client ??= new OpenAI({ apiKey: this.options.apiKey, baseURL: this.options.baseURL });
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: request.system },
          {
            role: "user",
            content: request.content.map((part) =>
              part.type === "text"
                ? { type: "text" as const, text: part.text }
                : { type: "image_url" as const, image_url: { url: `data:${part.mediaType};base64,${part.data}` } },
            ),
          },
        ],
        tools: request.tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: "required",
        parallel_tool_calls: false,
      });
    } catch (err) {
      if (err instanceof OpenAI.APIError) throw new InfraError(`OpenAI API error ${err.status ?? ""}: ${err.message}`);
      throw err;
    }
    const usage = {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
    const message = response.choices[0]?.message;
    const call = message?.tool_calls?.find((c) => c.type === "function");
    if (call && call.type === "function") {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        return { text: `Unparseable tool arguments: ${call.function.arguments}`, usage };
      }
      return { toolCall: { name: call.function.name, input }, usage };
    }
    return { text: message?.content ?? undefined, usage };
  }
}

export function openai(options: OpenAIProviderOptions): OpenAIProvider {
  return new OpenAIProvider(options);
}
