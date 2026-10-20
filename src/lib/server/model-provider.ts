/** Picks the chat model: OpenRouter if OPENROUTER_API_KEY is set, otherwise local Ollama. */
import { getAiProvider, type AppConfig } from "./config";
import { createOllamaChatModel, type ChatModel } from "./ollama";
import { createOpenRouterChatModel } from "./openrouter";

export function createChatModel(config: AppConfig): ChatModel {
  if (getAiProvider(config) === "openrouter") {
    return createOpenRouterChatModel({
      baseUrl: config.OPENROUTER_BASE_URL,
      apiKey: config.OPENROUTER_API_KEY!.trim(),
      model: config.OPENROUTER_MODEL,
      timeoutMs: config.OPENROUTER_TIMEOUT_MS,
      reasoning: config.OPENROUTER_REASONING,
    });
  }
  return createOllamaChatModel({
    host: config.OLLAMA_HOST,
    model: config.OLLAMA_MODEL,
    timeoutMs: config.OLLAMA_TIMEOUT_MS,
    think: config.OLLAMA_THINK,
    keepAlive: config.OLLAMA_KEEP_ALIVE,
  });
}
