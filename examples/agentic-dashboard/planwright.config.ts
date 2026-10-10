import { anthropic, claudeCli, defineConfig } from "planwright-e2e";
import { layaJudge } from "planwright-e2e/judge/laya";

import { startApp, type App } from "./app/server.js";
import { conversation } from "./judge-state.js";
import { offlineBrain } from "./offline-brain.js";

const port = Number(process.env.PORT ?? 4280);
let app: App | undefined;

/** PLANWRIGHT_LLM=claude-cli → your logged-in Claude Code CLI; else ANTHROPIC_API_KEY → API; else the offline brain. */
function pickLlm() {
  if (process.env.PLANWRIGHT_LLM === "claude-cli") return claudeCli({ model: process.env.PLANWRIGHT_MODEL });
  if (process.env.ANTHROPIC_API_KEY) return anthropic();
  process.stderr.write("planwright example: no LLM configured (PLANWRIGHT_LLM=claude-cli or ANTHROPIC_API_KEY), using the offline demo brain.\n");
  return offlineBrain();
}

export default defineConfig({
  baseURL: `http://127.0.0.1:${port}`,
  features: "features",
  llm: pickLlm(),
  // PLANWRIGHT_JUDGE=laya judges semantic Thens with Laya locally (npm i @receptron/laya).
  ...(process.env.PLANWRIGHT_JUDGE === "laya" ? { judge: { using: layaJudge({ state: conversation, threshold: 0.5 }) } } : {}),
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
