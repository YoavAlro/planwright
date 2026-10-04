import { readFileSync, writeFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startDemo, type DemoServer } from "../../demo/server.js";
import { createProject, type Project } from "../support/harness.js";

const FEATURE = `Feature: Tasks
  Scenario: Add a task
    Given I am on the task board
    When I add a task named "Buy milk"
    Then I see the task "Buy milk" in the list
    And the open tasks counter is shown
`;

/**
 * Acceptance criteria 1-8 run as one ordered lifecycle against the same plan
 * file, the way a real repo evolves: cold run → warm run → UI changes.
 */
describe("plan lifecycle", () => {
  let demo: DemoServer;
  let project: Project;
  let featurePath: string;

  beforeAll(async () => {
    demo = await startDemo();
    project = createProject(demo.url);
    featurePath = project.writeFeature("tasks.feature", FEATURE);
  });
  afterAll(async () => demo.close());
  beforeEach(() => demo.reset());

  it("1. cold run plans every step, writes the plan, and exits 2 in CI", async () => {
    const result = await project.run({ ci: true });
    expect(result.fatal).toBeUndefined();
    expect(result.scenarios[0]?.status).toBe("passed");
    expect(result.exitCode).toBe(2);
    expect(result.drift.map((d) => d.kind)).toEqual(["new", "new", "new", "new"]);
    expect(project.provider.calls.length).toBeGreaterThan(0);
    const plan = JSON.parse(project.readPlan("tasks.feature"));
    expect(Object.keys(plan.scenarios)).toEqual(["Add a task"]);
    expect(plan.scenarios["Add a task"].steps).toHaveLength(4);
    expect(project.output.join("")).toContain("PLAN DRIFT");
  });

  it("2. warm run replays with zero LLM calls and exits 0", async () => {
    const before = project.readPlan("tasks.feature");
    const result = await project.run({ ci: true });
    expect(result.exitCode).toBe(0);
    expect(project.provider.calls).toHaveLength(0);
    expect(result.scenarios[0]?.steps.every((s) => s.mode === "replayed")).toBe(true);
    expect(project.readPlan("tasks.feature")).toBe(before);
  });

  it("7. stateless Then: a counter value that changes between runs still passes", async () => {
    demo.variant.counterOffset = 41;
    const result = await project.run({ ci: true });
    expect(result.exitCode).toBe(0);
    expect(project.provider.calls).toHaveLength(0);
  });

  it("3. a ranked fallback locator absorbs a removed test id with zero LLM calls", async () => {
    demo.variant.addButton = { label: "Add task", id: "add-task-btn" };
    const result = await project.run({ ci: true });
    expect(result.exitCode).toBe(0);
    expect(project.provider.calls).toHaveLength(0);
  });

  it("8. infra failure (HTTP 500) never re-plans and exits 3", async () => {
    const before = project.readPlan("tasks.feature");
    demo.variant.serverError = true;
    const result = await project.run({ ci: true });
    expect(result.exitCode).toBe(3);
    expect(result.scenarios[0]?.failureKind).toBe("infra");
    expect(project.provider.calls).toHaveLength(0);
    expect(project.readPlan("tasks.feature")).toBe(before);
  });

  it("--frozen fails a drifted step instead of calling the LLM", async () => {
    demo.variant.addButton = { label: "Create task", testid: "create-task", id: "create-btn", wrapped: true };
    const result = await project.run({ ci: true, frozen: true });
    expect(result.exitCode).toBe(1);
    expect(project.provider.calls).toHaveLength(0);
  });

  it("4. UI drift heals only the drifted step, passes, and exits 2", async () => {
    demo.variant.addButton = { label: "Create task", testid: "create-task", id: "create-btn", wrapped: true };
    const result = await project.run({ ci: true });
    expect(result.exitCode).toBe(2);
    const steps = result.scenarios[0]!.steps;
    expect(steps.map((s) => s.mode)).toEqual(["replayed", "healed", "replayed", "replayed"]);
    expect(project.provider.calls.every((c) => c.goal.includes("add a task"))).toBe(true);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toMatchObject({ kind: "healed", step: 'When I add a task named "Buy milk"' });
    expect(result.drift[0]?.reason).toMatch(/not found/);
    const plan = project.readPlan("tasks.feature");
    expect(plan).toContain("create-task");
    expect(plan).toContain('"source": "healed"');
    expect(readFileSync(`${project.dir}/planwright-results/drift-report.md`, "utf8")).toContain("Healed");
  });

  it("2b. the healed plan replays cleanly afterwards", async () => {
    demo.variant.addButton = { label: "Create task", testid: "create-task", id: "create-btn", wrapped: true };
    const result = await project.run({ ci: true });
    expect(result.exitCode).toBe(0);
    expect(project.provider.calls).toHaveLength(0);
  });

  it("5. a real regression fails the scenario and keeps the old plan", async () => {
    const before = project.readPlan("tasks.feature");
    demo.variant.addButton = null;
    const result = await project.run({ ci: true });
    expect(result.exitCode).toBe(1);
    expect(result.scenarios[0]?.steps[1]).toMatchObject({ status: "failed" });
    expect(result.scenarios[0]?.steps[1]?.error).toMatch(/no add button/);
    expect(project.readPlan("tasks.feature")).toBe(before);
  });

  it("6. editing a step's text re-plans only that step", async () => {
    demo.variant.addButton = { label: "Create task", testid: "create-task", id: "create-btn", wrapped: true };
    writeFileSync(featurePath, FEATURE.replace("And the open tasks counter is shown", "And the open tasks counter is displayed"));
    const result = await project.run({ ci: true });
    expect(result.exitCode).toBe(2);
    expect(result.scenarios[0]!.steps.map((s) => s.mode)).toEqual(["replayed", "replayed", "replayed", "planned"]);
    expect(project.provider.calls).toHaveLength(1);
    expect(project.readPlan("tasks.feature")).not.toContain("counter is shown");
  });
});
