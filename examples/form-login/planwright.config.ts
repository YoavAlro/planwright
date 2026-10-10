import { existsSync } from "node:fs";

import { defineConfig, type ScenarioContext } from "planwright-e2e";

/**
 * Generic auth adapter: log in through the app's own form once, save the
 * session as Playwright storageState, and reuse it for every scenario.
 * Login is a custom deterministic step, so it is never planned or cached,
 * and the password never reaches the LLM or a plan file.
 */
const STATE_FILE = "planwright-results/.auth/user.json";

async function signIn(ctx: ScenarioContext): Promise<void> {
  const { page, context } = ctx;
  await page.goto("/login");
  await page.getByLabel("Username").fill(process.env.APP_USER ?? "");
  await page.getByLabel("Password").fill(process.env.APP_PASSWORD ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await context.storageState({ path: STATE_FILE });
}

export default defineConfig({
  baseURL: process.env.BASE_URL,
  // Reuse a saved session when there is one; the step below refreshes it.
  browser: { contextOptions: existsSync(STATE_FILE) ? { storageState: STATE_FILE } : {} },
  secrets: ["APP_PASSWORD"],
  steps: [
    {
      pattern: "I am logged in",
      async run(ctx) {
        await ctx.page.goto("/");
        if (ctx.page.url().includes("/login")) await signIn(ctx);
      },
    },
  ],
});
