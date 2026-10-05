import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { InfraError } from "../runtime/errors.js";
import type { LlmProvider, LlmRequest, LlmResponse, LlmTool } from "./types.js";

export interface ClaudeCliOptions {
  /** Model alias or id passed to `--model`. Default: whatever the CLI is configured to use. */
  model?: string;
  /** Executable. Default "claude". */
  command?: string;
  /** Per-call timeout. Default 180000 ms. */
  timeoutMs?: number;
  /** Extra CLI arguments, appended last. */
  extraArgs?: string[];
  /**
   * Write every call (args, prompt text, raw CLI result, stderr, timing) as JSON into this
   * directory, for diagnosing CLI behaviour. Default: the PLANWRIGHT_CLI_LOG env var.
   */
  logDir?: string;
}

let callCounter = 0;

/**
 * One structured answer: which tool, with which input. The CLI turns this into a tool
 * definition, which may not use a top-level anyOf, so per-tool argument schemas go in
 * the system prompt and planwright validates the arguments when it executes them.
 */
function toolSchema(tools: LlmTool[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      tool: { type: "string", enum: tools.map((t) => t.name) },
      input: { type: "object", description: "Arguments for the chosen tool, matching its schema." },
    },
    required: ["tool", "input"],
    additionalProperties: false,
  };
}

function systemPrompt(request: LlmRequest): string {
  return [
    request.system,
    "",
    "Answer with exactly one action as structured output: {\"tool\": <name>, \"input\": <arguments>}.",
    "Available tools:",
    ...request.tools.map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.parameters)}`),
  ].join("\n");
}

interface CliResult {
  type: "result";
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/**
 * Drives the model through the Claude Code CLI (`claude -p`) instead of the API,
 * so it runs on whatever the CLI is logged in with (e.g. a Claude subscription)
 * and needs no ANTHROPIC_API_KEY. Claude Code's own tools, settings, MCP servers
 * and session persistence are disabled: each call is one isolated model turn.
 */
export class ClaudeCliProvider implements LlmProvider {
  readonly name = "claude-cli";
  readonly model: string;
  private readonly command: string;

  constructor(private readonly options: ClaudeCliOptions = {}) {
    this.model = options.model ?? "cli-default";
    this.command = options.command ?? "claude";
  }

  checkCredentials(): string | null {
    const probe = spawnSync(this.command, ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      return `The \`${this.command}\` CLI was not found. Fix: npm install -g @anthropic-ai/claude-code, then run \`claude\` once to log in.`;
    }
    return null;
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--tools", "",
      "--setting-sources", "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--system-prompt", systemPrompt(request),
      "--json-schema", JSON.stringify(toolSchema(request.tools)),
      ...(this.options.model ? ["--model", this.options.model] : []),
      ...(this.options.extraArgs ?? []),
    ];
    const message = {
      type: "user",
      message: {
        role: "user",
        content: request.content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } },
        ),
      },
    };

    const logDir = this.options.logDir ?? process.env.PLANWRIGHT_CLI_LOG;
    const started = Date.now();
    const log = (entry: Record<string, unknown>) => {
      if (!logDir) return;
      mkdirSync(logDir, { recursive: true });
      const n = String(++callCounter).padStart(3, "0");
      writeFileSync(
        join(logDir, `${n}-${request.purpose}.json`),
        JSON.stringify(
          {
            purpose: request.purpose,
            durationMs: Date.now() - started,
            args: args.map((a) => (a.length > 400 ? `${a.slice(0, 400)}…(${a.length} chars)` : a)),
            prompt: request.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text.slice(0, 4000)),
            images: request.content.filter((c) => c.type === "image").length,
            ...entry,
          },
          null,
          2,
        ),
      );
    };

    return new Promise((resolve, reject) => {
      // Run outside the project so no CLAUDE.md or project settings leak into the prompt.
      const child = spawn(this.command, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        log({ timedOut: true, stderr: stderr.slice(-2000), stdoutTail: stdout.slice(-3000) });
        reject(new InfraError(`claude CLI timed out after ${this.options.timeoutMs ?? 180_000}ms`));
      }, this.options.timeoutMs ?? 180_000);
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new InfraError(`Could not start \`${this.command}\`: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const lastLines = stdout.trim().split("\n").slice(-3);
        log({ exitCode: code, stderr: stderr.slice(-2000), lastStdoutLines: lastLines.map((l) => l.slice(0, 3000)) });
        const result = stdout
          .split("\n")
          .map((line) => {
            try {
              return JSON.parse(line) as { type?: string };
            } catch {
              return undefined;
            }
          })
          .filter((e): e is CliResult => e?.type === "result")
          .at(-1);
        if (!result) {
          reject(new InfraError(`claude CLI exited with ${code} and no result: ${stderr.trim().slice(-500)}`));
          return;
        }
        if (result.is_error) {
          reject(new InfraError(`claude CLI error (${result.subtype ?? "error"}): ${String(result.result ?? "").slice(0, 500)}`));
          return;
        }
        const u = result.usage ?? {};
        const usage = {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
        };
        const out = result.structured_output as (Record<string, unknown> & { tool?: string; input?: Record<string, unknown> }) | undefined;
        if (out?.tool) {
          // Arguments occasionally arrive beside `tool` instead of inside `input`: accept both.
          const { tool, input, ...rest } = out;
          const args = input && Object.keys(input).length ? input : rest;
          resolve({ toolCall: { name: tool, input: args }, usage });
        }
        else resolve({ text: result.result ?? "", usage });
      });
      child.stdin.end(JSON.stringify(message) + "\n");
    });
  }
}

export function claudeCli(options?: ClaudeCliOptions): ClaudeCliProvider {
  return new ClaudeCliProvider(options);
}
