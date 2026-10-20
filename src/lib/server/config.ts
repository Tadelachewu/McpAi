/**
 * Server-only configuration. These variables are read on the server and are never sent to the
 * browser; do NOT prefix any of them with NEXT_PUBLIC_.
 */
import { z } from "zod";

const boolFromEnv = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const ConfigSchema = z.object({
  OLLAMA_HOST: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().min(1).max(200).default("qwen3:8b"),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(180_000),
  OLLAMA_THINK: boolFromEnv.default(false),
  OLLAMA_KEEP_ALIVE: z.string().max(20).default("10m"),
  MAX_TOOL_ITERATIONS: z.coerce.number().int().min(1).max(10).default(5),
  MAX_TOOL_CALLS_PER_TURN: z.coerce.number().int().min(1).max(10).default(4),
  MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  MCP_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  /** Allow requests whose Host header is not localhost. Keep false unless you've read SECURITY in README. */
  ALLOW_NON_LOCAL_REQUESTS: boolFromEnv.default(false),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let cached: AppConfig | undefined;

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached && env === process.env) return cached;
  const raw = Object.fromEntries(
    Object.keys(ConfigSchema.shape).map((key) => [key, env[key] === "" ? undefined : env[key]]),
  );
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // Report only which keys are wrong, never their values.
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`Invalid server configuration in environment variables: ${keys}`);
  }
  if (env === process.env) cached = parsed.data;
  return parsed.data;
}
