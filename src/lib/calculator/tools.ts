/**
 * Single source of truth for the calculator tools: names, metadata, Zod schemas and handlers.
 * The MCP server registers exactly these tools; the Next.js orchestrator uses the same schemas
 * as a second validation layer and as the allowlist of tools the model may call.
 */
import { z } from "zod";
import { MAX_EXPRESSION_LENGTH } from "./expression";
import {
  add,
  calculateExpression,
  divide,
  multiply,
  percentage,
  power,
  squareRoot,
  subtract,
  type CalculationResult,
} from "./operations";

const num = (description: string) => z.number().describe(description);

export const calculationOutputShape = {
  operation: z.string().describe("Name of the operation that was performed"),
  expression: z.string().describe("The calculation that was performed, in readable form"),
  result: z.string().describe("Exact result rounded to 15 significant digits, as a decimal string"),
  value: z.number().describe("The result as a number"),
};

interface ToolDefinition<Shape extends z.ZodRawShape> {
  title: string;
  description: string;
  inputSchema: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>) => CalculationResult;
}

function defineTool<Shape extends z.ZodRawShape>(def: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return def;
}

export const calculatorTools = {
  calculate_expression: defineTool({
    title: "Calculate expression",
    description:
      "Safely evaluate an arithmetic expression. Supports numbers (decimals and 1e5 notation), + - * / % (modulo) ^ (power), " +
      "parentheses, unary minus and sqrt(x). Use this for any multi-step calculation, e.g. \"(100 + 50) * 4\".",
    inputSchema: {
      expression: z
        .string()
        .min(1)
        .max(MAX_EXPRESSION_LENGTH)
        .describe("Arithmetic expression, e.g. \"(100 + 50) * 4\" or \"2^10 - sqrt(144)\""),
    },
    handler: ({ expression }) => calculateExpression(expression),
  }),
  add: defineTool({
    title: "Add",
    description: "Add two numbers: a + b.",
    inputSchema: { a: num("First addend"), b: num("Second addend") },
    handler: ({ a, b }) => add(a, b),
  }),
  subtract: defineTool({
    title: "Subtract",
    description: "Subtract b from a: a - b.",
    inputSchema: { a: num("Minuend"), b: num("Subtrahend") },
    handler: ({ a, b }) => subtract(a, b),
  }),
  multiply: defineTool({
    title: "Multiply",
    description: "Multiply two numbers: a × b.",
    inputSchema: { a: num("First factor"), b: num("Second factor") },
    handler: ({ a, b }) => multiply(a, b),
  }),
  divide: defineTool({
    title: "Divide",
    description: "Divide a by b: a ÷ b. Division by zero is rejected with an error.",
    inputSchema: { a: num("Dividend"), b: num("Divisor (must not be zero)") },
    handler: ({ a, b }) => divide(a, b),
  }),
  percentage: defineTool({
    title: "Percentage",
    description: "Compute percent% of value, e.g. \"15% of 800\" is percentage(value=800, percent=15) = 120.",
    inputSchema: { value: num("The whole amount (e.g. 800)"), percent: num("The percentage (e.g. 15 for 15%)") },
    handler: ({ value, percent }) => percentage(value, percent),
  }),
  power: defineTool({
    title: "Power",
    description: "Raise base to exponent: base ^ exponent. |exponent| must be ≤ 10000; negative bases need integer exponents.",
    inputSchema: { base: num("The base"), exponent: num("The exponent") },
    handler: ({ base, exponent }) => power(base, exponent),
  }),
  square_root: defineTool({
    title: "Square root",
    description: "Square root of a non-negative number. Negative inputs are rejected (complex numbers are not supported).",
    inputSchema: { value: num("A non-negative number") },
    handler: ({ value }) => squareRoot(value),
  }),
} as const;

export type CalculatorToolName = keyof typeof calculatorTools;

export const CALCULATOR_TOOL_NAMES = Object.keys(calculatorTools) as CalculatorToolName[];

export function isCalculatorToolName(name: unknown): name is CalculatorToolName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(calculatorTools, name);
}

/** Strict Zod object schema for a tool's arguments (unknown keys rejected). */
export function toolArgumentsSchema(name: CalculatorToolName) {
  return z.object(calculatorTools[name].inputSchema as z.ZodRawShape).strict();
}

/** Formats a calculation result as the text content returned to the model. */
export function formatCalculationText(result: CalculationResult): string {
  return `${result.expression} = ${result.result}`;
}
