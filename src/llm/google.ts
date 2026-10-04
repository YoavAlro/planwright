import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";

import type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

export interface GoogleProviderOptions {
  /** Required: Gemini model id. */
  model: string;
  /** Gemini API key. Omit when using Vertex AI. */
  apiKey?: string;
  /** Use Vertex AI (Application Default Credentials) instead of the Gemini API. */
  vertex?: { project: string; location: string };
}

/** Google Gemini adapter (Gemini API or Vertex AI). Requires the optional `@google/genai` peer dependency. */
export class GoogleProvider implements LlmProvider {
  readonly name = "google";
  readonly model: string;
  private client: GoogleGenAI | undefined;

  constructor(private readonly options: GoogleProviderOptions) {
    this.model = options.model;
  }

  checkCredentials(): string | null {
    if (this.options.vertex) return null; // ADC is resolved lazily by the SDK.
    if (this.options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return null;
    return "GEMINI_API_KEY is not set. Fix: export GEMINI_API_KEY=<key>, or configure google({ vertex: { project, location } }).";
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.client ??= this.options.vertex
      ? new GoogleGenAI({ vertexai: true, project: this.options.vertex.project, location: this.options.vertex.location })
      : new GoogleGenAI({ apiKey: this.options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY });
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: request.content.map((part) =>
            part.type === "text" ? { text: part.text } : { inlineData: { mimeType: part.mediaType, data: part.data } },
          ),
        },
      ],
      config: {
        systemInstruction: request.system,
        tools: [
          {
            functionDeclarations: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.parameters,
            })),
          },
        ],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
      },
    });
    const usage = {
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    };
    const call = response.functionCalls?.[0];
    if (call?.name) return { toolCall: { name: call.name, input: (call.args ?? {}) as Record<string, unknown> }, usage };
    return { text: response.text, usage };
  }
}

export function google(options: GoogleProviderOptions): GoogleProvider {
  return new GoogleProvider(options);
}
