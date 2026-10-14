export type TokType =
  | "name"
  | "keyword"
  | "number"
  | "string"
  | "op"
  | "comment"
  | "unknown"
  | "eof";

export interface Token {
  type: TokType;
  value: string;
  raw: string;
  pos: number;
  end: number;
  line: number;
  column: number;
  meta?: string;
  error?: string;
  changed?: boolean;
}

export const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if",
  "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
]);

const OPS = [
  "...", "..", "==", "~=", "<=", ">=", "//", "::", "<<", ">>",
  "+", "-", "*", "/", "%", "^", "#", "&", "~", "|", "<", ">", "=", "(", ")", "{", "}", "[", "]", ";", ":", ",", ".",
];

const isDigit = (c: string | undefined) => !!c && c >= "0" && c <= "9";
const isHex = (c: string | undefined) => !!c && /[0-9a-f]/i.test(c);
const isNameStart = (c: string | undefined) => !!c && /[A-Za-z_]/.test(c);
const isNamePart = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

interface LongBracket {
  content: string;
  end: number;
  level: number;
  closed: boolean;
}

function readLongBracket(src: string, start: number): LongBracket | null {
  if (src[start] !== "[") return null;
  let openerEnd = start + 1;
  while (src[openerEnd] === "=") openerEnd++;
  if (src[openerEnd] !== "[") return null;

  const level = openerEnd - start - 1;
  const bodyStart = openerEnd + 1;
  const closer = "]" + "=".repeat(level) + "]";
  const closeAt = src.indexOf(closer, bodyStart);
  const rawBodyEnd = closeAt < 0 ? src.length : closeAt;
  let contentStart = bodyStart;
  if (src[contentStart] === "\n") contentStart++;
  else if (src[contentStart] === "\r") contentStart += src[contentStart + 1] === "\n" ? 2 : 1;

  return {
    content: src.slice(contentStart, rawBodyEnd),
    end: closeAt < 0 ? src.length : closeAt + closer.length,
    level,
    closed: closeAt >= 0,
  };
}

/** Tokenizes Lua source while retaining comments and unknown characters. */
export function tokenize(src: string, keepComments = true): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;

  const advance = (to: number) => {
    while (i < to) {
      const c = src[i];
      if (c === "\r") {
        i += src[i + 1] === "\n" ? 2 : 1;
        line++;
        column = 1;
        continue;
      } else if (c === "\n") {
        line++;
        column = 1;
      } else {
        column++;
      }
      i++;
    }
  };

  const emit = (
    type: TokType,
    start: number,
    startLine: number,
    startColumn: number,
    value: string,
    raw: string,
    extra: Partial<Token> = {},
  ) => tokens.push({
    type, value, raw, pos: start, end: i, line: startLine, column: startColumn, ...extra,
  });

  if (src.startsWith("#!")) {
    const start = i;
    const startLine = line;
    const startColumn = column;
    while (i < src.length && src[i] !== "\n" && src[i] !== "\r") advance(i + 1);
    const raw = src.slice(start, i);
    if (keepComments) emit("comment", start, startLine, startColumn, raw.slice(2), raw);
  }

  while (i < src.length) {
    const c = src[i];
    if (c === "\n" || c === "\r") { advance(i + 1); continue; }
    if (c === " " || c === "\t" || c === "\f" || c === "\v") { advance(i + 1); continue; }

    const start = i;
    const startLine = line;
    const startColumn = column;

    if (c === "-" && src[i + 1] === "-") {
      const long = readLongBracket(src, i + 2);
      if (long) {
        advance(long.end);
        if (keepComments) {
          const raw = src.slice(start, i);
          emit("comment", start, startLine, startColumn, long.content, raw, {
            meta: `long:${long.level}`,
            error: long.closed ? undefined : "Unclosed long comment",
          });
        }
      } else {
        while (i < src.length && src[i] !== "\n" && src[i] !== "\r") advance(i + 1);
        const raw = src.slice(start, i);
        if (keepComments) emit("comment", start, startLine, startColumn, raw.slice(2), raw);
      }
      continue;
    }

    if (c === "[") {
      const long = readLongBracket(src, i);
      if (long) {
        advance(long.end);
        const raw = src.slice(start, i);
        emit("string", start, startLine, startColumn, long.content, raw, {
          meta: `long:${long.level}`,
          error: long.closed ? undefined : "Unclosed long string",
        });
        continue;
      }
    }

    if (c === "'" || c === '"') {
      const quote = c;
      advance(i + 1);
      let value = "";
      let error: string | undefined;
      while (i < src.length && src[i] !== quote) {
        const current = src[i];
        if (current === "\n" || current === "\r") {
          error ??= "Unescaped newline in quoted string";
          value += "\n";
          advance(i + 1);
          continue;
        }
        if (current !== "\\") {
          value += current;
          advance(i + 1);
          continue;
        }

        if (i + 1 >= src.length) {
          error ??= "Trailing escape in string";
          advance(i + 1);
          break;
        }

        const escaped = src[i + 1];
        if (escaped === "\n" || escaped === "\r") {
          value += "\n";
          advance(i + 2);
          if (escaped === "\r" && src[i] === "\n") advance(i + 1);
          continue;
        }

        if (escaped === "z") {
          advance(i + 2);
          while (i < src.length && /\s/.test(src[i])) advance(i + 1);
          continue;
        }

        const simpleEscapes: Record<string, string> = {
          a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
          "\\": "\\", '"': '"', "'": "'",
        };
        if (escaped in simpleEscapes) {
          value += simpleEscapes[escaped];
          advance(i + 2);
          continue;
        }

        if (escaped === "x") {
          const hex = src.slice(i + 2, i + 4);
          if (hex.length === 2 && [...hex].every(isHex)) {
            value += String.fromCharCode(parseInt(hex, 16));
            advance(i + 4);
          } else {
            error ??= "Invalid hexadecimal string escape";
            value += "x";
            advance(i + 2);
          }
          continue;
        }

        if (escaped === "u" && src[i + 2] === "{") {
          let end = i + 3;
          while (end < src.length && isHex(src[end])) end++;
          const digits = src.slice(i + 3, end);
          if (digits && src[end] === "}") {
            const point = parseInt(digits, 16);
            try { value += String.fromCodePoint(point); }
            catch { error ??= "Unicode escape is outside the valid range"; }
            advance(end + 1);
          } else {
            error ??= "Invalid Unicode string escape";
            value += "u";
            advance(i + 2);
          }
          continue;
        }

        if (isDigit(escaped)) {
          let end = i + 1;
          while (end < src.length && end < i + 4 && isDigit(src[end])) end++;
          const byte = parseInt(src.slice(i + 1, end), 10);
          if (byte > 255) error ??= "Decimal string escape exceeds byte range";
          value += String.fromCharCode(byte & 0xff);
          advance(end);
          continue;
        }

        error ??= `Unknown string escape \\${escaped}`;
        value += escaped;
        advance(i + 2);
      }

      if (src[i] === quote) advance(i + 1);
      else error ??= "Unclosed quoted string";
      const raw = src.slice(start, i);
      emit("string", start, startLine, startColumn, value, raw, { meta: quote, error });
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      const rest = src.slice(i);
      const hex = /^0[xX](?:[0-9a-fA-F]+(?:\.(?!\.)[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?/.exec(rest)?.[0];
      const decimal = /^(?:\d+(?:\.(?!\.)\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest)?.[0];
      const raw = hex ?? decimal ?? c;
      advance(i + raw.length);
      emit("number", start, startLine, startColumn, raw, raw);
      continue;
    }

    if (isNameStart(c)) {
      advance(i + 1);
      while (i < src.length && isNamePart(src[i])) advance(i + 1);
      const raw = src.slice(start, i);
      emit(KEYWORDS.has(raw) ? "keyword" : "name", start, startLine, startColumn, raw, raw);
      continue;
    }

    const op = OPS.find((candidate) => src.startsWith(candidate, i));
    if (op) {
      advance(i + op.length);
      emit("op", start, startLine, startColumn, op, op);
      continue;
    }

    advance(i + 1);
    const raw = src.slice(start, i);
    emit("unknown", start, startLine, startColumn, raw, raw, { error: `Unexpected character ${JSON.stringify(raw)}` });
  }

  tokens.push({ type: "eof", value: "", raw: "", pos: src.length, end: src.length, line, column });
  return keepComments ? tokens : tokens.filter((token) => token.type !== "comment");
}