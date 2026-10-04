import { defineConfig } from "planwright";

/**
 * Environments behind a bot-protection layer or an internal gateway often
 * need a bypass header, and some apps accept a pre-minted session cookie.
 * Both are plain Playwright context options plus a beforeScenario hook;
 * planwright itself knows nothing about them.
 */
export default defineConfig({
  baseURL: process.env.BASE_URL,
  browser: {
    contextOptions: {
      extraHTTPHeaders: process.env.BYPASS_HEADER_VALUE ? { "x-bypass-token": process.env.BYPASS_HEADER_VALUE } : {},
    },
  },
  hooks: {
    async beforeScenario(ctx) {
      // Mint a session out-of-band (your own API / script) and inject it.
      const token = process.env.SESSION_TOKEN;
      if (!token || !ctx.baseURL) return;
      await ctx.context.addCookies([{ name: "session", value: token, url: ctx.baseURL }]);
      ctx.vars.runId = `pw-${Date.now()}`;
    },
  },
});
