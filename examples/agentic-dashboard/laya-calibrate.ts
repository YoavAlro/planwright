/**
 * Calibrates a Jev-compatible judge (Laya) for this example's semantic Then step:
 * "the reply sounds like a helpful support teammate".
 *
 * It captures the real chat page, derives good and bad variants of the reply,
 * and scores every (question phrasing × page state) combination. A setup is
 * usable when every good case scores clearly above every bad one.
 *
 *   npm install -D @receptron/laya && npm run build
 *   node examples/agentic-dashboard/laya-calibrate.ts
 */
import { chromium } from "playwright";
import { defaultJudgeQuestion, type SystemOneClient, type SystemOneQuestion } from "planwright";

import { startApp } from "./app/server.ts";

const ASSERTION = "the reply sounds like a helpful support teammate";

// 1. Capture the real page after asking the assistant a question.
const app = await startApp({});
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${app.url}/chat`);
await page.getByPlaceholder("Ask the support agent…").fill("How many open tickets do we have?");
await page.locator("button[type=submit]").click();
await page.getByText("Thinking…").waitFor({ state: "hidden" });
const messages = await page.locator(".msg").allInnerTexts();
const pageText = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
const reply = messages.at(-1) ?? "";
const meta = { url: page.url(), title: await page.title() };
await browser.close();
await app.close();

// 2. Good and bad replies in the same page.
// `good: null` cases are shown but not scored: an apologetic error *sounds* helpful, so tone is the
// wrong layer for it. The structural Then ("replies with a number of open tickets") catches errors.
const cases: { name: string; good: boolean | null; reply: string }[] = [
  { name: "real reply", good: true, reply },
  { name: "helpful, other wording", good: true, reply: "Happy to help! We have 42 open tickets right now; most are billing questions." },
  { name: "rude", good: false, reply: "Figure it out yourself. I'm not your assistant." },
  { name: "error", good: null, reply: "Sorry, something went wrong." },
  { name: "off-topic", good: false, reply: "The weather in Paris is sunny today." },
];
const withReply = (r: string) => ({ text: pageText.replace(reply, r), messages: [...messages.slice(0, -1), r] });

// 3. Candidate page states and question phrasings.
const states: Record<string, (r: string) => unknown> = {
  "page (default)": (r) => ({ ...meta, text: withReply(r).text }),
  "conversation": (r) => ({ conversation: withReply(r).messages }),
  "last reply only": (r) => ({ reply: r }),
};
const questions: Record<string, (a: string) => SystemOneQuestion> = {
  "is it true (default)": defaultJudgeQuestion,
  "assertion holds": (a) => ({
    instructions: `Does this assertion hold for the web page in the state? Assertion: "${a}"`,
    criteria: { true: "the page shows that the assertion holds", false: "the page contradicts the assertion or does not show it" },
  }),
  "statement": (a) => ({ instructions: a.charAt(0).toUpperCase() + a.slice(1) + "." }),
  "chat judge": (a) => ({
    instructions: `You review a support chat. Is this true: ${a}?`,
    criteria: { true: "yes, it is true for the latest reply", false: "no, it is not true for the latest reply" },
  }),
};

// 4. Score everything with Laya.
const { Laya } = (await import("@receptron/laya" as string).catch(() => {
  process.stderr.write("Install Laya first: npm install -D @receptron/laya (from the planwright repo root)\n");
  process.exit(3);
})) as { Laya: { load(): Promise<SystemOneClient> } };
const laya = await Laya.load();
const rows: { state: string; question: string; scores: number[]; margin: number }[] = [];
for (const [sName, makeState] of Object.entries(states)) {
  for (const [qName, makeQ] of Object.entries(questions)) {
    const scores: number[] = [];
    for (const c of cases) {
      const res = await laya.systemOne(makeState(c.reply), { holds: { type: "noul", ...makeQ(ASSERTION) } });
      scores.push(res.answers.holds?.noul ?? NaN);
    }
    const good = scores.filter((_, i) => cases[i]!.good === true);
    const bad = scores.filter((_, i) => cases[i]!.good === false);
    rows.push({ state: sName, question: qName, scores, margin: Math.min(...good) - Math.max(...bad) });
  }
}
await laya.close?.();

rows.sort((a, b) => b.margin - a.margin);
const f = (n: number) => n.toFixed(3);
process.stdout.write(`Assertion: "${ASSERTION}"\nReal reply: "${reply}"\n\n`);
process.stdout.write(`| state | question | ${cases.map((c) => `${c.name} (${c.good === null ? "not scored" : c.good ? "good" : "bad"})`).join(" | ")} | margin |\n`);
process.stdout.write(`|---|---|${cases.map(() => "---|").join("")}---|\n`);
for (const r of rows) process.stdout.write(`| ${r.state} | ${r.question} | ${r.scores.map(f).join(" | ")} | ${f(r.margin)} |\n`);
const best = rows[0]!;
process.stdout.write(
  best.margin > 0
    ? `\nBest: state "${best.state}" + question "${best.question}". Separates good from bad by ${f(best.margin)}; a threshold near ${f(Math.max(...best.scores.filter((_, i) => cases[i]!.good === false)) + best.margin / 2)} would split them.\n`
    : "\nNo combination separates every good case from every bad one.\n",
);
