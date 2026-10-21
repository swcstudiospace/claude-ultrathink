// Semgrep test target for rule no-dynamic-code.
// Each `ruleid` comment sits directly above a line that must be reported.
// Each `ok` comment sits directly above a line that must not be reported.

// ruleid: no-dynamic-code
eval("1 + 1");

// ruleid: no-dynamic-code
const fromEval = eval(userInput);

// ruleid: no-dynamic-code
const bodyOnly = new Function("return 1");

// ruleid: no-dynamic-code
const withArgs = new Function("a", "b", "return a + b");

// ok: no-dynamic-code
const literal = "eval(1)";

// ok: no-dynamic-code
const evaluator = { evaluate: (expr: string) => expr.length };

// ok: no-dynamic-code
const result = evaluator.evaluate("1 + 1");

declare const userInput: string;
