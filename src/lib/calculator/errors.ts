export type CalculatorErrorCode =
  | "EMPTY_EXPRESSION"
  | "EXPRESSION_TOO_LONG"
  | "INVALID_CHARACTER"
  | "INVALID_NUMBER"
  | "UNEXPECTED_TOKEN"
  | "UNEXPECTED_END"
  | "MISMATCHED_PARENTHESES"
  | "TOO_COMPLEX"
  | "DIVISION_BY_ZERO"
  | "MODULO_BY_ZERO"
  | "INVALID_OPERATION"
  | "OVERFLOW"
  | "INVALID_INPUT";

/** Error raised for any user-facing calculation problem. Messages are safe to show to users. */
export class CalculatorError extends Error {
  readonly code: CalculatorErrorCode;
  /** Character offset in the source expression, when applicable. */
  readonly position?: number;

  constructor(code: CalculatorErrorCode, message: string, position?: number) {
    super(message);
    this.name = "CalculatorError";
    this.code = code;
    this.position = position;
  }
}

export function isCalculatorError(error: unknown): error is CalculatorError {
  return error instanceof CalculatorError;
}
