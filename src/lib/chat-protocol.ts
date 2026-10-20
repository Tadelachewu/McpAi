/**
 * Wire protocol between the browser and POST /api/chat.
 * Request: JSON body validated by ChatRequestSchema.
 * Response: NDJSON stream of ChatEvent objects (one JSON object per line).
 */
import { z } from "zod";

export const MAX_MESSAGE_CHARS = 2_000;
export const MAX_REQUEST_MESSAGES = 20;
/** How many of the most recent messages are actually forwarded to the model. */
export const MAX_MODEL_HISTORY = 12;
export const MAX_REQUEST_BYTES = 64 * 1024;

export const ChatMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  })
  .strict();

export const ChatRequestSchema = z
  .object({
    messages: z.array(ChatMessageSchema).min(1).max(MAX_REQUEST_MESSAGES),
  })
  .strict()
  .refine((body) => body.messages[body.messages.length - 1]?.role === "user", {
    message: "The last message must be from the user.",
    path: ["messages"],
  });

export type ChatMessageInput = z.infer<typeof ChatMessageSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export type ChatErrorCode =
  | "bad_request"
  | "forbidden"
  | "busy"
  | "ollama_unavailable"
  | "model_missing"
  | "tools_unsupported"
  | "timeout"
  | "cancelled"
  | "model_error"
  | "mcp_unavailable"
  | "max_iterations"
  | "internal";

export type ChatEvent =
  | { type: "status"; message: string }
  /** Incremental assistant text for the current model turn. */
  | { type: "delta"; text: string }
  /** The streamed draft turned out to be a tool-calling turn (or was rejected); clear it. */
  | { type: "discard_draft" }
  /** A tool call is about to be executed through the MCP client. */
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  /**
   * Outcome of a tool call. `executed` is false when the server rejected the call before it reached
   * the MCP server (unknown tool, invalid arguments, limit exceeded).
   */
  | { type: "tool_result"; id: string; name: string; ok: boolean; executed: boolean; text: string; result?: string }
  | {
      type: "final";
      content: string;
      /** Names of tools that actually ran successfully during this response. */
      toolsUsed: string[];
      /** True when the answer is backed by at least one successful tool call. */
      verified: boolean;
      /** True when the AI was unavailable and the server computed the expression directly via MCP. */
      fallback?: boolean;
    }
  | { type: "error"; code: ChatErrorCode; message: string };
