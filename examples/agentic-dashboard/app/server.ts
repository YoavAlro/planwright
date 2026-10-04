import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * "Support Ops": a small dashboard + AI assistant used to show planwright on a
 * realistic, non-deterministic app:
 * - KPI values change on every page load (stateless assertions),
 * - the assistant answers with different wording every time (LLM judge),
 * - answers take a moment behind a "Thinking…" indicator (known-slow waits),
 * - `ui: "v2"` ships a redesign: renamed nav, buttons, labels and test ids (healing),
 * - `slow: true` makes the assistant hang (infra failure, never re-planned).
 *
 * The assistant is a scripted fake so the app runs without any API key.
 */
export interface AppOptions {
  port?: number;
  ui?: "v1" | "v2";
  slow?: boolean;
}

export interface App {
  url: string;
  options: Required<AppOptions>;
  close(): Promise<void>;
}

interface Ticket {
  id: number;
  subject: string;
  status: "open" | "pending" | "solved";
}

const SEED_TICKETS: Ticket[] = [
  { id: 1041, subject: "Invoice PDF shows wrong currency", status: "open" },
  { id: 1042, subject: "Cannot invite teammates", status: "pending" },
  { id: 1043, subject: "Export to CSV is slow", status: "open" },
  { id: 1044, subject: "Password reset email delayed", status: "solved" },
];

const pick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;
const between = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** UI strings and hooks that the v2 redesign changes. */
function copy(ui: "v1" | "v2") {
  return ui === "v1"
    ? { navChat: "Assistant", navHome: "Dashboard", send: "Send", sendId: "send", input: "Message", kpi: "kpi", title: "Support Ops" }
    : { navChat: "AI Assistant", navHome: "Overview", send: "Ask", sendId: "ask-button", input: "Your question", kpi: "metric", title: "Support Ops 2.0" };
}

const STYLE = `
  :root { --bg:#f6f7fb; --card:#fff; --ink:#1d2433; --muted:#667085; --brand:#4f46e5; --line:#e4e7ec; }
  * { box-sizing: border-box; } body { margin:0; font-family: system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  header { display:flex; gap:1.5rem; align-items:center; padding:1rem 2rem; background:var(--card); border-bottom:1px solid var(--line); }
  header strong { margin-right:auto; } header a { color:var(--brand); text-decoration:none; font-weight:600; margin-left:1.25rem; }
  main { max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
  .kpis { display:grid; grid-template-columns: repeat(3, 1fr); gap:1rem; }
  .kpi { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:1rem; }
  .kpi h2 { margin:0; font-size:.9rem; color:var(--muted); font-weight:500; } .kpi .value { font-size:2rem; margin:.25rem 0; font-weight:700; }
  .kpi .trend { margin:0; color:var(--muted); font-size:.85rem; }
  table { width:100%; border-collapse:collapse; margin-top:2rem; background:var(--card); border-radius:12px; overflow:hidden; }
  th, td { text-align:left; padding:.6rem 1rem; border-bottom:1px solid var(--line); }
  .chat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:1rem; min-height:320px; display:flex; flex-direction:column; gap:.75rem; }
  .msg { max-width:75%; padding:.6rem .9rem; border-radius:12px; } .msg.user { align-self:flex-end; background:var(--brand); color:#fff; }
  .msg.assistant { align-self:flex-start; background:#eef0f6; } [role=status] { color:var(--muted); font-style:italic; }
  form { display:flex; gap:.5rem; margin-top:1rem; } textarea { flex:1; min-height:3rem; padding:.6rem; border-radius:8px; border:1px solid var(--line); font:inherit; }
  button { background:var(--brand); color:#fff; border:0; border-radius:8px; padding:0 1.25rem; font:inherit; cursor:pointer; }
  .v2 header { background:#111827; } .v2 header a, .v2 header strong { color:#fff; }
`;

export async function startApp(options: AppOptions = {}): Promise<App> {
  const opts: Required<AppOptions> = { port: options.port ?? 0, ui: options.ui ?? "v1", slow: options.slow ?? false };
  const tickets: Ticket[] = structuredClone(SEED_TICKETS);
  let nextId = 1045;
  const t = copy(opts.ui);

  const layout = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · ${t.title}</title><style>${STYLE}</style></head>
<body class="${opts.ui}"><header><strong>${t.title}</strong><nav>${
    opts.ui === "v1"
      ? `<a href="/">${t.navHome}</a> <a href="/chat">${t.navChat}</a>`
      : `<a href="/chat">${t.navChat}</a> <a href="/">${t.navHome}</a>`
  }</nav></header><main>${body}</main></body></html>`;

  const dashboard = () => {
    const open = tickets.filter((x) => x.status !== "solved").length;
    const kpi = (id: string, label: string, value: string, trend: string) =>
      `<section class="kpi" data-testid="${t.kpi}-${id}"><h2>${label}</h2><p class="value">${value}</p><p class="trend">${trend}</p></section>`;
    const delta = between(-5, 6);
    const rows = [...tickets]
      .reverse()
      .map((x) => `<tr><td>#${x.id}</td><td>${esc(x.subject)}</td><td>${x.status}</td></tr>`)
      .join("");
    return layout(
      "Dashboard",
      `<h1>${opts.ui === "v1" ? "Today" : "Overview"}</h1>
<div class="kpis">
${kpi("open-tickets", "Open tickets", String(open + between(20, 60)), `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta)} vs yesterday`)}
${kpi("csat", "Customer satisfaction", `${between(81, 98)}%`, "last 7 days")}
${kpi("first-response", "Median first response", `${between(4, 45)} min`, "business hours")}
</div>
<table id="recent-tickets" aria-label="Recent tickets"><thead><tr><th>Ticket</th><th>Subject</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`,
    );
  };

  const chat = () =>
    layout(
      "Assistant",
      `<h1>${opts.ui === "v1" ? "Support assistant" : "Ask the AI"}</h1>
<div class="chat" id="conversation" aria-live="polite"><div class="msg assistant">Hi! I can look up tickets, summarize KPIs and open new tickets.</div></div>
<form id="composer"><label for="message" style="position:absolute;left:-9999px">${t.input}</label>
<textarea id="message" name="message" placeholder="Ask the support agent…"></textarea>
<button type="submit" data-testid="${t.sendId}">${t.send}</button></form>
<script>
const form = document.getElementById("composer"), box = document.getElementById("message"), log = document.getElementById("conversation");
const add = (cls, text) => { const d = document.createElement("div"); d.className = "msg " + cls; d.textContent = text; log.append(d); return d; };
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = box.value.trim(); if (!message) return;
  add("user", message); box.value = "";
  const status = document.createElement("div"); status.setAttribute("role", "status"); status.textContent = "Thinking…"; log.append(status);
  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
    const { reply } = await res.json();
    status.remove(); add("assistant", reply);
  } catch { status.remove(); add("assistant error", "Sorry, something went wrong."); }
});
</script>`,
    );

  /** The fake agent: intent matching with varied wording, plus one tool (create ticket). */
  const agent = (message: string): string => {
    const m = message.toLowerCase();
    const open = tickets.filter((x) => x.status !== "solved").length + between(20, 60);
    if (/create|open a ticket|file a ticket|new ticket/.test(m)) {
      const subject = /about (.+?)[.?!]*$/i.exec(message)?.[1] ?? message;
      const ticket: Ticket = { id: nextId++, subject, status: "open" };
      tickets.push(ticket);
      return pick([
        `Done — I opened ticket #${ticket.id}: "${subject}". It's in the queue now.`,
        `Created #${ticket.id} for "${subject}". I'll keep an eye on it.`,
        `Ticket #${ticket.id} is open: "${subject}".`,
      ]);
    }
    if (/how many|open tickets|backlog/.test(m)) {
      return pick([
        `There are ${open} open tickets right now, a little ${pick(["above", "below"])} yesterday.`,
        `We have ${open} open tickets at the moment. Want me to summarize the oldest ones?`,
        `${open} tickets are open. Most are billing questions.`,
      ]);
    }
    if (/summar/.test(m)) {
      return `Quick summary: ${open} open tickets, satisfaction at ${between(81, 98)}%, median first response ${between(4, 45)} minutes.`;
    }
    return "I can help with ticket counts, KPI summaries, and opening new tickets.";
  };

  const send = (res: ServerResponse, status: number, body: string, type = "text/html; charset=utf-8") => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };
  const readJson = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let data = "";
      req.on("data", (c: Buffer) => (data += c.toString()));
      req.on("end", () => {
        try {
          resolve(JSON.parse(data) as Record<string, unknown>);
        } catch {
          resolve({});
        }
      });
    });

  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (req.method === "GET" && path === "/") return send(res, 200, dashboard());
      if (req.method === "GET" && path === "/chat") return send(res, 200, chat());
      if (req.method === "POST" && path === "/api/chat") {
        const { message } = await readJson(req);
        if (opts.slow) return; // never answers: the "Thinking…" indicator stays up
        await new Promise((r) => setTimeout(r, between(500, 1500)));
        return send(res, 200, JSON.stringify({ reply: agent(String(message ?? "")) }), "application/json");
      }
      return send(res, 404, layout("Not found", "<h1>Not found</h1>"));
    })();
  });

  await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    options: opts,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// `node app/server.ts` serves the app on its own (PORT, APP_UI=v2, APP_SLOW=1).
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await startApp({
    port: Number(process.env.PORT ?? 4280),
    ui: process.env.APP_UI === "v2" ? "v2" : "v1",
    slow: process.env.APP_SLOW === "1",
  });
  process.stdout.write(`Support Ops on ${app.url} (ui ${app.options.ui}${app.options.slow ? ", slow assistant" : ""})\n`);
}
