import { useEffect, useMemo, useRef } from "react";
import { highlightLua } from "../lib/lua/highlight";

function lineNumbers(code: string): string {
  const count = Math.max(1, code.split("\n").length);
  return Array.from({ length: count }, (_, index) => index + 1).join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function CodeView({ code, className = "" }: { code: string; className?: string }) {
  const html = useMemo(() => highlightLua(code), [code]);
  const numbers = useMemo(() => lineNumbers(code), [code]);

  return (
    <div className={`code-scroll flex min-h-0 flex-1 overflow-auto font-mono text-[12.5px] leading-[1.7] ${className}`}>
      <pre aria-hidden="true" className="sticky left-0 z-10 m-0 min-h-full shrink-0 select-none border-r border-white/[0.06] bg-[#0a0c10] px-4 py-4 text-right text-[#596477]">
        {numbers}
      </pre>
      <pre
        className="m-0 min-w-0 flex-1 whitespace-pre px-5 py-4 text-[#d9e0e9]"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  placeholder?: string;
}

export function CodeEditor({ value, onChange, onRun, placeholder }: CodeEditorProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const highlight = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const numbers = useMemo(() => lineNumbers(value), [value]);
  const html = useMemo(() => {
    if (value.length > 180_000) return escapeHtml(value);
    return highlightLua(value);
  }, [value]);

  useEffect(() => {
    const area = textarea.current;
    if (!area) return;
    const sync = () => {
      if (highlight.current) {
        highlight.current.scrollTop = area.scrollTop;
        highlight.current.scrollLeft = area.scrollLeft;
      }
      if (gutter.current) gutter.current.scrollTop = area.scrollTop;
    };
    area.addEventListener("scroll", sync, { passive: true });
    return () => area.removeEventListener("scroll", sync);
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      onRun?.();
      return;
    }
    if (event.key !== "Tab") return;

    event.preventDefault();
    const area = event.currentTarget;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const nextValue = value.slice(0, start) + "  " + value.slice(end);
    onChange(nextValue);
    requestAnimationFrame(() => {
      area.selectionStart = area.selectionEnd = start + 2;
    });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <pre
        ref={gutter}
        aria-hidden="true"
        className="m-0 w-[58px] shrink-0 select-none overflow-hidden border-r border-white/[0.06] bg-[#0a0c10] px-3 py-4 text-right font-mono text-[12.5px] leading-[1.7] text-[#596477]"
      >
        {numbers}
      </pre>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <pre
          ref={highlight}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-[#d9e0e9]"
          dangerouslySetInnerHTML={{ __html: html || " " }}
        />
        <textarea
          ref={textarea}
          aria-label="Lua source code input"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="off"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          className="code-scroll absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre bg-transparent px-5 py-4 font-mono text-[12.5px] leading-[1.7] text-transparent caret-cyan-300 outline-none selection:bg-cyan-400/25 placeholder:text-[#46505d] placeholder:!text-[#46505d]"
        />
      </div>
    </div>
  );
}