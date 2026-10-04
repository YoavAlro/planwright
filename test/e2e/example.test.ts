import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startApp, type App } from "../../examples/agentic-dashboard/app/server.js";
import { offlineBrain } from "../../examples/agentic-dashboard/offline-brain.js";
import { resolveConfig, run, systemOneJudge, type Judge, type SystemOneClient } from "../../src/index.js";

/**
 * Keeps examples/agentic-dashboard honest: its committed plans must replay,
 * its redesign must heal, and its slow backend must fail as infra.
 */
describe("example: agentic dashboard", () => {
  let app: App | undefined;
  afterEach(async () => app?.close());

  async function runAgainst(options: { ui?: "v1" | "v2"; slow?: boolean }, tags?: string, judge?: Judge) {
    app = await startApp(options);
    const dir = mkdtempSync(join(tmpdir(), "planwright-example-"));
    cpSync(new URL("../../examples/agentic-dashboard/features", import.meta.url), join(dir, "features"), { recursive: true });
    const llm = offlineBrain();
    const config = resolveConfig({ baseURL: app.url, llm, trace: "off", timeouts: { actionMs: 1_500 }, ...(judge ? { judge: { using: judge } } : {}) }, dir);
    const result = await run({ config, ci: true, tags, write: () => undefined });
    return { result, llm };
  }

  it("committed plans replay; only the tone judge calls the LLM", async () => {
    const { result, llm } = await runAgainst({});
    expect(result.scenarios.map((s) => [s.key, s.status, s.error])).toEqual(result.scenarios.map((s) => [s.key, "passed", undefined]));
    expect(result.exitCode).toBe(0);
    expect(llm.calls.map((c) => c.purpose)).toEqual(["judge"]);
  });

  it("the v2 redesign heals only the steps it broke", async () => {
    const { result } = await runAgainst({ ui: "v2" });
    expect(result.exitCode).toBe(2);
    expect(result.drift.every((d) => d.kind === "healed")).toBe(true);
    expect(result.drift.map((d) => d.step).sort()).toEqual(
      [
        "Given I open the assistant",
        "Given I open the assistant",
        'When I ask the assistant "How many open tickets do we have?"',
        'When I ask the assistant "Please create a ticket about the login page timing out"',
        "When I go to the dashboard",
        "Then I see the open tickets KPI with a number",
        "And I see customer satisfaction as a percentage",
      ].sort(),
    );
  });

  it("a hung assistant fails as infra without re-planning", async () => {
    // One scenario is enough to prove it; each waits out the 20s "Thinking…" timeout.
    const { result, llm } = await runAgainst({ slow: true }, "@mutating");
    expect(result.exitCode).toBe(3);
    expect(llm.calls).toHaveLength(0);
  }, 90_000);

  it("a Jev-style system_one judge replaces the LLM judge: zero LLM calls", async () => {
    const seen: { state: unknown; instructions: string }[] = [];
    const client: SystemOneClient = {
      async systemOne(state, questions) {
        const q = questions.holds!;
        seen.push({ state, instructions: q.instructions });
        return { model: "fake-laya", answers: { holds: { noul: 0.91 } } };
      },
    };
    const { result, llm } = await runAgainst({}, undefined, systemOneJudge(client, { name: "fake-laya" }));
    expect(result.exitCode).toBe(0);
    expect(llm.calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.instructions).toContain("the reply sounds like a helpful support teammate");
    expect(JSON.stringify(seen[0]!.state)).toContain("open tickets");
    const judged = result.scenarios.flatMap((s) => s.steps).find((s) => s.mode === "judged");
    expect(judged?.evidence).toContain("P(holds) = 0.910");
  });

  it("a low P(true) from the system_one judge fails the step", async () => {
    const client: SystemOneClient = { systemOne: async () => ({ answers: { holds: { noul: 0.2 } } }) };
    const { result } = await runAgainst({}, "not @mutating", systemOneJudge(client));
    expect(result.exitCode).toBe(1);
    expect(result.scenarios.find((s) => s.status === "failed")?.error).toMatch(/P\(holds\) = 0.200/);
  });
});
