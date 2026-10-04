import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startDemo } from "../../demo/server.js";
import { anthropic, resolveConfig, run } from "../../src/index.js";

/**
 * Optional smoke test against the real default provider. Skipped unless
 * ANTHROPIC_API_KEY is set; costs a few cents per run.
 */
describe.skipIf(!process.env.ANTHROPIC_API_KEY)("real LLM smoke (Anthropic)", () => {
  it("plans the demo scenario cold, then replays it with zero LLM calls", async () => {
    const demo = await startDemo();
    try {
      const dir = mkdtempSync(join(tmpdir(), "planwright-real-"));
      mkdirSync(join(dir, "features"));
      writeFileSync(
        join(dir, "features", "tasks.feature"),
        `Feature: Tasks
  Scenario: Add a task
    Given I am on the task board
    When I add a task named "Buy milk"
    Then I see the task "Buy milk" in the list
    And the open tasks counter is shown
`,
      );
      const config = resolveConfig({ baseURL: demo.url, llm: anthropic(), trace: "off" }, dir);
      const cold = await run({ config, ci: true, write: () => undefined });
      expect(cold.scenarios[0]?.status, cold.scenarios[0]?.error).toBe("passed");
      expect(cold.exitCode).toBe(2);

      demo.reset();
      const warm = await run({ config, ci: true, write: () => undefined });
      expect(warm.exitCode).toBe(0);
      expect(warm.usage.calls).toBe(0);
    } finally {
      await demo.close();
    }
  }, 600_000);
});
