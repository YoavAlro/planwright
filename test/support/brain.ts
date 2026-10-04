import type { LlmToolCall, ScriptedRequestMeta } from "../../src/index.js";
import type { ElementInfo } from "../../src/runtime/page-state.js";

/**
 * Rule-based stand-in for an LLM that knows the demo app. It only sees what a
 * real model would (goal, elements, history), so the runner is exercised
 * exactly as with a real provider.
 */
export interface BrainOptions {
  /** Propose a check that pins the observed counter value (should be rejected). */
  pinCounterValue?: boolean;
  /** Type the literal secret instead of the ${env.X} reference. */
  typeLiteralSecret?: boolean;
}

const find = (els: ElementInfo[], pred: (e: ElementInfo) => boolean) => els.find(pred);
const byName = (els: ElementInfo[], role: string, re: RegExp) => find(els, (e) => e.role === role && re.test(e.name ?? ""));

export function demoBrain(options: BrainOptions = {}) {
  return (meta: ScriptedRequestMeta): LlmToolCall | undefined => {
    const els = meta.state.elements;
    const url = meta.state.url;
    const text = meta.state.text;

    if (meta.kind === "judge") {
      const quoted = /"([^"]+)"/.exec(meta.goal)?.[1];
      const pass = quoted ? text.includes(quoted) : /Open tasks: \d+|Signed in as/.test(text);
      return { name: "verdict", input: { pass, confidence: 0.9, evidence: pass ? "found on page" : "not found" } };
    }

    if (meta.kind === "assert") {
      const task = /the task "([^"]+)"/.exec(meta.goal)?.[1];
      if (task) {
        const pass = text.includes(task);
        return { name: "verdict", input: { pass, confidence: 0.95, evidence: pass ? `"${task}" is listed` : "missing", checks: pass ? [{ kind: "visible", locator: { by: "text", value: task } }] : [] } };
      }
      if (/counter/.test(meta.goal)) {
        const counter = find(els, (e) => e.testid === "open-count");
        if (!counter) return { name: "verdict", input: { pass: false, confidence: 0.9, evidence: "no counter" } };
        const pattern = options.pinCounterValue ? counter.text!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "^Open tasks: \\d+$";
        return { name: "verdict", input: { pass: true, confidence: 0.95, evidence: counter.text, checks: [{ kind: "text", ref: counter.ref, pattern }] } };
      }
      if (/account name/.test(meta.goal)) {
        const name = find(els, (e) => e.testid === "account-name");
        return { name: "verdict", input: { pass: !!name, confidence: 0.9, evidence: name?.text ?? "none", checks: name ? [{ kind: "visible", ref: name.ref }] : [] } };
      }
      return { name: "verdict", input: { pass: false, confidence: 0.5, evidence: "unknown assertion" } };
    }

    // Planning.
    const done = (summary: string): LlmToolCall => ({ name: "done", input: { summary } });
    const okTools = meta.history.filter((h) => h.result.startsWith("ok")).map((h) => h.tool);
    const healedTools = (meta.healing?.executed ?? []).map((s) => s.split(" ")[0]);
    const did = (tool: string) => okTools.includes(tool) || healedTools.includes(tool);

    if (/on the task board/.test(meta.goal)) {
      if (url.endsWith("/tasks")) return done("on tasks page");
      const link = byName(els, "link", /^tasks$/i);
      return link ? { name: "click", input: { ref: link.ref } } : { name: "navigate", input: { url: "/" } };
    }

    const add = /add a task (?:named|called) "([^"]+)"/.exec(meta.goal);
    if (add) {
      if (did("click")) return done("task submitted");
      if (!did("fill")) {
        const input = find(els, (e) => e.role === "textbox");
        return input ? { name: "fill", input: { ref: input.ref, value: add[1] } } : { name: "fail", input: { reason: "no task input" } };
      }
      const button = byName(els, "button", /add|create/i);
      return button ? { name: "click", input: { ref: button.ref } } : { name: "fail", input: { reason: "no add button on the page" } };
    }

    if (/sign in with password/.test(meta.goal)) {
      if (did("click")) return done("signed in");
      if (!url.endsWith("/login")) return { name: "navigate", input: { url: "/login" } };
      const user = find(els, (e) => e.label === "Username");
      const pass = find(els, (e) => e.type === "password");
      if (!okTools.includes("fill")) return { name: "fill", input: { ref: user!.ref, value: "demo" } };
      if (okTools.filter((t) => t === "fill").length === 1) {
        const ref = /"(\$\{env\.[A-Z_]+\})"/.exec(meta.goal)?.[1] ?? "";
        const value = options.typeLiteralSecret ? process.env.DEMO_PASSWORD ?? "" : ref;
        return { name: "fill", input: { ref: pass!.ref, value } };
      }
      return { name: "click", input: { ref: byName(els, "button", /sign in/i)!.ref } };
    }

    if (/open my account page/.test(meta.goal)) {
      return url.endsWith("/account") ? done("on account page") : { name: "navigate", input: { url: "/account" } };
    }

    return { name: "fail", input: { reason: `brain does not know "${meta.goal}"` } };
  };
}
