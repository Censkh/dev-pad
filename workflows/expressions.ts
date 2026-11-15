// GitHub Actions expressions (`${{ ... }}`), as the workflow runner evaluates them:
// https://docs.github.com/actions/reference/workflows-and-actions/expressions
// Literals, context and property access, the operators ! < <= > >= == != && || and the functions
// the workflows use. Comparison is GitHub's: strings ignore case, mixed types compare as numbers.

export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

export type StatusFunctions = {
  success(): boolean;
  failure(): boolean;
  cancelled(): boolean;
};

export type ExpressionContext = {
  contexts: Record<string, Value | undefined>;
  status?: StatusFunctions;
};

// A context the evaluation cannot know yet (a job's outputs before it ran): `check` mode
// evaluates conditions with these, and an expression that reads one is undecidable.
export class UnknownContextError extends Error {}

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "ident"; value: string }
  | { type: "op"; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      i++;
    } else if (char === "'") {
      let value = "";
      i++;
      for (;;) {
        if (i >= source.length) throw new Error(`Unterminated string in expression: ${source}`);
        if (source[i] === "'") {
          if (source[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += source[i++];
      }
      tokens.push({ type: "string", value });
    } else if (/[0-9]/.test(char) || (char === "-" && /[0-9]/.test(source[i + 1] ?? ""))) {
      const match = /^-?(0x[0-9a-f]+|[0-9]+(\.[0-9]+)?(e[+-]?[0-9]+)?)/i.exec(source.slice(i))!;
      tokens.push({ type: "number", value: Number(match[0]) });
      i += match[0].length;
    } else if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(i))!;
      tokens.push({ type: "ident", value: match[0] });
      i += match[0].length;
    } else {
      const two = source.slice(i, i + 2);
      if (["&&", "||", "==", "!=", "<=", ">="].includes(two)) {
        tokens.push({ type: "op", value: two });
        i += 2;
      } else if ("!<>()[].,*".includes(char)) {
        tokens.push({ type: "op", value: char });
        i++;
      } else {
        throw new Error(`Unexpected '${char}' in expression: ${source}`);
      }
    }
  }
  return tokens;
}

type Node =
  | { kind: "literal"; value: Value }
  | { kind: "context"; name: string }
  | { kind: "property"; object: Node; key: Node }
  | { kind: "call"; name: string; args: Node[] }
  | { kind: "not"; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node };

function parse(source: string): Node {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const isOp = (value: string) => peek()?.type === "op" && peek()!.value === value;
  const expectOp = (value: string) => {
    if (!isOp(value)) throw new Error(`Expected '${value}' in expression: ${source}`);
    position++;
  };

  function or(): Node {
    let left = and();
    while (isOp("||")) {
      position++;
      left = { kind: "binary", op: "||", left, right: and() };
    }
    return left;
  }
  function and(): Node {
    let left = comparison();
    while (isOp("&&")) {
      position++;
      left = { kind: "binary", op: "&&", left, right: comparison() };
    }
    return left;
  }
  function comparison(): Node {
    let left = unary();
    while (["==", "!=", "<", "<=", ">", ">="].some(isOp)) {
      const op = (tokens[position++] as { value: string }).value;
      left = { kind: "binary", op, left, right: unary() };
    }
    return left;
  }
  function unary(): Node {
    if (isOp("!")) {
      position++;
      return { kind: "not", operand: unary() };
    }
    return postfix();
  }
  function postfix(): Node {
    let node = primary();
    for (;;) {
      if (isOp(".")) {
        position++;
        const token = tokens[position++];
        if (token?.type === "op" && token.value === "*")
          throw new Error(`Object filters (.*) are not supported: ${source}`);
        if (token?.type !== "ident") throw new Error(`Expected a property name in: ${source}`);
        node = { kind: "property", object: node, key: { kind: "literal", value: token.value } };
      } else if (isOp("[")) {
        position++;
        const key = or();
        expectOp("]");
        node = { kind: "property", object: node, key };
      } else {
        return node;
      }
    }
  }
  function primary(): Node {
    const token = tokens[position++];
    if (!token) throw new Error(`Unexpected end of expression: ${source}`);
    if (token.type === "number" || token.type === "string") return { kind: "literal", value: token.value };
    if (token.type === "op" && token.value === "(") {
      const node = or();
      expectOp(")");
      return node;
    }
    if (token.type === "ident") {
      if (token.value === "true") return { kind: "literal", value: true };
      if (token.value === "false") return { kind: "literal", value: false };
      if (token.value === "null") return { kind: "literal", value: null };
      if (isOp("(")) {
        position++;
        const args: Node[] = [];
        if (!isOp(")")) {
          args.push(or());
          while (isOp(",")) {
            position++;
            args.push(or());
          }
        }
        expectOp(")");
        return { kind: "call", name: token.value.toLowerCase(), args };
      }
      return { kind: "context", name: token.value.toLowerCase() };
    }
    throw new Error(`Unexpected '${token.value}' in expression: ${source}`);
  }

  const node = or();
  if (position !== tokens.length) throw new Error(`Unexpected '${tokens[position].value}' in expression: ${source}`);
  return node;
}

export function truthy(value: Value | undefined): boolean {
  return !(
    value === false ||
    value === 0 ||
    value === "" ||
    value === null ||
    value === undefined ||
    Number.isNaN(value)
  );
}

function toNumber(value: Value): number {
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.trim() === "" ? 0 : Number(value);
  return Number.NaN;
}

function compare(op: string, left: Value, right: Value): boolean {
  let a: Value = left;
  let b: Value = right;
  if (typeof a === "string" && typeof b === "string") {
    a = a.toLowerCase();
    b = b.toLowerCase();
  } else if (typeof a !== typeof b || typeof a !== "object") {
    if (typeof a === "object" && a !== null) return op === "!=";
    if (typeof b === "object" && b !== null) return op === "!=";
    a = toNumber(a);
    b = toNumber(b);
  }
  switch (op) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return (a as number) < (b as number);
    case "<=":
      return (a as number) <= (b as number);
    case ">":
      return (a as number) > (b as number);
    default:
      return (a as number) >= (b as number);
  }
}

// Property names match case-insensitively, as GitHub's do.
function property(object: Value | undefined, key: Value): Value | undefined {
  if (object === null || object === undefined || typeof object !== "object") return null;
  if (Array.isArray(object)) return typeof key === "number" ? (object[key] ?? null) : null;
  const name = String(key);
  if (name in object) return object[name];
  const lower = name.toLowerCase();
  for (const [candidate, value] of Object.entries(object)) if (candidate.toLowerCase() === lower) return value;
  return null;
}

export function stringify(value: Value | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function call(name: string, args: Value[], context: ExpressionContext): Value {
  const status = context.status;
  switch (name) {
    case "success":
    case "failure":
    case "cancelled":
      if (!status) throw new UnknownContextError(`${name}() is not known here`);
      return status[name]();
    case "always":
      return true;
    case "contains": {
      const [search, item] = args;
      if (Array.isArray(search)) return search.some((entry) => compare("==", entry, item));
      return stringify(search).toLowerCase().includes(stringify(item).toLowerCase());
    }
    case "startswith":
      return stringify(args[0]).toLowerCase().startsWith(stringify(args[1]).toLowerCase());
    case "endswith":
      return stringify(args[0]).toLowerCase().endsWith(stringify(args[1]).toLowerCase());
    case "format": {
      const [template, ...values] = args;
      return stringify(template).replace(/\{\{|\}\}|\{(\d+)\}/g, (match, index) =>
        match === "{{" ? "{" : match === "}}" ? "}" : stringify(values[Number(index)]),
      );
    }
    case "join": {
      const [items, separator] = args;
      const joiner = separator === undefined ? "," : stringify(separator);
      return Array.isArray(items) ? items.map(stringify).join(joiner) : stringify(items);
    }
    case "tojson":
      return JSON.stringify(args[0] ?? null, null, 2);
    case "fromjson":
      return JSON.parse(stringify(args[0]));
    default:
      throw new Error(`The expression function ${name}() has no local implementation`);
  }
}

function evaluateNode(node: Node, context: ExpressionContext): Value {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "context": {
      if (!(node.name in context.contexts)) throw new Error(`Unknown context '${node.name}'`);
      const value = context.contexts[node.name];
      if (value === undefined) throw new UnknownContextError(`The ${node.name} context is not known here`);
      return value;
    }
    case "property": {
      const value = property(evaluateNode(node.object, context), evaluateNode(node.key, context));
      return value === undefined ? null : value;
    }
    case "call":
      return call(
        node.name,
        node.args.map((arg) => evaluateNode(arg, context)),
        context,
      );
    case "not":
      return !truthy(evaluateNode(node.operand, context));
    case "binary": {
      if (node.op === "&&" || node.op === "||") {
        let left: Value;
        try {
          left = evaluateNode(node.left, context);
        } catch (error) {
          // An unknown left side still decides `x && false` and `x || true`.
          if (!(error instanceof UnknownContextError)) throw error;
          const right = evaluateNode(node.right, context);
          if (node.op === "&&" ? !truthy(right) : truthy(right)) return right;
          throw error;
        }
        if (node.op === "&&") return truthy(left) ? evaluateNode(node.right, context) : left;
        return truthy(left) ? left : evaluateNode(node.right, context);
      }
      return compare(node.op, evaluateNode(node.left, context), evaluateNode(node.right, context));
    }
  }
}

export function evaluate(expression: string, context: ExpressionContext): Value {
  return evaluateNode(parse(expression), context);
}

// The `${{ }}` parts of a string, found by scanning so that `}}` inside a quoted string literal
// doesn't end an expression.
function expressionsIn(text: string): { start: number; end: number; source: string }[] {
  const found: { start: number; end: number; source: string }[] = [];
  let index = text.indexOf("${{");
  while (index !== -1) {
    let i = index + 3;
    let quoted = false;
    for (; i < text.length; i++) {
      if (text[i] === "'") quoted = !quoted;
      else if (!quoted && text.startsWith("}}", i)) break;
    }
    if (i >= text.length) throw new Error(`Unterminated expression in: ${text}`);
    found.push({ start: index, end: i + 2, source: text.slice(index + 3, i) });
    index = text.indexOf("${{", i + 2);
  }
  return found;
}

// The expression when the string is exactly one `${{ }}`, ignoring surrounding space.
function wholeExpression(text: string): string | undefined {
  const parts = expressionsIn(text);
  if (parts.length !== 1) return undefined;
  const [part] = parts;
  return text.slice(0, part.start).trim() === "" && text.slice(part.end).trim() === "" ? part.source : undefined;
}

// A string with `${{ }}` parts substituted, as GitHub does for names, inputs and env.
export function interpolate(text: string, context: ExpressionContext): string {
  let out = "";
  let last = 0;
  for (const part of expressionsIn(text)) {
    out += text.slice(last, part.start) + stringify(evaluate(part.source, context));
    last = part.end;
  }
  return out + text.slice(last);
}

// A YAML value with its expressions evaluated: a string that is one whole expression keeps the
// expression's type (a matrix's `fromJSON(...)` stays an array), other strings are interpolated.
export function evaluateValue(value: unknown, context: ExpressionContext): Value {
  if (typeof value === "string") {
    const whole = wholeExpression(value);
    return whole === undefined ? interpolate(value, context) : evaluate(whole, context);
  }
  if (Array.isArray(value)) return value.map((item) => evaluateValue(item, context));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluateValue(item, context)]));
  return (value ?? null) as Value;
}

// A job or step `if`: bare or wrapped in `${{ }}`, and implicitly `success() && (...)` unless it
// calls a status function itself.
export function condition(source: unknown, context: ExpressionContext): boolean {
  if (source === undefined || source === null) return truthy(call("success", [], context));
  if (typeof source === "boolean") return source && truthy(call("success", [], context));
  let expression = String(source).trim();
  const whole = wholeExpression(expression);
  if (whole !== undefined) expression = whole;
  else if (expression.includes("${{")) return truthy(interpolate(expression, context));
  if (!/\b(success|failure|cancelled|always)\s*\(/i.test(expression)) expression = `success() && (${expression})`;
  return truthy(evaluate(expression, context));
}
