import { getAiProvider, getConfig, type AiProvider } from "@/lib/server/config";
import { getCalculatorMcp } from "@/lib/server/mcp-client";
import { checkOllama } from "@/lib/server/ollama";
import { checkOpenRouter } from "@/lib/server/openrouter";
import { checkRequestOrigin } from "@/lib/server/request-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface HealthResponse {
  ai: { provider: AiProvider; reachable: boolean; modelAvailable: boolean; model: string; version?: string };
  mcp: { connected: boolean; tools: string[]; error?: string };
}

/** Reports whether the AI provider, the model and the MCP server are usable. Exposes no secrets or URLs. */
export async function GET(request: Request): Promise<Response> {
  const config = getConfig();
  const guard = checkRequestOrigin(request.headers, config.ALLOW_NON_LOCAL_REQUESTS);
  if (!guard.ok) return Response.json({ error: guard.message }, { status: guard.status });

  const provider = getAiProvider(config);
  const model = provider === "openrouter" ? config.OPENROUTER_MODEL : config.OLLAMA_MODEL;
  const [ai, mcp] = await Promise.all([
    provider === "openrouter"
      ? checkOpenRouter(config.OPENROUTER_BASE_URL, config.OPENROUTER_API_KEY!.trim(), model)
      : checkOllama(config.OLLAMA_HOST, model),
    getCalculatorMcp(config.MCP_CONNECT_TIMEOUT_MS)
      .then(async (client) => ({ connected: true, tools: (await client.listTools()).map((t) => t.name) }))
      .catch((error: unknown) => ({
        connected: false,
        tools: [] as string[],
        error: error instanceof Error ? error.message : "MCP server unavailable",
      })),
  ]);

  const body: HealthResponse = { ai: { ...ai, provider, model }, mcp };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
