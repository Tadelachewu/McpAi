/**
 * Minimal Ollama /api/chat client with native tool calling and NDJSON streaming.
 * Verified against Ollama 0.40.x with qwen3:8b (tool calls arrive in message.tool_calls).
 */

export type OllamaErrorCode =
  | "unavailable"
  | "model_missing"
  | "tools_unsupported"
  | "timeout"
  | "cancelled"
  | "bad_response"
  | "http_error";

export class OllamaError extends Error {
  readonly code: OllamaErrorCode;
  constructor(code: OllamaErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OllamaError";
    this.code = code;
  }
}

export interface OllamaToolCall {
  id?: string;
  function: { name: string; arguments: unknown };
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  tool_call_id?: string;
}

export interface OllamaTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatTurn {
  content: string;
  toolCalls: OllamaToolCall[];
}

export interface ChatParams {
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  signal?: AbortSignal;
  /** Called with incremental visible assistant text while streaming. */
  onDelta?: (text: string) => void;
}

export interface ChatModel {
  readonly model: string;
  chat(params: ChatParams): Promise<ChatTurn>;
}

export interface OllamaOptions {
  host: string;
  model: string;
  timeoutMs: number;
  think: boolean;
  keepAlive?: string;
  fetchImpl?: typeof fetch;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** Removes <think>…</think> reasoning blocks (complete or still open) from model text. */
export function visibleText(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = text.indexOf(THINK_OPEN);
  if (open !== -1) text = text.slice(0, open);
  // Hold back a trailing partial "<think>" prefix so it never flashes in the UI.
  for (let n = THINK_OPEN.length - 1; n > 0; n--) {
    if (text.endsWith(THINK_OPEN.slice(0, n))) {
      text = text.slice(0, -n);
      break;
    }
  }
  return text.replace(THINK_CLOSE, "");
}

function joinUrl(host: string, pathname: string): string {
  return new URL(pathname, host.endsWith("/") ? host : `${host}/`).toString();
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") return parsed.error;
    } catch {
      // not JSON
    }
    return text;
  } catch {
    return "";
  }
}

function classifyHttpError(status: number, body: string, model: string): OllamaError {
  const lower = body.toLowerCase();
  if (lower.includes("does not support tools")) {
    return new OllamaError("tools_unsupported", `The Ollama model "${model}" does not support tool calling.`);
  }
  if (status === 404 || (lower.includes("model") && lower.includes("not found"))) {
    return new OllamaError(
      "model_missing",
      `The Ollama model "${model}" is not installed. Run: ollama pull ${model}`,
    );
  }
  return new OllamaError("http_error", `Ollama returned HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
}

export function createOllamaChatModel(options: OllamaOptions): ChatModel {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = joinUrl(options.host, "/api/chat");

  return {
    model: options.model,
    async chat({ messages, tools, signal, onDelta }: ChatParams): Promise<ChatTurn> {
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      const abortError = (cause?: unknown): OllamaError =>
        signal?.aborted
          ? new OllamaError("cancelled", "The request was cancelled.", { cause })
          : new OllamaError(
              "timeout",
              `Ollama did not finish within ${Math.round(options.timeoutMs / 1000)} s. The model may still be loading; try again.`,
              { cause },
            );

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: options.model,
            messages,
            ...(tools && tools.length > 0 ? { tools } : {}),
            stream: true,
            think: options.think,
            keep_alive: options.keepAlive,
            options: { temperature: 0 },
          }),
          signal: combined,
        });
      } catch (error) {
        if (combined.aborted) throw abortError(error);
        throw new OllamaError(
          "unavailable",
          `Cannot reach Ollama at ${options.host}. Make sure Ollama is running ("ollama serve" or the Ollama app).`,
          { cause: error },
        );
      }

      if (!response.ok) {
        throw classifyHttpError(response.status, await readErrorBody(response), options.model);
      }
      if (!response.body) {
        throw new OllamaError("bad_response", "Ollama returned an empty response.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let rawContent = "";
      let emitted = "";
      const toolCalls: OllamaToolCall[] = [];
      let done = false;

      const handleLine = (line: string): void => {
        if (!line.trim()) return;
        let chunk: {
          message?: { content?: unknown; tool_calls?: unknown };
          done?: boolean;
          error?: unknown;
        };
        try {
          chunk = JSON.parse(line);
        } catch {
          throw new OllamaError("bad_response", "Ollama sent malformed streaming data.");
        }
        if (typeof chunk.error === "string") {
          throw classifyHttpError(500, chunk.error, options.model);
        }
        const message = chunk.message;
        if (message) {
          if (typeof message.content === "string" && message.content) {
            rawContent += message.content;
            const visible = visibleText(rawContent);
            if (visible.length > emitted.length && visible.startsWith(emitted)) {
              onDelta?.(visible.slice(emitted.length));
              emitted = visible;
            }
          }
          if (Array.isArray(message.tool_calls)) {
            for (const call of message.tool_calls as OllamaToolCall[]) toolCalls.push(call);
          }
        }
        if (chunk.done) done = true;
      };

      try {
        while (true) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            handleLine(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
        }
        buffer += decoder.decode();
        handleLine(buffer);
      } catch (error) {
        if (error instanceof OllamaError) throw error;
        if (combined.aborted) throw abortError(error);
        throw new OllamaError("bad_response", "The connection to Ollama was interrupted.", { cause: error });
      } finally {
        reader.releaseLock();
      }

      if (!done) {
        throw new OllamaError("bad_response", "Ollama ended the response unexpectedly.");
      }
      return { content: visibleText(rawContent).trim(), toolCalls };
    },
  };
}

export interface OllamaHealth {
  reachable: boolean;
  version?: string;
  modelAvailable: boolean;
}

/** Lightweight health probe: is Ollama up, and is the configured model installed? */
export async function checkOllama(host: string, model: string, fetchImpl: typeof fetch = fetch): Promise<OllamaHealth> {
  try {
    const [versionRes, tagsRes] = await Promise.all([
      fetchImpl(joinUrl(host, "/api/version"), { signal: AbortSignal.timeout(3_000) }),
      fetchImpl(joinUrl(host, "/api/tags"), { signal: AbortSignal.timeout(3_000) }),
    ]);
    const version = versionRes.ok ? ((await versionRes.json()) as { version?: string }).version : undefined;
    const tags = tagsRes.ok ? ((await tagsRes.json()) as { models?: { name?: string; model?: string }[] }) : {};
    const wanted = model.includes(":") ? model : `${model}:latest`;
    const modelAvailable = (tags.models ?? []).some((m) => m.name === wanted || m.model === wanted);
    return { reachable: true, version, modelAvailable };
  } catch {
    return { reachable: false, modelAvailable: false };
  }
}
