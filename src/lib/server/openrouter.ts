/**
 * OpenRouter (OpenAI-compatible /chat/completions) client implementing the same ChatModel interface
 * as the Ollama client. Used instead of Ollama when OPENROUTER_API_KEY is configured.
 *
 * Requests are non-streaming so that `reasoning_details` arrive complete; they are passed back to the
 * model unmodified on the next turn (OpenRouter's recommendation for reasoning + tool calling).
 * Errors are reported as OllamaError so the agent handles both providers the same way.
 */
import {
  OllamaError,
  visibleText,
  type ChatModel,
  type ChatParams,
  type ChatTurn,
  type OllamaMessage,
  type OllamaToolCall,
} from "./ollama";

export interface OpenRouterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  reasoning: boolean;
  fetchImpl?: typeof fetch;
}

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: unknown; arguments?: unknown };
}

interface OpenAiMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  reasoning_details?: unknown;
}

function joinUrl(base: string, pathname: string): string {
  return `${base.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
}

/** Converts the agent's (Ollama-shaped) history to OpenAI chat-completions messages. */
export function toOpenAiMessages(messages: OllamaMessage[]): OpenAiMessage[] {
  return messages.map((m): OpenAiMessage => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id ?? "", content: m.content };
    }
    if (m.role === "assistant") {
      const out: OpenAiMessage = { role: "assistant", content: m.content || null };
      if (m.tool_calls && m.tool_calls.length > 0) {
        out.tool_calls = m.tool_calls.map((call, i) => ({
          id: call.id ?? `call_${i}`,
          type: "function",
          function: {
            name: call.function.name,
            arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
          },
        }));
      }
      if (m.reasoning_details !== undefined) out.reasoning_details = m.reasoning_details;
      return out;
    }
    return { role: m.role, content: m.content };
  });
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 1_000);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
      if (typeof parsed.error === "string") return parsed.error;
      if (typeof parsed.error?.message === "string") return parsed.error.message;
    } catch {
      // not JSON
    }
    return text;
  } catch {
    return "";
  }
}

function classifyError(status: number, message: string, model: string): OllamaError {
  const lower = message.toLowerCase();
  const detail = message ? `: ${message.slice(0, 200)}` : "";
  if (status === 401 || status === 403) {
    return new OllamaError("unavailable", `OpenRouter rejected the API key (HTTP ${status}). Check OPENROUTER_API_KEY.`);
  }
  if (lower.includes("tool use") || lower.includes("support tool")) {
    return new OllamaError("tools_unsupported", `The OpenRouter model "${model}" does not support tool calling.`);
  }
  if (status === 404 || lower.includes("not a valid model")) {
    return new OllamaError("model_missing", `The OpenRouter model "${model}" was not found. Check OPENROUTER_MODEL.`);
  }
  if (status === 402) {
    return new OllamaError("http_error", `OpenRouter: insufficient credits (HTTP 402)${detail}`);
  }
  if (status === 429) {
    return new OllamaError("http_error", `OpenRouter rate limit reached (HTTP 429). Free models have strict limits; wait and try again.`);
  }
  return new OllamaError("http_error", `OpenRouter returned HTTP ${status}${detail}`);
}

export function createOpenRouterChatModel(options: OpenRouterOptions): ChatModel {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = joinUrl(options.baseUrl, "chat/completions");

  return {
    model: options.model,
    async chat({ messages, tools, signal, onDelta }: ChatParams): Promise<ChatTurn> {
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      const abortError = (cause?: unknown): OllamaError =>
        signal?.aborted
          ? new OllamaError("cancelled", "The request was cancelled.", { cause })
          : new OllamaError("timeout", `OpenRouter did not answer within ${Math.round(options.timeoutMs / 1000)} s. Try again.`, { cause });

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
            "X-Title": "AI Calculator",
          },
          body: JSON.stringify({
            model: options.model,
            messages: toOpenAiMessages(messages),
            ...(tools && tools.length > 0 ? { tools } : {}),
            ...(options.reasoning ? { reasoning: { enabled: true } } : {}),
            temperature: 0,
            stream: false,
          }),
          signal: combined,
        });
      } catch (error) {
        if (combined.aborted) throw abortError(error);
        throw new OllamaError("unavailable", "Cannot reach OpenRouter. Check your internet connection and OPENROUTER_BASE_URL.", { cause: error });
      }

      if (!response.ok) {
        throw classifyError(response.status, await readErrorMessage(response), options.model);
      }

      let data: {
        error?: { message?: unknown; code?: unknown };
        choices?: { message?: { content?: unknown; tool_calls?: unknown; reasoning_details?: unknown } }[];
      };
      try {
        data = await response.json();
      } catch (error) {
        if (combined.aborted) throw abortError(error);
        throw new OllamaError("bad_response", "OpenRouter sent a malformed response.", { cause: error });
      }
      // OpenRouter can report upstream provider errors with HTTP 200.
      if (data.error) {
        const message = typeof data.error.message === "string" ? data.error.message : "";
        throw classifyError(typeof data.error.code === "number" ? data.error.code : 502, message, options.model);
      }
      const message = data.choices?.[0]?.message;
      if (!message) {
        throw new OllamaError("bad_response", "OpenRouter returned no answer.");
      }

      const content = visibleText(typeof message.content === "string" ? message.content : "").trim();
      const toolCalls: OllamaToolCall[] = [];
      if (Array.isArray(message.tool_calls)) {
        for (const [i, call] of (message.tool_calls as OpenAiToolCall[]).entries()) {
          toolCalls.push({
            id: typeof call?.id === "string" && call.id ? call.id : `call_${i}`,
            function: { name: String(call?.function?.name ?? ""), arguments: call?.function?.arguments ?? {} },
          });
        }
      }
      if (content && toolCalls.length === 0) onDelta?.(content);
      return {
        content,
        toolCalls,
        ...(message.reasoning_details !== undefined ? { reasoningDetails: message.reasoning_details } : {}),
      };
    },
  };
}

export interface OpenRouterHealth {
  reachable: boolean;
  modelAvailable: boolean;
}

let modelsCache: { at: number; ids: Set<string> } | undefined;
const MODELS_CACHE_MS = 10 * 60_000;

/** Health probe: is the API key accepted, and does the configured model exist and support tools? */
export async function checkOpenRouter(
  baseUrl: string,
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterHealth> {
  try {
    const keyRes = await fetchImpl(joinUrl(baseUrl, "key"), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!keyRes.ok) return { reachable: false, modelAvailable: false };

    if (!modelsCache || Date.now() - modelsCache.at > MODELS_CACHE_MS) {
      const modelsRes = await fetchImpl(joinUrl(baseUrl, "models"), { signal: AbortSignal.timeout(10_000) });
      if (!modelsRes.ok) return { reachable: true, modelAvailable: false };
      const list = (await modelsRes.json()) as { data?: { id?: string; supported_parameters?: string[] }[] };
      const ids = new Set(
        (list.data ?? []).filter((m) => m.supported_parameters?.includes("tools")).map((m) => m.id ?? ""),
      );
      modelsCache = { at: Date.now(), ids };
    }
    return { reachable: true, modelAvailable: modelsCache.ids.has(model) };
  } catch {
    return { reachable: false, modelAvailable: false };
  }
}
