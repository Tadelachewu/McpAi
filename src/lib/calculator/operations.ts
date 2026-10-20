/**
 * Pure calculator operations used as MCP tool handlers. They take plain numbers (as received
 * from validated JSON), compute with Decimal, and return a uniform, serializable result.
 */
import { Decimal, assertInRange, decimalFromNumber, formatDecimal } from "./decimal";
import { CalculatorError } from "./errors";
import { decimalPower, decimalSqrt, evaluateExpression } from "./expression";
import {
  HYPERBOLIC_FUNCTIONS,
  decimalFactorial,
  decimalHyperbolic,
  decimalLn,
  decimalLog,
  decimalTrig,
  type AngleUnit,
  type HyperbolicFunction,
  type TrigFunction,
} from "./scientific";

export interface CalculationResult {
  /** Tool/operation name, e.g. "add". */
  operation: string;
  /** Human-readable calculation that was performed, e.g. "15% of 800". */
  expression: string;
  /** Exact result rounded to display precision, as a string. */
  result: string;
  /** Result as a JS number. */
  value: number;
}

function finish(operation: string, expression: string, value: Decimal): CalculationResult {
  const result = formatDecimal(assertInRange(value));
  return { operation, expression, result, value: Number(result) };
}

function fmt(n: number): string {
  return formatDecimal(decimalFromNumber(n));
}

function signed(n: number): string {
  return n < 0 ? `(${fmt(n)})` : fmt(n);
}

export function add(a: number, b: number): CalculationResult {
  return finish("add", `${fmt(a)} + ${signed(b)}`, decimalFromNumber(a, "a").plus(decimalFromNumber(b, "b")));
}

export function subtract(a: number, b: number): CalculationResult {
  return finish("subtract", `${fmt(a)} - ${signed(b)}`, decimalFromNumber(a, "a").minus(decimalFromNumber(b, "b")));
}

export function multiply(a: number, b: number): CalculationResult {
  return finish("multiply", `${fmt(a)} × ${signed(b)}`, decimalFromNumber(a, "a").times(decimalFromNumber(b, "b")));
}

export function divide(a: number, b: number): CalculationResult {
  const divisor = decimalFromNumber(b, "b");
  if (divisor.isZero()) {
    throw new CalculatorError("DIVISION_BY_ZERO", "Division by zero is undefined.");
  }
  return finish("divide", `${fmt(a)} ÷ ${signed(b)}`, decimalFromNumber(a, "a").dividedBy(divisor));
}

/** percent% of value, e.g. percentage(800, 15) = 120. */
export function percentage(value: number, percent: number): CalculationResult {
  return finish(
    "percentage",
    `${fmt(percent)}% of ${fmt(value)}`,
    decimalFromNumber(value, "value").times(decimalFromNumber(percent, "percent")).dividedBy(100),
  );
}

export function power(base: number, exponent: number): CalculationResult {
  return finish(
    "power",
    `${signed(base)} ^ ${signed(exponent)}`,
    decimalPower(decimalFromNumber(base, "base"), decimalFromNumber(exponent, "exponent")),
  );
}

export function squareRoot(value: number): CalculationResult {
  return finish("square_root", `√${signed(value)}`, decimalSqrt(decimalFromNumber(value, "value")));
}

export function calculateExpression(expression: string, angleUnit: AngleUnit = "radians"): CalculationResult {
  const evaluated = evaluateExpression(expression, { angleUnit });
  return {
    operation: "calculate_expression",
    expression: evaluated.usesAngles ? `${evaluated.expression} [${angleUnit}]` : evaluated.expression,
    result: evaluated.result,
    value: evaluated.value,
  };
}

export type ScientificFunction = TrigFunction | HyperbolicFunction;

/** sin/cos/tan/asin/acos/atan (angle unit applies) and the hyperbolic functions (unit ignored). */
export function trigonometry(fn: ScientificFunction, value: number, angleUnit: AngleUnit = "radians"): CalculationResult {
  const x = decimalFromNumber(value, "value");
  if ((HYPERBOLIC_FUNCTIONS as readonly string[]).includes(fn)) {
    return finish("trigonometry", `${fn}(${fmt(value)})`, decimalHyperbolic(fn as HyperbolicFunction, x));
  }
  const label = fn.startsWith("a")
    ? `${fn}(${fmt(value)}) in ${angleUnit}`
    : `${fn}(${fmt(value)}${angleUnit === "degrees" ? "°" : " rad"})`;
  return finish("trigonometry", label, decimalTrig(fn as TrigFunction, x, angleUnit));
}

/** Logarithm of value; base defaults to 10, "e" means natural logarithm. */
export function logarithm(value: number, base: number | "e" = 10): CalculationResult {
  const x = decimalFromNumber(value, "value");
  if (base === "e") return finish("logarithm", `ln(${fmt(value)})`, decimalLn(x));
  const label = base === 10 ? `log(${fmt(value)})` : `log base ${fmt(base)} of ${fmt(value)}`;
  return finish("logarithm", label, decimalLog(x, decimalFromNumber(base, "base")));
}

export function factorial(n: number): CalculationResult {
  return finish("factorial", `${signed(n)}!`, decimalFactorial(decimalFromNumber(n, "n")));
}

