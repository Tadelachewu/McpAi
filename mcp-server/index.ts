/**
 * Stdio entry point for the calculator MCP server.
 *
 * The Next.js app spawns this automatically (see src/lib/server/mcp-client.ts). You can also run it
 * standalone with `npm run mcp:server`, or inspect it with `npm run mcp:inspect`.
 *
 * stdout carries the JSON-RPC protocol, so diagnostics go to stderr only. Tool arguments are never logged.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION, createCalculatorServer } from "./server";

async function main(): Promise<void> {
  const server = createCalculatorServer();
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // When the parent (Next.js) goes away, stdin closes; exit instead of lingering.
  process.stdin.on("close", () => void shutdown());

  await server.connect(transport);
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} ready on stdio`);
}

main().catch((error: unknown) => {
  console.error(`[${SERVER_NAME}] fatal:`, error instanceof Error ? error.message : error);
  process.exit(1);
});
