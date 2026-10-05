import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startDemo, type DemoServer } from "../../demo/server.js";
import { doctor, resolveConfig, ScriptedProvider, type ScenarioContext } from "../../src/index.js";
import { demoBrain } from "../support/brain.js";
import { createProject } from "../support/harness.js";

describe("gherkin features, secrets, extensibility", () => {
  let demo: DemoServer;
  beforeAll(async () => {
    demo = await startDemo();
  });
  afterAll(async () => demo.close());
  beforeEach(() => demo.reset());

  it("9. a Scenario Outline gets one plan per Examples row with values stored as references", async () => {
    const project = createProject(demo.url);
    project.writeFeature(
      "outline.feature",
      `Feature: Outline
  Background:
    Given I am on the task board

  Scenario Outline: Add <name>
    When I add a task named "<name>"
    Then I see the task "<name>" in the list

    Examples:
      | name        |
      | Water plants |
      | Call mom     |
`,
    );
    const result = await project.run({ ci: true });
    expect(result.scenarios.map((s) => s.status)).toEqual(["passed", "passed"]);
    const plan = JSON.parse(project.readPlan("outline.feature"));
    expect(Object.keys(plan.scenarios).sort()).toEqual(["Add Call mom [name=Call mom]", "Add Water plants [name=Water plants]"]);
    const fill = plan.scenarios["Add Call mom [name=Call mom]"].steps[1].actions.find((a: { type: string }) => a.type === "fill");
    expect(fill.value).toBe("${param.name}");

    demo.reset();
    const warm = await project.run({ ci: true });
    expect(warm.exitCode).toBe(0);
    expect(project.provider.calls).toHaveLength(0);
  });

  it("9b. secrets are never written to a plan, even when the model types the literal", async () => {
    process.env.DEMO_PASSWORD = "hunter2-secret";
    const source = `Feature: Login
  Scenario: Sign in
    When I sign in with password "\${env.DEMO_PASSWORD}"
    Then I see my account name
`;
    for (const typeLiteralSecret of [false, true]) {
      const project = createProject(demo.url, { typeLiteralSecret }, { secrets: ["DEMO_PASSWORD"] });
      project.writeFeature("login.feature", source);
      const result = await project.run({ ci: true });
      expect(result.scenarios[0]?.status).toBe("passed");
      const plan = project.readPlan("login.feature");
      expect(plan).not.toContain("hunter2-secret");
      expect(plan).toContain("${env.DEMO_PASSWORD}");
      const warm = await project.run({ ci: true });
      expect(warm.exitCode).toBe(0);
    }
  });

  it("10. custom steps and hooks run and are never planned", async () => {
    const calls: string[] = [];
    const project = createProject(demo.url, {}, {
      steps: [
        {
          pattern: /^I am signed in as "([^"]+)"$/,
          async run(ctx: ScenarioContext, user: string) {
            calls.push(`step:${user}:${String(ctx.vars.runId)}`);
            await ctx.context.addCookies([{ name: "demo_session", value: user, url: demo.url }]);
          },
        },
      ],
      hooks: {
        beforeScenario(ctx) {
          ctx.vars.runId = "run-1";
          calls.push(`before:${ctx.scenario.name}`);
        },
        afterScenario(_ctx, result) {
          calls.push(`after:${result.status}`);
        },
      },
    });
    project.writeFeature(
      "account.feature",
      `Feature: Account
  Scenario: Account page
    Given I am signed in as "ada"
    When I open my account page
    Then I see my account name
`,
    );
    const result = await project.run();
    expect(result.scenarios[0]?.status).toBe("passed");
    expect(result.scenarios[0]?.steps[0]?.mode).toBe("custom");
    expect(calls).toEqual(["before:Account page", "step:ada:run-1", "after:passed"]);
    expect(project.provider.calls.some((c) => c.goal.includes("signed in as"))).toBe(false);
    const plan = JSON.parse(project.readPlan("account.feature"));
    expect(plan.scenarios["Account page"].steps.map((s: { text: string }) => s.text)).toEqual([
      "I open my account page",
      "I see my account name",
    ]);
  });

  it("a Then that pins an observed value is stored as an LLM judge instead", async () => {
    const project = createProject(demo.url, { pinCounterValue: true });
    project.writeFeature(
      "counter.feature",
      `Feature: Counter
  Scenario: Counter
    Given I am on the task board
    Then the open tasks counter is shown
`,
    );
    await project.run();
    const plan = JSON.parse(project.readPlan("counter.feature"));
    expect(plan.scenarios.Counter.steps[1].actions).toEqual([{ type: "judge" }]);
    const warm = await project.run();
    expect(warm.exitCode).toBe(0);
    expect(warm.scenarios[0]?.steps[1]?.mode).toBe("judged");
  });

  it("assertions tolerate repeated data from earlier runs", async () => {
    const project = createProject(demo.url);
    project.writeFeature(
      "repeat.feature",
      `Feature: Repeat
  Scenario: Repeat
    Given I am on the task board
    When I add a task named "Milk"
    Then I see the task "Milk" in the list
`,
    );
    await project.run();
    // No demo.reset(): the list now holds "Milk" twice.
    const warm = await project.run({ ci: true });
    expect(warm.exitCode).toBe(0);
    expect(project.provider.calls).toHaveLength(0);
    expect(demo.tasks).toEqual(["Milk", "Milk"]);
  });

  it("--no-cache plans every step from scratch and leaves plan files untouched", async () => {
    const project = createProject(demo.url);
    project.writeFeature(
      "fresh.feature",
      `Feature: Fresh
  Scenario: Fresh
    Given I am on the task board
    When I add a task named "Milk"
    Then I see the task "Milk" in the list
`,
    );
    await project.run();
    const before = project.readPlan("fresh.feature");
    const fresh = await project.run({ ci: true, noCache: true });
    expect(fresh.exitCode).toBe(0);
    expect(fresh.scenarios[0]?.steps.every((s) => s.mode === "planned")).toBe(true);
    expect(project.provider.calls.length).toBeGreaterThan(0);
    expect(fresh.drift).toEqual([]);
    expect(fresh.plansWritten).toEqual([]);
    expect(project.readPlan("fresh.feature")).toBe(before);

    for (const conflict of [{ frozen: true }, { replan: true }]) {
      const bad = await project.run({ noCache: true, ...conflict });
      expect(bad.exitCode).toBe(3);
      expect(bad.fatal).toMatch(/--no-cache/);
    }
  });

  it("a premature done on a blank page is rejected and the agent continues", async () => {
    const project = createProject(demo.url, { prematureDone: true });
    project.writeFeature("blank.feature", "Feature: Blank\n  Scenario: Blank\n    Given I am on the task board\n    Then the open tasks counter is shown\n");
    const result = await project.run();
    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(project.readPlan("blank.feature"));
    expect(plan.scenarios.Blank.steps[0].actions.length).toBeGreaterThan(0);
  });

  it("done on an HTTP error page is refused, so a guessed URL can't pass a step", async () => {
    const project = createProject(demo.url, { guessWrongPath: true });
    project.writeFeature("guess.feature", "Feature: Guess\n  Scenario: Guess\n    Given I am on the task board\n    Then the open tasks counter is shown\n");
    const result = await project.run();
    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(project.readPlan("guess.feature"));
    expect(JSON.stringify(plan.scenarios.Guess.steps[0].actions)).toContain("Tasks");
  });

  it("done on an error page is accepted when insisted on, so steps about error pages still plan", async () => {
    const project = createProject(demo.url);
    project.writeFeature("missing.feature", "Feature: Missing\n  Scenario: Missing\n    When I open a page that does not exist\n");
    const result = await project.run();
    expect(result.exitCode).toBe(0);
    // navigate, done (refused once: HTTP 404), done again (accepted).
    expect(project.provider.callsFor("does not exist")).toBe(3);
    const plan = JSON.parse(project.readPlan("missing.feature"));
    expect(plan.scenarios.Missing.steps[0].actions).toEqual([{ type: "navigate", url: "/no-such-page" }]);
  });

  it("a prose-only answer to an assertion fails the step; a malformed verdict is an infra error", async () => {
    const project = createProject(demo.url);
    project.writeFeature("verdict.feature", "Feature: Verdict\n  Scenario: Verdict\n    Given I am on the task board\n    Then the open tasks counter is shown\n");
    const brain = demoBrain();
    const answering = (verdict: { name: string; input: Record<string, unknown> } | undefined) =>
      new ScriptedProvider((meta) => (meta.kind === "plan" ? brain(meta) : verdict));
    const prose = await project.run({}, { llm: answering(undefined) });
    expect(prose.exitCode).toBe(1);
    expect(prose.scenarios[0]?.steps[1]?.error).toMatch(/No verdict returned/);
    const malformed = await project.run({}, { llm: answering({ name: "verdict", input: { pass: true } }) });
    expect(malformed.exitCode).toBe(3);
  });

  it("tag filters select scenarios", async () => {
    const project = createProject(demo.url);
    project.writeFeature(
      "tags.feature",
      `Feature: Tags
  @smoke
  Scenario: Smoke
    Given I am on the task board

  @slow
  Scenario: Slow
    Given I am on the task board
`,
    );
    const result = await project.run({ tags: "@smoke" });
    expect(result.scenarios.map((s) => s.name)).toEqual(["Smoke"]);
  });

  it("11. doctor reports missing Anthropic credentials with the fix", async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const out: string[] = [];
      const project = createProject(demo.url);
      project.writeFeature("x.feature", "Feature: X\n  Scenario: X\n    Given I am on the task board\n");
      const code = await doctor(resolveConfig({ baseURL: demo.url, features: "features" }, project.dir), (t) => out.push(t), undefined);
      expect(code).toBe(3);
      expect(out.join("")).toContain("ANTHROPIC_API_KEY is not set");
      expect(out.join("")).toContain("export ANTHROPIC_API_KEY");
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    }
  });
});
