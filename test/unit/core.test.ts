import { describe, expect, it } from "vitest";

import { isStatelessPattern } from "../../src/agent/asserter.js";
import { matchesTags, parseFeatureSource } from "../../src/gherkin/parse.js";
import { emptyPlan, serializePlan } from "../../src/plan/store.js";
import { resolveTemplate, stepHash, toReferences } from "../../src/plan/template.js";
import { renderJUnit } from "../../src/report/files.js";
import { ConfigError } from "../../src/runtime/errors.js";
import { candidateLocators, isGroundedPattern } from "../../src/runtime/locators.js";

describe("templates", () => {
  const scope = { env: { PASSWORD: "s3cr3t-pw" }, params: { name: "Call mom", n: "1" }, vars: { runId: "run-42" } };

  it("resolves env, param and vars references", () => {
    expect(resolveTemplate("${env.PASSWORD}/${param.name}/${vars.runId}", scope)).toBe("s3cr3t-pw/Call mom/run-42");
  });

  it("throws a config error on unknown references", () => {
    expect(() => resolveTemplate("${env.MISSING}", scope)).toThrow(ConfigError);
  });

  it("replaces secrets anywhere and params when whole or long enough", () => {
    expect(toReferences("pw=s3cr3t-pw", scope, ["PASSWORD"])).toBe("pw=${env.PASSWORD}");
    expect(toReferences("Call mom", scope, [])).toBe("${param.name}");
    expect(toReferences("Please Call mom now", scope, [])).toBe("Please ${param.name} now");
    // A short param value is only replaced when it is the whole value.
    expect(toReferences("1", scope, [])).toBe("${param.n}");
    expect(toReferences("10 items", scope, [])).toBe("10 items");
    expect(toReferences("tag-run-42", scope, [])).toBe("tag-${vars.runId}");
  });

  it("hashes on normalized text and argument", () => {
    expect(stepHash("action", "I  add   a task", undefined)).toBe(stepHash("action", "I add a task", undefined));
    expect(stepHash("action", "I add a task", "doc")).not.toBe(stepHash("action", "I add a task", undefined));
    expect(stepHash("outcome", "x", undefined)).not.toBe(stepHash("action", "x", undefined));
  });
});

describe("gherkin parsing", () => {
  const source = `Feature: F
  Background:
    Given I am on the board

  @smoke
  Scenario: Plain
    When I click "Save"
    And I wait
    Then I see "Saved"
    But I do not see "Error"

  Scenario Outline: Row <name>
    When I add "<name>"
      """
      some doc
      """

    Examples:
      | name |
      | a    |
      | b    |

  Scenario: Plain
    Given dup name
`;
  const feature = parseFeatureSource(source, "/x/f.feature", "/x");

  it("expands background, outlines and keeps keywords and kinds", () => {
    expect(feature.scenarios.map((s) => s.key)).toEqual(["Plain", "Row a [name=a]", "Row b [name=b]", "Plain #2"]);
    const plain = feature.scenarios[0]!;
    expect(plain.tags).toEqual(["@smoke"]);
    expect(plain.steps.map((s) => `${s.keyword}:${s.kind}`)).toEqual([
      "Given:context",
      "When:action",
      "And:action",
      "Then:outcome",
      "But:outcome",
    ]);
    const row = feature.scenarios[1]!;
    expect(row.params).toEqual({ name: "a" });
    expect(row.steps[1]?.text).toBe('I add "a"');
    expect(row.steps[1]?.argument).toBe("some doc");
  });

  it("matches tag expressions", () => {
    expect(matchesTags(["@smoke"], "@smoke")).toBe(true);
    expect(matchesTags(["@smoke", "@slow"], "@smoke and not @slow")).toBe(false);
    expect(matchesTags(["@b"], "@a,@b")).toBe(true);
    expect(matchesTags([], undefined)).toBe(true);
  });

  it("reports syntax errors as config errors", () => {
    expect(() => parseFeatureSource("Feature: a\n  Scenario: x\n    Given y\n      \"\"\"\n", "/x/bad.feature", "/x")).toThrow(ConfigError);
  });
});

describe("stateless pattern guard", () => {
  it("rejects digits observed on the page but not in the step", () => {
    expect(isStatelessPattern("^Open tasks: \\d+$", "the open tasks counter is shown")).toBe(true);
    expect(isStatelessPattern("Open tasks: 7", "the open tasks counter is shown")).toBe(false);
    expect(isStatelessPattern("\\d{3}-\\d{4}", "a phone number is shown")).toBe(true);
    expect(isStatelessPattern("3 results", 'I see "3 results"')).toBe(true);
  });
});

describe("grounded pattern guard", () => {
  it("only allows words from the assertion, ignoring regex syntax", () => {
    const step = "Then the assistant confirms a new ticket number";
    expect(isGroundedPattern("#\\d+", step)).toBe(true);
    expect(isGroundedPattern("tickets?\\s*#\\d+", step)).toBe(true);
    expect(isGroundedPattern("created\\s+#\\d+", step)).toBe(false);
    expect(isGroundedPattern("(?=.*\\d)(?=.*\\bopen\\b)", "the reply has a number of open tickets")).toBe(true);
    expect(isGroundedPattern("^\\d+(\\.\\d+)?%$", "satisfaction as a percentage")).toBe(true);
  });
});

describe("plan serialization", () => {
  it("is byte-stable regardless of insertion order and puts readable keys first", () => {
    const a = emptyPlan("/x/f.feature");
    a.scenarios.S = {
      name: "S",
      steps: [{ actions: [{ type: "navigate", url: "/" }], text: "t", keyword: "Given", hash: "h", source: "planned", generatedBy: { model: "m", provider: "p" } }],
    };
    const b = JSON.parse(JSON.stringify(a));
    b.scenarios.S.steps[0] = { generatedBy: { provider: "p", model: "m" }, source: "planned", hash: "h", keyword: "Given", text: "t", actions: [{ url: "/", type: "navigate" }] };
    expect(serializePlan(a)).toBe(serializePlan(b));
    const out = serializePlan(a);
    expect(out.indexOf('"keyword"')).toBeLessThan(out.indexOf('"actions"'));
  });
});

describe("locator candidates", () => {
  it("ranks test id, role, label, placeholder, stable id, text and skips generated ids", () => {
    const specs = candidateLocators({
      ref: 0,
      tag: "input",
      role: "textbox",
      name: "Email",
      testid: "email",
      label: "Email",
      placeholder: "you@example.com",
      id: ":r12:",
      interactive: true,
      cssPath: "body > input",
    });
    expect(specs.map((s) => s.by)).toEqual(["testid", "role", "label", "placeholder", "css"]);
  });
});

describe("junit", () => {
  it("escapes and reports failures", () => {
    const xml = renderJUnit({
      exitCode: 1,
      drift: [],
      plansWritten: [],
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      durationMs: 1,
      scenarios: [
        { feature: "f.feature", key: "A <b>", name: "A", status: "failed", error: 'bad "x"', failureKind: "failure", durationMs: 5, steps: [], artifacts: [] },
      ],
    });
    expect(xml).toContain('name="A &lt;b&gt;"');
    expect(xml).toContain('<failure message="bad &quot;x&quot;"');
  });
});
