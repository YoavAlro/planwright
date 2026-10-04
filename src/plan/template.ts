import { createHash } from "node:crypto";

import { ConfigError } from "../runtime/errors.js";

/**
 * Plans never store secrets or run-specific values. They store references that
 * are resolved at replay time:
 *   ${env.NAME}    process environment
 *   ${param.name}  Scenario Outline Examples column
 *   ${vars.name}   runtime variables set by hooks / custom steps
 */
export interface TemplateScope {
  env: Record<string, string | undefined>;
  params: Record<string, string>;
  vars: Record<string, unknown>;
}

const REF = /\$\{(env|param|vars)\.([A-Za-z_][A-Za-z0-9_-]*)\}/g;

export function resolveTemplate(input: string, scope: TemplateScope): string {
  return input.replace(REF, (_match, ns: string, key: string) => {
    const value =
      ns === "env" ? scope.env[key] : ns === "param" ? scope.params[key] : scope.vars[key];
    if (value === undefined || value === null) {
      throw new ConfigError(`Unresolved reference \${${ns}.${key}}: no such ${ns === "vars" ? "var" : ns} is set.`);
    }
    return String(value);
  });
}

const MIN_SUBSTRING_LEN = 3;

/**
 * Replaces literal values the planner typed with references, so a plan never
 * stores an outline value, a runtime var, or a secret verbatim.
 * Secrets are matched anywhere; params/vars when the whole value matches or
 * when they are long enough not to collide with ordinary words.
 */
export function toReferences(value: string, scope: TemplateScope, secretEnvNames: readonly string[]): string {
  const candidates: { literal: string; ref: string; anywhere: boolean }[] = [];
  for (const name of secretEnvNames) {
    const secret = scope.env[name];
    if (secret) candidates.push({ literal: secret, ref: `\${env.${name}}`, anywhere: true });
  }
  for (const [k, v] of Object.entries(scope.params)) {
    if (v) candidates.push({ literal: v, ref: `\${param.${k}}`, anywhere: v.length >= MIN_SUBSTRING_LEN });
  }
  for (const [k, v] of Object.entries(scope.vars)) {
    if (typeof v === "string" || typeof v === "number") {
      const s = String(v);
      if (s) candidates.push({ literal: s, ref: `\${vars.${k}}`, anywhere: s.length >= MIN_SUBSTRING_LEN });
    }
  }
  // Longest literal first so "Buy milk today" wins over "milk".
  candidates.sort((a, b) => b.literal.length - a.literal.length);
  let out = value;
  for (const c of candidates) {
    if (out === c.literal) return c.ref;
    if (c.anywhere && out.includes(c.literal)) out = out.split(c.literal).join(c.ref);
  }
  return out;
}

export function stepHash(stepType: string, text: string, argument: string | undefined): string {
  return createHash("sha256")
    .update(`${stepType}\n${text.trim().replace(/\s+/g, " ")}\n${argument ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}
