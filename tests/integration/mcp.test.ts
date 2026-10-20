/**
 * INTEGRATION (no external services needed): real MCP protocol between the official SDK client
 * and our MCP server — first over an in-memory transport, then over stdio with a real child process
 * spawned exactly the way the Next.js server does it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createCalculatorServer } from "../../mcp-server/server";
import { connectCalculatorMcp, type CalculatorMcpClient } from "@/lib/server/mcp-client";

const EXPECTED_TOOLS = ["add", "calculate_expression", "divide", "multiply", "percentage", "power", "square_root", "subtract"];

describe("MCP server over in-memory transport", () => {
  let client: Client;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createCalculatorServer().connect(serverTransport);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists tools with input/output schemas and annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    const divide = tools.find((t) => t.name === "divide")!;
    expect(divide.description).toMatch(/zero/i);
    expect(divide.inputSchema).toMatchObject({ type: "object", required: ["a", "b"], properties: { a: { type: "number" }, b: { type: "number" } } });
    expect(divide.outputSchema).toMatchObject({ type: "object", properties: { result: { type: "string" } } });
    expect(divide.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it("calls tools and returns text + structured content", async () => {
    const result = (await client.callTool({ name: "calculate_expression", arguments: { expression: "(100 + 50) * 4" } })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "(100 + 50) * 4 = 600" }]);
    expect(result.structuredContent).toEqual({ operation: "calculate_expression", expression: "(100 + 50) * 4", result: "600", value: 600 });
  });

  it("returns tool errors for invalid input and math errors", async () => {
    const zero = (await client.callTool({ name: "divide", arguments: { a: 1, b: 0 } })) as CallToolResult;
    expect(zero.isError).toBe(true);
    expect(zero.content[0]).toMatchObject({ text: expect.stringContaining("Division by zero") });

    const badArgs = (await client.callTool({ name: "add", arguments: { a: "one", b: 2 } })) as CallToolResult;
    expect(badArgs.isError).toBe(true);
    expect(badArgs.content[0]).toMatchObject({ text: expect.stringMatching(/validation/i) });

    const badExpr = (await client.callTool({ name: "calculate_expression", arguments: { expression: "require('fs')" } })) as CallToolResult;
    expect(badExpr.isError).toBe(true);
  });

  it("rejects unknown tools", async () => {
    const result = (await client.callTool({ name: "exec", arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
  });
});

describe("MCP server over stdio (spawned child process, as used by Next.js)", () => {
  let mcp: CalculatorMcpClient;

  beforeAll(async () => {
    mcp = await connectCalculatorMcp({ connectTimeoutMs: 30_000 });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("lists the allowlisted tools", async () => {
    expect((await mcp.listTools()).map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it.each([
    ["multiply", { a: 125, b: 24 }, "3000"],
    ["percentage", { value: 800, percent: 15 }, "120"],
    ["calculate_expression", { expression: "(100 + 50) * 4" }, "600"],
    ["square_root", { value: 144 }, "12"],
  ])("%s(%j) = %s", async (name, args, expected) => {
    const outcome = await mcp.callTool(name, args);
    expect(outcome.ok).toBe(true);
    expect(outcome.structured?.result).toBe(expected);
  });

  it("returns a safe error for division by zero", async () => {
    expect(await mcp.callTool("divide", { a: 10, b: 0 })).toMatchObject({ ok: false, text: "Error: Division by zero is undefined." });
  });

  it("refuses non-allowlisted tool names client-side", async () => {
    expect(await mcp.callTool("delete_files", {})).toMatchObject({ ok: false, text: expect.stringContaining("not permitted") });
  });
});
