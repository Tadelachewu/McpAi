import { describe, expect, it } from "vitest";
import { CalculatorError } from "@/lib/calculator/errors";
import * as ops from "@/lib/calculator/operations";
import { calculatorTools, isCalculatorToolName, toolArgumentsSchema } from "@/lib/calculator/tools";
import { runCalculatorTool } from "../../mcp-server/server";

describe("tool handlers (operations)", () => {
  it("add / subtract / multiply / divide", () => {
    expect(ops.add(0.1, 0.2)).toEqual({ operation: "add", expression: "0.1 + 0.2", result: "0.3", value: 0.3 });
    expect(ops.subtract(10, -5)).toMatchObject({ expression: "10 - (-5)", result: "15" });
    expect(ops.multiply(125, 24)).toMatchObject({ expression: "125 × 24", result: "3000", value: 3000 });
    expect(ops.divide(1, 4)).toMatchObject({ result: "0.25" });
  });

  it("percentage: 15% of 800 = 120", () => {
    expect(ops.percentage(800, 15)).toEqual({ operation: "percentage", expression: "15% of 800", result: "120", value: 120 });
    expect(ops.percentage(19.99, 7.5).result).toBe("1.49925");
  });

  it("power and square_root", () => {
    expect(ops.power(2, 10).result).toBe("1024");
    expect(ops.power(-2, 3).result).toBe("-8");
    expect(ops.squareRoot(144)).toMatchObject({ expression: "√144", result: "12" });
    expect(ops.squareRoot(0).result).toBe("0");
  });

  it("calculate_expression", () => {
    expect(ops.calculateExpression("(100 + 50) * 4")).toMatchObject({ operation: "calculate_expression", result: "600" });
  });

  it("rejects invalid inputs with CalculatorError", () => {
    expect(() => ops.divide(5, 0)).toThrowError(CalculatorError);
    expect(() => ops.squareRoot(-1)).toThrowError(/negative/);
    expect(() => ops.power(-8, 0.5)).toThrowError(/fractional/);
    expect(() => ops.power(10, 400)).toThrowError(/too large/);
    expect(() => ops.add(Number.NaN, 1)).toThrowError(/finite/);
    expect(() => ops.multiply(Number.POSITIVE_INFINITY, 1)).toThrowError(/finite/);
    expect(() => ops.multiply(1e200, 1e200)).toThrowError(/too large/);
  });
});

describe("tool registry & schemas", () => {
  it("exposes exactly the documented tools", () => {
    expect(Object.keys(calculatorTools).sort()).toEqual(
      ["add", "calculate_expression", "divide", "factorial", "logarithm", "multiply", "percentage", "power", "square_root", "subtract", "trigonometry"].sort(),
    );
    expect(isCalculatorToolName("add")).toBe(true);
    expect(isCalculatorToolName("toString")).toBe(false);
    expect(isCalculatorToolName("run_shell")).toBe(false);
  });

  it("validates arguments strictly", () => {
    expect(toolArgumentsSchema("add").safeParse({ a: 1, b: 2 }).success).toBe(true);
    expect(toolArgumentsSchema("add").safeParse({ a: "1", b: 2 }).success).toBe(false);
    expect(toolArgumentsSchema("add").safeParse({ a: 1 }).success).toBe(false);
    expect(toolArgumentsSchema("add").safeParse({ a: 1, b: 2, c: 3 }).success).toBe(false);
    expect(toolArgumentsSchema("divide").safeParse({ a: 1, b: Infinity }).success).toBe(false);
    expect(toolArgumentsSchema("calculate_expression").safeParse({ expression: "" }).success).toBe(false);
    expect(toolArgumentsSchema("calculate_expression").safeParse({ expression: "x".repeat(501) }).success).toBe(false);
  });
});

describe("MCP tool result formatting", () => {
  it("returns text + structuredContent on success", () => {
    const result = runCalculatorTool((a) => ops.percentage(a.value as number, a.percent as number), { value: 800, percent: 15 });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "15% of 800 = 120" }]);
    expect(result.structuredContent).toMatchObject({ result: "120", value: 120 });
  });

  it("returns isError with a safe message on calculator errors", () => {
    const result = runCalculatorTool((a) => ops.divide(a.a as number, a.b as number), { a: 1, b: 0 });
    expect(result).toEqual({ content: [{ type: "text", text: "Error: Division by zero is undefined." }], isError: true });
  });

  it("hides unexpected internal errors", () => {
    const result = runCalculatorTool(() => {
      throw new Error("secret internal detail");
    }, {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
