import DecimalBase from "decimal.js";
import { CalculatorError } from "./errors";

/**
 * Isolated Decimal constructor so we never mutate decimal.js global config.
 * 34 significant digits (IEEE 754 decimal128 precision) for intermediate work;
 * results are rounded to DISPLAY_SIGNIFICANT_DIGITS for presentation.
 */
export const Decimal = DecimalBase.clone({
  precision: 34,
  rounding: DecimalBase.ROUND_HALF_EVEN,
  toExpPos: 21,
  toExpNeg: -7,
});
export type Decimal = InstanceType<typeof Decimal>;

export const DISPLAY_SIGNIFICANT_DIGITS = 15;
/** Results must stay representable as a finite JS number (needed for JSON/structured output). */
export const MAX_ABS_RESULT = new Decimal("1e300");
/** Non-zero results smaller than this are flushed to zero to avoid denormal noise. */
export const MIN_ABS_RESULT = new Decimal("1e-300");

export function assertInRange(value: Decimal): Decimal {
  if (!value.isFinite()) {
    throw new CalculatorError("OVERFLOW", "The result is not a finite number.");
  }
  if (value.abs().gt(MAX_ABS_RESULT)) {
    throw new CalculatorError("OVERFLOW", "The result is too large (limit is ±1e300).");
  }
  if (!value.isZero() && value.abs().lt(MIN_ABS_RESULT)) {
    return new Decimal(0);
  }
  return value;
}

/** Converts a JS number to Decimal via its shortest string form, so 0.1 stays exactly 0.1. */
export function decimalFromNumber(value: number, label = "value"): Decimal {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CalculatorError("INVALID_INPUT", `${label} must be a finite number.`);
  }
  return new Decimal(value.toString());
}

/** Rounds to display precision and returns a clean string (no trailing zeros, no "-0"). */
export function formatDecimal(value: Decimal): string {
  const rounded = value.toSignificantDigits(DISPLAY_SIGNIFICANT_DIGITS);
  if (rounded.isZero()) return "0";
  return rounded.toString();
}
