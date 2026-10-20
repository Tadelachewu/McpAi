/**
 * Safe scientific expression engine: tokenizer -> recursive-descent parser -> AST -> Decimal evaluator.
 * No eval()/new Function(). Grammar (lowest to highest precedence):
 *
 *   expression := term (("+" | "-") term)*
 *   term       := unary (("*" | "/" | "%") unary)*        % is modulo
 *   unary      := ("-" | "+") unary | power
 *   power      := postfix ("^" unary)?                      right-associative; -2^2 = -4
 *   postfix    := primary "!"*                              factorial; -3! = -6, 2^3! = 64
 *   primary    := NUMBER | CONSTANT | "(" expression ")" | FUNCTION "(" expression ("," expression)* ")"
 *
 * Constants: pi (π), e. Functions: see FUNCTION_ARITY. Names are case-insensitive and looked up in a
 * fixed table, so nothing else (globals, properties) can ever be referenced.
 * Aliases accepted: × * ÷ / − - ** ^ √ sqrt ∛ cbrt π pi. "," only separates function arguments
 * (no thousands separators).
 */
import { Decimal, assertInRange, formatDecimal } from "./decimal";
import { CalculatorError } from "./errors";
import {
  DECIMAL_E,
  DECIMAL_PI,
  HYPERBOLIC_FUNCTIONS,
  TRIG_FUNCTIONS,
  decimalCbrt,
  decimalCombinations,
  decimalExp,
  decimalFactorial,
  decimalHyperbolic,
  decimalLn,
  decimalLog,
  decimalPermutations,
  decimalRoot,
  decimalRound,
  decimalTrig,
  type AngleUnit,
  type HyperbolicFunction,
  type TrigFunction,
} from "./scientific";

export const MAX_EXPRESSION_LENGTH = 500;
export const MAX_TOKENS = 250;
export const MAX_NESTING_DEPTH = 32;
export const MAX_NUMBER_LITERAL_LENGTH = 64;
export const MAX_ABS_EXPONENT = 10_000;

type Operator = "+" | "-" | "*" | "/" | "%" | "^";

/** Supported functions with their [min, max] argument counts. */
export const FUNCTION_ARITY = {
  sqrt: [1, 1],
  cbrt: [1, 1],
  root: [2, 2],
  abs: [1, 1],
  floor: [1, 1],
  ceil: [1, 1],
  round: [1, 1],
  sin: [1, 1],
  cos: [1, 1],
  tan: [1, 1],
  asin: [1, 1],
  acos: [1, 1],
  atan: [1, 1],
  sinh: [1, 1],
  cosh: [1, 1],
  tanh: [1, 1],
  asinh: [1, 1],
  acosh: [1, 1],
  atanh: [1, 1],
  ln: [1, 1],
  log: [1, 2],
  log2: [1, 1],
  exp: [1, 1],
  nCr: [2, 2],
  nPr: [2, 2],
} as const satisfies Record<string, readonly [number, number]>;

export type FunctionName = keyof typeof FUNCTION_ARITY;
export type ConstantName = "pi" | "e";

/** Lower-case spelling -> canonical function name. A Map, so "constructor" etc. never match. */
const FUNCTION_LOOKUP = new Map<string, FunctionName>([
  ...(Object.keys(FUNCTION_ARITY) as FunctionName[]).map((name): [string, FunctionName] => [name.toLowerCase(), name]),
  ["arcsin", "asin"],
  ["arccos", "acos"],
  ["arctan", "atan"],
  ["log10", "log"],
]);
const CONSTANT_LOOKUP = new Map<string, ConstantName>([
  ["pi", "pi"],
  ["e", "e"],
]);

type Token =
  | { type: "number"; value: string; pos: number }
  | { type: "op"; value: Operator; pos: number }
  | { type: "lparen"; pos: number }
  | { type: "rparen"; pos: number }
  | { type: "comma"; pos: number }
  | { type: "bang"; pos: number }
  | { type: "func"; value: FunctionName; pos: number }
  | { type: "const"; value: ConstantName; pos: number };

export type AstNode =
  | { kind: "number"; value: string }
  | { kind: "constant"; name: ConstantName }
  | { kind: "unary"; op: "+" | "-"; operand: AstNode }
  | { kind: "binary"; op: Operator; left: AstNode; right: AstNode }
  | { kind: "factorial"; operand: AstNode }
  | { kind: "call"; fn: FunctionName; args: AstNode[] };

export interface EvaluateOptions {
  /** Unit for sin/cos/tan inputs and asin/acos/atan outputs. Default: radians. */
  angleUnit?: AngleUnit;
}

export interface ExpressionResult {
  /** Normalized ASCII expression that was evaluated. */
  expression: string;
  /** Result rounded to display precision, as a string (exact decimal representation). */
  result: string;
  /** Same result as a JS number (may lose precision beyond ~15-17 significant digits). */
  value: number;
  /** True when the expression uses a trigonometric function, so the angle unit matters. */
  usesAngles: boolean;
}

const NUMBER_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*/;

function normalize(input: string): string {
  return input
    .replace(/[×✕∗]/g, "*")
    .replace(/[÷∕]/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/\*\*/g, "^")
    .replace(/√/g, "sqrt")
    .replace(/∛/g, "cbrt")
    .replace(/π/g, "pi");
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
    const identifierMatch = numberMatch ? null : IDENTIFIER_RE.exec(src.slice(i));
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
    } else if (ch === ",") {
      tokens.push({ type: "comma", pos: i });
      i++;
    } else if (ch === "!") {
      tokens.push({ type: "bang", pos: i });
      i++;
    } else if (identifierMatch) {
      const name = identifierMatch[0];
      const lower = name.toLowerCase();
      const fn = FUNCTION_LOOKUP.get(lower);
      const constant = CONSTANT_LOOKUP.get(lower);
      if (fn) tokens.push({ type: "func", value: fn, pos: i });
      else if (constant) tokens.push({ type: "const", value: constant, pos: i });
      else {
        throw new CalculatorError(
          "INVALID_CHARACTER",
          `Unknown name "${name.slice(0, 20)}" at position ${i + 1}. Supported: pi, e and the functions ${Object.keys(FUNCTION_ARITY).join(", ")}.`,
          i,
        );
      }
      i += name.length;
    } else {
      throw new CalculatorError(
        "INVALID_CHARACTER",
        `Unsupported character "${ch}" at position ${i + 1}. Allowed: numbers, + - * / % ^ ! ( ) , and named functions/constants.`,
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
    case "comma":
      return `","`;
    case "bang":
      return `"!"`;
    case "func":
    case "const":
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
      if (extra.type === "comma") throw this.commaError(extra.pos);
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

  private commaError(pos: number): CalculatorError {
    return new CalculatorError(
      "UNEXPECTED_TOKEN",
      `Unexpected "," at position ${pos + 1}. Commas only separate function arguments, e.g. log(8, 2); thousands separators are not supported.`,
      pos,
    );
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
    const base = this.postfix();
    if (this.isOp(this.peek(), "^")) {
      this.next();
      this.enter();
      const exponent = this.unary();
      this.leave();
      return { kind: "binary", op: "^", left: base, right: exponent };
    }
    return base;
  }

  private postfix(): AstNode {
    let node = this.primary();
    while (this.peek()?.type === "bang") {
      this.next();
      node = { kind: "factorial", operand: node };
    }
    return node;
  }

  private primary(): AstNode {
    const token = this.next();
    if (!token) {
      throw new CalculatorError("UNEXPECTED_END", "Expression ends unexpectedly; a number or \"(\" is missing.");
    }
    if (token.type === "number") {
      return { kind: "number", value: token.value };
    }
    if (token.type === "const") {
      return { kind: "constant", name: token.value };
    }
    if (token.type === "lparen") {
      return this.parenthesized(token.pos);
    }
    if (token.type === "func") {
      const open = this.next();
      if (open?.type !== "lparen") {
        throw new CalculatorError(
          "UNEXPECTED_TOKEN",
          `"${token.value}" must be followed by "(" (position ${token.pos + 1}), e.g. ${token.value}(2).`,
          token.pos,
        );
      }
      const args = this.argumentList(open.pos);
      const [min, max] = FUNCTION_ARITY[token.value];
      if (args.length < min || args.length > max) {
        const expected = min === max ? `${min}` : `${min} or ${max}`;
        throw new CalculatorError(
          "UNEXPECTED_TOKEN",
          `"${token.value}" takes ${expected} argument${max === 1 ? "" : "s"}, but got ${args.length}.`,
          token.pos,
        );
      }
      return { kind: "call", fn: token.value, args };
    }
    if (token.type === "comma") throw this.commaError(token.pos);
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
    if (close?.type === "comma") throw this.commaError(close.pos);
    if (close?.type !== "rparen") {
      throw new CalculatorError("MISMATCHED_PARENTHESES", `Missing ")" for "(" at position ${openPos + 1}.`, openPos);
    }
    this.leave();
    return inner;
  }

  private argumentList(openPos: number): AstNode[] {
    this.enter();
    if (this.peek()?.type === "rparen") {
      throw new CalculatorError("UNEXPECTED_TOKEN", `Empty parentheses at position ${openPos + 1}.`, openPos);
    }
    const args = [this.expression()];
    while (this.peek()?.type === "comma") {
      this.next();
      args.push(this.expression());
    }
    const close = this.next();
    if (close?.type !== "rparen") {
      throw new CalculatorError("MISMATCHED_PARENTHESES", `Missing ")" for "(" at position ${openPos + 1}.`, openPos);
    }
    this.leave();
    return args;
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

const TRIG = new Set<FunctionName>(TRIG_FUNCTIONS);
const HYPERBOLIC = new Set<FunctionName>(HYPERBOLIC_FUNCTIONS);

function evaluateCall(fn: FunctionName, args: Decimal[], angleUnit: AngleUnit): Decimal {
  const x = args[0]!;
  const y = args[1];
  if (TRIG.has(fn)) return decimalTrig(fn as TrigFunction, x, angleUnit);
  if (HYPERBOLIC.has(fn)) return decimalHyperbolic(fn as HyperbolicFunction, x);
  switch (fn) {
    case "sqrt":
      return decimalSqrt(x);
    case "cbrt":
      return decimalCbrt(x);
    case "root":
      return decimalRoot(x, y!, decimalPower);
    case "abs":
    case "floor":
    case "ceil":
    case "round":
      return decimalRound(fn, x);
    case "ln":
      return decimalLn(x);
    case "log":
      return decimalLog(x, y);
    case "log2":
      return decimalLog(x, new Decimal(2));
    case "exp":
      return decimalExp(x);
    case "nCr":
      return decimalCombinations(x, y!);
    case "nPr":
      return decimalPermutations(x, y!);
    default:
      throw new CalculatorError("INVALID_OPERATION", `Unsupported function "${fn}".`);
  }
}

export function evaluateAst(node: AstNode, options: EvaluateOptions = {}): Decimal {
  switch (node.kind) {
    case "number": {
      const value = new Decimal(node.value);
      return assertInRange(value);
    }
    case "constant":
      return node.name === "pi" ? DECIMAL_PI : DECIMAL_E;
    case "unary": {
      const operand = evaluateAst(node.operand, options);
      return node.op === "-" ? operand.negated() : operand;
    }
    case "factorial":
      return decimalFactorial(evaluateAst(node.operand, options));
    case "call": {
      const args = node.args.map((arg) => evaluateAst(arg, options));
      return assertInRange(evaluateCall(node.fn, args, options.angleUnit ?? "radians"));
    }
    case "binary": {
      const left = evaluateAst(node.left, options);
      const right = evaluateAst(node.right, options);
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
    case "constant":
      return node.name;
    case "call":
      return `${node.fn}(${node.args.map((arg) => stringifyAst(arg)).join(", ")})`;
    case "factorial":
      return `${stringifyAst(node.operand, 5)}!`;
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

/** True if the AST contains sin/cos/tan/asin/acos/atan (so the angle unit affects the result). */
export function usesAngles(node: AstNode): boolean {
  switch (node.kind) {
    case "call":
      return TRIG.has(node.fn) || node.args.some(usesAngles);
    case "unary":
    case "factorial":
      return usesAngles(node.operand);
    case "binary":
      return usesAngles(node.left) || usesAngles(node.right);
    default:
      return false;
  }
}

/** Parses and evaluates an expression. Throws CalculatorError on any problem. */
export function evaluateExpression(input: string, options: EvaluateOptions = {}): ExpressionResult {
  const ast = parse(input);
  const value = evaluateAst(ast, options);
  const result = formatDecimal(value);
  return { expression: stringifyAst(ast), result, value: Number(result), usesAngles: usesAngles(ast) };
}

/** Non-throwing variant for UI previews. */
export function tryEvaluateExpression(
  input: string,
  options: EvaluateOptions = {},
): { ok: true; value: ExpressionResult } | { ok: false; error: CalculatorError } {
  try {
    return { ok: true, value: evaluateExpression(input, options) };
  } catch (error) {
    if (error instanceof CalculatorError) return { ok: false, error };
    return { ok: false, error: new CalculatorError("INVALID_INPUT", "Could not evaluate expression.") };
  }
}
