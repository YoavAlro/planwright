import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { claudeCli } from "../../src/index.js";

/** A stand-in `claude` executable: records its argv and stdin, answers with a scripted result line. */
function fakeClaude(result: Record<string, unknown>): { command: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const log = join(dir, "call.json");
  const command = join(dir, "claude");
  writeFileSync(
    command,
    `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }));
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  console.log(JSON.stringify(${JSON.stringify({ type: "result", ...result })}));
});
`,
  );
  chmodSync(command, 0o755);
  return { command, log };
}

const request = {
  purpose: "plan" as const,
  system: "SYSTEM",
  tools: [{ name: "click", description: "Click", parameters: { type: "object", properties: { ref: { type: "integer" } } } }],
  content: [
    { type: "text" as const, text: "GOAL" },
    { type: "image" as const, mediaType: "image/jpeg" as const, data: "AAAA" },
  ],
};

describe("claudeCli provider", () => {
  it("sends an isolated print-mode turn and returns the structured tool call with usage", async () => {
    const fake = fakeClaude({
      is_error: false,
      structured_output: { tool: "click", input: { ref: 3 } },
      usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 },
    });
    const res = await claudeCli({ command: fake.command, model: "opus" }).complete(request);
    expect(res).toEqual({ toolCall: { name: "click", input: { ref: 3 } }, usage: { inputTokens: 115, outputTokens: 7 } });

    const call = JSON.parse(readFileSync(fake.log, "utf8")) as { argv: string[]; input: string };
    expect(call.argv).toEqual(expect.arrayContaining(["-p", "--tools", "", "--no-session-persistence", "--model", "opus"]));
    const schema = JSON.parse(call.argv[call.argv.indexOf("--json-schema") + 1]!);
    expect(schema.properties.tool.enum).toEqual(["click"]);
    const message = JSON.parse(call.input.trim());
    expect(message.message.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
  });

  it("accepts arguments returned beside `tool` instead of inside `input`", async () => {
    const fake = fakeClaude({ is_error: false, structured_output: { tool: "verdict", input: {}, pass: true, confidence: 0.9, evidence: "ok" } });
    const res = await claudeCli({ command: fake.command }).complete(request);
    expect(res.toolCall).toEqual({ name: "verdict", input: { pass: true, confidence: 0.9, evidence: "ok" } });
  });

  it("a timed-out call rejects once as an infra error and is logged once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
    const command = join(dir, "claude");
    writeFileSync(command, "#!/usr/bin/env node\nsetTimeout(() => {}, 10_000);\n");
    chmodSync(command, 0o755);
    const logDir = join(dir, "log");
    await expect(claudeCli({ command, timeoutMs: 300, logDir }).complete(request)).rejects.toThrow(/timed out after 300ms/);
    await new Promise((r) => setTimeout(r, 200)); // let the killed child's "close" fire
    const files = readdirSync(logDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-001-plan\.json$/);
    expect(JSON.parse(readFileSync(join(logDir, files[0]!), "utf8"))).toMatchObject({ timedOut: true });
  });

  it("reports CLI errors as infra errors", async () => {
    const fake = fakeClaude({ is_error: true, subtype: "error_during_execution", result: "API Error: 529" });
    await expect(claudeCli({ command: fake.command }).complete(request)).rejects.toThrow(/claude CLI error.*529/);
  });
});
