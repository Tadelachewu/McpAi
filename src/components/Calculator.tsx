"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MAX_EXPRESSION_LENGTH, tryEvaluateExpression } from "@/lib/calculator";

type AngleUnit = "degrees" | "radians";

interface HistoryEntry {
  id: number;
  expression: string;
  result: string;
  /** Set when the expression used trigonometry, so the unit matters. */
  angleUnit?: AngleUnit;
}

type KeyKind = "digit" | "operator" | "function" | "action" | "equals";

interface KeyDef {
  label: string;
  /** Text appended to the expression, or an action name. */
  value: string;
  kind: KeyKind;
  aria: string;
  span?: 2;
}

const KEYS: KeyDef[] = [
  { label: "AC", value: "clear", kind: "action", aria: "Clear all" },
  { label: "⌫", value: "backspace", kind: "action", aria: "Backspace" },
  { label: "(", value: "(", kind: "function", aria: "Open parenthesis" },
  { label: ")", value: ")", kind: "function", aria: "Close parenthesis" },
  { label: "÷", value: "/", kind: "operator", aria: "Divide" },

  { label: "7", value: "7", kind: "digit", aria: "7" },
  { label: "8", value: "8", kind: "digit", aria: "8" },
  { label: "9", value: "9", kind: "digit", aria: "9" },
  { label: "xʸ", value: "^", kind: "function", aria: "Power" },
  { label: "×", value: "*", kind: "operator", aria: "Multiply" },

  { label: "4", value: "4", kind: "digit", aria: "4" },
  { label: "5", value: "5", kind: "digit", aria: "5" },
  { label: "6", value: "6", kind: "digit", aria: "6" },
  { label: "mod", value: "%", kind: "function", aria: "Modulo" },
  { label: "−", value: "-", kind: "operator", aria: "Subtract or negative sign" },

  { label: "1", value: "1", kind: "digit", aria: "1" },
  { label: "2", value: "2", kind: "digit", aria: "2" },
  { label: "3", value: "3", kind: "digit", aria: "3" },
  { label: "√", value: "sqrt(", kind: "function", aria: "Square root" },
  { label: "+", value: "+", kind: "operator", aria: "Add" },

  { label: "0", value: "0", kind: "digit", aria: "0", span: 2 },
  { label: ".", value: ".", kind: "digit", aria: "Decimal point" },
  { label: "=", value: "equals", kind: "equals", aria: "Equals", span: 2 },
];

/** Scientific keys, shown above the main keypad. "angle" toggles DEG/RAD. */
const SCI_KEYS: KeyDef[] = [
  { label: "DEG", value: "angle", kind: "action", aria: "Toggle degrees or radians" },
  { label: "sin", value: "sin(", kind: "function", aria: "Sine" },
  { label: "cos", value: "cos(", kind: "function", aria: "Cosine" },
  { label: "tan", value: "tan(", kind: "function", aria: "Tangent" },
  { label: "π", value: "pi", kind: "function", aria: "Pi" },

  { label: "sin⁻¹", value: "asin(", kind: "function", aria: "Inverse sine" },
  { label: "cos⁻¹", value: "acos(", kind: "function", aria: "Inverse cosine" },
  { label: "tan⁻¹", value: "atan(", kind: "function", aria: "Inverse tangent" },
  { label: "e", value: "e", kind: "function", aria: "Euler number" },
  { label: "n!", value: "!", kind: "function", aria: "Factorial" },

  { label: "ln", value: "ln(", kind: "function", aria: "Natural logarithm" },
  { label: "log", value: "log(", kind: "function", aria: "Logarithm base 10, or log(x, base)" },
  { label: "eˣ", value: "exp(", kind: "function", aria: "e to the power of" },
  { label: "10ˣ", value: "10^", kind: "function", aria: "10 to the power of" },
  { label: "x²", value: "^2", kind: "function", aria: "Square" },

  { label: "∛", value: "cbrt(", kind: "function", aria: "Cube root" },
  { label: "ʸ√x", value: "root(", kind: "function", aria: "Nth root: root(x, n)" },
  { label: "|x|", value: "abs(", kind: "function", aria: "Absolute value" },
  { label: "nCr", value: "nCr(", kind: "function", aria: "Combinations: nCr(n, r)" },
  { label: ",", value: ",", kind: "function", aria: "Argument separator" },
];

const KEY_STYLES: Record<KeyKind, string> = {
  digit: "bg-slate-800/80 text-slate-100 hover:bg-slate-700 active:bg-slate-600",
  function: "bg-slate-700/60 text-sky-200 hover:bg-slate-600/80 active:bg-slate-500",
  operator: "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-400/30 hover:bg-sky-500/25 active:bg-sky-500/35 text-2xl",
  action: "bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-400/20 hover:bg-rose-500/20 active:bg-rose-500/30",
  equals: "bg-sky-500 text-slate-950 font-semibold hover:bg-sky-400 active:bg-sky-300 text-2xl",
};

/** Pretty-prints an ASCII expression for display. */
export function prettyExpression(expr: string): string {
  return expr
    .replace(/sqrt/g, "√")
    .replace(/cbrt/g, "∛")
    .replace(/\bpi\b/g, "π")
    .replace(/\*/g, "×")
    .replace(/\//g, "÷")
    .replace(/-/g, "−");
}

/** Keys that continue from the previous result instead of starting a new expression. */
const OPERATOR_START = /^[+*/%^!,]/;
/** A trailing function name with its "(" (e.g. "asin(") or a constant, removed as one unit by backspace. */
const TRAILING_NAME = /(?:[a-zA-Z][a-zA-Z0-9]*\(|pi)$/;
const USES_ANGLES = /\b(?:a?(?:sin|cos|tan)|arc(?:sin|cos|tan))\(/i;

interface CalculatorProps {
  onAskAi?: (expression: string) => void;
}

export function Calculator({ onAskAi }: CalculatorProps) {
  const [expr, setExpr] = useState("");
  const [justEvaluated, setJustEvaluated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEvaluated, setLastEvaluated] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [angleUnit, setAngleUnit] = useState<AngleUnit>("degrees");

  const preview = useMemo(() => {
    if (!expr || justEvaluated || /^[+-]?[\d.]+(e[+-]?\d+)?$/i.test(expr)) return null;
    const outcome = tryEvaluateExpression(expr, { angleUnit });
    return outcome.ok ? outcome.value.result : null;
  }, [expr, justEvaluated, angleUnit]);

  const input = useCallback(
    (value: string) => {
      setError(null);
      setExpr((current) => {
        // After "=", typing a number starts fresh; typing an operator continues from the result.
        const base = justEvaluated && !OPERATOR_START.test(value) && value !== "-" ? "" : current;
        const next = base + value;
        return next.length > MAX_EXPRESSION_LENGTH ? current : next;
      });
      setJustEvaluated(false);
    },
    [justEvaluated],
  );

  const clear = useCallback(() => {
    setExpr("");
    setError(null);
    setJustEvaluated(false);
    setLastEvaluated(null);
  }, []);

  const backspace = useCallback(() => {
    setError(null);
    setJustEvaluated(false);
    setExpr((current) => {
      const name = TRAILING_NAME.exec(current);
      return name ? current.slice(0, -name[0].length) : current.slice(0, -1);
    });
  }, []);

  const equals = useCallback(() => {
    if (!expr.trim()) return;
    const outcome = tryEvaluateExpression(expr, { angleUnit });
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    const { result, usesAngles } = outcome.value;
    const entry: HistoryEntry = { id: Date.now() + Math.random(), expression: expr, result, ...(usesAngles ? { angleUnit } : {}) };
    setHistory((h) => [entry, ...h].slice(0, 50));
    setLastEvaluated(expr);
    setExpr(result);
    setJustEvaluated(true);
    setError(null);
  }, [expr, angleUnit]);

  const press = useCallback(
    (key: KeyDef) => {
      if (key.value === "angle") setAngleUnit((u) => (u === "degrees" ? "radians" : "degrees"));
      else if (key.value === "clear") clear();
      else if (key.value === "backspace") backspace();
      else if (key.value === "equals") equals();
      else input(key.value);
    },
    [backspace, clear, equals, input],
  );

  // Physical keyboard support (ignored while typing in the chat box or other inputs).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      // Let Enter/Space activate a keyboard-focused button normally.
      if (target?.tagName === "BUTTON" && (event.key === "Enter" || event.key === " ")) return;

      const k = event.key;
      if (/^[0-9.]$/.test(k) || "+-*/%^()!,".includes(k)) input(k);
      else if (k === "x" || k === "X") input("*");
      else if (k === "s" || k === "S") input("sqrt(");
      else if (k === "Enter" || k === "=") equals();
      else if (k === "Backspace") backspace();
      else if (k === "Escape" || k === "Delete") clear();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [backspace, clear, equals, input]);

  return (
    <section aria-labelledby="calc-heading" className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 id="calc-heading" className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          Calculator
        </h2>
        <span className="text-xs text-slate-500">Direct, local calculation · no AI</span>
      </div>

      {/* Display */}
      <div className="rounded-2xl border border-slate-700/60 bg-slate-950/70 p-4 shadow-inner">
        <div className="min-h-5 truncate text-right font-mono text-sm text-slate-500" aria-hidden="true">
          {justEvaluated && lastEvaluated ? `${prettyExpression(lastEvaluated)} =` : " "}
        </div>
        <output
          aria-live="polite"
          aria-label="Calculator display"
          className="block min-h-12 break-all text-right font-mono text-4xl font-medium tracking-tight text-white"
        >
          {expr ? prettyExpression(expr) : "0"}
        </output>
        <div className="mt-1 min-h-6 text-right font-mono text-base" aria-live="polite">
          {error ? (
            <span role="alert" className="text-rose-400 text-sm font-sans">
              {error}
            </span>
          ) : preview !== null ? (
            <span className="text-slate-400">= {preview}</span>
          ) : null}
        </div>
      </div>

      {/* Scientific keys */}
      <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="Scientific functions">
        {SCI_KEYS.map((key) => {
          const isAngle = key.value === "angle";
          return (
            <button
              key={key.label}
              type="button"
              aria-label={isAngle ? `Angle unit: ${angleUnit}. Click to switch.` : key.aria}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => press(key)}
              className={`h-10 rounded-lg text-sm font-medium transition-colors select-none ${
                isAngle
                  ? "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30 hover:bg-amber-500/25"
                  : KEY_STYLES[key.kind]
              }`}
            >
              {isAngle ? (angleUnit === "degrees" ? "DEG" : "RAD") : key.label}
            </button>
          );
        })}
      </div>

      {/* Keypad */}
      <div className="grid grid-cols-5 gap-2" role="group" aria-label="Calculator keypad">
        {KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            aria-label={key.aria}
            // Keep mouse clicks from moving focus, so the physical Enter key always means "=".
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => press(key)}
            className={`h-14 rounded-xl text-xl font-medium transition-colors select-none sm:h-16 ${KEY_STYLES[key.kind]} ${
              key.span === 2 ? "col-span-2" : ""
            }`}
          >
            {key.label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
        <span>Keyboard: 0-9 . + − × ÷ ^ % ! , ( ) · s = √ · Enter = · Esc clear</span>
        {onAskAi && (
          <button
            type="button"
            onClick={() => {
              const target = justEvaluated && lastEvaluated ? lastEvaluated : expr;
              if (target.trim()) onAskAi(USES_ANGLES.test(target) ? `${target} (angles in ${angleUnit})` : target);
            }}
            disabled={!expr.trim()}
            className="shrink-0 rounded-lg px-2 py-1 text-sky-300 hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Explain with AI →
          </button>
        )}
      </div>

      {/* History */}
      <div className="rounded-2xl border border-slate-700/60 bg-slate-900/50">
        <div className="flex items-center justify-between border-b border-slate-700/60 px-4 py-2">
          <h3 className="text-sm font-semibold text-slate-300">History</h3>
          {history.length > 0 && (
            <button type="button" onClick={() => setHistory([])} className="rounded px-2 py-0.5 text-xs text-slate-400 hover:text-slate-200">
              Clear history
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500">No calculations yet.</p>
        ) : (
          <ul className="max-h-48 overflow-y-auto py-1" aria-label="Calculation history">
            {history.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => {
                    setExpr(entry.result);
                    setJustEvaluated(true);
                    setLastEvaluated(entry.expression);
                    setError(null);
                  }}
                  className="flex w-full items-baseline justify-between gap-3 px-4 py-1.5 text-left font-mono text-sm hover:bg-slate-800/60"
                  title="Use this result"
                >
                  <span className="truncate text-slate-400">
                    {prettyExpression(entry.expression)}
                    {entry.angleUnit && (
                      <span className="ml-1.5 text-[10px] uppercase text-amber-400/70">{entry.angleUnit === "degrees" ? "deg" : "rad"}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-slate-100">= {entry.result}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
