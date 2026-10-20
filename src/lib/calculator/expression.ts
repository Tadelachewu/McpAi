/**
 * Safe arithmetic expression engine: tokenizer -> recursive-descent parser -> AST -> Decimal evaluator.
 * No eval()/new Function(). Grammar (lowest to highest precedence):
 *
 *   expression := term (("+" | "-") term)*
 *   term       := unary (("*" | "/" | "%") unary)*        % is modulo
 *   unary      := ("-" | "+") unary | power
 *   power      := primary ("^" unary)?                      right-associative; -2^2 = -4
 *   primary    := NUMBER | "(" expression ")" | "sqrt" "(" expression ")"
 *
 * Aliases accepted: × * ÷ / − - ** ^ √ sqrt, and "," is NOT accepted (no thousands separators).
 */
import { Decimal, assertInRange, formatDecimal } from "./decimal";
import { CalculatorError } from "./errors";

export const MAX_EXPRESSION_LENGTH = 500;
export const MAX_TOKENS = 250;
export const MAX_NESTING_DEPTH = 32;
export const MAX_NUMBER_LITERAL_LENGTH = 64;
export const MAX_ABS_EXPONENT = 10_000;

type Operator = "+" | "-" | "*" | "/" | "%" | "^";

type Token =
  | { type: "number"; value: string; pos: number }
  | { type: "op"; value: Operator; pos: number }
  | { type: "lparen"; pos: number }
  | { type: "rparen"; pos: number }
  | { type: "func"; value: "sqrt"; pos: number };

export type AstNode =
  | { kind: "number"; value: string }
  | { kind: "unary"; op: "+" | "-"; operand: AstNode }
  | { kind: "binary"; op: Operator; left: AstNode; right: AstNode }
  | { kind: "call"; fn: "sqrt"; arg: AstNode };

export interface ExpressionResult {
  /** Normalized ASCII expression that was evaluated. */
  expression: string;
  /** Result rounded to display precision, as a string (exact decimal representation). */
  result: string;
  /** Same result as a JS number (may lose precision beyond ~15-17 significant digits). */
  value: number;
}

const NUMBER_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;

function normalize(input: string): string {
  return input
    .replace(/[×✕∗]/g, "*")
    .replace(/[÷∕]/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/\*\*/g, "^")
    .replace(/√/g, "sqrt");
}

export function tokenize(input: string): Token[] {
  if (typeof input !== "string") {
    throw new CalculatorError("INVALID_INPUT", "Expression must be a string.");
  }
  if (input.length > MAX_EXPRESSION_LENGTH) {
    throw new CalculatorError(
      "EXPRESSION_TOO_LONG",
      `Expression is too long (max ${MAX_EXPRESSION_LENGTH} characters).`,
    );
  }
  const src = normalize(input);
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const numberMatch = NUMBER_RE.exec(src.slice(i));
    if (numberMatch) {
      const literal = numberMatch[0];
      if (literal.length > MAX_NUMBER_LITERAL_LENGTH) {
        throw new CalculatorError("INVALID_NUMBER", "Number literal is too long.", i);
      }
      tokens.push({ type: "number", value: literal, pos: i });
      i += literal.length;
      // Reject things like "1.2.3" or "5e" that would otherwise silently split.
      if (src[i] === "." || /[eE]/.test(src[i] ?? "")) {
        throw new CalculatorError("INVALID_NUMBER", `Invalid number near position ${i + 1}.`, i);
      }
    } else if ("+-*/%^".includes(ch)) {
      tokens.push({ type: "op", value: ch as Operator, pos: i });
      i++;
    } else if (ch === "(") {
      tokens.push({ type: "lparen", pos: i });
      i++;
    } else if (ch === ")") {
      tokens.push({ type: "rparen", pos: i });
      i++;
    } else if (src.startsWith("sqrt", i)) {
      tokens.push({ type: "func", value: "sqrt", pos: i });
      i += 4;
    } else {
      throw new CalculatorError(
        "INVALID_CHARACTER",
        `Unsupported character "${ch}" at position ${i + 1}. Only numbers, + - * / % ^ ( ) and sqrt are allowed.`,
        i,
      );
    }
    if (tokens.length > MAX_TOKENS) {
      throw new CalculatorError("TOO_COMPLEX", `Expression is too complex (max ${MAX_TOKENS} tokens).`);
    }
  }
  if (tokens.length === 0) {
    throw new CalculatorError("EMPTY_EXPRESSION", "Expression is empty.");
  }
  return tokens;
}

function describe(token: Token | undefined): string {
  if (!token) return "end of expression";
  switch (token.type) {
    case "number":
      return `number ${token.value}`;
    case "op":
      return `"${token.value}"`;
    case "lparen":
      return `"("`;
    case "rparen":
      return `")"`;
    case "func":
      return `"${token.value}"`;
  }
}

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): AstNode {
    const node = this.expression();
    const extra = this.peek();
    if (extra) {
      if (extra.type === "rparen") {
        throw new CalculatorError("MISMATCHED_PARENTHESES", `Unmatched ")" at position ${extra.pos + 1}.`, extra.pos);
      }
      throw new CalculatorError(
        "UNEXPECTED_TOKEN",
        `Missing operator before ${describe(extra)} at position ${extra.pos + 1}.`,
        extra.pos,
      );
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token | undefined {
    return this.tokens[this.index++];
  }

  private isOp(token: Token | undefined, ...ops: Operator[]): token is Extract<Token, { type: "op" }> {
    return token?.type === "op" && ops.includes(token.value);
  }

  private enter(): void {
    if (++this.depth > MAX_NESTING_DEPTH) {
      throw new CalculatorError("TOO_COMPLEX", `Expression is nested too deeply (max depth ${MAX_NESTING_DEPTH}).`);
    }
  }

  private leave(): void {
    this.depth--;
  }

  private expression(): AstNode {
    let left = this.term();
    while (this.isOp(this.peek(), "+", "-")) {
      const op = (this.next() as Extract<Token, { type: "op" }>).value;
      left = { kind: "binary", op, left, right: this.term() };
    }
    return left;
  }

  private term(): AstNode {
    let left = this.unary();
    while (this.isOp(this.peek(), "*", "/", "%")) {
      const op = (this.next() as Extract<Token, { type: "op" }>).value;
      left = { kind: "binary", op, left, right: this.unary() };
    }
    return left;
  }

  private unary(): AstNode {
    const token = this.peek();
    if (this.isOp(token, "+", "-")) {
      this.next();
      this.enter();
      const operand = this.unary();
      this.leave();
      return { kind: "unary", op: token.value as "+" | "-", operand };
    }
    return this.power();
  }

  private power(): AstNode {
    const base = this.primary();
    if (this.isOp(this.peek(), "^")) {
      this.next();
      this.enter();
      const exponent = this.unary();
      this.leave();
      return { kind: "binary", op: "^", left: base, right: exponent };
    }
    return base;
  }

  private primary(): AstNode {
    const token = this.next();
    if (!token) {
      throw new CalculatorError("UNEXPECTED_END", "Expression ends unexpectedly; a number or \"(\" is missing.");
    }
    if (token.type === "number") {
      return { kind: "number", value: token.value };
    }
    if (token.type === "lparen") {
      return this.parenthesized(token.pos);
    }
    if (token.type === "func") {
      const open = this.next();
      if (open?.type !== "lparen") {
        throw new CalculatorError("UNEXPECTED_TOKEN", `"sqrt" must be followed by "(" (position ${token.pos + 1}).`, token.pos);
      }
      return { kind: "call", fn: "sqrt", arg: this.parenthesized(open.pos) };
    }
    throw new CalculatorError(
      "UNEXPECTED_TOKEN",
      `Unexpected ${describe(token)} at position ${token.pos + 1}.`,
      token.pos,
    );
  }

  private parenthesized(openPos: number): AstNode {
    this.enter();
    if (this.peek()?.type === "rparen") {
      throw new CalculatorError("UNEXPECTED_TOKEN", `Empty parentheses at position ${openPos + 1}.`, openPos);
    }
    const inner = this.expression();
    const close = this.next();
    if (close?.type !== "rparen") {
      throw new CalculatorError("MISMATCHED_PARENTHESES", `Missing ")" for "(" at position ${openPos + 1}.`, openPos);
    }
    this.leave();
    return inner;
  }
}

export function parse(input: string): AstNode {
  return new Parser(tokenize(input)).parse();
}

// ---------------------------------------------------------------------------
// Evaluation (shared with the MCP tools through ./operations)
// ---------------------------------------------------------------------------

export function decimalPower(base: Decimal, exponent: Decimal): Decimal {
  if (exponent.abs().gt(MAX_ABS_EXPONENT)) {
    throw new CalculatorError("TOO_COMPLEX", `Exponent is too large (max |exponent| is ${MAX_ABS_EXPONENT}).`);
  }
  if (base.isZero() && exponent.isNegative()) {
    throw new CalculatorError("DIVISION_BY_ZERO", "Zero cannot be raised to a negative power (division by zero).");
  }
  if (base.isNegative() && !exponent.isInteger()) {
    throw new CalculatorError(
      "INVALID_OPERATION",
      "A negative number cannot be raised to a fractional power (complex results are not supported).",
    );
  }
  // Cheap magnitude estimate before computing, to avoid huge intermediate values.
  if (!base.isZero()) {
    const magnitude = base.abs().log(10).times(exponent);
    if (magnitude.gt(300)) {
      throw new CalculatorError("OVERFLOW", "The result is too large (limit is ±1e300).");
    }
  }
  return assertInRange(base.pow(exponent));
}

export function decimalSqrt(value: Decimal): Decimal {
  if (value.isNegative()) {
    throw new CalculatorError(
      "INVALID_OPERATION",
      "Cannot take the square root of a negative number (complex results are not supported).",
    );
  }
  return value.sqrt();
}

export function evaluateAst(node: AstNode): Decimal {
  switch (node.kind) {
    case "number": {
      const value = new Decimal(node.value);
      return assertInRange(value);
    }
    case "unary": {
      const operand = evaluateAst(node.operand);
      return node.op === "-" ? operand.negated() : operand;
    }
    case "call":
      return decimalSqrt(evaluateAst(node.arg));
    case "binary": {
      const left = evaluateAst(node.left);
      const right = evaluateAst(node.right);
      switch (node.op) {
        case "+":
          return assertInRange(left.plus(right));
        case "-":
          return assertInRange(left.minus(right));
        case "*":
          return assertInRange(left.times(right));
        case "/":
          if (right.isZero()) throw new CalculatorError("DIVISION_BY_ZERO", "Division by zero is undefined.");
          return assertInRange(left.dividedBy(right));
        case "%":
          if (right.isZero()) throw new CalculatorError("MODULO_BY_ZERO", "Modulo by zero is undefined.");
          // Truncated modulo: sign follows the dividend (same as JavaScript's %).
          return assertInRange(left.mod(right));
        case "^":
          return decimalPower(left, right);
      }
    }
  }
}

/** Serializes an AST back to a canonical, fully explicit ASCII expression. */
export function stringifyAst(node: AstNode, parentPrecedence = 0): string {
  const precedence: Record<Operator, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2, "^": 4 };
  switch (node.kind) {
    case "number":
      return node.value;
    case "call":
      return `sqrt(${stringifyAst(node.arg)})`;
    case "unary": {
      const text = `${node.op}${stringifyAst(node.operand, 3)}`;
      return parentPrecedence > 3 ? `(${text})` : text;
    }
    case "binary": {
      const p = precedence[node.op];
      // Right-assoc for ^, left-assoc otherwise.
      const left = stringifyAst(node.left, node.op === "^" ? p + 1 : p);
      const right = stringifyAst(node.right, node.op === "^" ? p - 1 : p + 1);
      const text = `${left} ${node.op} ${right}`;
      return p < parentPrecedence ? `(${text})` : text;
    }
  }
}

/** Parses and evaluates an arithmetic expression. Throws CalculatorError on any problem. */
export function evaluateExpression(input: string): ExpressionResult {
  const ast = parse(input);
  const value = evaluateAst(ast);
  const result = formatDecimal(value);
  return { expression: stringifyAst(ast), result, value: Number(result) };
}

/** Non-throwing variant for UI previews. */
export function tryEvaluateExpression(
  input: string,
): { ok: true; value: ExpressionResult } | { ok: false; error: CalculatorError } {
  try {
    return { ok: true, value: evaluateExpression(input) };
  } catch (error) {
    if (error instanceof CalculatorError) return { ok: false, error };
    return { ok: false, error: new CalculatorError("INVALID_INPUT", "Could not evaluate expression.") };
  }
}
