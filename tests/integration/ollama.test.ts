/**
 * INTEGRATION — REAL OLLAMA. These tests talk to the real local Ollama server and qwen3:8b and the
 * real stdio MCP server. They are skipped unless RUN_OLLAMA_TESTS=1 (use `npm run test:ollama`).
 * The "unreachable host" test always runs: it needs no Ollama.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatEvent } from "@/lib/chat-protocol";
import { runAgent } from "@/lib/server/agent";
import { getConfig } from "@/lib/server/config";
import { connectCalculatorMcp, type CalculatorMcpClient } from "@/lib/server/mcp-client";
import { createOllamaChatModel } from "@/lib/server/ollama";

const RUN_REAL = process.env.RUN_OLLAMA_TESTS === "1";

describe("Ollama unreachable (always runs)", () => {
  it("returns a useful error when nothing listens on the configured port", async () => {
    const mcp = await connectCalculatorMcp();
    try {
      const events: ChatEvent[] = [];
      await runAgent([{ role: "user", content: "Explain what a percentage is" }], {
        model: createOllamaChatModel({ host: "http://127.0.0.1:9", model: "qwen3:8b", timeoutMs: 5_000, think: false }),
        getTools: async () => mcp,
        emit: (e) => events.push(e),
        signal: new AbortController().signal,
        maxIterations: 3,
        maxToolCallsPerTurn: 2,
        toolTimeoutMs: 5_000,
      });
      expect(events.at(-1)).toMatchObject({ type: "error", code: "ollama_unavailable", message: expect.stringContaining("Cannot reach Ollama") });
    } finally {
      await mcp.close();
    }
  });
});

describe.skipIf(!RUN_REAL)("REAL qwen3:8b + MCP tool calling", () => {
  let mcp: CalculatorMcpClient;
  const config = getConfig();
  const model = createOllamaChatModel({
    host: config.OLLAMA_HOST,
    model: config.OLLAMA_MODEL,
    timeoutMs: config.OLLAMA_TIMEOUT_MS,
    think: config.OLLAMA_THINK,
    keepAlive: config.OLLAMA_KEEP_ALIVE,
  });

  beforeAll(async () => {
    mcp = await connectCalculatorMcp();
  });
  afterAll(async () => {
    await mcp?.close();
  });

  async function ask(question: string) {
    const events: ChatEvent[] = [];
    await runAgent([{ role: "user", content: question }], {
      model,
      getTools: async () => mcp,
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      maxIterations: config.MAX_TOOL_ITERATIONS,
      maxToolCallsPerTurn: config.MAX_TOOL_CALLS_PER_TURN,
      toolTimeoutMs: config.MCP_TOOL_TIMEOUT_MS,
    });
    const final = events.find((e) => e.type === "final");
    const toolResults = events.filter((e): e is Extract<ChatEvent, { type: "tool_result" }> => e.type === "tool_result");
    return { events, final, toolResults };
  }

  it.each([
    ["What is 125 * 24?", "3000"],
    ["What is 15% of 800?", "120"],
    ["Calculate (100 + 50) * 4", "600"],
    ["What is the square root of 144?", "12"],
  ])("%s -> %s (via a real MCP tool call)", { timeout: 300_000 }, async (question, expected) => {
    const { final, toolResults } = await ask(question);
    expect(toolResults.some((r) => r.executed && r.ok && r.result === expected)).toBe(true);
    expect(final).toMatchObject({ type: "final", verified: true });
    expect((final as { content: string }).content.replace(/,/g, "")).toContain(expected);
  });

  it("division by zero produces a tool error and no invented number", { timeout: 300_000 }, async () => {
    const { final, toolResults } = await ask("What is 10 divided by 0?");
    expect(toolResults.some((r) => r.executed && !r.ok)).toBe(true);
    expect(final).toBeDefined();
    expect((final as { content: string }).content.toLowerCase()).toMatch(/zero|undefined|cannot|not possible/);
  });
});
