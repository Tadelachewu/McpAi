"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { MAX_MESSAGE_CHARS, MAX_REQUEST_MESSAGES, type ChatEvent } from "@/lib/chat-protocol";
import { readChatEvents } from "@/lib/client/chat-stream";

interface ToolActivity {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  state: "running" | "ok" | "error" | "rejected";
  text?: string;
}

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
  status?: string;
  tools: ToolActivity[];
  toolsUsed?: string[];
  verified?: boolean;
  fallback?: boolean;
  error?: string;
}

export interface ChatPanelHandle {
  ask: (prompt: string) => void;
}

const QUICK_PROMPTS = ["What is 15% of 800?", "Calculate (100 + 50) * 4", "What is the square root of 144?"];

let idCounter = 0;
const newId = () => `m${Date.now().toString(36)}${(idCounter++).toString(36)}`;

function formatArgs(args?: Record<string, unknown>): string {
  if (!args) return "";
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}`)
    .join(", ");
}

export const ChatPanel = forwardRef<ChatPanelHandle>(function ChatPanel(_props, ref) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const updateAssistant = useCallback((id: string, update: (m: UiMessage) => UiMessage) => {
    setMessages((all) => all.map((m) => (m.id === id ? update(m) : m)));
  }, []);

  const applyEvent = useCallback(
    (id: string, event: ChatEvent) => {
      updateAssistant(id, (m) => {
        switch (event.type) {
          case "status":
            return { ...m, status: event.message };
          case "delta":
            return { ...m, content: m.content + event.text, status: undefined };
          case "discard_draft":
            return { ...m, content: "" };
          case "tool_call":
            return {
              ...m,
              status: `Using ${event.name}…`,
              tools: [...m.tools, { id: event.id, name: event.name, args: event.arguments, state: "running" }],
            };
          case "tool_result": {
            const state: ToolActivity["state"] = !event.executed ? "rejected" : event.ok ? "ok" : "error";
            const exists = m.tools.some((t) => t.id === event.id);
            const tools = exists
              ? m.tools.map((t) => (t.id === event.id ? { ...t, state, text: event.text } : t))
              : [...m.tools, { id: event.id, name: event.name, state, text: event.text }];
            return { ...m, tools };
          }
          case "final":
            return {
              ...m,
              content: event.content,
              pending: false,
              status: undefined,
              toolsUsed: event.toolsUsed,
              verified: event.verified,
              fallback: event.fallback,
            };
          case "error":
            return { ...m, pending: false, status: undefined, error: event.message };
          default:
            return m;
        }
      });
    },
    [updateAssistant],
  );

  const send = useCallback(
    async (text: string) => {
      const content = text.trim().slice(0, MAX_MESSAGE_CHARS);
      if (!content || busy) return;

      const userMessage: UiMessage = { id: newId(), role: "user", content, tools: [] };
      const assistantId = newId();
      const assistantMessage: UiMessage = { id: assistantId, role: "assistant", content: "", pending: true, status: "Connecting…", tools: [] };

      // Only completed, successful turns are sent back as history (bounded).
      const history = messages
        .filter((m) => !m.pending && !m.error && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
      const payload = { messages: [...history, { role: "user" as const, content }].slice(-MAX_REQUEST_MESSAGES) };
      // The server requires the history to start cleanly; drop a leading assistant message if trimming caused one.
      if (payload.messages[0]?.role === "assistant") payload.messages.shift();

      setMessages((all) => [...all, userMessage, assistantMessage]);
      setDraft("");
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;
      let finished = false;
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          let message = `Request failed (HTTP ${response.status}).`;
          try {
            const data = (await response.json()) as { message?: string };
            if (data.message) message = data.message;
          } catch {
            // ignore
          }
          applyEvent(assistantId, { type: "error", code: "internal", message });
          finished = true;
          return;
        }
        for await (const event of readChatEvents(response.body)) {
          applyEvent(assistantId, event);
          if (event.type === "final" || event.type === "error") finished = true;
        }
        if (!finished) {
          applyEvent(assistantId, { type: "error", code: "internal", message: "The response ended unexpectedly." });
          finished = true;
        }
      } catch {
        if (!finished) {
          applyEvent(assistantId, {
            type: "error",
            code: controller.signal.aborted ? "cancelled" : "internal",
            message: controller.signal.aborted ? "Stopped." : "Could not reach the app server. Is `npm run dev` still running?",
          });
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [applyEvent, busy, messages],
  );

  useImperativeHandle(ref, () => ({ ask: (prompt: string) => void send(prompt) }), [send]);

  return (
    <section aria-labelledby="chat-heading" className="flex h-full min-h-[32rem] flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 id="chat-heading" className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          AI Assistant
        </h2>
        {messages.length > 0 && !busy && (
          <button type="button" onClick={() => setMessages([])} className="rounded px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200">
            New chat
          </button>
        )}
      </div>

      <div
        ref={listRef}
        className="flex-1 space-y-4 overflow-y-auto rounded-2xl border border-slate-700/60 bg-slate-950/50 p-4"
        aria-live="polite"
        aria-busy={busy}
      >
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 py-8 text-center">
            <p className="max-w-sm text-sm text-slate-400">
              Ask in plain language. The local <span className="font-mono text-slate-300">qwen3:8b</span> model chooses a calculator
              tool, the server runs it through MCP, and the answer is based on the tool&apos;s result.
            </p>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-sky-600 px-4 py-2 text-sm text-white">
                {m.content}
              </p>
            </div>
          ) : (
            <div key={m.id} className="flex flex-col items-start gap-2">
              {m.tools.length > 0 && (
                <ul className="flex w-full max-w-[90%] flex-col gap-1.5" aria-label="Tool activity">
                  {m.tools.map((t) => (
                    <li
                      key={t.id}
                      className={`rounded-lg border px-3 py-1.5 font-mono text-xs ${
                        t.state === "ok"
                          ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-200"
                          : t.state === "running"
                            ? "border-sky-500/30 bg-sky-500/5 text-sky-200"
                            : "border-amber-500/30 bg-amber-500/5 text-amber-200"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {t.state === "running" && (
                          <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" aria-hidden="true" />
                        )}
                        <span className="font-sans font-medium">
                          {t.state === "rejected" ? "Rejected (not executed):" : t.state === "running" ? "Using" : "Used"}
                        </span>
                        <span>
                          {t.name}({formatArgs(t.args)})
                        </span>
                      </div>
                      {t.text && <div className="mt-0.5 break-words text-slate-300">→ {t.text}</div>}
                    </li>
                  ))}
                </ul>
              )}

              {(m.content || m.pending) && !m.error && (
                <div className="max-w-[90%] rounded-2xl rounded-bl-sm border border-slate-700/60 bg-slate-800/70 px-4 py-2 text-sm text-slate-100">
                  {m.content ? (
                    <p className="whitespace-pre-wrap">{m.content}</p>
                  ) : (
                    <p className="flex items-center gap-2 text-slate-400">
                      <span className="flex gap-1" aria-hidden="true">
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
                      </span>
                      {m.status ?? "Working…"}
                    </p>
                  )}
                </div>
              )}

              {m.error && (
                <p role="alert" className="max-w-[90%] rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
                  {m.error}
                </p>
              )}

              {!m.pending && !m.error && (
                <p className="text-xs">
                  {m.fallback ? (
                    <span className="text-amber-300">⚠ AI unavailable — computed directly via MCP calculate_expression</span>
                  ) : m.verified ? (
                    <span className="text-emerald-400">✓ Verified by MCP tool: {[...new Set(m.toolsUsed)].join(", ")}</span>
                  ) : m.tools.some((t) => t.state === "error") ? (
                    <span className="text-amber-300">⚠ The MCP tool returned an error — no numeric result was produced</span>
                  ) : (
                    <span className="text-amber-300">⚠ No calculator tool was used — this answer is not tool-verified</span>
                  )}
                </p>
              )}
            </div>
          ),
        )}
      </div>

      <div className="flex flex-wrap gap-2" aria-label="Quick prompts">
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={busy}
            onClick={() => void send(prompt)}
            className="rounded-full border border-slate-600/70 bg-slate-800/60 px-3 py-1 text-xs text-slate-300 hover:border-sky-400/60 hover:text-sky-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {prompt}
          </button>
        ))}
      </div>

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <label htmlFor="chat-input" className="sr-only">
          Ask a calculation question
        </label>
        <textarea
          id="chat-input"
          ref={inputRef}
          value={draft}
          maxLength={MAX_MESSAGE_CHARS}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(draft);
            }
          }}
          placeholder="e.g. What is 125 times 24?  (Enter to send, Shift+Enter for new line)"
          className="min-h-12 flex-1 resize-none rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className="h-12 rounded-xl bg-rose-500/20 px-4 text-sm font-medium text-rose-200 ring-1 ring-inset ring-rose-400/40 hover:bg-rose-500/30"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!draft.trim()}
            className="h-12 rounded-xl bg-sky-500 px-4 text-sm font-semibold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        )}
      </form>
    </section>
  );
});
