import type { Page } from "playwright";

/** What the agent sees of one element. `ref` is only valid until the next capture. */
export interface ElementInfo {
  ref: number;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  id?: string;
  testid?: string;
  label?: string;
  placeholder?: string;
  type?: string;
  href?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  interactive: boolean;
  cssPath: string;
}

export interface PageState {
  url: string;
  title: string;
  text: string;
  elements: ElementInfo[];
  screenshot?: string;
}

const TEXT_LIMIT = 12_000;
const MAX_INTERACTIVE = 250;
const MAX_CONTENT = 200;

/**
 * Runs in the browser. Must be self-contained (no closures over Node scope).
 * Registers matched elements in `window.__planwrightRefs` so a ref can be
 * mapped back to a live element for locator validation.
 */
function collectElements(args: { testIdAttribute: string; maxInteractive: number; maxContent: number }): Omit<ElementInfo, never>[] {
  const { testIdAttribute, maxInteractive, maxContent } = args;
  const INTERACTIVE =
    "a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable=''],[contenteditable=true],[tabindex]:not([tabindex='-1'])";
  const CONTENT = `h1,h2,h3,h4,h5,h6,[${testIdAttribute}],[aria-label],[role=status],[role=alert],[role=dialog],[role=heading],li,td,th,p,span,div,label,dt,dd`;

  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  };
  const clean = (s: string | null | undefined, max = 80): string | undefined => {
    if (!s) return undefined;
    const t = s.replace(/\s+/g, " ").trim();
    if (!t) return undefined;
    return t.length > max ? `${t.slice(0, max)}…` : t;
  };
  const ownText = (el: Element): string =>
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? "")
      .join(" ")
      .trim();
  const implicitRole = (el: Element): string | undefined => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
    if (tag === "li") return "listitem";
    if (tag === "input") {
      const type = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (["text", "email", "tel", "url", "password", ""].includes(type)) return type === "password" ? undefined : "textbox";
    }
    return undefined;
  };
  const labelOf = (el: Element): string | undefined => {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (clean(text)) return clean(text);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) return clean(labels[0]?.textContent);
    return undefined;
  };
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body && parts.length < 8) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`#${node.id}`);
        return parts.join(" > ");
      }
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      const current: Element = node;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
        parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(current) + 1})` : tag);
      } else {
        parts.unshift(tag);
      }
      node = parent;
    }
    parts.unshift("body");
    return parts.join(" > ");
  };

  const seen = new Set<Element>();
  const picked: { el: Element; interactive: boolean }[] = [];
  for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
    if (picked.length >= maxInteractive) break;
    if (!seen.has(el) && isVisible(el)) {
      seen.add(el);
      picked.push({ el, interactive: true });
    }
  }
  let contentCount = 0;
  for (const el of Array.from(document.querySelectorAll(CONTENT))) {
    if (contentCount >= maxContent) break;
    if (seen.has(el) || !isVisible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const generic = ["span", "div", "p", "li", "td", "th", "label", "dt", "dd"].includes(tag);
    const own = ownText(el);
    // Generic containers are only useful when they carry their own short text or an explicit hook.
    if (generic && !el.hasAttribute(testIdAttribute) && !el.hasAttribute("aria-label") && !el.getAttribute("role") && (!own || own.length > 160)) continue;
    seen.add(el);
    picked.push({ el, interactive: false });
    contentCount++;
  }

  const w = window as unknown as { __planwrightRefs?: Element[] };
  w.__planwrightRefs = picked.map((p) => p.el);

  return picked.map(({ el, interactive }, ref) => {
    const input = el as HTMLInputElement;
    const tag = el.tagName.toLowerCase();
    const isPassword = tag === "input" && input.type === "password";
    const role = implicitRole(el);
    const label = labelOf(el);
    const text = clean((el as HTMLElement).innerText, 120);
    const name =
      clean(el.getAttribute("aria-label")) ??
      label ??
      (tag === "input" && ["button", "submit", "reset"].includes(input.type) ? clean(input.value) : undefined) ??
      clean((el as HTMLElement).innerText) ??
      clean(el.getAttribute("title")) ??
      clean(el.getAttribute("alt")) ??
      clean(el.getAttribute("placeholder"));
    return {
      ref,
      tag,
      role,
      name,
      text,
      id: el.id || undefined,
      testid: el.getAttribute(testIdAttribute) ?? undefined,
      label,
      placeholder: el.getAttribute("placeholder") ?? undefined,
      type: tag === "input" ? input.type : undefined,
      href: tag === "a" ? (el.getAttribute("href") ?? undefined) : undefined,
      value: (tag === "input" || tag === "textarea" || tag === "select") && !isPassword ? clean(input.value) : undefined,
      disabled: (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true" || undefined,
      checked: tag === "input" && ["checkbox", "radio"].includes(input.type) ? input.checked : undefined,
      interactive,
      cssPath: cssPath(el),
    };
  });
}

export async function capturePageState(
  page: Page,
  options: { screenshot: boolean; testIdAttribute: string },
): Promise<PageState> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  const elements = await page
    .evaluate(collectElements, {
      testIdAttribute: options.testIdAttribute,
      maxInteractive: MAX_INTERACTIVE,
      maxContent: MAX_CONTENT,
    })
    .catch(() => [] as ElementInfo[]);
  const text = await page
    .evaluate(() => document.body?.innerText ?? "")
    .catch(() => "");
  const screenshot = options.screenshot
    ? await page
        .screenshot({ type: "jpeg", quality: 60 })
        .then((b) => b.toString("base64"))
        .catch(() => undefined)
    : undefined;
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n…(truncated)` : text,
    elements,
    screenshot,
  };
}
