/**
 * Unit tests for the agent loop. The model (Ollama) and the MCP transport are external dependencies
 * and are replaced by fakes here; the fake executor runs the real calculator tool handlers.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "@/lib/chat-protocol";
import { calculatorTools, CALCULATOR_TOOL_NAMES, type CalculatorToolName } from "@/lib/calculator/tools";
import { runCalculatorTool } from "../../mcp-server/server";
import { extractPlainExpression, prepareToolCall, runAgent, toOllamaTools, type ToolExecutor } from "@/lib/server/agent";
import { McpUnavailableError, type McpToolDescriptor } from "@/lib/server/mcp-client";
import { OllamaError, type ChatModel, type ChatParams, type ChatTurn } from "@/lib/server/ollama";

const descriptors: McpToolDescriptor[] = CALCULATOR_TOOL_NAMES.map((name) => ({
  name,
  description: calculatorTools[name].description,
  inputSchema: { type: "object", properties: {}, $schema: "http://json-schema.org/draft-07/schema#" },
}));

function fakeExecutor(): ToolExecutor & { calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    listTools: async () => descriptors,
    callTool: async (name, args) => {
      calls.push({ name, args });
      const handler = calculatorTools[name as CalculatorToolName].handler as (a: Record<string, unknown>) => never;
      const result = runCalculatorTool(handler, args);
      const text = (result.content[0] as { text: string }).text;
      return { ok: !result.isError, text, structured: result.structuredContent };
    },
  };
}

function scriptedModel(turns: (ChatTurn | Error)[]): ChatModel & { seen: ChatParams[] } {
  const seen: ChatParams[] = [];
  let i = 0;
  return {
    model: "fake",
    seen,
    async chat(params) {
      seen.push({ ...params, messages: [...params.messages] });
      const turn = turns[i++];
      if (!turn) throw new Error("script exhausted");
      if (turn instanceof Error) throw turn;
      if (turn.content) params.onDelta?.(turn.content);
      return turn;
    },
  };
}

async function run(model: ChatModel, executor: ToolExecutor | (() => Promise<ToolExecutor>), userText: string, overrides = {}) {
  const events: ChatEvent[] = [];
  await runAgent([{ role: "user", content: userText }], {
    model,
    getTools: typeof executor === "function" ? executor : async () => executor,
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    maxIterations: 5,
    maxToolCallsPerTurn: 4,
    toolTimeoutMs: 1000,
    ...overrides,
  });
  return events;
}

const call = (name: string, args: unknown, id?: string) => ({ id, function: { name, arguments: args } });

describe("runAgent", () => {
  it("runs model -> tool -> model and reports the verified final answer", async () => {
    const model = scriptedModel([
      { content: "", toolCalls: [call("percentage", { value: 800, percent: 15 }, "c1")] },
      { content: "15% of 800 = 120", toolCalls: [] },
    ]);
    const executor = fakeExecutor();
    const events = await run(model, executor, "What is 15% of 800?");

    expect(executor.calls).toEqual([{ name: "percentage", args: { value: 800, percent: 15 } }]);
    expect(events).toContainEqual({ type: "tool_call", id: "c1", name: "percentage", arguments: { value: 800, percent: 15 } });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "c1", ok: true, executed: true, result: "120" }));
    expect(events.at(-1)).toEqual({ type: "final", content: "15% of 800 = 120", toolsUsed: ["percentage"], verified: true });

    // The tool result is fed back to the model as a tool message.
    const secondTurn = model.seen[1]!.messages;
    expect(secondTurn.at(-1)).toEqual({ role: "tool", tool_name: "percentage", tool_call_id: "c1", content: "15% of 800 = 120" });
    // Tools offered to Ollama come from the MCP listing, without JSON-schema meta keys.
    expect(model.seen[0]!.tools!.map((t) => t.function.name).sort()).toEqual([...CALCULATOR_TOOL_NAMES].sort());
    expect(model.seen[0]!.tools![0]!.function.parameters).not.toHaveProperty("$schema");
  });

  it("feeds tool errors (division by zero) back to the model", async () => {
    const model = scriptedModel([
      { content: "", toolCalls: [call("divide", { a: 5, b: 0 })] },
      { content: "Division by zero is undefined.", toolCalls: [] },
    ]);
    const events = await run(model, fakeExecutor(), "5 divided by 0");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", ok: false, executed: true, text: "Error: Division by zero is undefined." }));
    expect(events.at(-1)).toMatchObject({ type: "final", verified: false, toolsUsed: [] });
  });

  it("rejects unknown tools and invalid arguments without calling MCP", async () => {
    const model = scriptedModel([
      {
        content: "",
        toolCalls: [call("run_shell", { cmd: "rm -rf /" }), call("add", { a: "abc", b: 1 }), call("add", "{not json")],
      },
      { content: "Sorry.", toolCalls: [] },
    ]);
    const executor = fakeExecutor();
    const events = await run(model, executor, "add abc and 1");
    expect(executor.calls).toHaveLength(0);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.type === "tool_result" && !r.executed && !r.ok)).toBe(true);
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
  });

  it("accepts strictly numeric strings and JSON-string arguments", async () => {
    const model = scriptedModel([
      { content: "", toolCalls: [call("multiply", '{"a":"125","b":24}')] },
      { content: "125 × 24 = 3000", toolCalls: [] },
    ]);
    const executor = fakeExecutor();
    await run(model, executor, "125 * 24");
    expect(executor.calls).toEqual([{ name: "multiply", args: { a: 125, b: 24 } }]);
  });

  it("nudges once when the model answers arithmetic without a tool", async () => {
    const model = scriptedModel([
      { content: "It's 3000.", toolCalls: [] },
      { content: "", toolCalls: [call("multiply", { a: 125, b: 24 })] },
      { content: "125 × 24 = 3000", toolCalls: [] },
    ]);
    const events = await run(model, fakeExecutor(), "What is 125 * 24?");
    expect(events).toContainEqual({ type: "discard_draft" });
    expect(events.at(-1)).toMatchObject({ type: "final", verified: true, toolsUsed: ["multiply"] });
  });

  it("marks answers without any tool call as unverified", async () => {
    const model = scriptedModel([{ content: "I can only help with calculations.", toolCalls: [] }]);
    const events = await run(model, fakeExecutor(), "Tell me a joke");
    expect(events.at(-1)).toEqual({ type: "final", content: "I can only help with calculations.", toolsUsed: [], verified: false });
  });

  it("stops at the iteration limit", async () => {
    const loop: ChatTurn = { content: "", toolCalls: [call("add", { a: 1, b: 1 })] };
    const model = scriptedModel([loop, loop, loop]);
    const events = await run(model, fakeExecutor(), "1+1", { maxIterations: 3 });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "max_iterations" });
  });

  it("limits tool calls per turn", async () => {
    const many = Array.from({ length: 3 }, () => call("add", { a: 1, b: 1 }));
    const model = scriptedModel([{ content: "", toolCalls: many }, { content: "done", toolCalls: [] }]);
    const executor = fakeExecutor();
    const events = await run(model, executor, "1+1", { maxToolCallsPerTurn: 2 });
    expect(executor.calls).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", executed: false, text: expect.stringContaining("Too many") }));
  });

  it("reports Ollama unavailable with a useful message", async () => {
    const model = scriptedModel([new OllamaError("unavailable", "Cannot reach Ollama at http://127.0.0.1:11434.")]);
    const events = await run(model, fakeExecutor(), "Explain percentages to me");
    expect(events.at(-1)).toEqual({ type: "error", code: "ollama_unavailable", message: "Cannot reach Ollama at http://127.0.0.1:11434." });
  });

  it("falls back to a direct MCP calculation when the model is unusable and the input is a plain expression", async () => {
    const model = scriptedModel([new OllamaError("model_missing", "The Ollama model is not installed.")]);
    const executor = fakeExecutor();
    const events = await run(model, executor, "What is (100 + 50) * 4?");
    expect(executor.calls).toEqual([{ name: "calculate_expression", args: { expression: "(100 + 50) * 4" } }]);
    expect(events.at(-1)).toMatchObject({ type: "final", fallback: true, verified: true });
    expect((events.at(-1) as { content: string }).content).toContain("= 600");
  });

  it("reports MCP startup failures", async () => {
    const model = scriptedModel([]);
    const events = await run(model, async () => {
      throw new McpUnavailableError("Could not start or connect to the calculator MCP server.");
    }, "1+1");
    expect(events).toEqual([{ type: "error", code: "mcp_unavailable", message: "Could not start or connect to the calculator MCP server." }]);
  });

  it("reports cancellation", async () => {
    const controller = new AbortController();
    const model: ChatModel = {
      model: "fake",
      chat: vi.fn(async () => {
        controller.abort();
        throw new OllamaError("cancelled", "The request was cancelled.");
      }),
    };
    const events: ChatEvent[] = [];
    await runAgent([{ role: "user", content: "1+1" }], {
      model,
      getTools: async () => fakeExecutor(),
      emit: (e) => events.push(e),
      signal: controller.signal,
      maxIterations: 3,
      maxToolCallsPerTurn: 2,
      toolTimeoutMs: 1000,
    });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "cancelled" });
  });
});

describe("helpers", () => {
  it("extractPlainExpression", () => {
    expect(extractPlainExpression("What is 2 + 2?")).toBe("2 + 2");
    expect(extractPlainExpression("calculate (100 + 50) * 4")).toBe("(100 + 50) * 4");
    expect(extractPlainExpression("125*24=")).toBe("125*24");
    expect(extractPlainExpression("What is 15% of 800?")).toBeNull();
    expect(extractPlainExpression("hello")).toBeNull();
  });

  it("prepareToolCall rejects prototype keys as tool names", () => {
    const offered = new Set(["add"]);
    expect(prepareToolCall(call("constructor", {}), offered)).toMatchObject({ ok: false });
    expect(prepareToolCall(call("__proto__", {}), offered)).toMatchObject({ ok: false });
    expect(prepareToolCall(call("add", [1, 2]), offered)).toMatchObject({ ok: false });
    // Tool known but not offered by the MCP server -> rejected.
    expect(prepareToolCall(call("divide", { a: 1, b: 2 }), offered)).toMatchObject({ ok: false });
  });

  it("toOllamaTools maps MCP descriptors to Ollama function tools", () => {
    expect(toOllamaTools([descriptors[0]!])[0]).toEqual({
      type: "function",
      function: { name: descriptors[0]!.name, description: descriptors[0]!.description, parameters: { type: "object", properties: {} } },
    });
  });
});
