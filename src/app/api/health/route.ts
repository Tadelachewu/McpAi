import { getConfig } from "@/lib/server/config";
import { getCalculatorMcp } from "@/lib/server/mcp-client";
import { checkOllama } from "@/lib/server/ollama";
import { checkRequestOrigin } from "@/lib/server/request-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface HealthResponse {
  ollama: { reachable: boolean; modelAvailable: boolean; model: string; version?: string };
  mcp: { connected: boolean; tools: string[]; error?: string };
}

/** Reports whether Ollama, the model and the MCP server are usable. Exposes no secrets or URLs. */
export async function GET(request: Request): Promise<Response> {
  const config = getConfig();
  const guard = checkRequestOrigin(request.headers, config.ALLOW_NON_LOCAL_REQUESTS);
  if (!guard.ok) return Response.json({ error: guard.message }, { status: guard.status });

  const [ollama, mcp] = await Promise.all([
    checkOllama(config.OLLAMA_HOST, config.OLLAMA_MODEL),
    getCalculatorMcp(config.MCP_CONNECT_TIMEOUT_MS)
      .then(async (client) => ({ connected: true, tools: (await client.listTools()).map((t) => t.name) }))
      .catch((error: unknown) => ({
        connected: false,
        tools: [] as string[],
        error: error instanceof Error ? error.message : "MCP server unavailable",
      })),
  ]);

  const body: HealthResponse = { ollama: { ...ollama, model: config.OLLAMA_MODEL }, mcp };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
