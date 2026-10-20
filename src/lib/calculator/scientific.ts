/**
 * Scientific functions on Decimal: trigonometry (degrees or radians), hyperbolic functions,
 * logarithms, exponentials, roots, rounding, factorial and combinatorics.
 * Every function validates its domain and throws CalculatorError with a user-safe message.
 */
import { Decimal, assertInRange } from "./decimal";
import { CalculatorError } from "./errors";

export type AngleUnit = "degrees" | "radians";

export const DECIMAL_PI = Decimal.acos(-1);
export const DECIMAL_E = Decimal.exp(1);

/** Results this close to zero are rounding noise (e.g. sin(pi) ≈ 1e-34) and are snapped to 0. */
const EPSILON = new Decimal("1e-30");
/** Larger angles lose all meaningful precision after range reduction. */
const MAX_ANGLE = new Decimal("1e15");
/** exp/sinh/cosh beyond this exceed the ±1e300 result limit. */
const MAX_EXP_ARG = 700;
export const MAX_FACTORIAL = 170;
const MAX_COMBINATORIC_STEPS = 100_000;

export const TRIG_FUNCTIONS = ["sin", "cos", "tan", "asin", "acos", "atan"] as const;
export const HYPERBOLIC_FUNCTIONS = ["sinh", "cosh", "tanh", "asinh", "acosh", "atanh"] as const;
export type TrigFunction = (typeof TRIG_FUNCTIONS)[number];
export type HyperbolicFunction = (typeof HYPERBOLIC_FUNCTIONS)[number];

const snap = (x: Decimal): Decimal => (x.abs().lt(EPSILON) ? new Decimal(0) : x);

function invalid(message: string): never {
  throw new CalculatorError("INVALID_OPERATION", message);
}

function requireInteger(x: Decimal, what: string): void {
  if (!x.isInteger()) invalid(`${what} must be a whole number.`);
}

/** sin, cos, tan with exact results at multiples of 90° and an error where tan is undefined. */
function forwardTrig(fn: "sin" | "cos" | "tan", x: Decimal, unit: AngleUnit): Decimal {
  if (x.abs().gt(MAX_ANGLE)) {
    throw new CalculatorError("TOO_COMPLEX", "The angle is too large (max |angle| is 1e15).");
  }
  let radians: Decimal;
  if (unit === "degrees") {
    const reduced = x.mod(360);
    if (reduced.mod(90).isZero()) {
      const quarter = ((reduced.dividedBy(90).toNumber() % 4) + 4) % 4;
      if (fn === "sin") return new Decimal([0, 1, 0, -1][quarter]!);
      if (fn === "cos") return new Decimal([1, 0, -1, 0][quarter]!);
      if (quarter % 2 === 1) invalid(`tan(${x.toString()}°) is undefined.`);
      return new Decimal(0);
    }
    radians = reduced.times(DECIMAL_PI).dividedBy(180);
  } else {
    radians = x;
  }
  if (fn === "sin") return snap(radians.sin());
  if (fn === "cos") return snap(radians.cos());
  const cos = radians.cos();
  if (cos.abs().lt(EPSILON)) invalid(`tan is undefined at this angle (an odd multiple of π/2).`);
  return snap(radians.sin().dividedBy(cos));
}

export function decimalTrig(fn: TrigFunction, x: Decimal, unit: AngleUnit): Decimal {
  if (fn === "sin" || fn === "cos" || fn === "tan") return forwardTrig(fn, x, unit);
  if ((fn === "asin" || fn === "acos") && x.abs().gt(1)) {
    invalid(`${fn} is only defined for values between -1 and 1.`);
  }
  const radians = fn === "asin" ? x.asin() : fn === "acos" ? x.acos() : x.atan();
  return snap(unit === "degrees" ? radians.times(180).dividedBy(DECIMAL_PI) : radians);
}

export function decimalHyperbolic(fn: HyperbolicFunction, x: Decimal): Decimal {
  switch (fn) {
    case "sinh":
    case "cosh":
      if (x.abs().gt(MAX_EXP_ARG)) throw new CalculatorError("OVERFLOW", "The result is too large (limit is ±1e300).");
      return assertInRange(fn === "sinh" ? x.sinh() : x.cosh());
    case "tanh":
      return x.tanh();
    case "asinh":
      return x.asinh();
    case "acosh":
      if (x.lt(1)) invalid("acosh is only defined for values ≥ 1.");
      return x.acosh();
    case "atanh":
      if (x.abs().gte(1)) invalid("atanh is only defined for values strictly between -1 and 1.");
      return x.atanh();
  }
}

export function decimalLn(x: Decimal): Decimal {
  if (!x.isPositive() || x.isZero()) invalid("The logarithm is only defined for positive numbers.");
  return x.ln();
}

export function decimalLog(x: Decimal, base: Decimal = new Decimal(10)): Decimal {
  if (!x.isPositive() || x.isZero()) invalid("The logarithm is only defined for positive numbers.");
  if (!base.isPositive() || base.isZero() || base.eq(1)) invalid("The logarithm base must be positive and not equal to 1.");
  return base.eq(10) ? x.log(10) : x.ln().dividedBy(base.ln());
}

export function decimalExp(x: Decimal): Decimal {
  if (x.gt(MAX_EXP_ARG)) throw new CalculatorError("OVERFLOW", "The result is too large (limit is ±1e300).");
  if (x.lt(-MAX_EXP_ARG)) return new Decimal(0);
  return assertInRange(x.exp());
}

export function decimalCbrt(x: Decimal): Decimal {
  return x.cbrt();
}

/** n-th root; negative x is allowed only for odd integer n. */
export function decimalRoot(x: Decimal, n: Decimal, power: (base: Decimal, exponent: Decimal) => Decimal): Decimal {
  if (n.isZero()) invalid("The 0th root is undefined.");
  if (x.isNegative()) {
    if (!n.isInteger() || n.mod(2).isZero()) {
      invalid("An even or fractional root of a negative number is not a real number.");
    }
    return power(x.abs(), new Decimal(1).dividedBy(n)).negated();
  }
  return power(x, new Decimal(1).dividedBy(n));
}

export function decimalRound(fn: "floor" | "ceil" | "round" | "abs", x: Decimal): Decimal {
  switch (fn) {
    case "floor":
      return x.floor();
    case "ceil":
      return x.ceil();
    case "round":
      // Half away from zero, as people expect: round(2.5) = 3, round(-2.5) = -3.
      return x.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    case "abs":
      return x.abs();
  }
}

export function decimalFactorial(n: Decimal): Decimal {
  requireInteger(n, "The factorial argument");
  if (n.isNegative()) invalid("The factorial is only defined for non-negative whole numbers.");
  if (n.gt(MAX_FACTORIAL)) throw new CalculatorError("OVERFLOW", "The result is too large (limit is ±1e300).");
  let result = new Decimal(1);
  for (let i = 2; i <= n.toNumber(); i++) result = result.times(i);
  return assertInRange(result);
}

function checkCombinatoricArgs(name: string, n: Decimal, r: Decimal): void {
  requireInteger(n, `${name}: n`);
  requireInteger(r, `${name}: r`);
  if (n.isNegative() || r.isNegative()) invalid(`${name} needs non-negative n and r.`);
  if (r.gt(n)) invalid(`${name} needs r ≤ n.`);
}

/** Permutations: n! / (n - r)! */
export function decimalPermutations(n: Decimal, r: Decimal): Decimal {
  checkCombinatoricArgs("nPr", n, r);
  if (r.gt(MAX_COMBINATORIC_STEPS)) throw new CalculatorError("OVERFLOW", "The result is too large (limit is ±1e300).");
  let result = new Decimal(1);
  for (let i = 0; i < r.toNumber(); i++) result = assertInRange(result.times(n.minus(i)));
  return result;
}

/** Combinations: n! / (r! (n - r)!) */
export function decimalCombinations(n: Decimal, r: Decimal): Decimal {
  checkCombinatoricArgs("nCr", n, r);
  const k = Decimal.min(r, n.minus(r));
  if (k.gt(MAX_COMBINATORIC_STEPS)) throw new CalculatorError("TOO_COMPLEX", "The combination is too large to compute.");
  let result = new Decimal(1);
  for (let i = 1; i <= k.toNumber(); i++) {
    result = assertInRange(result.times(n.minus(k).plus(i)).dividedBy(i));
  }
  return result.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}
