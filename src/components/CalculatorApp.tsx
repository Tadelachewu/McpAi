"use client";

import { useEffect, useRef, useState } from "react";
import type { HealthResponse } from "@/app/api/health/route";
import { Calculator } from "./Calculator";
import { ChatPanel, type ChatPanelHandle } from "./ChatPanel";

function StatusPill({ ok, label, title }: { ok: boolean | null; label: string; title?: string }) {
  const color = ok === null ? "bg-slate-500" : ok ? "bg-emerald-400" : "bg-rose-400";
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/70 bg-slate-900/70 px-2.5 py-1 text-xs text-slate-300"
    >
      <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function CalculatorApp() {
  const chatRef = useRef<ChatPanelHandle>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<HealthResponse>) : Promise.reject(new Error(String(r.status)))))
      .then((data) => !cancelled && setHealth(data))
      .catch(() => !cancelled && setHealthError(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const ollamaOk = health ? health.ollama.reachable && health.ollama.modelAvailable : healthError ? false : null;
  const mcpOk = health ? health.mcp.connected : healthError ? false : null;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-10">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">AI Calculator</h1>
          <p className="mt-1 text-sm text-slate-400">Local qwen3:8b via Ollama · calculations executed by MCP tools</p>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Service status">
          <StatusPill
            ok={ollamaOk}
            label={
              health
                ? !health.ollama.reachable
                  ? "Ollama offline"
                  : health.ollama.modelAvailable
                    ? `Ollama · ${health.ollama.model}`
                    : `${health.ollama.model} not installed`
                : healthError
                  ? "Status unavailable"
                  : "Checking Ollama…"
            }
            title={health?.ollama.version ? `Ollama ${health.ollama.version}` : undefined}
          />
          <StatusPill
            ok={mcpOk}
            label={health ? (health.mcp.connected ? `MCP · ${health.mcp.tools.length} tools` : "MCP server error") : "Checking MCP…"}
            title={health?.mcp.connected ? health.mcp.tools.join(", ") : health?.mcp.error}
          />
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="rounded-3xl border border-slate-700/50 bg-slate-900/60 p-4 shadow-2xl shadow-black/30 backdrop-blur sm:p-5">
          <Calculator onAskAi={(expression) => chatRef.current?.ask(`Calculate ${expression}`)} />
        </div>
        <div className="rounded-3xl border border-slate-700/50 bg-slate-900/60 p-4 shadow-2xl shadow-black/30 backdrop-blur sm:p-5 lg:h-[calc(100dvh-12rem)] lg:min-h-[36rem]">
          <ChatPanel ref={chatRef} />
        </div>
      </div>

      <footer className="text-center text-xs text-slate-500">
        Results use decimal arithmetic rounded to 15 significant digits. The AI never computes on its own: answers marked
        “Verified” come from an MCP tool result.
      </footer>
    </main>
  );
}
