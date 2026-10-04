import { anthropic, defineConfig } from "planwright";
import { layaJudge } from "planwright/judge/laya";

import { startApp, type App } from "./app/server.js";
import { offlineBrain } from "./offline-brain.js";

const port = Number(process.env.PORT ?? 4280);
let app: App | undefined;

if (!process.env.ANTHROPIC_API_KEY) {
  process.stderr.write("planwright example: ANTHROPIC_API_KEY is not set, using the offline demo brain.\n");
}

export default defineConfig({
  baseURL: `http://127.0.0.1:${port}`,
  features: "features",
  // Real model when a key is available; otherwise a scripted stand-in that knows this app.
  llm: process.env.ANTHROPIC_API_KEY ? anthropic() : offlineBrain(),
  // PLANWRIGHT_JUDGE=laya judges semantic Thens with Laya locally (npm i @receptron/laya).
  ...(process.env.PLANWRIGHT_JUDGE === "laya" ? { judge: { using: layaJudge() } } : {}),
  hooks: {
    // The example serves its own app so `planwright run` is all you need.
    // APP_UI=v2 ships the redesign; APP_SLOW=1 makes the assistant hang.
    async beforeAll() {
      app = await startApp({ port, ui: process.env.APP_UI === "v2" ? "v2" : "v1", slow: process.env.APP_SLOW === "1" });
    },
    async afterAll() {
      await app?.close();
    },
  },
  timeouts: { actionMs: 3_000 },
});
