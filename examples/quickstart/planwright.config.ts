import { defineConfig } from "planwright";

// Runs against the bundled demo app: `node demo/server.ts` (http://127.0.0.1:4173).
// The default LLM provider is Anthropic (claude-opus-5-5) and reads ANTHROPIC_API_KEY.
export default defineConfig({
  baseURL: process.env.BASE_URL ?? "http://127.0.0.1:4173",
  features: "features",
});
