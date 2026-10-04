import type { Locator, Page } from "playwright";

import type { LocatorSpec, Target } from "../plan/types.js";
import { DriftError } from "./errors.js";
import type { ElementInfo } from "./page-state.js";

export function buildLocator(page: Page, spec: LocatorSpec): Locator {
  switch (spec.by) {
    case "testid":
      return page.getByTestId(spec.value);
    case "role":
      return page.getByRole(spec.role as Parameters<Page["getByRole"]>[0], { name: spec.name, exact: true });
    case "label":
      return page.getByLabel(spec.value, { exact: true });
    case "placeholder":
      return page.getByPlaceholder(spec.value, { exact: true });
    case "id":
      return page.locator(`[id="${spec.value.replace(/"/g, '\\"')}"]`);
    case "text":
      return page.getByText(spec.value, { exact: true });
    case "css":
      return page.locator(spec.value);
  }
}

export function describeLocator(spec: LocatorSpec): string {
  switch (spec.by) {
    case "role":
      return `role=${spec.role}[name="${spec.name}"]`;
    default:
      return `${spec.by}=${JSON.stringify(spec.value)}`;
  }
}

/** Ids that look framework-generated (React useId, numeric suffixes) are unstable across builds. */
function isStableId(id: string): boolean {
  return !/[:]|\d{3,}|^[a-f0-9-]{16,}$/i.test(id);
}

/** Candidate locators for an element, ranked by expected stability. */
export function candidateLocators(el: ElementInfo): LocatorSpec[] {
  const out: LocatorSpec[] = [];
  if (el.testid) out.push({ by: "testid", value: el.testid });
  if (el.role && el.name && !el.name.endsWith("…")) out.push({ by: "role", role: el.role, name: el.name });
  if (el.label) out.push({ by: "label", value: el.label });
  if (el.placeholder) out.push({ by: "placeholder", value: el.placeholder });
  if (el.id && isStableId(el.id)) out.push({ by: "id", value: el.id });
  if (el.text && !el.text.endsWith("…") && el.text.length <= 80) out.push({ by: "text", value: el.text });
  out.push({ by: "css", value: el.cssPath });
  return out;
}

/**
 * Builds a Target for an element captured under `ref`, keeping only candidates
 * that resolve to exactly that element right now.
 */
export async function recordTarget(page: Page, el: ElementInfo): Promise<Target> {
  const locators: LocatorSpec[] = [];
  for (const spec of candidateLocators(el)) {
    const loc = buildLocator(page, spec);
    const ok = await loc
      .count()
      .then(async (n) =>
        n === 1
          ? loc.evaluate(
              (node, ref) => (window as unknown as { __planwrightRefs?: Element[] }).__planwrightRefs?.[ref] === node,
              el.ref,
            )
          : false,
      )
      .catch(() => false);
    if (ok) locators.push(spec);
  }
  // Positional CSS is a last resort: keep it only when nothing semantic identifies the element,
  // otherwise it could silently match a different element after a layout change.
  if (locators.length > 1 && locators.at(-1)?.by === "css") locators.pop();
  if (locators.length === 0) {
    throw new DriftError(`No stable locator identifies element ref ${el.ref} (${el.tag} "${el.name ?? ""}").`);
  }
  return { locators, description: `${el.role ?? el.tag}${el.name ? ` "${el.name}"` : ""}` };
}

const POLL_MS = 200;

/**
 * Resolves a target by trying its ranked locators until one matches exactly
 * one element, polling up to `timeoutMs`. Throws DriftError if none does.
 */
export async function resolveTarget(
  page: Page,
  target: Target,
  options: { timeoutMs: number; state?: "visible" | "attached" },
): Promise<{ locator: Locator; spec: LocatorSpec; index: number }> {
  const deadline = Date.now() + options.timeoutMs;
  const requireVisible = (options.state ?? "visible") === "visible";
  for (;;) {
    for (const [index, spec] of target.locators.entries()) {
      const loc = buildLocator(page, spec);
      const n = await loc.count().catch(() => 0);
      if (n !== 1) continue;
      if (requireVisible && !(await loc.isVisible().catch(() => false))) continue;
      return { locator: loc, spec, index };
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(POLL_MS);
  }
  throw new DriftError(
    `Target ${target.description ?? ""} not found; tried ${target.locators.map(describeLocator).join(", ")}.`,
  );
}
