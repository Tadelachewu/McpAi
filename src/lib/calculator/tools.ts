/**
 * Single source of truth for the calculator tools: names, metadata, Zod schemas and handlers.
 * The MCP server registers exactly these tools; the Next.js orchestrator uses the same schemas
 * as a second validation layer and as the allowlist of tools the model may call.
 */
import { z } from "zod";
import { FUNCTION_ARITY, MAX_EXPRESSION_LENGTH } from "./expression";
import { HYPERBOLIC_FUNCTIONS, TRIG_FUNCTIONS } from "./scientific";
import {
  add,
  calculateExpression,
  divide,
  factorial,
  logarithm,
  multiply,
  percentage,
  power,
  squareRoot,
  subtract,
  trigonometry,
  type CalculationResult,
} from "./operations";

const num = (description: string) => z.number().describe(description);

const angleUnit = z
  .enum(["degrees", "radians"])
  .optional()
  .describe('Unit for trigonometric angles: "degrees" (default) or "radians". Use radians when the input uses pi.');

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
      "Safely evaluate an arithmetic or scientific expression. Supports numbers (decimals and 1e5 notation), " +
      "+ - * / % (modulo) ^ (power), ! (factorial), parentheses, unary minus, the constants pi and e, and the functions " +
      `${Object.keys(FUNCTION_ARITY).join(", ")}. log(x) is base 10, log(x, b) is base b, ln is natural log, ` +
      "root(x, n) is the n-th root, nCr/nPr are combinations/permutations. Functions need parentheses and there is no " +
      "implicit multiplication (write 2*pi, not 2pi). Use this for any multi-step calculation, e.g. \"(100 + 50) * 4\".",
    inputSchema: {
      expression: z
        .string()
        .min(1)
        .max(MAX_EXPRESSION_LENGTH)
        .describe("Expression, e.g. \"(100 + 50) * 4\", \"sin(30)^2 + cos(30)^2\" or \"log(8, 2) + 5!\""),
      angle_unit: angleUnit,
    },
    handler: ({ expression, angle_unit }) => calculateExpression(expression, angle_unit ?? "degrees"),
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
  trigonometry: defineTool({
    title: "Trigonometry",
    description:
      "Trigonometric (sin, cos, tan, asin, acos, atan) and hyperbolic (sinh, cosh, tanh, asinh, acosh, atanh) functions " +
      "of one plain number. angle_unit applies to sin/cos/tan inputs and asin/acos/atan outputs; it is ignored for hyperbolic " +
      "functions. For pi, e or combined expressions (e.g. sin(pi/6) + 1) use calculate_expression instead.",
    inputSchema: {
      function: z.enum([...TRIG_FUNCTIONS, ...HYPERBOLIC_FUNCTIONS]).describe("The function to apply"),
      value: num("The angle (sin/cos/tan) or the input value"),
      angle_unit: angleUnit,
    },
    handler: (args) => trigonometry(args.function, args.value, args.angle_unit ?? "degrees"),
  }),
  logarithm: defineTool({
    title: "Logarithm",
    description: 'Logarithm of a positive number. base defaults to 10; use base "e" for the natural logarithm (ln).',
    inputSchema: {
      value: num("A positive number"),
      base: z
        .union([z.number(), z.literal("e")])
        .optional()
        .describe('The base: a positive number other than 1, or "e" for the natural log. Default 10.'),
    },
    handler: ({ value, base }) => logarithm(value, base ?? 10),
  }),
  factorial: defineTool({
    title: "Factorial",
    description: "n! for a whole number 0 ≤ n ≤ 170 (larger results exceed the ±1e300 limit).",
    inputSchema: { n: num("A non-negative whole number") },
    handler: ({ n }) => factorial(n),
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
