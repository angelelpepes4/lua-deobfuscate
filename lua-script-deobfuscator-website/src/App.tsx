import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LuaWorker from "./workers/deobfuscate.worker?worker&inline";
import { CodeEditor, CodeView } from "./components/CodePane";
import { DEFAULT_OPTIONS, DeobResult, Options } from "./lib/lua/engine";
import { TransformResponse } from "./lib/lua/protocol";
import { SAMPLES } from "./lib/samples";

type BooleanOption = Exclude<keyof Options, "indent">;
type OutputSnapshot = {
  result: DeobResult;
  source: string;
  optionKey: string;
  durationMs: number;
};

const OPTION_DETAILS: { key: BooleanOption; title: string; description: string }[] = [
  { key: "deepUnpack", title: "Peel encoded layers", description: "Decode static base64, string helpers, literal tables, and immediately-invoked load chunks." },
  { key: "foldConstants", title: "Evaluate constants", description: "Fold arithmetic and literal-only expressions without running Lua." },
  { key: "decodeStrings", title: "Decode string escapes", description: "Re-quote escaped bytes and unicode so string contents are easier to read." },
  { key: "simplifyIndex", title: "Simplify field access", description: "Turn bracket access into dot access when the key is a valid Lua identifier." },
  { key: "renameVars", title: "Rename local noise", description: "Rename recognizable garbage local names; globals and table fields are preserved." },
  { key: "stripDeadCode", title: "Remove obvious dead branches", description: "Remove only if false/nil blocks with no alternate branch." },
  { key: "beautify", title: "Format output", description: "Re-indent blocks and split compact statements into readable lines." },
];

function Icon({
  name,
  size = 16,
  className = "",
}: {
  name: "logo" | "upload" | "copy" | "download" | "settings" | "chevron" | "terminal" | "spark" | "close" | "check" | "file";
  size?: number;
  className?: string;
}) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className, "aria-hidden": true as const };
  switch (name) {
    case "logo": return <svg {...common}><path d="M6 4v16M6 12h11M12 7l5 5-5 5" /></svg>;
    case "upload": return <svg {...common}><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 15v4a1 1 0 001 1h14a1 1 0 001-1v-4" /></svg>;
    case "copy": return <svg {...common}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" /></svg>;
    case "download": return <svg {...common}><path d="M12 4v11m0 0l4-4m-4 4l-4-4M5 19h14" /></svg>;
    case "settings": return <svg {...common}><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>;
    case "chevron": return <svg {...common}><path d="m7 10 5 5 5-5" /></svg>;
    case "terminal": return <svg {...common}><path d="m5 7 5 5-5 5m7 0h7" /></svg>;
    case "spark": return <svg {...common}><path d="m12 3 1.9 5.7L20 11l-6.1 2.3L12 19l-1.9-5.7L4 11l6.1-2.3L12 3Z" /><path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" /></svg>;
    case "close": return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    case "check": return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
    case "file": return <svg {...common}><path d="M13 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V10z" /><path d="M13 3v7h7M8 14h8M8 17h6" /></svg>;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

export default function App() {
  const [source, setSource] = useState("");
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS);
  const [output, setOutput] = useState<OutputSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [workerError, setWorkerError] = useState("");
  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const filePicker = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const sequence = useRef(0);
  const lastManualRequest = useRef(0);
  const snapshots = useRef(new Map<number, { source: string; optionKey: string }>());

  const optionKey = useMemo(() => JSON.stringify(options), [options]);
  const isCurrent = Boolean(output && output.source === source && output.optionKey === optionKey);

  useEffect(() => {
    let worker: Worker | null = null;
    try {
      worker = new LuaWorker();
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<TransformResponse>) => {
        const message = event.data;
        if (message.id !== sequence.current) return;
        const snapshot = snapshots.current.get(message.id);
        snapshots.current.delete(message.id);
        setBusy(false);
        if (message.error || !message.result || !snapshot) {
          setWorkerError(message.error ?? "The processing worker returned no result.");
          return;
        }
        setWorkerError("");
        setOutput({ ...snapshot, result: message.result, durationMs: message.durationMs });
      };
      worker.onerror = () => {
        setBusy(false);
        setWorkerError("The local processing worker stopped unexpectedly. Try reloading the page.");
      };
    } catch {
      setWorkerError("This browser could not start a local worker. Try a current version of Chrome, Firefox, Safari, or Edge.");
    }
    return () => {
      worker?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!source.trim()) {
      sequence.current++;
      setBusy(false);
      setOutput(null);
      setWorkerError("");
      return;
    }

    const id = ++sequence.current;
    const immediate = requestVersion !== lastManualRequest.current;
    if (immediate) lastManualRequest.current = requestVersion;
    snapshots.current.clear();
    snapshots.current.set(id, { source, optionKey });
    setBusy(true);
    setWorkerError("");

    const timer = window.setTimeout(() => {
      const worker = workerRef.current;
      if (!worker) {
        setBusy(false);
        setWorkerError("The local processing worker is unavailable. Reload the page and try again.");
        return;
      }
      worker.postMessage({ id, source, options });
    }, immediate ? 0 : 180);

    return () => window.clearTimeout(timer);
  }, [source, options, optionKey, requestVersion]);

  const runNow = useCallback(() => {
    if (!source.trim()) return;
    setRequestVersion((version) => version + 1);
  }, [source]);

  const handleSourceChange = (value: string) => {
    setSource(value);
    setFileName("");
    setCopied(false);
  };

  const loadFile = useCallback(async (file?: File) => {
    if (!file) return;
    if (!/\.(lua|txt|text)$/i.test(file.name) && file.type !== "text/plain") {
      setWorkerError("Choose a .lua or plain-text file.");
      return;
    }
    try {
      setSource(await file.text());
      setFileName(file.name);
      setWorkerError("");
      setCopied(false);
    } catch {
      setWorkerError("This file could not be read as text.");
    } finally {
      if (filePicker.current) filePicker.current.value = "";
    }
  }, []);

  const loadSample = (index: string) => {
    if (index === "") return;
    const sample = SAMPLES[Number(index)];
    if (!sample) return;
    setSource(sample.code);
    setFileName(`${sample.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.lua`);
    setWorkerError("");
    setCopied(false);
    const selector = document.getElementById("sample-select") as HTMLSelectElement | null;
    if (selector) selector.value = "";
  };

  const updateOption = (key: BooleanOption) => {
    setOptions((current) => ({ ...current, [key]: !current[key] }));
  };

  const copyOutput = async () => {
    if (!output || !isCurrent || !output.result.code) return;
    try {
      await navigator.clipboard.writeText(output.result.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      const field = document.createElement("textarea");
      field.value = output.result.code;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand("copy");
      field.remove();
      setCopied(ok);
      window.setTimeout(() => setCopied(false), 1400);
    }
  };

  const saveOutput = () => {
    if (!output || !isCurrent || !output.result.code) return;
    const blob = new Blob([output.result.code], { type: "text/x-lua;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "deobfuscated.lua";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const result = output?.result;
  const changedPasses = result?.passes.filter((pass) => pass.changes > 0).length ?? 0;

  return (
    <div className="app-shell min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-[1760px] flex-col px-4 sm:px-6 lg:px-9">
        <header className="topbar flex h-[76px] shrink-0 items-center justify-between border-b border-white/[0.08]">
          <div className="flex items-center gap-3.5">
            <div className="brand-mark grid h-10 w-10 place-items-center rounded-xl">
              <Icon name="logo" size={24} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-bold tracking-[0.12em] text-[#e8ede6]">LUA<span className="text-[#c8f078]">UNWRAP</span></span>
                <span className="hidden rounded border border-[#c8f078]/20 px-1.5 py-0.5 font-mono text-[9px] tracking-[0.15em] text-[#b3d976] sm:inline">STATIC LAB</span>
              </div>
              <p className="mt-0.5 text-[11px] text-[#778078]">Readable source, recovered locally</p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-white/[0.09] px-3 py-1.5 sm:flex">
              <span className="local-dot h-1.5 w-1.5 rounded-full bg-[#b7ed62]" />
              <span className="text-[10px] font-medium tracking-[0.08em] text-[#a5afa5]">ON-DEVICE ONLY</span>
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
              className={`icon-button ${settingsOpen ? "icon-button-active" : ""}`}
              title="Transformation settings"
            >
              <Icon name="settings" size={17} />
              <span className="hidden text-xs sm:inline">Tune</span>
            </button>
          </div>
        </header>

        {settingsOpen && (
          <section className="settings-panel animate-enter" aria-label="Transformation settings">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.07] pb-3">
              <div>
                <h2 className="text-sm font-semibold text-[#e3e9df]">Transformation passes</h2>
                <p className="mt-1 text-xs text-[#78827a]">Changes are applied locally as you edit.</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="mr-1 text-[10px] uppercase tracking-[0.12em] text-[#667168]">Indent</span>
                {[
                  { label: "2 spaces", value: "  " },
                  { label: "4 spaces", value: "    " },
                  { label: "Tabs", value: "\t" },
                ].map((space) => (
                  <button
                    key={space.label}
                    type="button"
                    onClick={() => setOptions((current) => ({ ...current, indent: space.value }))}
                    className={`indent-choice ${options.indent === space.value ? "indent-choice-active" : ""}`}
                  >
                    {space.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-x-8 gap-y-1 pt-3 sm:grid-cols-2 xl:grid-cols-4">
              {OPTION_DETAILS.map((option) => (
                <label key={option.key} className="setting-row flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2">
                  <input
                    type="checkbox"
                    checked={options[option.key]}
                    onChange={() => updateOption(option.key)}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#c8f078]"
                  />
                  <span>
                    <span className="block text-xs font-medium text-[#c7d0c6]">{option.title}</span>
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-[#788178]">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}

        <main className="flex flex-1 flex-col pb-5 pt-5 sm:pt-7">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8f9a8f]">
                <Icon name="spark" size={13} className="text-[#c8f078]" />
                <span>Lua source recovery</span>
              </div>
              <h1 className="text-lg font-semibold tracking-tight text-[#edf2e9] sm:text-xl">Paste Lua. Get readable Lua.</h1>
              <p className="mt-1 text-xs text-[#7c867c]">No upload, no execution. Static transforms run in a background worker.</p>
            </div>

            <div className="flex items-center gap-2">
              <label className="sample-select-wrap">
                <span className="sr-only">Load a sample script</span>
                <select id="sample-select" defaultValue="" onChange={(event) => loadSample(event.target.value)} className="sample-select">
                  <option value="">Try an example</option>
                  {SAMPLES.map((sample, index) => <option value={index} key={sample.name}>{sample.name}</option>)}
                </select>
                <Icon name="chevron" size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[#96a18f]" />
              </label>
              <input
                ref={filePicker}
                type="file"
                accept=".lua,.txt,.text,text/plain"
                className="hidden"
                onChange={(event) => void loadFile(event.target.files?.[0])}
              />
              <button type="button" onClick={() => filePicker.current?.click()} className="action-button">
                <Icon name="upload" size={14} />
                <span className="hidden sm:inline">Open file</span>
              </button>
            </div>
          </div>

          <div className="workbench grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
            <section
              className={`workspace-panel flex min-h-[380px] flex-col overflow-hidden rounded-2xl border ${dragging ? "border-[#c8f078]/70" : "border-white/[0.09]"}`}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
              onDrop={(event) => { event.preventDefault(); setDragging(false); void loadFile(event.dataTransfer.files?.[0]); }}
            >
              <div className="panel-heading flex h-[54px] shrink-0 items-center justify-between border-b border-white/[0.07] px-4 sm:px-5">
                <div className="flex items-center gap-2.5">
                  <span className="step-number">01</span>
                  <div>
                    <h2 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[#d9e0d5]">Source Lua</h2>
                    <p className="mt-0.5 max-w-[240px] truncate font-mono text-[10px] text-[#778177]">{fileName || "paste or drop a script"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {source && <span className="font-mono text-[10px] tabular-nums text-[#647067]">{formatBytes(new Blob([source]).size)}</span>}
                  {source && (
                    <button type="button" onClick={() => { setSource(""); setFileName(""); }} className="micro-button" title="Clear source">
                      <Icon name="close" size={14} />
                    </button>
                  )}
                </div>
              </div>
              <CodeEditor
                value={source}
                onChange={handleSourceChange}
                onRun={runNow}
                placeholder="-- Paste obfuscated Lua here\n-- or drop a .lua file into this panel"
              />
            </section>

            <section className="workspace-panel flex min-h-[380px] flex-col overflow-hidden rounded-2xl border border-white/[0.09]">
              <div className="panel-heading flex h-[54px] shrink-0 items-center justify-between border-b border-white/[0.07] px-4 sm:px-5">
                <div className="flex items-center gap-2.5">
                  <span className="step-number">02</span>
                  <div>
                    <h2 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[#d9e0d5]">Readable Lua</h2>
                    <p className="mt-0.5 text-[10px] text-[#778177]">Output contains source code only</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {busy ? (
                    <span className="inline-flex items-center gap-1.5 text-[10px] text-[#b6c38e]"><span className="working-dot" />Working</span>
                  ) : isCurrent ? (
                    <span className="inline-flex items-center gap-1 text-[10px] text-[#98c369]"><Icon name="check" size={12} />Ready</span>
                  ) : source ? (
                    <span className="text-[10px] text-[#929c91]">Waiting for transform</span>
                  ) : (
                    <span className="text-[10px] text-[#667066]">Awaiting source</span>
                  )}
                </div>
              </div>

              <div className="relative flex min-h-0 flex-1 flex-col">
                {result?.code ? (
                  <div className={`result-code flex min-h-0 flex-1 flex-col transition-opacity duration-200 ${isCurrent ? "opacity-100" : "opacity-45"}`}>
                    <CodeView code={result.code} />
                  </div>
                ) : (
                  <div className="empty-output flex flex-1 flex-col items-center justify-center px-6 text-center">
                    <div className="empty-glyph mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-white/[0.08] bg-white/[0.02] text-[#b6df74]">
                      <Icon name="terminal" size={22} />
                    </div>
                    <p className="text-sm font-medium text-[#cbd5c9]">Your Lua output goes here</p>
                    <p className="mt-1.5 max-w-[280px] text-xs leading-relaxed text-[#737e74]">Paste a script on the left or load a sample to recover and format its static code.</p>
                    <button type="button" onClick={() => loadSample("1")} className="mt-4 text-xs font-medium text-[#c8f078] hover:text-[#def8a5]">
                      Try a nested loader example
                    </button>
                  </div>
                )}
                {workerError && <div className="border-t border-[#f09378]/15 bg-[#f09378]/[0.06] px-4 py-2 text-xs text-[#f0a88f]">{workerError}</div>}
              </div>

              <div className="flex h-[51px] shrink-0 items-center justify-between border-t border-white/[0.07] px-3 sm:px-4">
                <div className="flex min-w-0 items-center gap-2 text-[10px] text-[#697369]">
                  {result && isCurrent ? (
                    <>
                      <span className="truncate">{result.stats.layers ? `${result.stats.layers} layer${result.stats.layers === 1 ? "" : "s"} recovered` : "Static cleanup complete"}</span>
                      <span className="text-[#404a41]">/</span>
                      <span className="shrink-0">{result.stats.changes} change{result.stats.changes === 1 ? "" : "s"}</span>
                      <span className="hidden shrink-0 text-[#59635a] sm:inline">/ {output?.durationMs.toFixed(0)} ms</span>
                    </>
                  ) : source ? <span>{busy ? "Analyzing locally..." : "Output updates automatically"}</span> : <span>Paste code to begin</span>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button type="button" onClick={runNow} disabled={!source.trim() || busy} className="action-button compact-button">
                    <Icon name="spark" size={13} />
                    <span>Transform</span>
                  </button>
                  <button type="button" onClick={() => void copyOutput()} disabled={!isCurrent || !result?.code} className={`action-button compact-button ${copied ? "copy-success" : ""}`}>
                    <Icon name={copied ? "check" : "copy"} size={13} />
                    <span>{copied ? "Copied" : "Copy Lua"}</span>
                  </button>
                  <button type="button" onClick={saveOutput} disabled={!isCurrent || !result?.code} className="action-button compact-button" title="Download deobfuscated.lua">
                    <Icon name="download" size={13} />
                    <span className="hidden sm:inline">Save</span>
                  </button>
                </div>
              </div>
            </section>
          </div>

          {result && isCurrent && (
            <div className="result-summary mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-white/[0.07] pb-3 text-[10px]">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[#8e998c]">
                <span className="inline-flex items-center gap-1.5 text-[#a9cf76]"><span className="h-1.5 w-1.5 rounded-full bg-[#a9cf76]" />Local analysis</span>
                <span>{result.stats.tokens.toLocaleString()} tokens</span>
                <span>{result.stats.strings} strings</span>
                {result.stats.renamed > 0 && <span>{result.stats.renamed} local names recovered</span>}
                {result.detected.length > 0 && <span>{result.detected.length} technique marker{result.detected.length === 1 ? "" : "s"}</span>}
              </div>
              <button type="button" onClick={runNow} className="inline-flex items-center gap-1 text-[#8c9989] transition hover:text-[#d7e5c9]">
                <span>Run again</span>
                <span aria-hidden="true">Ctrl + Enter</span>
              </button>
            </div>
          )}

          {result && isCurrent && (
            <details className="analysis-details mt-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3 text-xs text-[#9da89b]">
                <span className="flex items-center gap-2">
                  <Icon name="file" size={14} className="text-[#9bb671]" />
                  <span className="font-medium text-[#c2ccc0]">Analysis report</span>
                  <span className="text-[#6f7a70]">{changedPasses} active pass{changedPasses === 1 ? "" : "es"}</span>
                </span>
                <span className="flex items-center gap-2 text-[10px] text-[#697369]">Static analysis only <Icon name="chevron" size={14} className="details-chevron" /></span>
              </summary>
              <div className="analysis-content grid gap-6 border-t border-white/[0.07] py-4 md:grid-cols-[1fr_1fr]">
                <div>
                  <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7e8a7d]">Passes</h3>
                  <ul className="space-y-2">
                    {result.passes.map((pass) => (
                      <li key={pass.name} className="flex items-start justify-between gap-4 text-[11px]">
                        <div>
                          <span className="font-medium text-[#c3cdc0]">{pass.name}</span>
                          <p className="mt-0.5 text-[10px] leading-relaxed text-[#778177]">{pass.note}</p>
                        </div>
                        <span className={`shrink-0 font-mono ${pass.changes ? "text-[#a4ca70]" : "text-[#586258]"}`}>{pass.changes}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="space-y-5">
                  {result.detected.length > 0 && (
                    <div>
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7e8a7d]">Technique markers</h3>
                      <ul className="space-y-1 text-[11px] text-[#c0c9bc]">{result.detected.map((item) => <li key={item}>{item}</li>)}</ul>
                    </div>
                  )}
                  {result.payloads.length > 0 && (
                    <div>
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7e8a7d]">Recovered chunks</h3>
                      <ul className="space-y-1.5">
                        {result.payloads.slice(0, 5).map((payload, index) => (
                          <li key={`${index}-${payload.slice(0, 12)}`}>
                            <button type="button" onClick={() => { setSource(payload); setFileName(`recovered-chunk-${index + 1}.lua`); }} className="w-full truncate rounded-md bg-white/[0.025] px-2.5 py-1.5 text-left font-mono text-[10px] text-[#a8c77b] hover:bg-white/[0.05]" title="Load this recovered chunk as the input">
                              {payload.replace(/\s+/g, " ").slice(0, 120)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {result.warnings.length > 0 && (
                    <div>
                      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#7e8a7d]">Notes</h3>
                      <ul className="space-y-2">{result.warnings.map((warning, index) => <li key={index} className="border-l border-[#d89578]/50 pl-2.5 text-[10px] leading-relaxed text-[#d0a28f]">{warning}</li>)}</ul>
                    </div>
                  )}
                  <p className="text-[10px] leading-relaxed text-[#687368]">This tool never executes the input. VM bytecode and runtime-generated keys may need additional manual analysis.</p>
                </div>
              </div>
            </details>
          )}
        </main>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] py-3 text-[10px] text-[#606c61]">
          <span>LuaUnwrap / static source cleanup</span>
          <span>Scripts stay in this tab and are never uploaded or executed.</span>
        </footer>
      </div>
    </div>
  );
}