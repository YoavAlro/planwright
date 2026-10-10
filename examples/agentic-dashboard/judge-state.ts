import type { PageState } from "planwright-e2e";

/**
 * Laya judges the chat transcript, not the whole page: with navigation and
 * headings in the state its verdicts stop separating good replies from bad
 * ones (see results/laya-calibration.md).
 */
export function conversation(page: PageState): { conversation: string[] } {
  return {
    conversation: page.elements
      .filter((e) => e.cssPath.startsWith("#conversation >") && e.text)
      .map((e) => e.text as string),
  };
}
