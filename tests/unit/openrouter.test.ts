/** Unit tests for the OpenRouter client and provider selection, with a mocked fetch. */
import { describe, expect, it } from "vitest";
import { getAiProvider, getConfig } from "@/lib/server/config";
import { OllamaError } from "@/lib/server/ollama";
import { createOpenRouterChatModel, toOpenAiMessages } from "@/lib/server/openrouter";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function modelWith(fetchImpl: typeof fetch) {
  return createOpenRouterChatModel({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-test",
    model: "google/gemma-4-31b-it:free",
    timeoutMs: 5_000,
    reasoning: true,
    fetchImpl,
  });
}

async function expectError(promise: Promise<unknown>, code: OllamaError["code"]) {
  await expect(promise).rejects.toSatisfy((e: unknown) => e instanceof OllamaError && e.code === code);
}

describe("provider selection", () => {
  it("uses Ollama without a key and OpenRouter with one", () => {
    expect(getAiProvider(getConfig({} as unknown as NodeJS.ProcessEnv))).toBe("ollama");
    expect(getAiProvider(getConfig({ OPENROUTER_API_KEY: "" } as unknown as NodeJS.ProcessEnv))).toBe("ollama");
    expect(getAiProvider(getConfig({ OPENROUTER_API_KEY: "sk-x" } as unknown as NodeJS.ProcessEnv))).toBe("openrouter");
  });
});

describe("OpenRouter chat client", () => {
  it("sends auth, model, tools and reasoning; returns tool calls and reasoning_details", async () => {
    let sentUrl = "";
    let sent: Record<string, unknown> = {};
    let auth = "";
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sentUrl = url;
      sent = JSON.parse(init.body as string);
      auth = (init.headers as Record<string, string>).Authorization ?? "";
      return json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "t1", type: "function", function: { name: "percentage", arguments: '{"value":800,"percent":15}' } }],
              reasoning_details: [{ type: "reasoning.text", text: "use percentage" }],
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    const turn = await modelWith(fetchImpl).chat({
      messages: [{ role: "user", content: "15% of 800" }],
      tools: [{ type: "function", function: { name: "percentage", description: "", parameters: {} } }],
    });
    expect(sentUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(auth).toBe("Bearer sk-test");
    expect(sent).toMatchObject({ model: "google/gemma-4-31b-it:free", reasoning: { enabled: true }, stream: false });
    expect(sent.tools).toHaveLength(1);
    expect(turn.content).toBe("");
    expect(turn.toolCalls).toEqual([{ id: "t1", function: { name: "percentage", arguments: '{"value":800,"percent":15}' } }]);
    expect(turn.reasoningDetails).toEqual([{ type: "reasoning.text", text: "use percentage" }]);
  });

  it("converts history to OpenAI format, preserving reasoning_details and tool ids", () => {
    const out = toOpenAiMessages([
      { role: "user", content: "2*3" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "t1", function: { name: "multiply", arguments: { a: 2, b: 3 } } }],
        reasoning_details: [{ type: "reasoning.encrypted", data: "x" }],
      },
      { role: "tool", tool_name: "multiply", tool_call_id: "t1", content: "2 × 3 = 6" },
    ]);
    expect(out[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t1", type: "function", function: { name: "multiply", arguments: '{"a":2,"b":3}' } }],
      reasoning_details: [{ type: "reasoning.encrypted", data: "x" }],
    });
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "t1", content: "2 × 3 = 6" });
  });

  it("classifies errors", async () => {
    const respond = (status: number, message: string) =>
      (async () => json({ error: { code: status, message } }, status)) as unknown as typeof fetch;
    await expectError(modelWith(respond(401, "No auth credentials found")).chat({ messages: [] }), "unavailable");
    await expectError(modelWith(respond(404, "No endpoints found that support tool use")).chat({ messages: [] }), "tools_unsupported");
    await expectError(modelWith(respond(400, "foo is not a valid model ID")).chat({ messages: [] }), "model_missing");
    await expectError(modelWith(respond(429, "Rate limit exceeded")).chat({ messages: [] }), "http_error");
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expectError(modelWith(offline).chat({ messages: [] }), "unavailable");
  });
});
