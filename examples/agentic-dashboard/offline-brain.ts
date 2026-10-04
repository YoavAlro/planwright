import { ScriptedProvider, type LlmToolCall, type ScriptedRequestMeta } from "planwright";

/**
 * Offline stand-in for an LLM, so the example runs end to end without an API
 * key. It only knows this app's scenarios, and it sees exactly what a real
 * model sees (step goal, element list, page text, what it already did), so
 * planwright exercises the same plan → replay → heal machinery.
 *
 * With ANTHROPIC_API_KEY set, planwright.config.ts uses the real default
 * provider instead and this file is not involved.
 */
export function offlineBrain(): ScriptedProvider {
  return new ScriptedProvider(decide, "offline-demo-brain");
}

const quoted = (goal: string) => /"([^"]+)"/.exec(goal)?.[1];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function decide(meta: ScriptedRequestMeta): LlmToolCall | undefined {
  const { elements, text } = meta.state;
  const path = new URL(meta.state.url, "http://x").pathname;
  const goal = meta.goal;

  if (meta.kind === "judge") {
    const q = quoted(goal);
    const pass = q ? text.toLowerCase().includes(q.toLowerCase()) : !/Sorry, something went wrong/.test(text);
    return { name: "verdict", input: { pass, confidence: 0.85, evidence: pass ? "the page supports the assertion" : "not shown" } };
  }

  if (meta.kind === "assert") {
    const verdict = (pass: boolean, evidence: string, checks: unknown[] = []) => ({ name: "verdict", input: { pass, confidence: 0.9, evidence, checks } });
    if (/open tickets KPI/.test(goal)) {
      const kpi = elements.find((e) => /open-tickets/.test(e.testid ?? ""));
      return kpi ? verdict(true, kpi.text ?? "", [{ kind: "text", ref: kpi.ref, pattern: "Open tickets \\d+" }]) : verdict(false, "no open tickets KPI");
    }
    if (/satisfaction as a percentage/.test(goal)) {
      const kpi = elements.find((e) => /csat/.test(e.testid ?? ""));
      return kpi ? verdict(true, kpi.text ?? "", [{ kind: "text", ref: kpi.ref, pattern: "\\d+%" }]) : verdict(false, "no satisfaction KPI");
    }
    if (/lists at least one ticket/.test(goal)) {
      return verdict(/#\d+/.test(text), "ticket rows present", [{ kind: "count", locator: { by: "css", value: "#recent-tickets tbody tr" }, min: 1 }]);
    }
    if (/number of open tickets/.test(goal)) {
      return verdict(/\d+ (open )?tickets/i.test(text), "the reply states a count", [
        { kind: "text", locator: { by: "css", value: ".msg.assistant" }, pattern: "(?=.*\\d)(?=.*\\bopen\\b)", flags: "i" },
      ]);
    }
    if (/confirms a new ticket number/.test(goal)) {
      return verdict(/#\d+/.test(text), "the reply names a ticket number", [{ kind: "text", locator: { by: "css", value: ".msg.assistant" }, pattern: "#\\d+" }]);
    }
    const shown = /table shows "([^"]+)"/.exec(goal)?.[1];
    if (shown) {
      return verdict(text.toLowerCase().includes(shown.toLowerCase()), `"${shown}" is listed`, [
        { kind: "text", locator: { by: "css", value: "#recent-tickets" }, pattern: escapeRe(shown), flags: "i" },
      ]);
    }
    // Tone and other semantic assertions: no structural checks, so planwright stores an LLM judge.
    return verdict(!/Sorry/.test(text), "the reply is friendly and on topic");
  }

  // Planning a Given/When step.
  const done = (summary: string): LlmToolCall => ({ name: "done", input: { summary } });
  const did = new Set([
    ...meta.history.filter((h) => h.result.startsWith("ok")).map((h) => h.tool),
    ...(meta.healing?.executed ?? []).map((s) => (s.startsWith("wait") ? "wait_for" : s.split(" ")[0]!)),
  ]);
  const link = (re: RegExp) => elements.find((e) => e.role === "link" && re.test(e.name ?? ""));

  if (/open the assistant/.test(goal)) {
    if (path === "/chat") return done("assistant is open");
    const a = link(/assistant/i);
    return a ? { name: "click", input: { ref: a.ref } } : { name: "navigate", input: { url: "/" } };
  }
  if (/(am on|go to) the dashboard/.test(goal)) {
    if (path === "/") return done("on the dashboard");
    const a = link(/dashboard|overview/i);
    return a ? { name: "click", input: { ref: a.ref } } : { name: "navigate", input: { url: "/" } };
  }
  const message = /ask the assistant "([^"]+)"/.exec(goal)?.[1];
  if (message) {
    if (!did.has("fill")) {
      const box = elements.find((e) => e.role === "textbox");
      return box ? { name: "fill", input: { ref: box.ref, value: message } } : { name: "fail", input: { reason: "no message box" } };
    }
    if (!did.has("click")) {
      const send = elements.find((e) => e.role === "button" && /send|ask/i.test(e.name ?? ""));
      return send ? { name: "click", input: { ref: send.ref } } : { name: "fail", input: { reason: "no send button" } };
    }
    if (!did.has("wait_for")) return { name: "wait_for", input: { text: "Thinking…", state: "hidden", timeout_ms: 20000 } };
    return done("the assistant answered");
  }
  return { name: "fail", input: { reason: `the offline brain does not know how to "${goal}"` } };
}
