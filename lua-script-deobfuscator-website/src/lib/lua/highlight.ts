import { Token, tokenize } from "./tokenizer";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tokenClass(token: Token, source: string): string {
  if (token.error || token.type === "unknown") return "tk-error";
  if (token.type === "keyword") return "tk-kw";
  if (token.type === "string") return "tk-str";
  if (token.type === "number") return "tk-num";
  if (token.type === "comment") return "tk-com";
  if (token.type === "op") return "tk-op";
  if (token.type === "name") {
    if (/^(string|table|math|os|io|coroutine|debug|bit32|bit|utf8|_G|_ENV|print|pairs|ipairs|pcall|type|setmetatable|getmetatable|tonumber|tostring|select|error|assert|require|task|game|workspace)$/.test(token.value)) return "tk-bi";
    if (/^\s*\(/.test(source.slice(token.end))) return "tk-fn";
    return "tk-id";
  }
  return "";
}

/** Syntax highlighting follows the same lexer used by the deobfuscator. */
export function highlightLua(source: string): string {
  if (!source) return "";
  if (source.length > 1_000_000) return escapeHtml(source);

  const tokens = tokenize(source, true);
  let html = "";
  let offset = 0;
  for (const token of tokens) {
    if (token.type === "eof") break;
    html += escapeHtml(source.slice(offset, token.pos));
    const raw = source.slice(token.pos, token.end);
    const className = tokenClass(token, source);
    const safeRaw = escapeHtml(raw);
    html += className ? `<span class="${className}">${safeRaw}</span>` : safeRaw;
    offset = token.end;
  }
  html += escapeHtml(source.slice(offset));
  return html;
}