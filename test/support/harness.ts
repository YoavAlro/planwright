import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveConfig, run, ScriptedProvider, type PlanwrightConfig, type RunOptions, type RunResult } from "../../src/index.js";
import { demoBrain, type BrainOptions } from "./brain.js";

export interface Project {
  dir: string;
  provider: ScriptedProvider;
  output: string[];
  writeFeature(name: string, source: string): string;
  readPlan(name: string): string;
  run(options?: Partial<Omit<RunOptions, "config">>, overrides?: PlanwrightConfig): Promise<RunResult>;
}

export function createProject(baseURL: string, brain: BrainOptions = {}, config: PlanwrightConfig = {}): Project {
  const dir = mkdtempSync(join(tmpdir(), "planwright-"));
  mkdirSync(join(dir, "features"), { recursive: true });
  const provider = new ScriptedProvider(demoBrain(brain));
  const output: string[] = [];
  return {
    dir,
    provider,
    output,
    writeFeature(name, source) {
      const path = join(dir, "features", name);
      writeFileSync(path, source);
      return path;
    },
    readPlan(name) {
      return readFileSync(join(dir, "features", name.replace(/\.feature$/, ".plan.json")), "utf8");
    },
    async run(options = {}, overrides = {}) {
      provider.reset();
      output.length = 0;
      const resolved = resolveConfig(
        { baseURL, llm: provider, trace: "off", timeouts: { actionMs: 1_000 }, ...config, ...overrides },
        dir,
      );
      return run({ config: resolved, write: (t) => output.push(t), ...options });
    },
  };
}
