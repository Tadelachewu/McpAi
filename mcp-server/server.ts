/**
 * MCP calculator server definition (transport-agnostic, so it can be tested in-memory).
 * Only the tools in `calculatorTools` are registered. Handlers are pure: no shell, no files, no network.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CalculatorError } from "../src/lib/calculator/errors";
import type { CalculationResult } from "../src/lib/calculator/operations";
import {
  CALCULATOR_TOOL_NAMES,
  calculationOutputShape,
  calculatorTools,
  formatCalculationText,
} from "../src/lib/calculator/tools";

export const SERVER_NAME = "calculator-mcp-server";
export const SERVER_VERSION = "1.0.0";

export function runCalculatorTool(
  handler: (args: Record<string, unknown>) => CalculationResult,
  args: Record<string, unknown>,
): CallToolResult {
  try {
    const result = handler(args);
    return {
      content: [{ type: "text", text: formatCalculationText(result) }],
      structuredContent: { ...result },
    };
  } catch (error) {
    const message =
      error instanceof CalculatorError ? `Error: ${error.message}` : "Error: Internal calculator error.";
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

export function createCalculatorServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Deterministic calculator tools. Always rely on these tools for arithmetic instead of computing mentally.",
    },
  );

  for (const name of CALCULATOR_TOOL_NAMES) {
    const tool = calculatorTools[name];
    // The per-tool generic types are erased here; the SDK validates `args` against `inputSchema`
    // before invoking the callback, so the handler always receives schema-conforming input.
    const handler = tool.handler as (args: Record<string, unknown>) => CalculationResult;
    server.registerTool(
      name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: calculationOutputShape,
        annotations: {
          title: tool.title,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => runCalculatorTool(handler, args),
    );
  }

  return server;
}
