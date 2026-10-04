import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { Locator, Page } from "playwright";

import { resolveTemplate, type TemplateScope } from "../plan/template.js";
import type { Action, Check, Target } from "../plan/types.js";
import { ConfigError, DriftError, InfraError, classifyPlaywrightError } from "./errors.js";
import { buildLocator, describeLocator, resolveTarget } from "./locators.js";

export interface ActionContext {
  page: Page;
  scope: TemplateScope;
  baseURL?: string;
  fixturesDir: string;
  /** How long to wait for a target to resolve / an assertion to hold. */
  actionTimeoutMs: number;
}

export function resolveFixture(fixturesDir: string, file: string): string {
  const abs = resolve(fixturesDir, file);
  const rel = relative(fixturesDir, abs);
  if (rel.startsWith("..") || resolve(fixturesDir, rel) !== abs) {
    throw new ConfigError(`Fixture "${file}" resolves outside fixturesDir.`);
  }
  if (!existsSync(abs)) throw new ConfigError(`Fixture "${file}" does not exist in ${fixturesDir}.`);
  return abs;
}

export async function navigate(page: Page, url: string, baseURL: string | undefined): Promise<void> {
  const absolute = baseURL ? new URL(url, baseURL).toString() : url;
  let response;
  try {
    response = await page.goto(absolute, { waitUntil: "domcontentloaded" });
  } catch (err) {
    throw new InfraError(`Navigation to ${absolute} failed: ${(err as Error).message}`);
  }
  if (response && response.status() >= 500) {
    throw new InfraError(`Navigation to ${absolute} returned HTTP ${response.status()}.`);
  }
}

async function waitHidden(page: Page, target: Target, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let anyVisible = false;
    for (const spec of target.locators) {
      if (await buildLocator(page, spec).first().isVisible().catch(() => false)) {
        anyVisible = true;
        break;
      }
    }
    if (!anyVisible) return;
    if (Date.now() >= deadline) {
      throw new DriftError(`${target.description ?? "Target"} still visible after ${timeoutMs}ms.`);
    }
    await page.waitForTimeout(200);
  }
}

async function poll(page: Page, timeoutMs: number, predicate: () => Promise<boolean>, failure: () => Promise<string>) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate().catch(() => false)) return;
    if (Date.now() >= deadline) throw new DriftError(`Assertion failed: ${await failure()}`);
    await page.waitForTimeout(200);
  }
}

/**
 * Assertions accept any matching element: "I see the task X" holds whether X
 * is listed once or twice. (Actions, by contrast, need exactly one target.)
 */
async function anyMatch(page: Page, target: Target, predicate: (el: Locator) => Promise<boolean>): Promise<boolean> {
  for (const spec of target.locators) {
    const loc = buildLocator(page, spec);
    const n = Math.min(await loc.count().catch(() => 0), 50);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if ((await el.isVisible().catch(() => false)) && (await predicate(el).catch(() => false))) return true;
    }
  }
  return false;
}

const label = (target: Target) => target.description ?? target.locators.map(describeLocator).join(" / ");

export async function runCheck(ctx: ActionContext, check: Check): Promise<void> {
  const { page, actionTimeoutMs: timeout } = ctx;
  switch (check.kind) {
    case "visible":
      await poll(page, timeout, () => anyMatch(page, check.target, async () => true), async () => `${label(check.target)} is not visible`);
      return;
    case "hidden":
      await waitHidden(page, check.target, timeout);
      return;
    case "enabled":
      await poll(page, timeout, () => anyMatch(page, check.target, (el) => el.isEnabled()), async () => `${label(check.target)} is not visible and enabled`);
      return;
    case "count": {
      let best = 0;
      await poll(
        page,
        timeout,
        async () => {
          for (const spec of check.target.locators) {
            const n = await buildLocator(page, spec).count();
            best = Math.max(best, n);
            if (n >= check.min) return true;
          }
          return false;
        },
        async () => `expected at least ${check.min} of ${label(check.target)}, found ${best}`,
      );
      return;
    }
    case "text": {
      const re = new RegExp(resolveTemplate(check.pattern, ctx.scope), check.flags);
      await poll(
        page,
        timeout,
        () => anyMatch(page, check.target, async (el) => re.test((await el.innerText()).replace(/\s+/g, " ").trim())),
        async () => `no visible ${label(check.target)} has text matching /${re.source}/`,
      );
      return;
    }
    case "url": {
      const re = new RegExp(resolveTemplate(check.pattern, ctx.scope), check.flags);
      await poll(page, timeout, async () => re.test(page.url()), async () => `URL ${page.url()} does not match /${re.source}/`);
      return;
    }
    case "title": {
      const re = new RegExp(resolveTemplate(check.pattern, ctx.scope), check.flags);
      await poll(page, timeout, async () => re.test(await page.title()), async () => `title ${JSON.stringify(await page.title())} does not match /${re.source}/`);
      return;
    }
  }
}

/** Executes one planned action deterministically. Throws DriftError / InfraError / ConfigError. */
export async function executeAction(ctx: ActionContext, action: Action): Promise<void> {
  const { page, actionTimeoutMs: timeout } = ctx;
  const value = (s: string) => resolveTemplate(s, ctx.scope);
  try {
    switch (action.type) {
      case "navigate":
        await navigate(page, value(action.url), ctx.baseURL);
        return;
      case "click": {
        const { locator } = await resolveTarget(page, action.target, { timeoutMs: timeout });
        await locator.click({ timeout });
        return;
      }
      case "fill": {
        const { locator } = await resolveTarget(page, action.target, { timeoutMs: timeout });
        await locator.fill(value(action.value), { timeout });
        return;
      }
      case "select": {
        const { locator } = await resolveTarget(page, action.target, { timeoutMs: timeout });
        await locator.selectOption(value(action.value), { timeout });
        return;
      }
      case "press":
        if (action.target) {
          const { locator } = await resolveTarget(page, action.target, { timeoutMs: timeout });
          await locator.press(action.key, { timeout });
        } else {
          await page.keyboard.press(action.key);
        }
        return;
      case "check": {
        const { locator } = await resolveTarget(page, action.target, { timeoutMs: timeout });
        await locator.setChecked(action.checked, { timeout });
        return;
      }
      case "upload": {
        const { locator } = await resolveTarget(page, action.target, { timeoutMs: timeout, state: "attached" });
        await locator.setInputFiles(resolveFixture(ctx.fixturesDir, value(action.file)), { timeout });
        return;
      }
      case "waitFor":
        if (action.state === "hidden") await waitHidden(page, action.target, action.timeoutMs ?? timeout);
        else await resolveTarget(page, action.target, { timeoutMs: action.timeoutMs ?? timeout });
        return;
      case "assert":
        await runCheck(ctx, action.check);
        return;
      case "judge":
        throw new Error("judge actions are evaluated by the step runner, not executed");
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw classifyPlaywrightError(err);
  }
}

export function describeAction(action: Action): string {
  const t = (target: Target) => target.description ?? target.locators.map(describeLocator)[0] ?? "?";
  switch (action.type) {
    case "navigate":
      return `navigate ${action.url}`;
    case "click":
      return `click ${t(action.target)}`;
    case "fill":
      return `fill ${t(action.target)} with ${JSON.stringify(action.value)}`;
    case "select":
      return `select ${JSON.stringify(action.value)} in ${t(action.target)}`;
    case "press":
      return `press ${action.key}${action.target ? ` on ${t(action.target)}` : ""}`;
    case "check":
      return `${action.checked ? "check" : "uncheck"} ${t(action.target)}`;
    case "upload":
      return `upload ${action.file} to ${t(action.target)}`;
    case "waitFor":
      return `wait for ${t(action.target)} to be ${action.state}`;
    case "assert": {
      const c = action.check;
      if (c.kind === "url" || c.kind === "title") return `assert ${c.kind} matches /${c.pattern}/`;
      if (c.kind === "text") return `assert text of ${t(c.target)} matches /${c.pattern}/`;
      if (c.kind === "count") return `assert at least ${c.min} × ${t(c.target)}`;
      return `assert ${t(c.target)} is ${c.kind}`;
    }
    case "judge":
      return "LLM judge";
  }
}
