import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { AstBuilder, GherkinClassicTokenMatcher, Parser, compile } from "@cucumber/gherkin";
import {
  IdGenerator,
  type FeatureChild,
  type GherkinDocument,
  type Pickle,
  type PickleStepArgument,
  type RuleChild,
  type Step,
} from "@cucumber/messages";

import { ConfigError } from "../runtime/errors.js";
import { stepHash } from "../plan/template.js";

export type StepKind = "context" | "action" | "outcome";

export interface ScenarioStep {
  keyword: string;
  kind: StepKind;
  text: string;
  /** Doc string or data table rendered as text, if any. */
  argument?: string;
  hash: string;
}

export interface ParsedScenario {
  /** Stable key inside the feature's plan file. */
  key: string;
  name: string;
  tags: string[];
  /** Examples-row values for outlines, by column header. */
  params: Record<string, string>;
  steps: ScenarioStep[];
}

export interface ParsedFeature {
  path: string;
  name: string;
  scenarios: ParsedScenario[];
}

function renderArgument(arg: PickleStepArgument | undefined): string | undefined {
  if (!arg) return undefined;
  if (arg.docString) return arg.docString.content;
  if (arg.dataTable) return arg.dataTable.rows.map((r) => `| ${r.cells.map((c) => c.value).join(" | ")} |`).join("\n");
  return undefined;
}

function indexDocument(doc: GherkinDocument) {
  const keywords = new Map<string, string>();
  const rowParams = new Map<string, Record<string, string>>();
  const visitSteps = (steps: readonly Step[]) => {
    for (const s of steps) keywords.set(s.id, s.keyword.trim());
  };
  const visitChildren = (children: readonly (FeatureChild | RuleChild)[]) => {
    for (const child of children) {
      if (child.background) visitSteps(child.background.steps);
      if (child.scenario) {
        visitSteps(child.scenario.steps);
        for (const ex of child.scenario.examples) {
          const headers = ex.tableHeader?.cells.map((c) => c.value) ?? [];
          for (const row of ex.tableBody) {
            const params: Record<string, string> = {};
            row.cells.forEach((cell, i) => {
              const header = headers[i];
              if (header !== undefined) params[header] = cell.value;
            });
            rowParams.set(row.id, params);
          }
        }
      }
      if ("rule" in child && child.rule) visitChildren(child.rule.children);
    }
  };
  if (doc.feature) visitChildren(doc.feature.children);
  return { keywords, rowParams };
}

const KIND: Record<string, StepKind> = { Context: "context", Action: "action", Outcome: "outcome" };

export function parseFeatureSource(source: string, path: string, cwd = process.cwd()): ParsedFeature {
  const newId = IdGenerator.incrementing();
  const parser = new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher());
  let doc: GherkinDocument;
  try {
    doc = parser.parse(source);
  } catch (err) {
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  }
  const uri = relative(cwd, path);
  const pickles: readonly Pickle[] = compile(doc, uri, newId);
  const { keywords, rowParams } = indexDocument(doc);

  const seenKeys = new Map<string, number>();
  const scenarios: ParsedScenario[] = pickles.map((pickle) => {
    const rowId = pickle.astNodeIds[1];
    const params = (rowId && rowParams.get(rowId)) || {};
    const paramSuffix = Object.keys(params).length
      ? ` [${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(", ")}]`
      : "";
    let key = `${pickle.name}${paramSuffix}`;
    const n = (seenKeys.get(key) ?? 0) + 1;
    seenKeys.set(key, n);
    if (n > 1) key = `${key} #${n}`;

    let lastKind: StepKind = "context";
    const steps = pickle.steps.map((step): ScenarioStep => {
      const kind = (step.type && KIND[step.type]) ?? lastKind;
      lastKind = kind;
      const argument = renderArgument(step.argument);
      return {
        keyword: keywords.get(step.astNodeIds[0] ?? "") ?? "*",
        kind,
        text: step.text,
        argument,
        hash: stepHash(kind, step.text, argument),
      };
    });
    return { key, name: pickle.name, tags: pickle.tags.map((t) => t.name), params, steps };
  });

  return { path, name: doc.feature?.name ?? uri, scenarios };
}

export function parseFeatureFile(path: string, cwd?: string): ParsedFeature {
  return parseFeatureSource(readFileSync(path, "utf8"), path, cwd);
}

/**
 * Minimal tag expression support: comma = OR, `and` = AND, `not` prefix.
 * Examples: "@smoke", "@smoke and not @slow", "@a,@b".
 */
export function matchesTags(tags: readonly string[], expression: string | undefined): boolean {
  if (!expression) return true;
  return expression.split(",").some((alt) =>
    alt
      .split(/\s+and\s+/i)
      .map((t) => t.trim())
      .filter(Boolean)
      .every((term) => (term.toLowerCase().startsWith("not ") ? !tags.includes(term.slice(4).trim()) : tags.includes(term))),
  );
}
