import { existsSync } from "node:fs";
import { relative } from "node:path";

import pc from "picocolors";
import { chromium } from "playwright";

import { discoverFeatures, type ResolvedConfig } from "./config.js";
import { parseFeatureFile } from "./gherkin/parse.js";
import { anthropic } from "./llm/anthropic.js";
import { loadPlan } from "./plan/store.js";

type Write = (text: string) => void;

/** Checks everything a run needs and prints the exact fix for each problem. Returns an exit code (0 or 3). */
export async function doctor(config: ResolvedConfig, write: Write, configPath: string | undefined): Promise<0 | 3> {
  let problems = 0;
  const ok = (msg: string) => write(`${pc.green("✓")} ${msg}\n`);
  const bad = (msg: string, fix: string) => {
    problems++;
    write(`${pc.red("✗")} ${msg}\n    ${pc.dim("fix:")} ${fix}\n`);
  };

  if (configPath) ok(`config: ${relative(process.cwd(), configPath) || configPath}`);
  else write(`${pc.yellow("!")} no planwright.config.ts found; using defaults\n`);

  try {
    const features = discoverFeatures(config.features);
    let scenarios = 0;
    for (const f of features) scenarios += parseFeatureFile(f, config.rootDir).scenarios.length;
    if (features.length) ok(`features: ${features.length} file(s), ${scenarios} scenario(s)`);
    else bad("no .feature files found", `add features under ${config.features.join(", ")} or set \`features\` in the config`);
  } catch (err) {
    bad(`features: ${(err as Error).message}`, "fix the path or the Gherkin syntax");
  }

  const llm = config.llm ?? anthropic();
  const credentialProblem = llm.checkCredentials?.() ?? null;
  if (credentialProblem) {
    const [problem, fix] = credentialProblem.split(" Fix: ");
    bad(`LLM (${llm.name}/${llm.model}): ${problem}`, fix ?? "configure the provider's credentials");
  }
  else ok(`LLM: ${llm.name}/${llm.model}`);
  ok(`judge: ${config.judge ? config.judge.name : "LLM"}`);

  try {
    const browser = await chromium.launch({ headless: true, ...config.launchOptions });
    ok(`browser: chromium ${browser.version()}`);
    await browser.close();
  } catch (err) {
    bad(`browser: ${(err as Error).message.split("\n")[0]}`, "run `npx playwright install chromium` (or set browser.launchOptions.executablePath)");
  }

  if (config.baseURL) {
    try {
      const res = await fetch(config.baseURL, { method: "GET", redirect: "manual" });
      if (res.status >= 500) bad(`baseURL ${config.baseURL} returned HTTP ${res.status}`, "start the app or point baseURL at a healthy environment");
      else ok(`baseURL: ${config.baseURL} (HTTP ${res.status})`);
    } catch (err) {
      bad(`baseURL ${config.baseURL} unreachable: ${(err as Error).message}`, "start the app or fix baseURL");
    }
  } else {
    write(`${pc.yellow("!")} no baseURL; scenarios must navigate with absolute URLs\n`);
  }

  if (!existsSync(config.fixturesDir)) write(`${pc.dim(`- fixtures dir ${relative(config.rootDir, config.fixturesDir)} does not exist (only needed for uploads)`)}\n`);

  write(problems ? pc.red(`\n${problems} problem(s) found.\n`) : pc.green("\nAll checks passed.\n"));
  return problems ? 3 : 0;
}

/** Lists scenarios with their plan status. */
export function list(config: ResolvedConfig, paths: string[] | undefined, write: Write): void {
  for (const path of discoverFeatures(paths?.length ? paths : config.features)) {
    const feature = parseFeatureFile(path, config.rootDir);
    const plan = loadPlan(path);
    write(`${pc.bold(relative(config.rootDir, path))}\n`);
    for (const s of feature.scenarios) {
      const custom = (text: string) =>
        config.steps.some((d) => (typeof d.pattern === "string" ? d.pattern === text : d.pattern.test(text)));
      const plannable = s.steps.filter((st) => !custom(st.text));
      const cached = new Set(plan.scenarios[s.key]?.steps.map((p) => p.hash) ?? []);
      const have = plannable.filter((st) => cached.has(st.hash)).length;
      const status =
        plannable.length === 0
          ? pc.dim("custom steps only")
          : have === plannable.length
            ? pc.green(`planned ${have}/${plannable.length}`)
            : have === 0
              ? pc.yellow("no plan")
              : pc.yellow(`stale: ${plannable.length - have} of ${plannable.length} step(s) need planning`);
      write(`  ${s.key} ${s.tags.length ? pc.dim(s.tags.join(" ")) : ""} — ${status}\n`);
    }
  }
}
