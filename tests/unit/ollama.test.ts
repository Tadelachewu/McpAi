/** Unit tests for the Ollama client with a mocked fetch (Ollama itself is an external dependency). */
import { describe, expect, it } from "vitest";
import { createOllamaChatModel, OllamaError, visibleText, checkOllama } from "@/lib/server/ollama";

function ndjson(lines: unknown[], status = 200): Response {
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return new Response(body, { status, headers: { "Content-Type": "application/x-ndjson" } });
}

function modelWith(fetchImpl: typeof fetch, timeoutMs = 5_000) {
  return createOllamaChatModel({ host: "http://127.0.0.1:11434", model: "qwen3:8b", timeoutMs, think: false, fetchImpl });
}

async function expectOllamaError(promise: Promise<unknown>, code: OllamaError["code"]) {
  await expect(promise).rejects.toSatisfy((e: unknown) => e instanceof OllamaError && e.code === code);
}

describe("Ollama chat client", () => {
  it("sends model, tools and think flag; parses streamed content", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return ndjson([
        { message: { role: "assistant", content: "15% of " } },
        { message: { role: "assistant", content: "800 = 120" } },
        { message: { role: "assistant", content: "" }, done: true },
      ]);
    }) as unknown as typeof fetch;
    const deltas: string[] = [];
    const turn = await modelWith(fetchImpl).chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "add", description: "", parameters: {} } }],
      onDelta: (t) => deltas.push(t),
    });
    expect(sent).toMatchObject({ model: "qwen3:8b", stream: true, think: false });
    expect(sent.tools).toHaveLength(1);
    expect(turn).toEqual({ content: "15% of 800 = 120", toolCalls: [] });
    expect(deltas.join("")).toBe("15% of 800 = 120");
  });

  it("collects tool calls", async () => {
    const fetchImpl = (async () =>
      ndjson([
        { message: { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "multiply", arguments: { a: 125, b: 24 } } }] } },
        { message: { role: "assistant", content: "" }, done: true },
      ])) as unknown as typeof fetch;
    const turn = await modelWith(fetchImpl).chat({ messages: [] });
    expect(turn.toolCalls).toEqual([{ id: "c1", function: { name: "multiply", arguments: { a: 125, b: 24 } } }]);
  });

  it("hides <think> blocks", async () => {
    expect(visibleText("<think>secret</think>Answer")).toBe("Answer");
    expect(visibleText("Answer<think>partial")).toBe("Answer");
    expect(visibleText("Answer <thi")).toBe("Answer ");
  });

  it("classifies connection failures as unavailable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expectOllamaError(modelWith(fetchImpl).chat({ messages: [] }), "unavailable");
  });

  it("classifies missing model and unsupported tools", async () => {
    const missing = (async () => Response.json({ error: "model 'qwen3:8b' not found" }, { status: 404 })) as unknown as typeof fetch;
    await expectOllamaError(modelWith(missing).chat({ messages: [] }), "model_missing");
    const noTools = (async () => Response.json({ error: "registry.ollama.ai/library/x does not support tools" }, { status: 400 })) as unknown as typeof fetch;
    await expectOllamaError(modelWith(noTools).chat({ messages: [] }), "tools_unsupported");
  });

  it("rejects malformed streams and truncated responses", async () => {
    const bad = (async () => new Response("not json\n")) as unknown as typeof fetch;
    await expectOllamaError(modelWith(bad).chat({ messages: [] }), "bad_response");
    const truncated = (async () => ndjson([{ message: { content: "hi" } }])) as unknown as typeof fetch;
    await expectOllamaError(modelWith(truncated).chat({ messages: [] }), "bad_response");
  });

  it("times out and distinguishes user cancellation", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    await expectOllamaError(modelWith(hang, 1_000).chat({ messages: [] }), "timeout");

    const controller = new AbortController();
    const pending = modelWith(hang, 10_000).chat({ messages: [], signal: controller.signal });
    controller.abort();
    await expectOllamaError(pending, "cancelled");
  });

  it("health check reports unreachable hosts", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkOllama("http://127.0.0.1:11434", "qwen3:8b", down)).toEqual({ reachable: false, modelAvailable: false });
  });
});
