import { ConfigError } from "../runtime/errors.js";
import { systemOneJudge, type SystemOneClient, type SystemOneJudgeOptions } from "./system-one.js";
import type { Judge } from "./types.js";

export interface LayaJudgeOptions extends SystemOneJudgeOptions {
  /** Passed to `Laya.load()` (modelDir, repo, revision, cacheDir, executionProviders, …). */
  load?: Record<string, unknown>;
}

/** Kept as a variable so TypeScript does not require the optional dependency to be installed. */
const LAYA_MODULE = "@receptron/laya";

/**
 * Judge semantic `Then` steps locally with Laya, the open-source Jev-compatible
 * System 1 decision model: no API tokens, ~150ms per assertion on CPU.
 * Requires `npm i @receptron/laya`; the ONNX weights (~1.7 GB) download from
 * Hugging Face on first use and are cached.
 */
export function layaJudge(options: LayaJudgeOptions = {}): Judge {
  return systemOneJudge(
    async () => {
      let mod: { Laya: { load(opts?: Record<string, unknown>): Promise<SystemOneClient> } };
      try {
        mod = (await import(LAYA_MODULE)) as typeof mod;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ERR_MODULE_NOT_FOUND" && e.message.includes(LAYA_MODULE)) {
          throw new ConfigError(
            "layaJudge() needs the optional dependency: npm install @receptron/laya " +
              "(inside the planwright repo itself: npm install -D @receptron/laya)",
          );
        }
        // Installed but failed to load (e.g. onnxruntime-node native binary): show the real cause.
        throw new ConfigError(`Loading @receptron/laya failed: ${e.message}`);
      }
      return mod.Laya.load(options.load);
    },
    { name: "laya", ...options },
  );
}
