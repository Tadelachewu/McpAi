/**
 * Tool-calling loop: model -> tool calls -> (validate) -> MCP tools/call -> tool results -> model ...
 * until the model produces a final answer or the iteration limit is reached.
 */
import { z } from "zod";
import { parse as parseExpression } from "../calculator/expression";
import { isCalculatorToolName, toolArgumentsSchema, calculatorTools } from "../calculator/tools";
import type { ChatErrorCode, ChatEvent, ChatMessageInput } from "../chat-protocol";
import { MAX_MODEL_HISTORY } from "../chat-protocol";
import type { CalculatorMcpClient, McpToolDescriptor, McpToolOutcome } from "./mcp-client";
import { McpUnavailableError } from "./mcp-client";
import { OllamaError, type ChatModel, type OllamaMessage, type OllamaTool, type OllamaToolCall } from "./ollama";

export type ToolExecutor = Pick<CalculatorMcpClient, "listTools" | "callTool">;

export interface AgentOptions {
  model: ChatModel;
  /** Lazily obtains the MCP client (so MCP startup errors are reported as events). */
  getTools: () => Promise<ToolExecutor>;
  emit: (event: ChatEvent) => void;
  signal: AbortSignal;
  maxIterations: number;
  maxToolCallsPerTurn: number;
  toolTimeoutMs: number;
}

export const SYSTEM_PROMPT = `You are the assistant inside a calculator app. You MUST use the provided calculator tools for every arithmetic operation.

Rules:
- Never calculate anything yourself. Every number in your answer that results from a calculation must come from a tool result.
- Prefer calculate_expression for multi-step or parenthesized expressions, e.g. "(100 + 50) * 4".
- Use percentage for "X% of Y" (value=Y, percent=X), square_root for square roots, and the other tools for single operations.
- Scientific math on ONE plain number: trigonometry (sin, cos, tan, asin, acos, atan, sinh, …), logarithm (base "e" for ln), factorial. Their arguments must be plain numbers, never text like "pi/6".
- Anything else scientific — several operations, pi or e, nested functions — goes to calculate_expression as ONE expression, e.g. "sin(pi/6) + log(100)". It supports pi, e, sin, cos, tan, asin, acos, atan, sinh, cosh, tanh, ln, log(x) (base 10), log(x, base), log2, exp, sqrt, cbrt, root(x, n), abs, floor, ceil, round, n! and nCr(n, r) / nPr(n, r).
- Counting questions: "choose r from n" / combinations → calculate_expression "nCr(n, r)"; arrangements / permutations → "nPr(n, r)".
- Angles: pass angle_unit "degrees" unless the user says radians or the angle is written with pi (e.g. sin(pi/6)); then pass "radians".
- If a tool returns an error (for example division by zero), explain the error plainly; do not invent a result.
- After receiving tool results, reply with a short, clear answer that shows the calculation, e.g. "15% of 800 = 120".
- If the user asks something that is not a calculation, briefly say you can only help with calculations.`;

const NUDGE_MESSAGE =
  "Reminder: you must call one of the calculator tools to compute this. Do not answer from your own arithmetic. Call the appropriate tool now.";

const NUMERIC_STRING = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i;

export function looksLikeCalculation(text: string): boolean {
  return (
    /\d/.test(text) ||
    /\b(sqrt|square root|cube root|percent|plus|minus|times|divided|power|sin|cos|tan|sine|cosine|tangent|log|ln|logarithm|factorial|exp|pi|choose|combinations?|permutations?)\b/i.test(text)
  );
}

/** Converts MCP JSON Schema to the parameter schema Ollama expects (drops meta keys). */
export function toOllamaTools(tools: McpToolDescriptor[]): OllamaTool[] {
  return tools.map((tool) => {
    const { $schema: _ignored, ...parameters } = tool.inputSchema as Record<string, unknown>;
    return { type: "function", function: { name: tool.name, description: tool.description, parameters } };
  });
}

type PreparedCall =
  | { ok: true; name: string; args: Record<string, unknown> }
  | { ok: false; name: string; args: Record<string, unknown>; error: string };

/** Validates a model-produced tool call against the allowlist and the shared Zod schema. */
export function prepareToolCall(call: OllamaToolCall, offered: ReadonlySet<string>): PreparedCall {
  const rawName = call?.function?.name;
  const name = typeof rawName === "string" ? rawName.slice(0, 64) : "(missing)";

  let rawArgs: unknown = call?.function?.arguments ?? {};
  if (typeof rawArgs === "string") {
    try {
      rawArgs = JSON.parse(rawArgs);
    } catch {
      return { ok: false, name, args: {}, error: "Error: Tool arguments were not valid JSON." };
    }
  }
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return { ok: false, name, args: {}, error: "Error: Tool arguments must be a JSON object." };
  }
  const args = rawArgs as Record<string, unknown>;

  if (!isCalculatorToolName(name) || !offered.has(name)) {
    return {
      ok: false,
      name,
      args,
      error: `Error: Unknown tool "${name}". Available tools: ${[...offered].join(", ")}.`,
    };
  }

  // Models occasionally send numbers as strings ("125"). Convert only strictly numeric strings,
  // and only for fields the schema declares as numbers; everything else must validate as-is.
  const shape = calculatorTools[name].inputSchema as z.ZodRawShape;
  const normalized: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(normalized)) {
    if (shape[key] instanceof z.ZodNumber && typeof value === "string" && NUMERIC_STRING.test(value)) {
      normalized[key] = Number(value);
    }
  }

  const parsed = toolArgumentsSchema(name).safeParse(normalized);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
      .join("; ");
    return { ok: false, name, args, error: `Error: Invalid arguments for ${name}: ${details}` };
  }
  return { ok: true, name, args: parsed.data as Record<string, unknown> };
}

function ollamaErrorCode(error: OllamaError): ChatErrorCode {
  switch (error.code) {
    case "unavailable":
      return "ollama_unavailable";
    case "model_missing":
      return "model_missing";
    case "tools_unsupported":
      return "tools_unsupported";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    default:
      return "model_error";
  }
}

/** Extracts a bare arithmetic expression from simple phrasings like "what is 2+2?". */
export function extractPlainExpression(text: string): string | null {
  const candidate = text
    .trim()
    .replace(/^(please\s+)?(what\s+is|what's|calculate|compute|evaluate|solve)\s*:?\s*/i, "")
    .replace(/[?=\s]+$/, "")
    .trim();
  if (!candidate || !/\d/.test(candidate)) return null;
  try {
    parseExpression(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function safeArgs(args: Record<string, unknown>): Record<string, unknown> {
  // Bound what we echo back to the browser.
  const json = JSON.stringify(args);
  return json.length <= 1_000 ? args : { note: "arguments too large to display" };
}

export async function runAgent(history: ChatMessageInput[], options: AgentOptions): Promise<void> {
  const { emit, signal } = options;
  const recent = history.slice(-MAX_MODEL_HISTORY);
  const lastUser = recent[recent.length - 1]?.content ?? "";
  const toolsUsed: string[] = [];
  let toolsExecuted = 0;

  let executor: ToolExecutor;
  let offered: McpToolDescriptor[];
  try {
    executor = await options.getTools();
    offered = await executor.listTools();
  } catch (error) {
    emit({
      type: "error",
      code: "mcp_unavailable",
      message:
        error instanceof McpUnavailableError
          ? error.message
          : "The calculator MCP server is unavailable. Check the server console for details.",
    });
    return;
  }
  const offeredNames = new Set(offered.map((t) => t.name));
  const ollamaTools = toOllamaTools(offered);

  const callTool = async (id: string, prepared: PreparedCall): Promise<McpToolOutcome> => {
    if (!prepared.ok) {
      emit({ type: "tool_result", id, name: prepared.name, ok: false, executed: false, text: prepared.error });
      return { ok: false, text: prepared.error };
    }
    emit({ type: "tool_call", id, name: prepared.name, arguments: safeArgs(prepared.args) });
    toolsExecuted++;
    let outcome: McpToolOutcome;
    try {
      outcome = await executor.callTool(prepared.name, prepared.args, { signal, timeoutMs: options.toolTimeoutMs });
    } catch (error) {
      if (signal.aborted) throw error;
      const timedOut = error instanceof Error && /timed out|timeout/i.test(error.message);
      outcome = {
        ok: false,
        text: timedOut ? "Error: The tool call timed out." : "Error: The MCP tool call failed.",
      };
    }
    const result = typeof outcome.structured?.result === "string" ? outcome.structured.result : undefined;
    emit({ type: "tool_result", id, name: prepared.name, ok: outcome.ok, executed: true, text: outcome.text, result });
    if (outcome.ok) toolsUsed.push(prepared.name);
    return outcome;
  };

  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...recent.map((m): OllamaMessage => ({ role: m.role, content: m.content })),
  ];

  let nudged = false;
  try {
    for (let iteration = 0; iteration < options.maxIterations; iteration++) {
      if (signal.aborted) throw new OllamaError("cancelled", "The request was cancelled.");
      emit({ type: "status", message: iteration === 0 ? "Thinking…" : "Reading tool results…" });

      let streamed = false;
      const turn = await options.model.chat({
        messages,
        tools: ollamaTools,
        signal,
        onDelta: (text) => {
          streamed = true;
          emit({ type: "delta", text });
        },
      });

      if (turn.toolCalls.length === 0) {
        // Model answered directly. If this looks like arithmetic and no tool has run yet, insist once.
        if (toolsExecuted === 0 && !nudged && looksLikeCalculation(lastUser) && iteration + 1 < options.maxIterations) {
          nudged = true;
          if (streamed) emit({ type: "discard_draft" });
          messages.push(
            {
              role: "assistant",
              content: turn.content,
              ...(turn.reasoningDetails !== undefined ? { reasoning_details: turn.reasoningDetails } : {}),
            },
            { role: "user", content: NUDGE_MESSAGE },
          );
          continue;
        }
        emit({
          type: "final",
          content: turn.content || "(The model returned an empty answer.)",
          toolsUsed: [...toolsUsed],
          verified: toolsUsed.length > 0,
        });
        return;
      }

      if (streamed) emit({ type: "discard_draft" });
      messages.push({
        role: "assistant",
        content: turn.content,
        tool_calls: turn.toolCalls,
        ...(turn.reasoningDetails !== undefined ? { reasoning_details: turn.reasoningDetails } : {}),
      });

      for (const [index, call] of turn.toolCalls.entries()) {
        const id = (typeof call?.id === "string" && call.id.slice(0, 64)) || `call_${iteration}_${index}`;
        const prepared: PreparedCall =
          index < options.maxToolCallsPerTurn
            ? prepareToolCall(call, offeredNames)
            : {
                ok: false,
                name: typeof call?.function?.name === "string" ? call.function.name.slice(0, 64) : "(missing)",
                args: {},
                error: `Error: Too many tool calls in one turn (max ${options.maxToolCallsPerTurn}).`,
              };
        const outcome = await callTool(id, prepared);
        messages.push({ role: "tool", tool_name: prepared.name, tool_call_id: id, content: outcome.text });
      }
    }

    emit({
      type: "error",
      code: "max_iterations",
      message: `Stopped after ${options.maxIterations} model/tool rounds without a final answer. Try rephrasing the request more simply.`,
    });
  } catch (error) {
    if (signal.aborted) {
      emit({ type: "error", code: "cancelled", message: "The request was cancelled." });
      return;
    }
    if (error instanceof OllamaError) {
      // Documented fallback: if the model is unusable but the message is a plain arithmetic
      // expression, compute it directly through the MCP calculate_expression tool.
      const fallbackEligible = ["unavailable", "model_missing", "tools_unsupported"].includes(error.code);
      const expression = fallbackEligible && toolsUsed.length === 0 ? extractPlainExpression(lastUser) : null;
      if (expression && offeredNames.has("calculate_expression")) {
        emit({ type: "discard_draft" });
        const outcome = await callTool("fallback_0", prepareToolCall(
          { function: { name: "calculate_expression", arguments: { expression } } },
          offeredNames,
        ));
        emit({
          type: "final",
          content: `${error.message}\n\nThe AI model was not used. Computed directly with the calculate_expression tool: ${outcome.text}`,
          toolsUsed: [...toolsUsed],
          verified: outcome.ok,
          fallback: true,
        });
        return;
      }
      emit({ type: "error", code: ollamaErrorCode(error), message: error.message });
      return;
    }
    emit({ type: "error", code: "internal", message: "An unexpected server error occurred." });
    console.error("[agent] unexpected error:", error instanceof Error ? error.message : "unknown");
  }
}
