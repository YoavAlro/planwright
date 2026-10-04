import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny server-rendered task board used by planwright's own tests and the
 * quickstart. `variant` lets tests change the UI between runs to simulate
 * drift, regressions and outages.
 */
export interface DemoVariant {
  /** The "add task" button. null removes it (a real regression). */
  addButton: { label: string; testid?: string; id?: string; wrapped?: boolean } | null;
  /** Every route returns HTTP 500. */
  serverError: boolean;
  /** Added to the open-task count, to prove assertions are stateless. */
  counterOffset: number;
}

export const DEFAULT_VARIANT: DemoVariant = {
  addButton: { label: "Add task", testid: "add-task", id: "add-task-btn" },
  serverError: false,
  counterOffset: 0,
};

export interface DemoServer {
  url: string;
  variant: DemoVariant;
  tasks: string[];
  reset(): void;
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem}nav a{margin-right:1rem}li{margin:.25rem 0}</style></head>
<body><nav><a href="/">Home</a><a href="/tasks">Tasks</a><a href="/login">Sign in</a></nav>${body}</body></html>`;
}

function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => resolve(new URLSearchParams(data)));
  });
}

export async function startDemo(port = 0): Promise<DemoServer> {
  const state: DemoServer = {
    url: "",
    variant: structuredClone(DEFAULT_VARIANT),
    tasks: [],
    reset() {
      state.variant = structuredClone(DEFAULT_VARIANT);
      state.tasks = [];
    },
    close: async () => undefined,
  };

  const send = (res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(html);
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (state.variant.serverError) return send(res, 500, layout("Error", "<h1>Internal Server Error</h1>"));

      if (url.pathname === "/" && req.method === "GET") {
        return send(res, 200, layout("Task Board", `<h1>Task Board</h1><p>Organize your day.</p><a href="/tasks">Open the task board</a>`));
      }
      if (url.pathname === "/tasks" && req.method === "GET") {
        const b = state.variant.addButton;
        const button = b
          ? `<button type="submit"${b.testid ? ` data-testid="${esc(b.testid)}"` : ""}${b.id ? ` id="${esc(b.id)}"` : ""}>${esc(b.label)}</button>`
          : "";
        const form = `<form method="post" action="/tasks" id="${b?.wrapped ? "task-editor" : "task-form"}">
<label for="new-task">New task</label> <input id="new-task" name="title" placeholder="What needs doing?">
${b?.wrapped ? `<div class="actions">${button}</div>` : button}</form>`;
        const items = state.tasks.map((t) => `<li>${esc(t)}</li>`).join("");
        const count = state.tasks.length + state.variant.counterOffset;
        return send(
          res,
          200,
          layout("Tasks", `<h1>Tasks</h1>${form}<p data-testid="open-count">Open tasks: ${count}</p><ul id="task-list">${items}</ul>`),
        );
      }
      if (url.pathname === "/tasks" && req.method === "POST") {
        const title = (await readBody(req)).get("title")?.trim();
        if (title) state.tasks.push(title);
        return send(res, 303, "", { location: "/tasks" });
      }
      if (url.pathname === "/login" && req.method === "GET") {
        return send(
          res,
          200,
          layout(
            "Sign in",
            `<h1>Sign in</h1><form method="post" action="/login"><label for="user">Username</label> <input id="user" name="user">
<label for="password">Password</label> <input id="password" name="password" type="password"><button type="submit">Sign in</button></form>`,
          ),
        );
      }
      if (url.pathname === "/login" && req.method === "POST") {
        const body = await readBody(req);
        if (body.get("password") === (process.env.DEMO_PASSWORD ?? "hunter2")) {
          return send(res, 303, "", { location: "/account", "set-cookie": `demo_session=${encodeURIComponent(body.get("user") ?? "")}; Path=/` });
        }
        return send(res, 401, layout("Sign in", "<h1>Sign in</h1><p role=\"alert\">Wrong username or password.</p>"));
      }
      if (url.pathname === "/account") {
        const user = /demo_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
        if (!user) return send(res, 303, "", { location: "/login" });
        return send(res, 200, layout("Account", `<h1>Account</h1><p data-testid="account-name">Signed in as ${esc(decodeURIComponent(user))}</p>`));
      }
      return send(res, 404, layout("Not found", "<h1>Not found</h1>"));
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}

// `node demo/server.ts` starts it standalone for the quickstart.
if (import.meta.url === `file://${process.argv[1]}`) {
  const demo = await startDemo(Number(process.env.PORT ?? 4173));
  process.stdout.write(`demo app on ${demo.url}\n`);
}
