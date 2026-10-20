import { ChatRequestSchema, MAX_REQUEST_BYTES, type ChatEvent } from "@/lib/chat-protocol";
import { runAgent } from "@/lib/server/agent";
import { getConfig } from "@/lib/server/config";
import { getCalculatorMcp } from "@/lib/server/mcp-client";
import { createOllamaChatModel } from "@/lib/server/ollama";
import { checkRequestOrigin, createConcurrencyLimiter } from "@/lib/server/request-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createConcurrencyLimiter(2);

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ type: "error", code, message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  let config;
  try {
    config = getConfig();
  } catch (error) {
    return jsonError(500, "internal", error instanceof Error ? error.message : "Invalid server configuration.");
  }

  const guard = checkRequestOrigin(request.headers, config.ALLOW_NON_LOCAL_REQUESTS);
  if (!guard.ok) return jsonError(guard.status, "forbidden", guard.message);

  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return jsonError(415, "bad_request", "Content-Type must be application/json.");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_REQUEST_BYTES) {
    return jsonError(413, "bad_request", "Request body is too large.");
  }

  // Read the body with a hard byte cap (Content-Length may be absent or wrong).
  let raw = "";
  try {
    const reader = request.body?.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_REQUEST_BYTES) {
          await reader.cancel();
          return jsonError(413, "bad_request", "Request body is too large.");
        }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    }
  } catch {
    return jsonError(400, "bad_request", "Could not read request body.");
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError(400, "bad_request", "Request body must be valid JSON.");
  }
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return jsonError(400, "bad_request", `Invalid request: ${issue ? `${issue.path.join(".")} ${issue.message}` : "unknown error"}`);
  }

  const release = limiter.tryAcquire();
  if (!release) {
    return jsonError(429, "busy", "Another AI request is still running. Please wait for it to finish.");
  }

  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const model = createOllamaChatModel({
    host: config.OLLAMA_HOST,
    model: config.OLLAMA_MODEL,
    timeoutMs: config.OLLAMA_TIMEOUT_MS,
    think: config.OLLAMA_THINK,
    keepAlive: config.OLLAMA_KEEP_ALIVE,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: ChatEvent): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };
      try {
        await runAgent(parsed.data.messages, {
          model,
          getTools: () => getCalculatorMcp(config.MCP_CONNECT_TIMEOUT_MS),
          emit,
          signal: abort.signal,
          maxIterations: config.MAX_TOOL_ITERATIONS,
          maxToolCallsPerTurn: config.MAX_TOOL_CALLS_PER_TURN,
          toolTimeoutMs: config.MCP_TOOL_TIMEOUT_MS,
        });
      } finally {
        release();
        open = false;
        try {
          controller.close();
        } catch {
          // already closed/cancelled
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
