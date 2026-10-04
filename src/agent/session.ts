import type { LlmProvider, LlmRequest, LlmResponse } from "../llm/types.js";
import type { Usage } from "../report/types.js";
import { BudgetExceededError, ConfigError } from "../runtime/errors.js";

/** Wraps the provider for one run: counts calls and tokens, enforces the token budget. */
export class LlmSession {
  readonly usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

  constructor(
    private readonly provider: LlmProvider | undefined,
    private readonly maxTokens?: number,
  ) {}

  get identity(): { provider: string; model: string } {
    return { provider: this.provider?.name ?? "none", model: this.provider?.model ?? "none" };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (!this.provider) throw new ConfigError("This step needs an LLM but no provider is configured.");
    if (this.maxTokens !== undefined && this.usage.inputTokens + this.usage.outputTokens >= this.maxTokens) {
      throw new BudgetExceededError(`Token budget of ${this.maxTokens} exhausted.`);
    }
    const response = await this.provider.complete(request);
    this.usage.calls += 1;
    this.usage.inputTokens += response.usage.inputTokens;
    this.usage.outputTokens += response.usage.outputTokens;
    return response;
  }
}
