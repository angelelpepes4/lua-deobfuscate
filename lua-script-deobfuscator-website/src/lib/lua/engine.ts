import { KEYWORDS, Token, tokenize } from "./tokenizer";

export interface Options {
  deepUnpack: boolean;
  decodeStrings: boolean;
  foldConstants: boolean;
  simplifyIndex: boolean;
  stripDeadCode: boolean;
  renameVars: boolean;
  beautify: boolean;
  indent: string;
}

export const DEFAULT_OPTIONS: Options = {
  deepUnpack: true,
  decodeStrings: true,
  foldConstants: true,
  simplifyIndex: true,
  stripDeadCode: true,
  renameVars: true,
  beautify: true,
  indent: "  ",
};

export interface PassResult {
  name: string;
  changes: number;
  note: string;
}

export interface DeobResult {
  code: string;
  passes: PassResult[];
  warnings: string[];
  detected: string[];
  payloads: string[];
  stats: {
    inChars: number;
    outChars: number;
    inLines: number;
    outLines: number;
    tokens: number;
    strings: number;
    functions: number;
    renamed: number;
    layers: number;
    changes: number;
  };
}

const MAX_LAYER_PASSES = 10;
const MAX_LITERAL_SIZE = 256_000;
const MAX_SOURCE_SIZE = 1_000_000;

const makeToken = (type: Token["type"], value: string, origin?: Token): Token => ({
  type,
  value,
  raw: value,
  pos: origin?.pos ?? 0,
  end: origin?.end ?? 0,
  line: origin?.line ?? 1,
  column: origin?.column ?? 1,
  changed: true,
});

const isName = (token: Token | undefined) => token?.type === "name";

function numValue(raw: string): number | null {
  if (/^0[xX]/.test(raw) && /[pP]/.test(raw)) {
    const [mantissa, exponentText] = raw.slice(2).split(/[pP]/);
    const exponent = Number(exponentText);
    const [whole = "0", fraction = ""] = mantissa.split(".");
    const value = parseInt(whole || "0", 16) + (fraction ? parseInt(fraction, 16) / 16 ** fraction.length : 0);
    const result = value * 2 ** exponent;
    return Number.isFinite(result) ? result : null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function numberText(value: number): string {
  if (Object.is(value, -0)) return "0";
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  return String(Number(value.toPrecision(14)));
}

type Literal =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "nil"; value: null };

interface ParsedLiteral {
  value: Literal;
  end: number;
}

const PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  "<": 3, ">": 3, "<=": 3, ">=": 3, "==": 3, "~=": 3,
  "|": 4,
  "~": 5,
  "&": 6,
  "<<": 7, ">>": 7,
  "..": 8,
  "+": 9, "-": 9,
  "*": 10, "/": 10, "//": 10, "%": 10,
  "^": 12,
};

const isTruthy = (value: Literal) => value.kind !== "nil" && !(value.kind === "boolean" && !value.value);

function applyUnary(operator: string, operand: Literal): Literal | null {
  if (operator === "not") return { kind: "boolean", value: !isTruthy(operand) };
  if (operator === "-" && operand.kind === "number") return { kind: "number", value: -operand.value };
  if (operator === "+" && operand.kind === "number") return operand;
  return null;
}

function applyBinary(operator: string, left: Literal, right: Literal): Literal | null {
  if (operator === "and") return isTruthy(left) ? right : left;
  if (operator === "or") return isTruthy(left) ? left : right;

  if (operator === "==" || operator === "~=") {
    const equal = left.kind === right.kind && left.value === right.value;
    return { kind: "boolean", value: operator === "==" ? equal : !equal };
  }

  if (operator === ".." && (left.kind === "string" || left.kind === "number") && (right.kind === "string" || right.kind === "number")) {
    const leftText = left.kind === "number" ? numberText(left.value) : left.value;
    const rightText = right.kind === "number" ? numberText(right.value) : right.value;
    const joined = leftText + rightText;
    return joined.length <= MAX_LITERAL_SIZE ? { kind: "string", value: joined } : null;
  }

  if (["<", ">", "<=", ">="].includes(operator)) {
    if (left.kind === "number" && right.kind === "number") {
      const values: Record<string, boolean> = {
        "<": left.value < right.value,
        ">": left.value > right.value,
        "<=": left.value <= right.value,
        ">=": left.value >= right.value,
      };
      return { kind: "boolean", value: values[operator] };
    }
    if (left.kind === "string" && right.kind === "string" && /^[\x00-\x7f]*$/.test(left.value + right.value)) {
      const values: Record<string, boolean> = {
        "<": left.value < right.value,
        ">": left.value > right.value,
        "<=": left.value <= right.value,
        ">=": left.value >= right.value,
      };
      return { kind: "boolean", value: values[operator] };
    }
    return null;
  }

  if (left.kind !== "number" || right.kind !== "number") return null;
  let result: number;
  switch (operator) {
    case "+": result = left.value + right.value; break;
    case "-": result = left.value - right.value; break;
    case "*": result = left.value * right.value; break;
    case "/": if (right.value === 0) return null; result = left.value / right.value; break;
    case "//": if (right.value === 0) return null; result = Math.floor(left.value / right.value); break;
    case "%": if (right.value === 0) return null; result = left.value - Math.floor(left.value / right.value) * right.value; break;
    case "^": result = left.value ** right.value; break;
    default: return null;
  }
  return Number.isFinite(result) ? { kind: "number", value: result } : null;
}

function parseLiteralExpression(tokens: Token[], start: number): ParsedLiteral | null {
  let cursor = start;
  const first = tokens[start];
  const before = tokens[start - 1];
  const startsWithUnarySign = first?.value === "-" || first?.value === "+";
  const canEndExpression = before && (before.type === "name" || before.type === "number" || before.type === "string" ||
    [")", "]", "}", "...", "true", "false", "nil"].includes(before.value));
  if (startsWithUnarySign && canEndExpression) return null;

  const parse = (minimum = 0): Literal | null => {
    const token = tokens[cursor];
    if (!token || token.type === "comment" || token.type === "eof" || token.error) return null;
    let left: Literal | null = null;

    if ((token.value === "-" || token.value === "+" || token.value === "not") && token.type !== "string") {
      cursor++;
      const operand = parse(token.value === "not" ? 3 : 11);
      if (!operand) return null;
      left = applyUnary(token.value, operand);
    } else if (token.value === "(" && token.type === "op") {
      cursor++;
      left = parse(0);
      if (!left || tokens[cursor]?.value !== ")") return null;
      cursor++;
    } else if (token.type === "number") {
      const value = numValue(token.value);
      if (value === null) return null;
      left = { kind: "number", value };
      cursor++;
    } else if (token.type === "string") {
      left = { kind: "string", value: token.value };
      cursor++;
    } else if (token.value === "true" || token.value === "false") {
      left = { kind: "boolean", value: token.value === "true" };
      cursor++;
    } else if (token.value === "nil") {
      left = { kind: "nil", value: null };
      cursor++;
    }
    if (!left) return null;

    while (cursor < tokens.length) {
      const op = tokens[cursor];
      if (!op || op.type === "comment" || op.type === "eof") break;
      const precedence = PRECEDENCE[op.value];
      if (precedence === undefined || precedence < minimum) break;
      cursor++;
      const rightAssociative = op.value === "^" || op.value === "..";
      const right = parse(precedence + (rightAssociative ? 0 : 1));
      if (!right) return null;
      left = applyBinary(op.value, left, right);
      if (!left) return null;
    }
    return left;
  };

  const value = parse();
  if (!value || cursor <= start) return null;
  return { value, end: cursor };
}

function literalToken(value: Literal, origin?: Token): Token {
  if (value.kind === "number") return makeToken("number", numberText(value.value), origin);
  if (value.kind === "string") return makeToken("string", value.value, origin);
  if (value.kind === "boolean") return makeToken("keyword", String(value.value), origin);
  return makeToken("keyword", "nil", origin);
}

function foldExpressions(tokens: Token[]): { tokens: Token[]; changes: number } {
  const out: Token[] = [];
  let changes = 0;
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    if (token.type === "comment" || token.type === "eof") {
      out.push(token);
      i++;
      continue;
    }
    const parsed = parseLiteralExpression(tokens, i);
    const hasOperator = tokens.slice(i, parsed?.end ?? i).some((part) => PRECEDENCE[part.value] !== undefined || ["-", "+", "not"].includes(part.value));
    if (parsed && parsed.end - i > 1 && hasOperator) {
      out.push(literalToken(parsed.value, token));
      changes++;
      i = parsed.end;
    } else {
      out.push(token);
      i++;
    }
  }
  return { tokens: out, changes };
}

function matching(tokens: Token[], openAt: number, opener = "(", closer = ")"): number {
  let depth = 0;
  for (let i = openAt; i < tokens.length; i++) {
    if (tokens[i].type === "comment") continue;
    if (tokens[i].value === opener) depth++;
    else if (tokens[i].value === closer && --depth === 0) return i;
  }
  return -1;
}

function callArguments(tokens: Token[], openAt: number, closeAt: number): Token[][] {
  const args: Token[][] = [];
  let start = openAt + 1;
  const depth = { "(": 0, "[": 0, "{": 0 };
  for (let i = start; i < closeAt; i++) {
    const value = tokens[i].value;
    if (tokens[i].type === "comment") continue;
    if (value === "(") depth["("]++;
    else if (value === ")") depth["("]--;
    else if (value === "[") depth["["]++;
    else if (value === "]") depth["["]--;
    else if (value === "{") depth["{"]++;
    else if (value === "}") depth["{"]--;
    else if (value === "," && depth["("] === 0 && depth["["] === 0 && depth["{"] === 0) {
      args.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  if (start < closeAt || args.length) args.push(tokens.slice(start, closeAt));
  return args;
}

function onlyLiteral(tokens: Token[]): Literal | null {
  const filtered = tokens.filter((token) => token.type !== "comment");
  const parsed = parseLiteralExpression(filtered, 0);
  return parsed && parsed.end === filtered.length ? parsed.value : null;
}

function literalString(value: Literal | null): string | null {
  if (!value) return null;
  if (value.kind === "string") return value.value;
  if (value.kind === "number") return numberText(value.value);
  return null;
}

function evaluateCall(name: string, args: Token[][]): { type: "string" | "number"; value: string } | null {
  const values = args.map(onlyLiteral);
  if (name === "string.char" && values.length > 0 && values.every((value) => value?.kind === "number")) {
    const bytes = values.map((value) => (value as Extract<Literal, { kind: "number" }>).value);
    if (bytes.length > 65_536 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
    return { type: "string", value: String.fromCharCode(...bytes) };
  }

  if (name === "table.concat" && args[0]?.[0]?.value === "{") {
    const tableTokens = args[0];
    const close = matching(tableTokens, 0, "{", "}");
    if (close < 0 || close !== tableTokens.length - 1) return null;
    const wrapped = [makeToken("op", "("), ...tableTokens.slice(1, close), makeToken("op", ")")];
    const fields = callArguments(wrapped, 0, wrapped.length - 1).filter((field) => field.some((token) => token.type !== "comment"));
    const items = fields.map(onlyLiteral);
    if (items.some((item) => !item || (item.kind !== "string" && item.kind !== "number"))) return null;
    const separator = args[1] ? literalString(values[1]) : "";
    if (separator === null) return null;
    const parts = items.map((item) => literalString(item)!);
    const joined = parts.join(separator);
    return joined.length <= MAX_LITERAL_SIZE ? { type: "string", value: joined } : null;
  }

  if (name === "string.reverse" && values[0]?.kind === "string") {
    const value = values[0].value;
    if (value.length <= MAX_LITERAL_SIZE && /^[\x00-\x7f]*$/.test(value)) return { type: "string", value: [...value].reverse().join("") };
  }

  if (name === "string.rep" && values[0]?.kind === "string" && values[1]?.kind === "number") {
    const text = values[0].value;
    const count = values[1].value;
    const separator = values[2]?.kind === "string" ? values[2].value : "";
    if (/^[\x00-\x7f]*$/.test(text + separator) && Number.isInteger(count) && count >= 0 && count <= 10_000 && text.length * count + separator.length * Math.max(0, count - 1) <= MAX_LITERAL_SIZE) {
      return { type: "string", value: Array.from({ length: count }, () => text).join(separator) };
    }
  }

  if (name === "tonumber" && values[0]?.kind === "string" && values.length <= 2) {
    let parsed: number | null = null;
    if (values[1]?.kind === "number" && Number.isInteger(values[1].value) && values[1].value >= 2 && values[1].value <= 36) {
      const base = values[1].value;
      const digits = values[0].value.trim();
      const validDigits = "0123456789abcdefghijklmnopqrstuvwxyz".slice(0, base);
      if (digits && new RegExp(`^[+-]?[${validDigits}]+$`, "i").test(digits)) parsed = parseInt(digits, base);
    } else if (!values[1]) parsed = numValue(values[0].value);
    return parsed === null || !Number.isFinite(parsed) ? null : { type: "number", value: numberText(parsed) };
  }

  if (name === "tostring" && values[0]?.kind === "number") return { type: "string", value: numberText(values[0].value) };
  if (name === "tostring" && values[0]?.kind === "boolean") return { type: "string", value: String(values[0].value) };
  return null;
}

function foldCalls(tokens: Token[]): { tokens: Token[]; changes: number } {
  const out: Token[] = [];
  let changes = 0;
  let i = 0;
  while (i < tokens.length) {
    const nameToken = tokens[i];
    if (nameToken.type === "comment") { out.push(nameToken); i++; continue; }
    let functionName: string | null = null;
    let openAt = -1;
    if (nameToken.value === "string" && tokens[i + 1]?.value === "." && isName(tokens[i + 2])) {
      functionName = `string.${tokens[i + 2].value}`;
      openAt = i + 3;
    } else if (nameToken.value === "table" && tokens[i + 1]?.value === "." && tokens[i + 2]?.value === "concat") {
      functionName = "table.concat";
      openAt = i + 3;
    } else if (nameToken.value === "tonumber" || nameToken.value === "tostring") {
      functionName = nameToken.value;
      openAt = i + 1;
    }
    if (!functionName || tokens[openAt]?.value !== "(") { out.push(nameToken); i++; continue; }

    const closeAt = matching(tokens, openAt);
    if (closeAt < 0) { out.push(nameToken); i++; continue; }
    const args = callArguments(tokens, openAt, closeAt);
    const value = evaluateCall(functionName, args);
    if (value === null) { out.push(nameToken); i++; continue; }
    out.push(makeToken(value.type, value.value, nameToken));
    changes++;
    i = closeAt + 1;
  }
  return { tokens: out, changes };
}

function foldTableAliases(tokens: Token[]): { tokens: Token[]; changes: number } {
  const tables = new Map<string, Token[]>();
  const assignments = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "name" || tokens[i - 1]?.value !== "local" || tokens[i + 1]?.value !== "=") continue;
    const name = tokens[i].value;
    if (tokens[i + 2]?.value !== "{") continue;
    const close = matching(tokens, i + 2, "{", "}");
    if (close >= 0) tables.set(name, tokens.slice(i + 2, close + 1));
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === "name" && tokens[i + 1]?.value === "=" && tokens[i - 1]?.value !== "local") {
      assignments.set(tokens[i].value, (assignments.get(tokens[i].value) ?? 0) + 1);
    }
  }

  const safeTables = new Map([...tables].filter(([name]) => !assignments.has(name)));
  const output: Token[] = [];
  let changes = 0;
  for (let i = 0; i < tokens.length;) {
    const isConcat = tokens[i]?.value === "table" && tokens[i + 1]?.value === "." && tokens[i + 2]?.value === "concat" && tokens[i + 3]?.value === "(";
    if (!isConcat) { output.push(tokens[i++]); continue; }
    const close = matching(tokens, i + 3);
    if (close < 0) { output.push(tokens[i++]); continue; }
    const args = callArguments(tokens, i + 3, close);
    const first = args[0]?.filter((token) => token.type !== "comment") ?? [];
    const table = first.length === 1 && first[0].type === "name" ? safeTables.get(first[0].value) : undefined;
    if (!table) { output.push(tokens[i++]); continue; }
    const value = evaluateCall("table.concat", [table, ...(args[1] ? [args[1]] : [])]);
    if (!value) { output.push(tokens[i++]); continue; }
    output.push(makeToken(value.type, value.value, tokens[i]));
    changes++;
    i = close + 1;
  }
  return { tokens: output, changes };
}

function looksLikeLua(source: string): boolean {
  const code = source.trim();
  if (!code || code.length > MAX_SOURCE_SIZE || /\0/.test(code)) return false;
  const tokens = tokenize(code, false).filter((token) => token.type !== "eof");
  if (!tokens.length || tokens.some((token) => token.type === "unknown" || token.error)) return false;
  const first = tokens[0];
  if (first?.type === "keyword" && ["local", "function", "return", "if", "for", "while", "repeat", "do", "break"].includes(first.value)) return true;
  if (tokens.some((token) => token.value === "=" || token.value === ";" || token.value === "(" || token.value === "{" || token.value === "..")) return true;
  return tokens.length >= 2 && tokens.some((token) => token.type === "keyword");
}

function decodeBase64(value: string): string | null {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (normalized.length < 8 || normalized.length > MAX_SOURCE_SIZE * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  if (normalized.length % 4 === 1) return null;
  try {
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { decoded = binary; }
    return looksLikeLua(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function decodeBase64Literals(tokens: Token[]): { tokens: Token[]; changes: number } {
  const directPayloads = new Set<number>();
  const payloadLocals = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "name" || tokens[i].value !== "loadstring" && tokens[i].value !== "load" || tokens[i + 1]?.value !== "(") continue;
    const close = matching(tokens, i + 1);
    if (close < 0) continue;
    const args = callArguments(tokens, i + 1, close);
    const argument = args.length === 1 ? args[0]?.filter((token) => token.type !== "comment") : undefined;
    if (argument?.length === 1 && argument[0].type === "string") {
      const index = tokens.indexOf(argument[0], i + 2);
      if (index >= 0) directPayloads.add(index);
    } else if (argument?.length === 1 && argument[0].type === "name") payloadLocals.add(argument[0].value);
  }

  const localPayloadIndexes = new Set<number>();
  for (let i = 1; i + 2 < tokens.length; i++) {
    if (tokens[i].type === "name" && tokens[i - 1]?.value === "local" && tokens[i + 1]?.value === "=" && payloadLocals.has(tokens[i].value) && tokens[i + 2]?.type === "string") {
      localPayloadIndexes.add(i + 2);
    }
  }

  let changes = 0;
  const output = tokens.map((token, index) => {
    if (token.type !== "string" || token.error || !directPayloads.has(index) && !localPayloadIndexes.has(index)) return token;
    const decoded = decodeBase64(token.value);
    if (decoded === null) return token;
    changes++;
    return makeToken("string", decoded, token);
  });
  return { tokens: output, changes };
}

function collectLiteralLocals(tokens: Token[]): Map<string, Token> {
  const declarations = new Map<string, { token: Token; assignments: number }>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "name" || tokens[i - 1]?.value !== "local" || tokens[i + 1]?.value !== "=") continue;
    const rhs = tokens[i + 2];
    if (rhs?.type === "string" && !rhs.error) declarations.set(token.value, { token: rhs, assignments: 1 });
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === "name" && tokens[i + 1]?.value === "=") {
      const entry = declarations.get(tokens[i].value);
      if (entry && tokens[i - 1]?.value !== "local") entry.assignments++;
    }
  }
  return new Map([...declarations].filter(([, entry]) => entry.assignments === 1).map(([name, entry]) => [name, entry.token]));
}

function propagateLoaderLocals(tokens: Token[]): { tokens: Token[]; changes: number } {
  const literals = collectLiteralLocals(tokens);
  let changes = 0;
  const output = tokens.map((token, index) => {
    const isLoaderArgument = tokens[index - 1]?.value === "(" &&
      (tokens[index - 2]?.value === "load" || tokens[index - 2]?.value === "loadstring") &&
      tokens[index + 1]?.value === ")";
    const value = token.type === "name" && isLoaderArgument ? literals.get(token.value) : undefined;
    if (!value) return token;
    changes++;
    return makeToken("string", value.value, token);
  });
  return { tokens: output, changes };
}

const COMMON_GLOBALS = new Set([
  "assert", "collectgarbage", "coroutine", "debug", "dofile", "error", "getmetatable", "ipairs", "load", "loadfile",
  "loadstring", "math", "next", "pairs", "pcall", "print", "rawequal", "rawget", "rawlen", "rawset", "require",
  "select", "setmetatable", "string", "table", "tonumber", "tostring", "type", "utf8", "warn", "xpcall",
  "game", "workspace", "script", "task", "Instance", "Vector3", "CFrame", "Color3", "UDim2", "Enum",
]);

function simplifyEnvironmentIndexes(tokens: Token[]): { tokens: Token[]; changes: number } {
  const literals = collectLiteralLocals(tokens);
  const locallyDeclared = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value === "local" && tokens[i + 1]?.type === "name") locallyDeclared.add(tokens[i + 1].value);
  }
  const output: Token[] = [];
  let changes = 0;
  for (let i = 0; i < tokens.length; i++) {
    const isEnv = tokens[i].value === "_G" && tokens[i + 1]?.value === "[";
    if (!isEnv) { output.push(tokens[i]); continue; }
    const key = tokens[i + 2];
    const close = tokens[i + 3];
    const value = key?.type === "string" ? key.value : key?.type === "name" ? literals.get(key.value)?.value : undefined;
    if (close?.value === "]" && value && isIdentifierName(value) && COMMON_GLOBALS.has(value) && !locallyDeclared.has(value)) {
      output.push(makeToken("name", value, tokens[i]));
      changes++;
      i += 3;
    } else output.push(tokens[i]);
  }
  return { tokens: output, changes };
}

function isStaticInitializer(tokens: Token[], start: number): number | null {
  const value = tokens[start];
  if (!value) return null;
  if ((value.type === "string" || value.type === "number") && !value.error) return start;
  if (value.type === "keyword" && ["true", "false", "nil"].includes(value.value)) return start;
  if (value.value !== "{") return null;
  const close = matching(tokens, start, "{", "}");
  if (close < 0) return null;
  const safe = tokens.slice(start + 1, close).every((token) =>
    token.type === "comment" || token.value === "," || token.type === "string" || token.type === "number" ||
    token.value === "true" || token.value === "false" || token.value === "nil",
  );
  return safe ? close : null;
}

function unpackScaffoldingNames(tokens: Token[]): Set<string> {
  const roots = new Set<string>();
  const dependencies = new Map<string, Set<string>>();

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "name" || tokens[i].value !== "loadstring" && tokens[i].value !== "load" || tokens[i + 1]?.value !== "(") continue;
    const close = matching(tokens, i + 1);
    if (close < 0) continue;
    const args = callArguments(tokens, i + 1, close);
    const argument = args.length === 1 ? args[0]?.filter((token) => token.type !== "comment") ?? [] : [];
    if (argument.length === 1 && argument[0].type === "name") roots.add(argument[0].value);
    if (argument[0]?.value === "table" && argument[1]?.value === "." && argument[2]?.value === "concat") {
      for (const token of argument.slice(4)) if (token.type === "name") roots.add(token.value);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value === "_G" && tokens[i + 1]?.value === "[" && tokens[i + 2]?.type === "name") roots.add(tokens[i + 2].value);
    if (tokens[i].value !== "local" || tokens[i + 1]?.type !== "name" || tokens[i + 2]?.value !== "=") continue;
    const name = tokens[i + 1].value;
    const rhs = tokens[i + 3];
    const values = new Set<string>();
    if (rhs?.type === "name" && tokens[i + 4]?.value !== "(" && tokens[i + 4]?.value !== ".") values.add(rhs.value);
    if (rhs?.value === "table" && tokens[i + 4]?.value === "." && tokens[i + 5]?.value === "concat" && tokens[i + 6]?.value === "(") {
      const close = matching(tokens, i + 6);
      if (close >= 0) for (const token of tokens.slice(i + 7, close)) if (token.type === "name") values.add(token.value);
    }
    dependencies.set(name, values);
  }

  const queue = [...roots];
  const visited = new Set<string>();
  while (queue.length) {
    const name = queue.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    for (const dependency of dependencies.get(name) ?? []) queue.push(dependency);
  }
  return visited;
}

function pruneUnusedLiteralLocals(tokens: Token[], allowedNames: Set<string>): { tokens: Token[]; changes: number } {
  const removable: { start: number; end: number; name: string; declaration: number }[] = [];
  for (let i = 0; i < tokens.length - 3; i++) {
    if (tokens[i].value !== "local" || tokens[i + 1]?.type !== "name" || tokens[i + 2]?.value !== "=") continue;
    if (!allowedNames.has(tokens[i + 1].value)) continue;
    const end = isStaticInitializer(tokens, i + 3);
    if (end === null) continue;
    const name = tokens[i + 1].value;
    const references = tokens.some((token, index) => index !== i + 1 && token.type === "name" && token.value === name);
    if (references) continue;
    const semicolon = tokens[end + 1]?.value === ";" ? end + 1 : end;
    removable.push({ start: i, end: semicolon, name, declaration: i + 1 });
    i = end;
  }
  if (!removable.length) return { tokens, changes: 0 };
  const removedIndexes = new Set<number>();
  for (const item of removable) for (let i = item.start; i <= item.end; i++) removedIndexes.add(i);
  return { tokens: tokens.filter((_, index) => !removedIndexes.has(index)), changes: removable.length };
}

function statementBoundaryBefore(tokens: Token[], index: number): boolean {
  if (index === 0) return true;
  const previous = tokens[index - 1];
  const current = tokens[index];
  const previousEndsStatement = previous.type === "name" || previous.type === "number" || previous.type === "string" ||
    [")", "]", "}", "end", "true", "false", "nil", "break"].includes(previous.value);
  return previous.type === "comment" ||
    previous.value === ";" ||
    ["then", "do", "else", "end", "repeat"].includes(previous.value) ||
    previousEndsStatement ||
    previous.line < current.line;
}

function statementBoundaryAfter(tokens: Token[], index: number): boolean {
  const current = tokens[index];
  const next = tokens[index + 1];
  if (!next || next.type === "eof") return true;
  return next.type === "comment" || next.value === ";" ||
    ["end", "else", "elseif", "until"].includes(next.value) ||
    current.line < next.line;
}

function unwrapLoaders(tokens: Token[]): { tokens: Token[]; changes: number; payloads: string[] } {
  const output: Token[] = [];
  const payloads: string[] = [];
  let changes = 0;

  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    const recognized = token.type === "name" && (token.value === "loadstring" || token.value === "load");
    if (!recognized || tokens[i + 1]?.value !== "(" || !statementBoundaryBefore(tokens, i)) {
      output.push(token);
      i++;
      continue;
    }

    const closeAt = matching(tokens, i + 1);
    if (closeAt < 0) { output.push(token); i++; continue; }
    const args = callArguments(tokens, i + 1, closeAt);
    const source = args.length === 1 ? literalString(onlyLiteral(args[0])) : null;
    const callEnd = closeAt + 1;
    const invoked = tokens[callEnd]?.value === "(" && tokens[callEnd + 1]?.value === ")";
    const end = invoked ? callEnd + 2 : callEnd;
    const safeStatement = invoked && statementBoundaryAfter(tokens, end - 1);

    if (source && looksLikeLua(source)) {
      if (!payloads.includes(source)) payloads.push(source);
      if (safeStatement) {
        const inner = tokenize(source, true).filter((part) => part.type !== "eof");
        output.push(...inner);
        changes++;
        i = end;
        continue;
      }
    }

    output.push(token);
    i++;
  }
  return { tokens: output, changes, payloads };
}

function collectPayloads(tokens: Token[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "string") continue;
    const loaderContext = (tokens[i - 1]?.value === "(" &&
      (tokens[i - 2]?.value === "loadstring" || tokens[i - 2]?.value === "load")) ||
      looksLikeLua(token.value);
    const decoded = decodeBase64(token.value);
    const candidate = decoded ?? (loaderContext && looksLikeLua(token.value) ? token.value : null);
    if (candidate && !found.includes(candidate)) found.push(candidate);
  }
  return found.sort((a, b) => b.length - a.length);
}

function isIdentifierName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !KEYWORDS.has(value);
}

function simplifyIndexes(tokens: Token[]): { tokens: Token[]; changes: number } {
  const output: Token[] = [];
  let changes = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const previous = output[output.length - 1];
    const key = tokens[i + 1];
    if (token.value === "[" && key?.type === "string" && tokens[i + 2]?.value === "]" &&
      isIdentifierName(key.value) && previous && ["name", ")", "]", "}"].some((value) => previous.type === value || previous.value === value)) {
      output.push(makeToken("op", ".", token), makeToken("name", key.value, key));
      changes++;
      i += 2;
    } else output.push(token);
  }
  return { tokens: output, changes };
}

interface Scope {
  start: number;
  end: number;
  parent: Scope | null;
  depth: number;
}

interface Binding {
  name: string;
  index: number;
  visibleFrom: number;
  scope: Scope;
  isFunction: boolean;
}

function functionHeader(tokens: Token[], index: number): { open: number; close: number } | null {
  let open = index + 1;
  while (open < tokens.length && tokens[open].value !== "(" && tokens[open].value !== "end") open++;
  if (tokens[open]?.value !== "(") return null;
  const close = matching(tokens, open);
  return close < 0 ? null : { open, close };
}

function functionClose(tokens: Token[], index: number): number {
  return functionHeader(tokens, index)?.close ?? -1;
}

function buildScopes(tokens: Token[]): { root: Scope; scopes: Scope[]; functionBodies: Map<number, { open: number; close: number }> } {
  const root: Scope = { start: 0, end: tokens.length, parent: null, depth: 0 };
  const scopes = [root];
  const stack: Scope[] = [root];
  const functionBodies = new Map<number, { open: number; close: number }>();
  let pendingIf = 0;

  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (value === "function") {
      const header = functionHeader(tokens, i);
      if (header) functionBodies.set(i, header);
    } else if (value === "if") pendingIf++;
    else if (value === "then" && pendingIf > 0) {
      pendingIf--;
      const scope: Scope = { start: i + 1, end: tokens.length, parent: stack[stack.length - 1], depth: stack.length };
      scopes.push(scope); stack.push(scope);
    } else if (value === "do") {
      const scope: Scope = { start: i + 1, end: tokens.length, parent: stack[stack.length - 1], depth: stack.length };
      scopes.push(scope); stack.push(scope);
    } else if (value === "repeat") {
      const scope: Scope = { start: i + 1, end: tokens.length, parent: stack[stack.length - 1], depth: stack.length };
      scopes.push(scope); stack.push(scope);
    } else if (value === "end") {
      if (stack.length > 1) {
        const scope = stack.pop()!;
        scope.end = i;
      }
    } else if (value === "until") {
      const top = stack[stack.length - 1];
      if (top && top !== root) { top.end = i; stack.pop(); }
    }

    const body = functionBodies.get(i);
    if (body) {
      const scope: Scope = { start: body.close + 1, end: tokens.length, parent: stack[stack.length - 1], depth: stack.length };
      scopes.push(scope);
      stack.push(scope);
    }
  }
  return { root, scopes, functionBodies };
}

function statementEnd(tokens: Token[], start: number): number | null {
  const startLine = tokens[start]?.line ?? 1;
  let parens = 0, brackets = 0, braces = 0;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "comment") {
      if (token.line > startLine && parens === 0 && brackets === 0 && braces === 0) return i;
      continue;
    }
    if (token.value === "(" ) parens++;
    else if (token.value === ")") parens--;
    else if (token.value === "[") brackets++;
    else if (token.value === "]") brackets--;
    else if (token.value === "{") braces++;
    else if (token.value === "}") braces--;

    if (i > start && parens === 0 && brackets === 0 && braces === 0) {
      if (token.value === ";" || token.line > startLine || ["local", "return", "if", "for", "while", "function", "repeat", "break"].includes(token.value)) return i;
    }
  }
  return null;
}

function isGarbageName(name: string): boolean {
  return /^[Il1O0_]{4,}$/.test(name) ||
    /^_+\d*$/.test(name) && name.length > 2 ||
    /^[A-Za-z]_*0x[0-9a-fA-F]+$/.test(name) ||
    /^[A-Za-z]{1,3}\d{4,}$/.test(name) ||
    /^[A-Za-z_]*[Il1O0]{5,}[A-Za-z_0-9]*$/.test(name) ||
    /^[A-Za-z_]\w{11,}$/.test(name) && !/[aeiou]/i.test(name);
}

function renameLocalGarbage(tokens: Token[]): { tokens: Token[]; changes: number; bindings: number } {
  const { root, scopes, functionBodies } = buildScopes(tokens);
  const bindings: Binding[] = [];
  const scopeAt = (index: number) => scopes
    .filter((scope) => scope.start <= index && index <= scope.end)
    .sort((a, b) => b.depth - a.depth)[0] ?? root;

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value === "local") {
      if (tokens[i + 1]?.value === "function" && tokens[i + 2]?.type === "name") {
        const name = tokens[i + 2];
        bindings.push({ name: name.value, index: i + 2, visibleFrom: i + 2, scope: scopeAt(i), isFunction: true });
        continue;
      }
      let j = i + 1;
      const declarations: number[] = [];
      while (tokens[j]?.type === "name") {
        declarations.push(j++);
        if (tokens[j]?.value !== ",") break;
        j++;
      }
      if (!declarations.length) continue;
      const declarationScope = scopeAt(i);
      let visibleFrom = j;
      if (tokens[j]?.value === "=") {
        const end = statementEnd(tokens, j + 1);
        if (end === null && j + 1 < tokens.length) continue;
        visibleFrom = end ?? j + 1;
      }
      for (const index of declarations) bindings.push({
        name: tokens[index].value,
        index,
        visibleFrom,
        scope: declarationScope,
        isFunction: false,
      });
    }
  }

  for (const [functionIndex, body] of functionBodies) {
    const functionScope = scopes.find((scope) => scope.start === body.close + 1 && scope.parent === scopeAt(functionIndex));
    if (!functionScope) continue;
    const open = body.open;
    for (let i = open + 1; i < body.close; i++) {
      if (tokens[i].type === "name") bindings.push({
        name: tokens[i].value,
        index: i,
        visibleFrom: body.close + 1,
        scope: functionScope,
        isFunction: false,
      });
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== "for") continue;
    let body = i + 1;
    while (body < tokens.length && tokens[body].value !== "do") body++;
    if (body >= tokens.length) continue;
    const loopScope = scopes.find((scope) => scope.start === body + 1);
    if (!loopScope) continue;
    for (let j = i + 1; j < body && tokens[j].value !== "=" && tokens[j].value !== "in"; j++) {
      if (tokens[j].type === "name") bindings.push({ name: tokens[j].value, index: j, visibleFrom: body + 1, scope: loopScope, isFunction: false });
    }
  }

  const candidates = bindings.filter((binding) => isGarbageName(binding.name));
  if (!candidates.length) return { tokens, changes: 0, bindings: 0 };

  const usedNames = new Set(tokens.filter((token) => token.type === "name").map((token) => token.value));
  let variableCounter = 1;
  let functionCounter = 1;
  const tokenNames = new Map<number, string>();
  for (const binding of candidates) {
    let newName: string;
    do {
      newName = binding.isFunction ? `decoded_fn_${functionCounter++}` : `decoded_${variableCounter++}`;
    } while (usedNames.has(newName));
    usedNames.add(newName);
    tokenNames.set(binding.index, newName);
  }

  const declarationIndexes = new Set(candidates.map((binding) => binding.index));
  let changes = 0;
  const output = tokens.map((token, index) => {
    let renamed = tokenNames.get(index);
    if (!renamed && token.type === "name" && !declarationIndexes.has(index)) {
      const previous = tokens[index - 1];
      const next = tokens[index + 1];
      const isProperty = previous?.value === "." || previous?.value === ":" || previous?.value === "::";
      const isTableKey = next?.value === "=" && (previous?.value === "{" || previous?.value === ",");
      const isLabel = previous?.value === "goto" || previous?.value === "::";
      if (!isProperty && !isTableKey && !isLabel) {
        const resolved = candidates
          .filter((binding) => binding.name === token.value && binding.visibleFrom <= index && binding.scope.start <= index && binding.scope.end >= index)
          .sort((a, b) => b.scope.depth - a.scope.depth || b.visibleFrom - a.visibleFrom)[0];
        if (resolved) renamed = tokenNames.get(resolved.index);
      }
    }
    if (!renamed) return token;
    changes++;
    return { ...token, value: renamed, raw: renamed, changed: true };
  });
  return { tokens: output, changes, bindings: candidates.length };
}

function matchingIfEnd(tokens: Token[], start: number): { end: number; hasAlternate: boolean } | null {
  const stack: string[] = ["if"];
  let hasAlternate = false;
  for (let i = start + 3; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "comment") continue;
    if ((token.value === "else" || token.value === "elseif") && stack.length === 1) hasAlternate = true;
    if (token.value === "if") stack.push("if");
    else if (token.value === "function" || token.value === "do") stack.push(token.value);
    else if (token.value === "repeat") stack.push("repeat");
    else if (token.value === "until") {
      if (stack[stack.length - 1] === "repeat") stack.pop();
    } else if (token.value === "end") {
      if (stack[stack.length - 1] === "repeat") return null;
      stack.pop();
      if (!stack.length) return { end: i, hasAlternate };
    }
  }
  return null;
}

function removeDeadBranches(tokens: Token[]): { tokens: Token[]; changes: number } {
  const output: Token[] = [];
  let changes = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const condition = tokens[i + 1];
    if (token.value === "if" && (condition?.value === "false" || condition?.value === "nil") && tokens[i + 2]?.value === "then") {
      const block = matchingIfEnd(tokens, i);
      if (block && !block.hasAlternate) {
        changes++;
        i = block.end;
        continue;
      }
    }
    if (token.value === ";" && output[output.length - 1]?.value === ";") { changes++; continue; }
    output.push(token);
  }
  return { tokens: output, changes };
}

function outputString(token: Token, decodeStrings: boolean): string {
  if (!token.changed && !decodeStrings) return token.raw;
  if (!token.changed && !/\\(?:[0-9]{1,3}|x[0-9a-fA-F]{2}|u\{|z)/.test(token.raw)) return token.raw;
  const value = token.value;
  if (value.includes("\n")) {
    for (let level = 0; level < 4; level++) {
      const close = "]" + "=".repeat(level) + "]";
      if (!value.includes(close)) return "[" + "=".repeat(level) + "[\n" + value + close;
    }
  }
  const quote = (value.match(/"/g)?.length ?? 0) <= (value.match(/'/g)?.length ?? 0) ? '"' : "'";
  let output = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === quote || char === "\\") output += "\\" + char;
    else if (char === "\n") output += "\\n";
    else if (char === "\r") output += "\\r";
    else if (char === "\t") output += "\\t";
    else if (code < 32 || code === 127 || (token.changed && code >= 128 && code <= 255)) output += "\\" + String(code).padStart(3, "0");
    else output += char;
  }
  return quote + output + quote;
}

const BINARY_OPERATORS = new Set([
  "+", "-", "*", "/", "//", "%", "^", "..", "==", "~=", "<", ">", "<=", ">=", "=", "and", "or", "&", "|", "~", "<<", ">>",
]);

function formatLua(tokens: Token[], options: Options): string {
  const eof = tokens.filter((token) => token.type !== "eof");
  if (!eof.length) return "";
  const functionHeaderEnds = new Set<number>();
  for (let i = 0; i < eof.length; i++) {
    if (eof[i].value === "function") {
      const close = functionClose(eof, i);
      if (close >= 0) functionHeaderEnds.add(close);
    }
  }

  const output: string[] = [];
  let indent = 0;
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  const braces: boolean[] = [];
  const startLine = () => { if (!current) current = options.indent.repeat(Math.max(0, indent)); };
  const flush = () => {
    const line = current.replace(/[\t ]+$/, "");
    if (line.trim()) output.push(line);
    current = "";
  };
  const append = (value: string) => { startLine(); current += value; };

  for (let i = 0; i < eof.length; i++) {
    const token = eof[i];
    const previous = eof[i - 1];
    const next = eof[i + 1];
    const value = token.value;

    if (token.type === "comment") {
      if (current.trim()) current += " ";
      append(token.raw);
      flush();
      continue;
    }
    if (value === ";") { flush(); continue; }

    if (value === "end" || value === "until" || value === "else" || value === "elseif" || value === "}") {
      if (value === "}") {
        if (braces.pop()) { indent--; if (current.trim()) flush(); }
      } else {
        indent--;
        if (current.trim()) flush();
      }
    }

    const unary = (value === "-" || value === "+") && (!previous ||
      previous.type === "op" && ![")", "]", "}"].includes(previous.value) ||
      previous.type === "keyword" && ["return", "then", "do", "else", "in", "and", "or", "not"].includes(previous.value));

    const last = current[current.length - 1] ?? "";
    const previousIsWord = !!previous && (previous.type === "name" || previous.type === "number" || previous.type === "string" || previous.type === "keyword");
    const currentIsWord = token.type === "name" || token.type === "number" || token.type === "string" || token.type === "keyword";
    const isBinary = BINARY_OPERATORS.has(value) && !unary;
    const previousBinary = !!previous && BINARY_OPERATORS.has(previous.value);

    let needSpace = false;
    if (current.trim() && currentIsWord && previousIsWord) needSpace = true;
    if (current.trim() && (isBinary || previousBinary)) needSpace = true;
    if (current.trim() && value === "(" && previous?.type === "keyword" && previous.value !== "function") needSpace = true;
    if (current.trim() && value === "{" && previousIsWord) needSpace = true;
    if (current.trim() && value === "not") needSpace = true;
    if (current.trim() && previous?.value === "not") needSpace = true;
    if (value === "." || value === ":" || value === "::" || value === ")" || value === "]" || value === "}" || value === "," || value === ";") needSpace = false;
    if (previous?.value === "." || previous?.value === ":" || previous?.value === "::" || previous?.value === "(" || previous?.value === "[" || previous?.value === "#") needSpace = false;
    if (value === "(" && previous?.type === "name") needSpace = false;
    if (value === "[" && previous?.type === "name") needSpace = false;
    if (value === "}" && (last === "{" || last === " ")) needSpace = false;
    if (unary) needSpace = previousBinary || previousIsWord && ["return", "in", "then", "do", "else", "local"].includes(previous?.value ?? "");
    if (needSpace && last !== " " && last !== "\t") append(" ");

    if (token.type === "string") append(outputString(token, options.decodeStrings));
    else append(token.raw);

    if (value === ",") append(" ");
    if (value === "then" || value === "do" || value === "else" || value === "repeat") {
      indent++;
      flush();
      continue;
    }
    if (functionHeaderEnds.has(i)) {
      parenDepth = Math.max(0, parenDepth - 1);
      indent++;
      flush();
      continue;
    }
    if (value === "until") continue;
    if (value === "end") {
      if (!next || next.type === "eof" || next.value !== ")" && next.value !== "]" && next.value !== "}" && next.value !== "," && next.value !== "." && next.value !== ":") flush();
      continue;
    }
    if (value === "{") {
      const close = matching(eof, i, "{", "}");
      const lineCount = close >= 0 ? new Set(eof.slice(i, close + 1).map((part) => part.line)).size : 0;
      const commas = close >= 0 ? eof.slice(i + 1, close).filter((part) => part.value === ",").length : 0;
      const multiline = lineCount > 1 || commas >= 4 || (close >= 0 && close - i > 18);
      braces.push(multiline);
      if (multiline) { indent++; flush(); }
      continue;
    }
    if (value === "}") {
      const beginsStatement = next?.type === "keyword" && ["local", "if", "for", "while", "return", "function", "repeat", "break", "goto", "do"].includes(next.value);
      const beginsNameStatement = next?.type === "name";
      if ((beginsStatement || beginsNameStatement) && braces.length === 0 && parenDepth === 0 && bracketDepth === 0) flush();
      continue;
    }
    if (value === "," && braces[braces.length - 1] && parenDepth === 0 && bracketDepth === 0) {
      flush();
      continue;
    }

    if (value === "(") parenDepth++;
    else if (value === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (value === "[") bracketDepth++;
    else if (value === "]") bracketDepth = Math.max(0, bracketDepth - 1);

    const endsExpression = token.type === "name" || token.type === "number" || token.type === "string" ||
      [")", "]", "}", "...", "end", "true", "false", "nil", "break"].includes(value);
    const startsStatement = next?.type === "keyword" &&
      ["local", "if", "for", "while", "return", "function", "repeat", "break", "goto", "do"].includes(next.value);
    const startsNameStatement = next?.type === "name" && endsExpression;
    const shouldBreak = endsExpression && (startsStatement || startsNameStatement) && parenDepth === 0 && bracketDepth === 0 && braces.length === 0;
    if (shouldBreak) flush();
  }

  flush();
  return output.join("\n") + (output.length ? "\n" : "");
}

const DETECTION_RULES: [RegExp, string][] = [
  [/Luraph|LPH!|LPH_/i, "Luraph markers"],
  [/IronBrew/i, "IronBrew markers"],
  [/Prometheus|prometheus_/i, "Prometheus markers"],
  [/MoonSec/i, "MoonSec markers"],
  [/\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){3,}/i, "Hex-escaped string runs"],
  [/string\.char\s*\(/, "Character-code string construction"],
  [/loadstring|\bload\s*\(/, "Dynamic code loader"],
  [/_ENV\s*\[|getfenv|setfenv/, "Environment indirection"],
  [/bit32?\.(?:bxor|band|bor)/, "Bitwise decoder primitives"],
  [/\b(?:IlIl|lI1|O0O|0O0)[A-Za-z0-9_]{2,}/, "Confusable identifier pattern"],
  [/while\s+true\s+do[\s\S]{0,120}?if\s+\w+\s*==\s*\d+/, "Possible flattened state machine"],
];

export function detectObfuscators(source: string): string[] {
  return DETECTION_RULES.filter(([pattern]) => pattern.test(source)).map(([, label]) => label);
}

export function deobfuscate(source: string, requestedOptions: Options = DEFAULT_OPTIONS): DeobResult {
  const options = { ...DEFAULT_OPTIONS, ...requestedOptions };
  const warnings: string[] = [];
  const passes: PassResult[] = [];
  const detected = detectObfuscators(source);

  if (source.length > MAX_SOURCE_SIZE) {
    const message = `This file is larger than the ${MAX_SOURCE_SIZE.toLocaleString()} character client-side limit.`;
    return {
      code: "",
      passes,
      warnings: [message],
      detected,
      payloads: [],
      stats: { inChars: source.length, outChars: 0, inLines: source.split(/\r\n?|\n/).length, outLines: 0, tokens: 0, strings: 0, functions: 0, renamed: 0, layers: 0, changes: 0 },
    };
  }

  if (!source.trim()) {
    return {
      code: "", passes, warnings, detected, payloads: [],
      stats: { inChars: 0, outChars: 0, inLines: 0, outLines: 0, tokens: 0, strings: 0, functions: 0, renamed: 0, layers: 0, changes: 0 },
    };
  }

  const initial = tokenize(source, true);
  const scaffoldNames = unpackScaffoldingNames(initial);
  const initialCount = initial.filter((token) => token.type !== "eof" && token.type !== "comment").length;
  const initialStringEscapes = initial.filter((token) => token.type === "string" && /\\(?:[0-9]{1,3}|x[0-9a-fA-F]{2}|u\{|z)/.test(token.raw)).length;
  for (const token of initial) if (token.error) warnings.push(`Line ${token.line}: ${token.error}`);
  if (initialStringEscapes) passes.push({ name: "Decode string escapes", changes: initialStringEscapes, note: "String escapes are decoded and re-quoted without executing the script." });

  let tokens = initial;
  let changes = 0;
  let layers = 0;
  let decodedPayloads: string[] = [];
  let foldedCalls = 0;
  let decodedBase64 = 0;
  let propagated = 0;
  let foldedExpressions = 0;
  let foldedTables = 0;
  let simplifiedGlobals = 0;

  const iterations = options.deepUnpack ? MAX_LAYER_PASSES : 1;
  for (let round = 0; round < iterations; round++) {
    let roundChanges = 0;
    if (options.foldConstants || options.deepUnpack) {
      const expression = foldExpressions(tokens);
      tokens = expression.tokens;
      foldedExpressions += expression.changes;
      roundChanges += expression.changes;
      const calls = foldCalls(tokens);
      tokens = calls.tokens;
      foldedCalls += calls.changes;
      roundChanges += calls.changes;
      const tables = foldTableAliases(tokens);
      tokens = tables.tokens;
      foldedTables += tables.changes;
      roundChanges += tables.changes;
      const globals = simplifyEnvironmentIndexes(tokens);
      tokens = globals.tokens;
      simplifiedGlobals += globals.changes;
      roundChanges += globals.changes;
    }
    if (options.deepUnpack) {
      const base64 = decodeBase64Literals(tokens);
      tokens = base64.tokens;
      decodedBase64 += base64.changes;
      roundChanges += base64.changes;
      const substitutions = propagateLoaderLocals(tokens);
      tokens = substitutions.tokens;
      propagated += substitutions.changes;
      roundChanges += substitutions.changes;
      const unwrapped = unwrapLoaders(tokens);
      tokens = unwrapped.tokens;
      decodedPayloads = [...new Set([...decodedPayloads, ...unwrapped.payloads])];
      if (unwrapped.changes) layers++;
      roundChanges += unwrapped.changes;
      changes += roundChanges;
      if (!roundChanges) break;
    } else {
      changes += roundChanges;
      break;
    }
  }

  if (options.deepUnpack) {
    const count = foldedCalls + foldedTables + simplifiedGlobals + decodedBase64 + propagated;
    passes.push({
      name: "Unpack encoded layers",
      changes: count + layers,
      note: `${layers} loader layer(s), ${decodedBase64} base64 decode(s), ${foldedCalls + foldedTables + simplifiedGlobals} constant fold(s) and ${propagated} payload reference(s).`,
    });
  } else if (options.foldConstants) {
    passes.push({ name: "Evaluate constant expressions", changes: foldedExpressions + foldedCalls + foldedTables, note: "Only literal-only expressions and whitelisted pure string helpers are evaluated." });
  }

  const pruned = pruneUnusedLiteralLocals(tokens, scaffoldNames);
  tokens = pruned.tokens;
  if (pruned.changes) {
    changes += pruned.changes;
    passes.push({ name: "Remove unused decoder scaffolding", changes: pruned.changes, note: "Unused literal-only locals are removed after their payload has been recovered." });
  }

  if (options.simplifyIndex) {
    const result = simplifyIndexes(tokens);
    tokens = result.tokens;
    changes += result.changes;
    passes.push({ name: "Simplify constant indexes", changes: result.changes, note: 'a["field"] becomes a.field only when that is valid Lua syntax.' });
  }

  if (options.stripDeadCode) {
    const result = removeDeadBranches(tokens);
    tokens = result.tokens;
    changes += result.changes;
    passes.push({ name: "Remove provably dead branches", changes: result.changes, note: "Only literal false/nil branches without else arms are removed." });
  }

  let renamed = 0;
  if (options.renameVars) {
    const result = renameLocalGarbage(tokens);
    tokens = result.tokens;
    renamed = result.bindings;
    changes += result.changes;
    passes.push({ name: "Rename local obfuscated names", changes: result.changes, note: `${result.bindings} local binding(s); global names and table fields are left alone.` });
  }

  const payloads = [...new Set([...decodedPayloads, ...collectPayloads(tokens)])].sort((a, b) => b.length - a.length);
  const code = options.beautify
    ? formatLua(tokens, options)
    : tokens.filter((token) => token.type !== "eof").map((token) => token.type === "string" ? outputString(token, options.decodeStrings) : token.raw).join(" ");

  if (tokens.some((token) => token.value === "loadstring" || token.value === "load")) {
    warnings.push("A dynamic loader remains. Its payload may be computed at runtime, encrypted, or used inside an expression; this tool never executes untrusted Lua.");
  }
  if (detected.some((item) => /state machine|Luraph|IronBrew|MoonSec/i.test(item))) {
    warnings.push("This looks like VM or control-flow obfuscation. Static transforms can reveal literal layers, but cannot reliably reconstruct a virtualized program.");
  }
  if (!changes && initialCount > 0) warnings.push("No supported static transform matched. The result is a formatted Lua copy; this does not guarantee full deobfuscation.");

  return {
    code,
    passes,
    warnings: [...new Set(warnings)],
    detected,
    payloads,
    stats: {
      inChars: source.length,
      outChars: code.length,
      inLines: source.split(/\r\n?|\n/).length,
      outLines: code ? code.split("\n").length : 0,
      tokens: initialCount,
      strings: tokens.filter((token) => token.type === "string").length,
      functions: tokens.filter((token) => token.value === "function").length,
      renamed,
      layers,
      changes,
    },
  };
}

export function extractPayloads(source: string): string[] {
  return collectPayloads(tokenize(source, true));
}