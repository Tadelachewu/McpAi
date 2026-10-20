import { describe, expect, it } from "vitest";
import { CalculatorError } from "@/lib/calculator/errors";
import { evaluateExpression } from "@/lib/calculator/expression";
import { calculateExpression, factorial, logarithm, trigonometry } from "@/lib/calculator/operations";
import { calculatorTools, toolArgumentsSchema } from "@/lib/calculator/tools";

const deg = (expr: string) => evaluateExpression(expr, { angleUnit: "degrees" }).result;
const rad = (expr: string) => evaluateExpression(expr, { angleUnit: "radians" }).result;

function expectError(fn: () => unknown, code: CalculatorError["code"]) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CalculatorError);
    expect((error as CalculatorError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("scientific expressions", () => {
  it.each([
    ["sin(30)", "0.5"],
    ["cos(60)", "0.5"],
    ["tan(45)", "1"],
    ["sin(180)", "0"],
    ["cos(-90)", "0"],
    ["sin(270)", "-1"],
    ["asin(0.5)", "30"],
    ["acos(0)", "90"],
    ["atan(1)", "45"],
    ["sin(30)^2 + cos(30)^2", "1"],
  ])("degrees: %s = %s", (expr, expected) => {
    expect(deg(expr)).toBe(expected);
  });

  it.each([
    ["sin(pi)", "0"],
    ["cos(pi)", "-1"],
    ["sin(pi/6)", "0.5"],
    ["cos(pi/2)", "0"],
    ["atan(1)", "0.785398163397448"],
    ["sinh(0)", "0"],
    ["cosh(0)", "1"],
    ["tanh(1)", "0.761594155955765"],
  ])("radians: %s = %s", (expr, expected) => {
    expect(rad(expr)).toBe(expected);
  });

  it("defaults to radians", () => {
    expect(evaluateExpression("sin(pi/2)").result).toBe("1");
  });

  it.each([
    ["pi", "3.14159265358979"],
    ["π * 2", "6.28318530717959"],
    ["e", "2.71828182845905"],
    ["ln(e)", "1"],
    ["log(1000)", "3"],
    ["log10(0.01)", "-2"],
    ["log(8, 2)", "3"],
    ["log2(1024)", "10"],
    ["exp(0)", "1"],
    ["exp(1)", "2.71828182845905"],
    ["0!", "1"],
    ["5!", "120"],
    ["-3!", "-6"],
    ["2^3!", "64"],
    ["(2+3)!", "120"],
    ["3!!", "720"],
    ["nCr(5, 2)", "10"],
    ["nCr(52, 5)", "2598960"],
    ["nPr(5, 2)", "20"],
    ["cbrt(-27)", "-3"],
    ["∛(8)", "2"],
    ["root(16, 4)", "2"],
    ["root(-8, 3)", "-2"],
    ["abs(-4.5)", "4.5"],
    ["floor(-2.5)", "-3"],
    ["ceil(2.1)", "3"],
    ["round(2.5)", "3"],
    ["round(-2.5)", "-3"],
    ["SIN(0) + Cos(0)", "1"],
    ["arcsin(1)", "1.5707963267949"],
  ])("%s = %s", (expr, expected) => {
    expect(rad(expr)).toBe(expected);
  });

  it("normalizes function and constant names", () => {
    expect(evaluateExpression("√(16) + π").expression).toBe("sqrt(16) + pi");
    expect(evaluateExpression("NCR(5,2) + (1+2)!").expression).toBe("nCr(5, 2) + (1 + 2)!");
    expect(evaluateExpression("sin(1)").usesAngles).toBe(true);
    expect(evaluateExpression("sinh(1) + ln(2)").usesAngles).toBe(false);
  });

  it.each([
    ["tan(90)", "INVALID_OPERATION"],
    ["asin(2)", "INVALID_OPERATION"],
    ["acosh(0.5)", "INVALID_OPERATION"],
    ["atanh(1)", "INVALID_OPERATION"],
    ["ln(0)", "INVALID_OPERATION"],
    ["log(-1)", "INVALID_OPERATION"],
    ["log(8, 1)", "INVALID_OPERATION"],
    ["(-1)!", "INVALID_OPERATION"],
    ["2.5!", "INVALID_OPERATION"],
    ["171!", "OVERFLOW"],
    ["exp(1000)", "OVERFLOW"],
    ["cosh(1000)", "OVERFLOW"],
    ["root(-16, 2)", "INVALID_OPERATION"],
    ["root(2, 0)", "INVALID_OPERATION"],
    ["nCr(2, 5)", "INVALID_OPERATION"],
    ["sin(1e20)", "TOO_COMPLEX"],
  ] as const)("rejects %s (%s)", (expr, code) => {
    expectError(() => deg(expr), code);
  });

  it("flushes exp of very negative numbers to zero", () => {
    expect(rad("exp(-1000)")).toBe("0");
  });
});

describe("scientific tools", () => {
  it("trigonometry uses degrees by default through the tool handler", () => {
    expect(calculatorTools.trigonometry.handler({ function: "sin", value: 30 })).toMatchObject({ expression: "sin(30°)", result: "0.5" });
    expect(trigonometry("cos", Math.PI, "radians").result).toBe("-1");
    expect(trigonometry("asin", 0.5, "degrees")).toMatchObject({ expression: "asin(0.5) in degrees", result: "30" });
    expect(trigonometry("sinh", 0, "degrees").result).toBe("0");
  });

  it("logarithm defaults to base 10 and supports e", () => {
    expect(logarithm(1000)).toMatchObject({ expression: "log(1000)", result: "3" });
    expect(logarithm(8, 2)).toMatchObject({ expression: "log base 2 of 8", result: "3" });
    expect(logarithm(Math.E, "e").result).toBe("1");
  });

  it("factorial", () => {
    expect(factorial(5)).toMatchObject({ expression: "5!", result: "120" });
    expectError(() => factorial(-1), "INVALID_OPERATION");
  });

  it("calculate_expression defaults to degrees and labels the unit", () => {
    expect(calculatorTools.calculate_expression.handler({ expression: "sin(30)" })).toMatchObject({
      expression: "sin(30) [degrees]",
      result: "0.5",
    });
    expect(calculateExpression("sin(pi/2)", "radians").expression).toBe("sin(pi / 2) [radians]");
    expect(calculateExpression("2 + 2").expression).toBe("2 + 2");
  });

  it("validates tool arguments strictly", () => {
    expect(toolArgumentsSchema("trigonometry").safeParse({ function: "sin", value: 30, angle_unit: "degrees" }).success).toBe(true);
    expect(toolArgumentsSchema("trigonometry").safeParse({ function: "eval", value: 30 }).success).toBe(false);
    expect(toolArgumentsSchema("trigonometry").safeParse({ function: "sin", value: 30, angle_unit: "gradians" }).success).toBe(false);
    expect(toolArgumentsSchema("logarithm").safeParse({ value: 5, base: "e" }).success).toBe(true);
    expect(toolArgumentsSchema("logarithm").safeParse({ value: 5, base: "ten" }).success).toBe(false);
  });
});
