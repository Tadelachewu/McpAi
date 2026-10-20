# AI Calculator: Next.js + Ollama (qwen3:8b) + MCP

A calculator web app with a normal keypad and an AI chat assistant. The assistant runs on your **local**
Ollama `qwen3:8b` model. It never does arithmetic itself: it calls calculator tools, and the server runs
those tools through a **real MCP client** connected to a **separate MCP server process** (official
`@modelcontextprotocol/sdk`, stdio transport).

## Architecture

```
Browser (React UI)
  │  POST /api/chat (JSON, ≤64 KB)  →  NDJSON event stream (status, tool_call, tool_result, delta, final, error)
  ▼
Next.js server (Node runtime, 127.0.0.1 only)
  ├─ request guard: localhost Host, same-origin, size limit, Zod validation, concurrency limit
  ├─ agent loop (src/lib/server/agent.ts)
  │    Ollama /api/chat (qwen3:8b, native tool calling, streaming)
  │      → tool_calls → allowlist + Zod validation → MCP client tools/call → tool result → Ollama …
  │      (bounded: MAX_TOOL_ITERATIONS rounds, MAX_TOOL_CALLS_PER_TURN calls per round, timeouts)
  └─ MCP client (src/lib/server/mcp-client.ts)
         │ spawns automatically on first use, stdio JSON-RPC
         ▼
     MCP calculator server (mcp-server/, separate Node process)
         └─ 8 tools, Zod input/output schemas, pure calculator code (no shell, files or network)

Shared, dependency-free calculator engine (src/lib/calculator/) is used by both the keypad (in the browser)
and the MCP tools. There are no circular dependencies: the engine imports nothing from the app or the server.
```

**Roles**

| Part | Role |
|---|---|
| **Next.js** | Serves the UI; the server-side route validates requests and orchestrates the model and tools. Ollama and MCP are reachable only from the server. |
| **Ollama / qwen3:8b** | Understands the natural-language request and decides *which* tool to call with *which* arguments, then writes the final sentence from the tool's result. |
| **MCP client** | Lives in the Next.js server. Spawns the MCP server, lists its tools (which become the model's tool definitions) and executes `tools/call`. |
| **MCP server** | Separate process exposing the calculator tools over the Model Context Protocol, with its own validation. |
| **Calculator tools** | Deterministic Decimal arithmetic: the only source of numeric results. |

## File tree

```
mcp-server/
  index.ts              stdio entry point (npm run mcp:server)
  server.ts             McpServer + registerTool for each calculator tool
src/
  app/
    page.tsx, layout.tsx, globals.css
    api/chat/route.ts   POST: validation, guards, NDJSON streaming, runs the agent
    api/health/route.ts GET: Ollama/model/MCP status (no URLs or secrets)
  components/
    CalculatorApp.tsx   layout + status pills
    Calculator.tsx      keypad, display, keyboard input, history
    ChatPanel.tsx       chat, quick prompts, tool activity, Stop button
  lib/
    calculator/         SHARED: tokenizer/parser/evaluator (expression.ts), operations.ts,
                        tools.ts (tool names, Zod schemas, handlers), decimal.ts, errors.ts
    chat-protocol.ts    request schema + stream event types
    client/chat-stream.ts  NDJSON reader for the browser
    server/             config.ts, agent.ts, ollama.ts, mcp-client.ts, request-guard.ts
tests/
  unit/                 parser, tool handlers, agent loop (fake model), Ollama client (mocked fetch), validation
  integration/          mcp.test.ts (real MCP protocol, in-memory + real stdio child process)
                        ollama.test.ts (REAL Ollama; gated by RUN_OLLAMA_TESTS=1)
```

## MCP tools

| Tool | Arguments | Notes |
|---|---|---|
| `calculate_expression` | `expression: string` (1–500 chars) | `+ - * / % ^ ( )`, unary minus, decimals, `1e5`, `sqrt(x)`. `%` is **modulo** here. |
| `add` / `subtract` / `multiply` | `a: number, b: number` | |
| `divide` | `a: number, b: number` | `b = 0` → error |
| `percentage` | `value: number, percent: number` | `percentage(800, 15)` = 120 ("15% of 800") |
| `power` | `base: number, exponent: number` | \|exponent\| ≤ 10000; a negative base needs an integer exponent |
| `square_root` | `value: number` | negative → error (no complex numbers) |

Every tool returns a text result (`"15% of 800 = 120"`) **and** `structuredContent`
`{ operation, expression, result, value }` validated against an `outputSchema`. Errors are returned as
`isError: true` with a safe message.

## Setup and run (Windows PowerShell)

Prerequisites: Node.js ≥ 20.19 (tested with 24.12, npm 11.19), Ollama running locally (tested with 0.40.6).

```powershell
cd C:\Users\HP\Desktop\McpAi
ollama pull qwen3:8b              # once; already installed on this machine
npm install
Copy-Item .env.example .env.local # optional: the defaults work without it
npm run dev
```

Open **http://127.0.0.1:3000** (http://localhost:3000 also works).

**One terminal is enough.** You don't start the MCP server yourself: the Next.js server launches it
as a child process over stdio on the first request, reconnects if it dies, and it exits when Next.js
stops. Ollama has to be running already (the Ollama tray app or `ollama serve`).

Production mode:

```powershell
npm run build
npm start                          # http://127.0.0.1:3000
```

### npm scripts

| Script | What it does |
|---|---|
| `npm run dev` / `npm start` | Next.js on 127.0.0.1:3000 (dev / production) |
| `npm run mcp:server` | Run the MCP server standalone on stdio (for manual testing; Next.js doesn't need it) |
| `npm run mcp:inspect` | Open the MCP Inspector against the server |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint |
| `npm test` | Unit + MCP integration tests (no Ollama needed) |
| `npm run test:ollama` | **Real** Ollama + qwen3:8b + MCP end-to-end tests (needs Ollama running) |
| `npm run check` | typecheck, lint, test and build |

## Configuration (`.env.local`, server-side only)

See `.env.example`. None of these are `NEXT_PUBLIC_`, so none of them reach the browser. The app has no secrets.

| Variable | Default | |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | |
| `OLLAMA_MODEL` | `qwen3:8b` | Must support tool calling |
| `OLLAMA_TIMEOUT_MS` | `180000` | Per model call; the first call may need time to load the model |
| `OLLAMA_THINK` | `false` | qwen3 thinking mode (slower; reasoning is never shown) |
| `OLLAMA_KEEP_ALIVE` | `10m` | |
| `MAX_TOOL_ITERATIONS` | `5` | Model rounds per request (1–10) |
| `MAX_TOOL_CALLS_PER_TURN` | `4` | |
| `MCP_TOOL_TIMEOUT_MS` / `MCP_CONNECT_TIMEOUT_MS` | `10000` / `30000` | |
| `ALLOW_NON_LOCAL_REQUESTS` | `false` | See Security |

## AI behavior

- Tool definitions come from the MCP server's `tools/list`, filtered by an allowlist.
- Each model tool call is checked server-side before it reaches MCP: the tool name must be allowlisted
  and offered, the arguments must be a JSON object that passes the strict Zod schema (unknown keys are
  rejected), and at most `MAX_TOOL_CALLS_PER_TURN` calls are allowed per turn. Rejected calls are fed
  back to the model as errors and shown in the UI as "Rejected (not executed)". The MCP server then
  validates the arguments again.
- If the model answers an arithmetic-looking question without calling a tool, the server asks it once to use a tool.
- The UI badge comes from what the server actually executed, not from the model's text:
  **✓ Verified by MCP tool: …**, **⚠ The MCP tool returned an error**, or **⚠ No calculator tool was used**.
- Errors are surfaced clearly: Ollama unreachable, model not installed, model without tool support,
  timeout, Stop/cancel, malformed stream, MCP failure, iteration limit.
- **Fallback (documented):** when Ollama is unreachable, the model is missing, or the model doesn't
  support tools, *and* the message is a plain expression (e.g. `What is (2+3)*4?`), the server computes
  it directly with the `calculate_expression` MCP tool. The answer is labeled "AI unavailable — computed
  directly via MCP". Anything else gets an error message instead.
- Tool calling was **verified for real** on this machine (Ollama 0.40.6, qwen3:8b returns native `tool_calls`).

## Numeric behavior and limitations

- Arithmetic uses `decimal.js` (34 significant digits internally), so `0.1 + 0.2 = 0.3`. Results are rounded
  to **15 significant digits** (`1/3 = 0.333333333333333`).
- Results must stay within ±1e300. Smaller than 1e-300 becomes 0. Very large or small values use exponent notation (`1e+25`).
- Limits: 500 characters, 250 tokens, nesting depth 32, \|exponent\| ≤ 10000.
- `%` in expressions is modulo, truncated so the sign follows the dividend (`-7 % 3 = -1`). Use the `percentage` tool or natural language ("15% of 800") for percentages.
- `-2^2 = -4` (power binds tighter than unary minus) and `2^3^2 = 512` (right-associative).
- No implicit multiplication (`2(3)` is rejected), no thousands separators, no complex numbers.

## Tests

```powershell
npm test               # 115 tests: parser, tool handlers, agent loop, Ollama client, validation, real MCP (in-memory + stdio)
npm run test:ollama    # 6 tests against REAL Ollama/qwen3:8b + real MCP stdio server (~100 s)
```

Unit tests mock only external dependencies (the Ollama HTTP API and, in the agent tests, the model).
The MCP integration tests use the real SDK client and server. `tests/integration/ollama.test.ts` uses the real model.

## Verifying MCP with the MCP Inspector

```powershell
npm run mcp:inspect
```

This downloads and runs `@modelcontextprotocol/inspector` (it needs internet access the first time) and
opens a browser UI. Click **Connect**, then **Tools → List Tools** to see the 8 tools and their schemas.
Pick `percentage`, enter `value=800, percent=15`, and click **Run Tool**: the result is `15% of 800 = 120`
with `structuredContent`. Try `divide` with `b=0` to see the `isError` result.

Without the Inspector, the tool-activity entries in the chat UI show every real `tools/call` with its arguments and result.

## Security

Defaults are for **local development only**:

- Next.js binds to `127.0.0.1` (`-H 127.0.0.1`). The API rejects requests whose `Host` isn't localhost
  (DNS-rebinding protection) and cross-origin requests (`Origin` must match `Host`).
- Ollama and MCP are reachable only from the Next.js server. The browser never sees their URLs or config.
- Request body ≤ 64 KB; ≤ 20 messages of ≤ 2000 characters each, and only `user`/`assistant` roles are
  accepted (clients can't inject system or tool messages). Only the last 12 messages reach the model.
  At most 2 AI requests run at once.
- No `eval`/`new Function`. The MCP server has no shell, file or network access. The child process is
  spawned with a fixed command and a minimal environment.
- Prompts aren't logged or stored, and chat and calculator history live only in browser memory.

**Before exposing this on a network** (e.g. `next start -H 0.0.0.0` with `ALLOW_NON_LOCAL_REQUESTS=true`), you need at least:
authentication, per-user rate limiting, HTTPS (reverse proxy), CSRF protection beyond the Origin check,
resource quotas (one request can keep the GPU busy for minutes), and a decision about whether other people
may use your local model. Also keep Ollama itself bound to 127.0.0.1 (its default).

`npm audit` currently reports a high-severity advisory in `braces`, pulled in only through the ESLint
toolchain (`eslint-config-next → fast-glob → micromatch`). It's dev-only and not part of the running app.
Runtime dependencies audit clean (`npm audit --omit=dev`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Status pill "Ollama offline" / "Cannot reach Ollama" | Start the Ollama app or run `ollama serve`. Check `Invoke-RestMethod http://127.0.0.1:11434/api/version`. |
| "qwen3:8b not installed" | `ollama pull qwen3:8b`, or set `OLLAMA_MODEL` |
| First answer is slow or times out | The model is loading into memory (can take 30–60 s or more). Retry, or raise `OLLAMA_TIMEOUT_MS`. |
| "does not support tool calling" | Use a tool-capable model (qwen3, llama3.1+, …). The fallback still computes plain expressions. |
| "MCP server error" | Run `npm install` (it needs `node_modules/tsx`). Run `npm run mcp:server` to see startup errors. |
| Port 3000 in use | `Get-NetTCPConnection -LocalPort 3000` to find the process, or change `-p` in the npm scripts |
| 403 "only accepts requests on localhost" | Open http://127.0.0.1:3000 or http://localhost:3000, not the machine's LAN IP. |
| "Another AI request is still running" | Wait, or press Stop. At most 2 requests run concurrently. |
| `npm install` warns about install scripts (esbuild, unrs-resolver) | Harmless here (`tsx` works without them). To allow them: `npm install-scripts approve esbuild`. |
| Answer marked "No calculator tool was used" | The model answered without a tool even after being reminded. Rephrase as a calculation. |
