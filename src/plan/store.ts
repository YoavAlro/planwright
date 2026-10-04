import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { PlanFileError } from "../runtime/errors.js";
import { PLAN_SCHEMA_VERSION, type FeaturePlan } from "./types.js";

const SCHEMA_URL = "https://raw.githubusercontent.com/YoavAlro/planwright/main/schema/plan.schema.json";

export function planPathFor(featurePath: string): string {
  return featurePath.replace(/\.feature$/, ".plan.json");
}

export function emptyPlan(featurePath: string): FeaturePlan {
  return { $schema: SCHEMA_URL, version: PLAN_SCHEMA_VERSION, feature: basename(featurePath), scenarios: {} };
}

export function loadPlan(featurePath: string): FeaturePlan {
  const path = planPathFor(featurePath);
  if (!existsSync(path)) return emptyPlan(featurePath);
  let parsed: FeaturePlan;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as FeaturePlan;
  } catch (err) {
    throw new PlanFileError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed.version !== PLAN_SCHEMA_VERSION) {
    throw new PlanFileError(
      `${path} has plan version ${parsed.version}; this planwright reads version ${PLAN_SCHEMA_VERSION}. Delete the file to re-plan.`,
    );
  }
  return parsed;
}

// Keys that read best first in a diff; everything else follows alphabetically.
const KEY_ORDER = ["$schema", "version", "feature", "scenarios", "name", "steps", "keyword", "text", "hash", "source", "generatedBy", "type", "kind"];
const rank = (k: string) => {
  const i = KEY_ORDER.indexOf(k);
  return i === -1 ? KEY_ORDER.length : i;
};

/** Recursively orders object keys so serialization is byte-stable. Arrays keep their order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function serializePlan(plan: FeaturePlan): string {
  return JSON.stringify(sortKeys(plan), null, 2) + "\n";
}

/** Writes the plan only when its serialized form changed. Returns whether it wrote. */
export function savePlan(featurePath: string, plan: FeaturePlan): boolean {
  const path = planPathFor(featurePath);
  const next = serializePlan(plan);
  if (existsSync(path) && readFileSync(path, "utf8") === next) return false;
  writeFileSync(path, next);
  return true;
}
