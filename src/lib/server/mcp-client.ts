/**
 * MCP client that launches the calculator MCP server as a child process over stdio and keeps one
 * shared connection per Next.js server process. If the child dies, the next request respawns it.
 *
 * The child is started with a fixed command (this Node binary + tsx + mcp-server/index.ts) and
 * shell: false semantics — no user input ever reaches the command line.
 */
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { CALCULATOR_TOOL_NAMES, isCalculatorToolName } from "../calculator/tools";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
}

export interface McpToolOutcome {
  ok: boolean;
  /** Text returned by the tool (result text or error message). */
  text: string;
  structured?: Record<string, unknown>;
}

export interface CalculatorMcpClient {
  /** True once the underlying server process/transport has closed. */
  readonly closed: boolean;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpToolOutcome>;
  close(): Promise<void>;
}

export class McpUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpUnavailableError";
  }
}

export function resolveServerLaunch(projectRoot = process.cwd()): { command: string; args: string[]; cwd: string } {
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const entry = path.join(projectRoot, "mcp-server", "index.ts");
  for (const file of [tsxCli, entry]) {
    // Intentional runtime lookup in the project root (the server is spawned, not bundled).
    if (!fs.existsSync(/*turbopackIgnore: true*/ file)) {
      throw new McpUnavailableError(`MCP server launch file not found: ${path.relative(projectRoot, file)}. Run "npm install" in the project root.`);
    }
  }
  return { command: process.execPath, args: [tsxCli, entry], cwd: projectRoot };
}

/** Connects a fresh client to a newly spawned stdio server process. */
export async function connectCalculatorMcp(options: { connectTimeoutMs?: number; projectRoot?: string } = {}): Promise<CalculatorMcpClient> {
  const launch = resolveServerLaunch(options.projectRoot);
  const transport = new StdioClientTransport({
    ...launch,
    // Minimal inherited environment (PATH, SystemRoot, ...) — no app secrets are passed to the child.
    env: { ...getDefaultEnvironment(), NODE_ENV: process.env.NODE_ENV ?? "development" },
    stderr: "inherit",
  });
  const client = new Client({ name: "nextjs-ai-calculator", version: "1.0.0" });

  let closed = false;
  transport.onclose = () => {
    closed = true;
  };

  try {
    await client.connect(transport, { timeout: options.connectTimeoutMs ?? 30_000 });
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw new McpUnavailableError("Could not start or connect to the calculator MCP server.", { cause: error });
  }

  let toolCache: McpToolDescriptor[] | undefined;

  const instance: CalculatorMcpClient = {
    get closed() {
      return closed;
    },
    async listTools() {
      if (toolCache) return toolCache;
      const { tools } = await client.listTools();
      // Allowlist: only tools we know and validate server-side are ever offered to the model.
      toolCache = tools
        .filter((tool) => isCalculatorToolName(tool.name))
        .map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }));
      return toolCache;
    },
    async callTool(name, args, callOptions = {}) {
      if (!isCalculatorToolName(name)) {
        return { ok: false, text: `Error: Tool "${name}" is not permitted.` };
      }
      const result = (await client.callTool({ name, arguments: args }, undefined, {
        signal: callOptions.signal,
        timeout: callOptions.timeoutMs ?? 10_000,
      })) as CallToolResult;
      const text = (result.content ?? [])
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .slice(0, 2_000);
      return {
        ok: !result.isError,
        text: text || (result.isError ? "Error: Tool failed." : ""),
        structured: result.structuredContent,
      };
    },
    async close() {
      closed = true;
      await client.close().catch(() => undefined);
    },
  };
  return instance;
}

// ---------------------------------------------------------------------------
// Process-wide shared connection (survives Next.js dev hot reloads via globalThis).
// ---------------------------------------------------------------------------

const globalForMcp = globalThis as unknown as { __calculatorMcp?: Promise<CalculatorMcpClient> };

export async function getCalculatorMcp(connectTimeoutMs?: number): Promise<CalculatorMcpClient> {
  const existing = globalForMcp.__calculatorMcp;
  if (existing) {
    try {
      const client = await existing;
      if (!client.closed) return client;
    } catch {
      // previous connection attempt failed; retry below
    }
  }
  const pending = connectCalculatorMcp({ connectTimeoutMs });
  globalForMcp.__calculatorMcp = pending;
  pending.catch(() => {
    if (globalForMcp.__calculatorMcp === pending) globalForMcp.__calculatorMcp = undefined;
  });
  return pending;
}

export const EXPECTED_TOOL_NAMES: readonly string[] = CALCULATOR_TOOL_NAMES;
