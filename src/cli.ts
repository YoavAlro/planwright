#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import pc from "picocolors";

import { doctor, list } from "./commands.js";
import { findConfigFile, loadConfig } from "./config.js";
import { anthropic } from "./llm/anthropic.js";
import { ConfigError } from "./runtime/errors.js";
import { run } from "./runner.js";

const HELP = `planwright — Gherkin scenarios driven by an LLM once, replayed by Playwright after.

Usage:
  planwright run [paths...]     Run scenarios (replay cached plans, plan/heal what's missing)
  planwright plan [paths...]    Re-plan every step from scratch (same as run --replan)
  planwright list [paths...]    List scenarios and their plan status
  planwright doctor             Check config, LLM credentials, browser and baseURL

Options:
  -c, --config <file>   Config file (default: ./planwright.config.{ts,mts,js,mjs})
  -t, --tags <expr>     Tag filter, e.g. "@smoke and not @slow" or "@a,@b"
      --ci              CI mode: exit 2 when plans were created or healed
      --allow-drift     With --ci, report drift as a warning and exit 0
      --frozen          Never call the LLM for Given/When steps; missing/drifted plans fail
      --replan          Ignore cached plans and write fresh ones
      --no-cache        Plan every step from scratch; read and write no plan files (not with --frozen/--replan/plan)
      --headed          Show the browser
      --base-url <url>  Override baseURL
      --model <id>      Model for the default Anthropic provider
  -h, --help            Show help
  -v, --version         Show version

Exit codes: 0 passed · 1 scenario failure · 2 passed with plan drift (--ci) · 3 config/infra error
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      tags: { type: "string", short: "t" },
      ci: { type: "boolean" },
      "allow-drift": { type: "boolean" },
      frozen: { type: "boolean" },
      replan: { type: "boolean" },
      "no-cache": { type: "boolean" },
      headed: { type: "boolean" },
      "base-url": { type: "string" },
      model: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  const [command = "run", ...paths] = positionals;
  if (values.help || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  const cwd = process.cwd();
  const config = await loadConfig({ cwd, configPath: values.config });
  if (values["base-url"]) config.baseURL = values["base-url"];
  if (values.headed) config.headless = false;
  if (values.model) {
    if (config.llm) throw new ConfigError("--model only applies to the default provider; set the model in planwright.config instead.");
    config.llm = anthropic({ model: values.model });
  }
  const write = (t: string) => process.stdout.write(t);

  switch (command) {
    case "run":
    case "plan": {
      const result = await run({
        config,
        paths,
        tags: values.tags,
        ci: values.ci,
        allowDrift: values["allow-drift"],
        frozen: values.frozen,
        replan: values.replan || command === "plan",
        noCache: values["no-cache"],
      });
      return result.exitCode;
    }
    case "list":
      list(config, paths, write);
      return 0;
    case "doctor":
      return doctor(config, write, values.config ?? findConfigFile(cwd));
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 3;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${pc.red(err instanceof ConfigError ? "Config error: " : "Error: ")}${(err as Error).message}\n`);
    process.exit(3);
  },
);
