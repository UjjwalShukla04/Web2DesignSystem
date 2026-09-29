"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Code,
  Columns,
  Copy,
  Download,
  GitCompareArrows,
  Monitor,
  MoveHorizontal,
  Loader2,
  Redo2,
  RotateCw,
  Rows,
  Send,
  Smartphone,
  TriangleAlert,
  Undo2,
  WandSparkles,
} from "lucide-react";
import {
  SandpackProvider,
  SandpackLayout,
  SandpackCodeEditor,
  SandpackPreview,
  useSandpack,
} from "@codesandbox/sandpack-react";
import { cn } from "../lib/cn";
import { usePersistentState } from "../lib/storage";
import { formatCost, type Usage } from "../lib/api";
import { MOBILE_QUERY, useMediaQuery } from "../lib/media";
import { downloadFile } from "../lib/download";
import { FORMATS, FORMAT_KEYS, downloadName, type OutputFormat } from "../lib/formats";
import { BusyNotice, StreamingOutput } from "./Feedback";

// Tailwind's CDN build (Play CDN), pinned. The "#.js" is never sent to the server; it tells
// Sandpack the file type, which it reads from the extension (the static/HTML template
// otherwise fails with "Unable to determine file type for external resource").
const TAILWIND_CDN = "https://cdn.tailwindcss.com/3.4.17#.js";

// Kept at module level: Sandpack resets the editor whenever these objects change identity.
const REACT_INDEX_HTML = `<div id="root"></div><script src="${TAILWIND_CDN}"></script>`;
const SANDPACK_OPTIONS = { externalResources: [TAILWIND_CDN] };

// After this long without the preview finishing, suggest reloading it.
const SLOW_PREVIEW_MS = 20_000;

/**
 * Shows whether the preview is loading, ready or failed, with a Reload button. The first
 * preview of a session downloads packages inside the preview and can take a while, and
 * until then the pane is just white — this makes that visible.
 */
const PreviewStatus = () => {
  const { sandpack, listen } = useSandpack();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [slow, setSlow] = useState(false);

  useEffect(
    () =>
      listen((message) => {
        if (message.type === "start") {
          setState("loading");
        } else if (message.type === "done") {
          setState((s) => (s === "error" ? s : "ready"));
        } else if (message.type === "action" && message.action === "show-error") {
          setState("error");
        }
      }),
    [listen],
  );

  useEffect(() => {
    if (state !== "loading") return;
    const timer = setTimeout(() => setSlow(true), SLOW_PREVIEW_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [state]);

  const reload = () => {
    setState("loading");
    void sandpack.runSandpack();
  };

  const label =
    state === "loading" ? "Loading preview…" : state === "ready" ? "Preview ready" : "Preview error";
  return (
    <div className="absolute top-11 md:top-2 right-2 z-10 flex max-w-[calc(100%-1rem)] sm:max-w-sm flex-col items-end gap-2" aria-live="polite">
      <div className="flex items-center gap-2 rounded-full border border-gray-700 bg-gray-900/90 py-1 pl-3 pr-1 text-xs text-gray-300 shadow">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            state === "loading" && "animate-pulse bg-amber-400",
            state === "ready" && "bg-green-400",
            state === "error" && "bg-red-500",
          )}
          aria-hidden
        />
        <span>{label}</span>
        <button
          type="button"
          onClick={reload}
          className="rounded-full p-1 text-gray-400 hover:bg-gray-800 hover:text-white"
          aria-label="Reload preview"
          title="Reload preview"
        >
          <RotateCw className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      {slow && state === "loading" && (
        <p className="rounded-lg border border-amber-800 bg-gray-900/95 p-3 text-xs text-amber-200 shadow">
          Still loading. The first preview downloads packages and can take up to a minute. If
          it stays blank, press <strong>Reload preview</strong>; the preview runs on
          codesandbox.io, so also check that an ad blocker or network filter isn&apos;t blocking it.
        </p>
      )}
    </div>
  );
};
const SANDPACK_SETUPS = Object.fromEntries(
  FORMAT_KEYS.map((key) => [key, { dependencies: FORMATS[key].dependencies }]),
) as Record<OutputFormat, { dependencies: Record<string, string> }>;

// Reports the editor's current code (including manual edits) and any preview error.
const SandpackBridge = ({
  mainFile,
  onCodeChange,
  onErrorChange,
}: {
  mainFile: string;
  onCodeChange: (code: string) => void;
  onErrorChange: (error: string | null) => void;
}) => {
  const { sandpack, listen } = useSandpack();
  const current = sandpack.files[mainFile]?.code;
  const currentRef = useRef(current);
  // The last code that failed, and how. Recompiling unchanged code doesn't re-run it,
  // so no new error event arrives; the remembered error is re-reported instead.
  const failedRef = useRef<{ code: string | undefined; message: string } | null>(null);
  useEffect(() => {
    currentRef.current = current;
    if (current !== undefined) onCodeChange(current);
  }, [current, onCodeChange]);
  // Follow the bundler's events rather than sandpack.error: each compile clears the
  // error and reports it again, even when new code fails with the same message.
  useEffect(
    () =>
      listen((message) => {
        if (message.type === "start") {
          const failed = failedRef.current;
          onErrorChange(failed && failed.code === currentRef.current ? failed.message : null);
        } else if (message.type === "action" && message.action === "show-error") {
          const text = `${message.title}: ${message.message}`;
          failedRef.current = { code: currentRef.current, message: text };
          onErrorChange(text);
        }
      }),
    [listen, onErrorChange],
  );
  return null;
};

type PreviewWidth = "phone" | "fit" | "desktop";
const PREVIEW_WIDTHS: Record<PreviewWidth, number | null> = { phone: 390, fit: null, desktop: 1280 };

/**
 * Hosts the preview at a real device width: 390px (phone), the pane's own width (fit),
 * or 1280px (desktop, the width the original was scraped at) scaled down to fit.
 * The element structure never changes between widths, so switching doesn't reload
 * the preview.
 */
const PreviewPane = ({ width, children }: { width: PreviewWidth; children: React.ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const target = PREVIEW_WIDTHS[width];
  const scale = target && box.width ? Math.min(1, box.width / target) : 1;
  const innerWidth = target ?? box.width;
  return (
    <div
      ref={ref}
      data-preview-width={width}
      className={cn("relative h-full min-w-0 overflow-hidden", width === "phone" ? "bg-gray-900" : "bg-white")}
      style={{ flex: "1 1 0%" }}
    >
      <div
        className="absolute top-0"
        style={{
          width: innerWidth || "100%",
          height: box.height ? box.height / scale : "100%",
          left: Math.max(0, (box.width - innerWidth * scale) / 2),
          transform: scale === 1 ? undefined : `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {children}
      </div>
      {target && scale < 1 && (
        <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-gray-900/80 px-2 py-0.5 text-[11px] text-gray-300">
          {target}px · {Math.round(scale * 100)}%
        </span>
      )}
    </div>
  );
};

const iconButton =
  "p-2 transition-colors text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white disabled:opacity-30 disabled:hover:text-gray-500 dark:disabled:hover:text-gray-400";
const segmentGroup = "flex items-center rounded-lg p-1 bg-gray-100 dark:bg-gray-800";
const segment = (on: boolean) =>
  cn(
    "p-1.5 rounded-md transition-all disabled:opacity-30",
    on
      ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white"
      : "text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200",
  );

type MobileTab = "code" | "preview" | "original";

// 3. Editor & Preview
export const ComponentEditor = ({
  format,
  kind,
  originalImages,
  code,
  editorVersion,
  liveCode,
  fontCss,
  onCodeChange,
  previewError,
  onPreviewErrorChange,
  onFixError,
  onRefine,
  isRefining,
  refineText,
  onCancelRefine,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onBack,
  toolbar,
  dark,
  lastUsage,
  projectCostUsd,
}: {
  format: OutputFormat; // Format the code was generated in
  kind: "component" | "page"; // One section, or several combined
  originalImages: string[]; // Screenshots of the original section(s), for Compare
  code: string; // Code loaded into the editor (AI output or an undo/redo step)
  editorVersion: number; // Bumped to force-reload `code` into the editor
  liveCode: string; // What the editor shows now, including manual edits
  fontCss: string; // @font-face / @import rules for the page's web fonts
  onCodeChange: (code: string) => void;
  previewError: string | null;
  onPreviewErrorChange: (error: string | null) => void;
  onFixError: () => void;
  onRefine: (instructions: string) => void;
  isRefining: boolean;
  refineText: string; // The model's output streaming in
  onCancelRefine: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onBack: () => void;
  toolbar: React.ReactNode; // History, theme and settings buttons
  dark: boolean; // Resolved theme, for Sandpack's own theme
  lastUsage: Usage | null; // Tokens and estimated cost of the last AI request
  projectCostUsd: number; // Estimated cost of this project so far
}) => {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [layout, setLayout] = usePersistentState<"horizontal" | "vertical" | "compare">("layout", "horizontal");
  // Separate width settings: a 1280px desktop preview on a phone is shrunk to ~30%, so
  // phones default to the phone width.
  const [desktopWidth, setDesktopWidth] = usePersistentState<PreviewWidth>("previewWidth", "desktop");
  const [phoneWidth, setPhoneWidth] = usePersistentState<PreviewWidth>("previewWidthMobile", "phone");
  const previewWidth = isMobile ? phoneWidth : desktopWidth;
  const setPreviewWidth = isMobile ? setPhoneWidth : setDesktopWidth;
  const [mobileTab, setMobileTab] = useState<MobileTab>("preview");
  const canCompare = originalImages.length > 0;
  const activeLayout = layout === "compare" && !canCompare ? "horizontal" : layout;
  const [copied, setCopied] = useState(false);
  const [prompt, setPrompt] = useState("");
  const config = FORMATS[format];
  const files = useMemo(
    () => ({
      [config.mainFile]: code,
      // Each template already loads this stylesheet (for HTML, the generated page links it),
      // so the page's web fonts load in the preview.
      [config.fontsFile]: fontCss || "/* No web fonts were found on the page. */\n",
      ...(format === "react" ? { "/public/index.html": REACT_INDEX_HTML } : {}),
    }),
    // editorVersion forces a reload even when the code text is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [code, fontCss, format, editorVersion],
  );

  const handleDownloadCode = () =>
    downloadFile(downloadName(format, kind), liveCode, format === "html" ? "text/html" : "text/plain");
  const handleDownloadFonts = () => downloadFile("fonts.css", fontCss, "text/css");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(liveCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. not a secure context); nothing to do.
    }
  };

  const handleRefine = (e: React.FormEvent) => {
    e.preventDefault();
    if (prompt.trim()) {
      onRefine(prompt.trim());
      setPrompt("");
    }
  };

  const editor = (
    <SandpackCodeEditor
      showTabs
      showLineNumbers
      showInlineErrors
      wrapContent
      style={{ height: "100%" }}
    />
  );
  const preview = (
    <SandpackPreview
      showNavigator={false}
      showOpenInCodeSandbox
      style={{ height: "100%" }}
    />
  );
  const originalView = (
    <div className="relative h-full min-w-0 flex-1 overflow-auto bg-white" aria-label="Original design">
      <span className="sticky top-0 z-10 block bg-gray-900/90 px-3 py-1 text-xs font-medium text-gray-200">
        Original
      </span>
      {originalImages.map((src, i) => (
        // eslint-disable-next-line @next/next/no-img-element -- a local data URL
        <img key={i} src={src} alt={`Original section ${i + 1}`} className="block w-full" />
      ))}
    </div>
  );

  const costTitle = lastUsage
    ? `Last AI request: ${lastUsage.inputTokens.toLocaleString()} input + ${lastUsage.outputTokens.toLocaleString()} output tokens, ~${formatCost(lastUsage.costUsd)} (estimated). This project so far: ~${formatCost(projectCostUsd)}.`
    : "";

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-white">
      {/* Header */}
      {/* relative z-30: backdrop-blur creates a stacking context, so without it the
          settings popover would open underneath the editor below. */}
      <header className="relative z-30 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-3 py-3 sm:px-6 backdrop-blur bg-white/80 border-gray-200 dark:bg-gray-900/50 dark:border-gray-800">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-4">
          <button
            type="button"
            onClick={onBack}
            className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors"
            aria-label="Back to sections"
            title="Back to sections"
          >
            <ArrowLeft className="w-5 h-5" aria-hidden />
          </button>
          <h1 className="truncate font-bold text-base sm:text-lg tracking-tight">
            {kind === "page" ? "Generated Page" : "Generated Component"}
          </h1>
          <span className="rounded px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
            {config.label}
          </span>
          {lastUsage && (
            <span
              className="hidden sm:inline rounded px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700"
              title={costTitle}
              aria-label={costTitle}
            >
              ~{formatCost(lastUsage.costUsd)}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 order-2 sm:order-3">{toolbar}</div>

        {/* Tools: one scrollable row on phones. */}
        <div className="order-3 sm:order-2 flex w-full sm:w-auto shrink-0 items-center gap-2 sm:gap-3 overflow-x-auto">
          <div className="flex items-center" role="group" aria-label="Undo history">
            <button type="button" onClick={onUndo} disabled={!canUndo || isRefining} className={iconButton} aria-label="Undo AI change" title="Undo AI change">
              <Undo2 className="w-5 h-5" aria-hidden />
            </button>
            <button type="button" onClick={onRedo} disabled={!canRedo || isRefining} className={iconButton} aria-label="Redo AI change" title="Redo AI change">
              <Redo2 className="w-5 h-5" aria-hidden />
            </button>
          </div>
          {!isMobile && (
            <div className={segmentGroup} role="group" aria-label="Layout">
              {([
                ["horizontal", "Side-by-side view", Columns],
                ["vertical", "Stacked view", Rows],
                ["compare", canCompare ? "Compare with the original" : "Compare with the original (no screenshot of this section)", GitCompareArrows],
              ] as const).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setLayout(value)}
                  disabled={value === "compare" && !canCompare}
                  aria-pressed={activeLayout === value}
                  className={segment(activeLayout === value)}
                  aria-label={label}
                  title={label}
                >
                  <Icon className="w-4 h-4" aria-hidden />
                </button>
              ))}
            </div>
          )}
          <div className={segmentGroup} role="group" aria-label="Preview width">
            {([
              ["phone", "Phone preview (390px)", Smartphone],
              ["fit", "Fit preview to the pane", MoveHorizontal],
              ["desktop", "Desktop preview (1280px, scaled to fit)", Monitor],
            ] as const).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                onClick={() => setPreviewWidth(value)}
                aria-pressed={previewWidth === value}
                className={segment(previewWidth === value)}
                aria-label={label}
                title={label}
              >
                <Icon className="w-4 h-4" aria-hidden />
              </button>
            ))}
          </div>
          <button type="button" className={iconButton} onClick={handleCopy} aria-label="Copy code" title="Copy Code">
            {copied ? (
              <Check className="w-5 h-5 text-green-500" aria-hidden />
            ) : (
              <Copy className="w-5 h-5" aria-hidden />
            )}
          </button>
          <span className="sr-only" aria-live="polite">{copied ? "Code copied" : ""}</span>
          <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Download">
            <button
              type="button"
              onClick={handleDownloadCode}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
              aria-label={`Download ${downloadName(format, kind)}`}
              title={`Download ${downloadName(format, kind)}`}
            >
              <Download className="w-4 h-4" aria-hidden />
              <span className="hidden sm:inline">{downloadName(format, kind)}</span>
            </button>
            {fontCss && (
              <button
                type="button"
                onClick={handleDownloadFonts}
                className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                aria-label="Download fonts.css"
                title="Download fonts.css: the web fonts the original page uses"
              >
                <Download className="w-4 h-4" aria-hidden /> fonts.css
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Preview error with a one-click AI fix */}
      {previewError && !isRefining && (
        <div role="alert" className="mx-3 sm:mx-4 mt-4 flex flex-wrap sm:flex-nowrap items-start gap-3 rounded-lg border p-3 text-sm border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200">
          <TriangleAlert className="w-5 h-5 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1 font-mono text-xs whitespace-pre-wrap line-clamp-4">{previewError}</p>
          <button
            type="button"
            onClick={onFixError}
            className="shrink-0 flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-500"
          >
            <WandSparkles className="w-4 h-4" aria-hidden /> Fix with AI
          </button>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 p-2 sm:p-4 relative">
        {/* Full width container for Sandpack with resize capability */}
        <div
          className="relative w-full flex flex-col rounded-lg overflow-hidden resize-y border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
          style={{ height: isMobile ? "72vh" : "85vh", minHeight: isMobile ? "420px" : "500px" }}
        >
          <SandpackProvider
            key={format} // a different template needs a fresh Sandpack
            // Sandpack wraps its children in a div; without a height, the stacked and
            // Compare layouts (h-full) would only be as tall as their content.
            style={{ height: "100%" }}
            template={config.template}
            theme={dark ? "dark" : "light"}
            files={files}
            options={SANDPACK_OPTIONS}
            customSetup={SANDPACK_SETUPS[format]}
          >
            <PreviewStatus />
            <SandpackBridge
              mainFile={config.mainFile}
              onCodeChange={onCodeChange}
              onErrorChange={onPreviewErrorChange}
            />

            {isMobile ? (
              // Phones: one pane at a time. Panes stay mounted (hidden), so switching
              // tabs doesn't reload the preview or lose the editor's scroll position.
              <div className="flex h-full flex-col">
                <div role="tablist" aria-label="Panes" className="flex shrink-0 border-b border-gray-200 dark:border-gray-800">
                  {([
                    ["code", "Code"],
                    ["preview", "Preview"],
                    ...(canCompare ? ([["original", "Original"]] as const) : []),
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={mobileTab === value}
                      onClick={() => setMobileTab(value)}
                      className={cn(
                        "flex-1 py-2 text-sm font-medium border-b-2 transition-colors",
                        mobileTab === value
                          ? "border-blue-600 text-blue-600 dark:text-blue-400"
                          : "border-transparent text-gray-500 dark:text-gray-400",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="relative min-h-0 flex-1">
                  {/* Wrapped in SandpackLayout like the desktop layouts: Sandpack's own
                      loading overlay only clears correctly inside it. */}
                  <div className={cn("h-full", mobileTab !== "code" && "hidden")}>
                    <SandpackLayout style={{ height: "100%", border: "none" }}>{editor}</SandpackLayout>
                  </div>
                  <div className={cn("flex h-full", mobileTab !== "preview" && "hidden")}>
                    <SandpackLayout style={{ height: "100%", border: "none", flex: "1 1 0%", minWidth: 0 }}>
                      <PreviewPane width={previewWidth}>{preview}</PreviewPane>
                    </SandpackLayout>
                  </div>
                  {canCompare && (
                    <div className={cn("flex h-full", mobileTab !== "original" && "hidden")}>{originalView}</div>
                  )}
                </div>
              </div>
            ) : (
              <>
                {activeLayout === "horizontal" && (
                  <SandpackLayout style={{ height: "100%" }}>
                    {editor}
                    <PreviewPane width={previewWidth}>{preview}</PreviewPane>
                  </SandpackLayout>
                )}
                {activeLayout === "vertical" && (
                  <div className="flex flex-col h-full">
                    <div className="flex-1 overflow-hidden border-b border-gray-200 dark:border-gray-800 relative">
                      <SandpackLayout style={{ height: "100%", border: "none" }}>{editor}</SandpackLayout>
                    </div>
                    <div className="flex-1 overflow-hidden relative">
                      <SandpackLayout style={{ height: "100%", border: "none" }}>
                        <PreviewPane width={previewWidth}>{preview}</PreviewPane>
                      </SandpackLayout>
                    </div>
                  </div>
                )}
                {activeLayout === "compare" && (
                  // Original screenshot and live preview side by side. Both are 1280px-wide
                  // designs shown at the pane width, so with the Desktop preview they line up.
                  <div className="flex h-full">
                    <div className="flex h-full min-w-0 flex-1 border-r border-gray-200 dark:border-gray-800">{originalView}</div>
                    <SandpackLayout style={{ height: "100%", border: "none", flex: "1 1 0%", minWidth: 0 }}>
                      <PreviewPane width={previewWidth}>{preview}</PreviewPane>
                    </SandpackLayout>
                  </div>
                )}
              </>
            )}
          </SandpackProvider>
        </div>

        {isRefining && (
          <div className="absolute inset-2 sm:inset-4 z-10 flex items-center justify-center rounded-lg backdrop-blur-sm p-4 sm:p-6 bg-white/85 dark:bg-gray-950/85">
            <div className="w-full max-w-2xl">
              <BusyNotice message="AI is applying your changes…" onCancel={onCancelRefine}>
                <StreamingOutput text={refineText} />
              </BusyNotice>
            </div>
          </div>
        )}
      </div>

      {/* Chat / Refinement Bar */}
      <div className="h-auto border-t p-3 sm:p-4 border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <div className="max-w-4xl mx-auto w-full">
          <form onSubmit={handleRefine} className="relative flex items-center gap-2">
            <div className="absolute left-4 text-gray-400 dark:text-gray-500">
              <Code className="w-5 h-5" aria-hidden />
            </div>
            <input
              type="text"
              aria-label="Describe changes to the component"
              placeholder={isMobile ? "Describe changes…" : "Describe changes (e.g., 'Make the background dark', 'Add more padding')..."}
              className="w-full rounded-xl border pl-12 pr-14 py-3.5 sm:py-4 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 dark:bg-gray-900 dark:border-gray-800 dark:text-white dark:placeholder-gray-500"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={2000}
              disabled={isRefining}
            />
            <button
              type="submit"
              disabled={isRefining || !prompt.trim()}
              aria-label="Apply changes"
              className="absolute right-2 p-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isRefining ? (
                <Loader2 className="animate-spin w-5 h-5" aria-hidden />
              ) : (
                <Send className="w-5 h-5" aria-hidden />
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
