import { describe, expect, it } from "vitest";
import { CalculatorError } from "@/lib/calculator/errors";
import { evaluateExpression, tryEvaluateExpression, MAX_EXPRESSION_LENGTH, MAX_NESTING_DEPTH } from "@/lib/calculator/expression";

const calc = (expr: string) => evaluateExpression(expr).result;

function expectError(expr: string, code: CalculatorError["code"]) {
  try {
    evaluateExpression(expr);
  } catch (error) {
    expect(error).toBeInstanceOf(CalculatorError);
    expect((error as CalculatorError).code).toBe(code);
    return;
  }
  throw new Error(`Expected "${expr}" to throw ${code}`);
}

describe("evaluateExpression: arithmetic", () => {
  it.each([
    ["125 * 24", "3000"],
    ["(100 + 50) * 4", "600"],
    ["sqrt(144)", "12"],
    ["1 + 2 * 3", "7"],
    ["(1 + 2) * 3", "9"],
    ["10 - 4 - 3", "3"],
    ["100 / 10 / 5", "2"],
    ["7 % 3", "1"],
    ["-7 % 3", "-1"],
    ["2 ^ 10", "1024"],
    ["2 ^ 3 ^ 2", "512"],
    ["-2 ^ 2", "-4"],
    ["(-2) ^ 2", "4"],
    ["2 ^ -1", "0.5"],
    ["--5", "5"],
    ["-(3 + 2)", "-5"],
    ["+4", "4"],
    ["3.5 * 2", "7"],
    [".5 + .25", "0.75"],
    ["1e3 + 1", "1001"],
    ["1/3", "0.333333333333333"],
    ["2/3", "0.666666666666667"],
    ["  8   /  ( 3 - 1 ) ", "4"],
    ["√(16) + 1", "5"],
    ["6 × 7 ÷ 2 − 1", "20"],
    ["2 ** 8", "256"],
    ["sqrt(2)", "1.4142135623731"],
  ])("%s = %s", (expr, expected) => {
    expect(calc(expr)).toBe(expected);
  });

  it("avoids binary floating-point surprises", () => {
    expect(calc("0.1 + 0.2")).toBe("0.3");
    expect(calc("1.1 * 1.1")).toBe("1.21");
    expect(calc("0.3 - 0.1")).toBe("0.2");
  });

  it("returns a normalized expression and numeric value", () => {
    const r = evaluateExpression("(100+50)*4");
    expect(r).toEqual({ expression: "(100 + 50) * 4", result: "600", value: 600, usesAngles: false });
  });

  it("formats very large and very small numbers", () => {
    expect(calc("10 ^ 25")).toBe("1e+25");
    expect(calc("1 / 10 ^ 8")).toBe("1e-8");
    expect(calc("0 * -5")).toBe("0");
  });
});

describe("evaluateExpression: errors", () => {
  it("rejects division and modulo by zero", () => {
    expectError("5 / 0", "DIVISION_BY_ZERO");
    expectError("5 / (2 - 2)", "DIVISION_BY_ZERO");
    expectError("5 % 0", "MODULO_BY_ZERO");
    expectError("0 ^ -1", "DIVISION_BY_ZERO");
  });

  it.each([
    ["", "EMPTY_EXPRESSION"],
    ["   ", "EMPTY_EXPRESSION"],
    ["2 +", "UNEXPECTED_END"],
    ["* 2", "UNEXPECTED_TOKEN"],
    ["2 * * 3", "UNEXPECTED_TOKEN"],
    ["(2 + 3", "MISMATCHED_PARENTHESES"],
    ["2 + 3)", "MISMATCHED_PARENTHESES"],
    ["()", "UNEXPECTED_TOKEN"],
    ["2(3)", "UNEXPECTED_TOKEN"],
    ["1.2.3", "INVALID_NUMBER"],
    ["5e", "INVALID_NUMBER"],
    ["1,000", "UNEXPECTED_TOKEN"],
    ["sin 30", "UNEXPECTED_TOKEN"],
    ["log(1, 2, 3)", "UNEXPECTED_TOKEN"],
    ["2pi", "UNEXPECTED_TOKEN"],
    ["sqrt 4", "UNEXPECTED_TOKEN"],
  ] as const)("rejects %j (%s)", (expr, code) => {
    expectError(expr, code);
  });

  it.each(["alert(1)", "process.exit()", "2 + x", "Math.PI", "1; 2", "2 & 3", "constructor", "0x10", "toString(1)", "__proto__"])(
    "rejects unsupported tokens in %j",
    (expr) => {
      expectError(expr, "INVALID_CHARACTER");
    },
  );

  it("rejects invalid math", () => {
    expectError("sqrt(-4)", "INVALID_OPERATION");
    expectError("(-8) ^ 0.5", "INVALID_OPERATION");
  });

  it("caps length, nesting and exponent size", () => {
    expectError("1+".repeat(MAX_EXPRESSION_LENGTH), "EXPRESSION_TOO_LONG");
    expectError("(".repeat(MAX_NESTING_DEPTH + 1) + "1" + ")".repeat(MAX_NESTING_DEPTH + 1), "TOO_COMPLEX");
    expectError("-".repeat(MAX_NESTING_DEPTH + 1) + "1", "TOO_COMPLEX");
    expectError("2 ^ 100000", "TOO_COMPLEX");
    expectError("10 ^ 400", "OVERFLOW");
    expectError("9 ^ 9 ^ 9", "TOO_COMPLEX");
    expectError("1e400", "OVERFLOW");
    expectError("1".repeat(65), "INVALID_NUMBER");
  });

  it("tryEvaluateExpression never throws", () => {
    expect(tryEvaluateExpression("1 +")).toMatchObject({ ok: false });
    expect(tryEvaluateExpression("1 + 1")).toMatchObject({ ok: true, value: { result: "2" } });
    // @ts-expect-error runtime guard against non-strings
    expect(tryEvaluateExpression(42)).toMatchObject({ ok: false });
  });
});
