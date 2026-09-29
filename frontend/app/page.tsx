"use client";

import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import {
  describeError,
  generate,
  scrape,
  fetchServerProviders,
  wakeBackend,
  type Provider,
  type ScrapeResult,
  type ScrapedSection,
  type Usage,
} from "./lib/api";
import { newProjectId, saveProject, updateProject, type Project } from "./lib/history";
import { useTheme } from "./lib/theme";
import { readStored, usePersistentState } from "./lib/storage";
import type { OutputFormat } from "./lib/formats";
import { cropSection } from "./lib/crop";
import { ProviderSettings } from "./components/ProviderSettings";
import { UrlInput } from "./components/UrlInput";
import { SectionSelector } from "./components/SectionSelector";
import { ComponentEditor } from "./components/ComponentEditor";
import { BusyNotice, ErrorBanner, StreamingOutput } from "./components/Feedback";
import { HistoryButton, HistoryPanel } from "./components/HistoryPanel";
import { ThemeToggle } from "./components/ThemeToggle";

type Step = "INPUT" | "SELECT" | "EDIT";

const MAX_UNDO_STEPS = 20;
const DEFAULT_INSTRUCTIONS = "Make it a modern, responsive, faithful version of the original.";
// Saved projects keep the latest editor contents, a moment after typing stops.
const AUTOSAVE_DELAY_MS = 800;

/** e.g. "footer · aetnastudenthealth.com" or "Page (3 sections) · stripe.com" */
function projectTitle(picked: ScrapedSection[], siteUrl: string): string {
  let host = siteUrl;
  try {
    host = new URL(siteUrl).hostname.replace(/^www\./, "");
  } catch {
    // keep the raw URL
  }
  const what = picked.length > 1 ? `Page (${picked.length} sections)` : picked[0]?.tagName ?? "section";
  return `${what} · ${host}`;
}

function App() {
  // --- Saved across refreshes (sessionStorage) ---
  const [step, setStep] = usePersistentState<Step>("step", "INPUT");
  const [scrapeResult, setScrapeResult] = usePersistentState<ScrapeResult | null>("scrape", null);
  const [liveCode, setLiveCode] = usePersistentState("liveCode", ""); // editor contents, incl. manual edits
  const [undoStack, setUndoStack] = usePersistentState<string[]>("undo", []);
  const [redoStack, setRedoStack] = usePersistentState<string[]>("redo", []);
  const [format, setFormat] = usePersistentState<OutputFormat>("format", "react"); // for the next generation
  const [codeFormat, setCodeFormat] = usePersistentState<OutputFormat>("codeFormat", "react"); // of the code in the editor
  const [codeKind, setCodeKind] = usePersistentState<"component" | "page">("codeKind", "component");
  // Screenshots of the section(s) the code was generated from (for the AI and Compare view).
  const [originalImages, setOriginalImages] = usePersistentState<string[]>("originalImages", []);
  const [useScreenshots, setUseScreenshots] = usePersistentState("useScreenshots", true);
  // The user's own key per provider ("" = use the server's key).
  const [keys, setKeys] = usePersistentState<Record<Provider, string>>("apiKeys", { gemini: "", openai: "" });
  const setKey = (p: Provider, key: string) => setKeys((current) => ({ ...current, [p]: key }));
  // Whether the server has a working key per provider (null until known).
  const [serverKeys, setServerKeys] = useState<Record<Provider, boolean> | null>(null);
  // The provider the user picked, or null: then use one that has a working key.
  const [providerChoice, setProviderChoice] = usePersistentState<Provider | null>("providerChoice", null);
  const usable = (p: Provider) => !!keys[p].trim() || serverKeys?.[p] !== false;
  const provider: Provider =
    providerChoice ?? (!usable("gemini") && usable("openai") ? "openai" : "gemini");
  const apiKey = keys[provider]?.trim() || undefined; // sent with requests for the selected provider
  const [accessCode, setAccessCode] = usePersistentState("accessCode", "");
  // The saved project (history) the editor is working on, and its details.
  const [projectId, setProjectId] = usePersistentState<string | null>("projectId", null);
  const [editorFontCss, setEditorFontCss] = usePersistentState("editorFontCss", "");
  const [projectCost, setProjectCost] = usePersistentState("projectCost", 0);
  const [lastUsage, setLastUsage] = usePersistentState<Usage | null>("lastUsage", null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const theme = useTheme();

  // Code loaded into the editor. After a refresh it starts from the saved editor contents.
  const [code, setCode] = useState(() => readStored("liveCode", ""));
  const [editorVersion, setEditorVersion] = useState(0);

  // --- Request state ---
  const [busy, setBusy] = useState<null | "scrape" | "generate" | "refine">(null);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Sections picked for a combined page, in the order they were picked.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  // Only one automatic "fix the preview error" attempt per user action.
  const autoFixUsedRef = useRef(false);

  // Free hosting sleeps when idle; start waking the backend while the user types.
  useEffect(() => {
    wakeBackend();
    fetchServerProviders().then(setServerKeys);
  }, []);

  // A refresh can restore a step whose data didn't fit in storage.
  const currentStep: Step =
    step === "EDIT" && !liveCode ? (scrapeResult ? "SELECT" : "INPUT")
    : step === "SELECT" && !scrapeResult ? "INPUT"
    : step;

  const begin = (kind: "scrape" | "generate" | "refine") => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(kind);
    setStreamText("");
    setError(null);
    return controller;
  };
  const finish = (controller: AbortController) => {
    if (abortRef.current === controller) {
      abortRef.current = null;
      setBusy(null);
    }
  };
  const cancel = () => abortRef.current?.abort();
  const fail = (err: unknown, action: string) => {
    const message = describeError(err, action);
    if (!message) return; // cancelled by the user: not an error
    console.error(err);
    setError(message);
    // A rejected server key is now reported as unusable; refresh the settings' key status.
    fetchServerProviders().then((status) => {
      if (status) setServerKeys(status);
    });
  };

  const loadIntoEditor = (next: string) => {
    setCode(next);
    setLiveCode(next);
    setEditorVersion((v) => v + 1);
    setPreviewError(null);
  };

  const handleScrape = async (url: string, { fresh = false } = {}) => {
    const controller = begin("scrape");
    try {
      const result = await scrape(url, accessCode, controller.signal, { fresh });
      if (!result.sections.length) {
        setError(
          "No sections were found on that page. It may block automated browsers, need a login, or be mostly empty.",
        );
        return;
      }
      setScrapeResult(result);
      setSelectedIds([]);
      setStep("SELECT");
    } catch (err) {
      fail(err, "Scraping the page");
    } finally {
      finish(controller);
    }
  };

  /** Each section's image, cut out of the page screenshot (null where it isn't in it). */
  const sectionImages = async (picked: ScrapedSection[]): Promise<(string | null)[]> => {
    const shot = scrapeResult?.screenshot;
    const size = scrapeResult?.screenshotSize;
    if (!shot || !size) return picked.map(() => null);
    return Promise.all(picked.map((s) => cropSection(shot, size, s.rect).catch(() => null)));
  };

  /** Generates from one section, or several (in order) combined into a page. */
  const runGeneration = async (picked: ScrapedSection[]) => {
    if (busy || !picked.length) return;
    const kind = picked.length > 1 ? "page" : "component";
    const controller = begin("generate");
    try {
      const images = await sectionImages(picked);
      const { code: newCode, usage } = await generate(
        {
          ...(kind === "page" ? { sections: picked.map((s) => s.html) } : { html: picked[0]!.html }),
          instructions: DEFAULT_INSTRUCTIONS,
          format,
          provider,
          apiKey,
          fonts: scrapeResult?.fonts.families,
          // Screenshots help the AI match the design (a few more tokens per request).
          ...(useScreenshots && images.some(Boolean) ? { images } : {}),
        },
        accessCode,
        controller.signal,
        setStreamText,
      );
      setUndoStack([]);
      setRedoStack([]);
      autoFixUsedRef.current = false;
      setCodeFormat(format);
      setCodeKind(kind);
      const kept = images.filter((img): img is string => !!img);
      setOriginalImages(kept);
      setEditorFontCss(scrapeResult?.fonts.css ?? "");
      setLastUsage(usage);
      setProjectCost(usage.costUsd);
      loadIntoEditor(newCode);
      setStep("EDIT");
      // Save to history (this browser).
      const id = newProjectId();
      setProjectId(id);
      const now = Date.now();
      saveProject({
        id,
        title: projectTitle(picked, scrapeResult?.url ?? ""),
        siteUrl: scrapeResult?.url ?? "",
        kind,
        format,
        code: newCode,
        images: kept,
        fontCss: scrapeResult?.fonts.css ?? "",
        fontFamilies: scrapeResult?.fonts.families ?? [],
        costUsd: usage.costUsd,
        createdAt: now,
        updatedAt: now,
      }).catch(() => {}); // storage unavailable: history just isn't kept
    } catch (err) {
      fail(err, kind === "page" ? "Generating the page" : "Generating the component");
    } finally {
      finish(controller);
    }
  };

  const handleGenerate = (section: ScrapedSection) => runGeneration([section]);

  const handleGeneratePage = () => {
    // In the order the user picked them.
    const picked = selectedIds
      .map((id) => scrapeResult?.sections.find((s) => s.id === id))
      .filter((s): s is ScrapedSection => !!s);
    if (picked.length >= 2) void runGeneration(picked);
  };

  const toggleSection = (id: string) =>
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const handleRefine = async (instructions: string, { auto = false } = {}) => {
    if (!auto) autoFixUsedRef.current = false;
    const before = liveCode;
    const controller = begin("refine");
    try {
      // Send the editor's current code (including manual edits and earlier
      // refinements) so the AI modifies it instead of starting over.
      const { code: newCode, usage } = await generate(
        {
          currentCode: before,
          instructions,
          format: codeFormat,
          provider,
          apiKey,
          // The original design, so requests like "match the original spacing" work.
          ...(useScreenshots && originalImages.length ? { images: originalImages } : {}),
        },
        accessCode,
        controller.signal,
        setStreamText,
      );
      setUndoStack((stack) => [...stack, before].slice(-MAX_UNDO_STEPS));
      setRedoStack([]);
      setLastUsage(usage);
      const total = projectCost + usage.costUsd;
      setProjectCost(total);
      if (projectId) updateProject(projectId, { costUsd: total }).catch(() => {});
      loadIntoEditor(newCode);
    } catch (err) {
      fail(err, "Applying your changes");
    } finally {
      finish(controller);
    }
  };

  const fixPreviewError = (auto = false) => {
    if (!previewError) return;
    void handleRefine(
      `The code fails in the preview with the error below. Fix it without changing anything else.\n${previewError.slice(0, 1500)}`,
      { auto },
    );
  };

  // If fresh AI output doesn't run, ask the AI to fix it once, automatically.
  // Never while the user is editing by hand (liveCode !== code).
  const autoFix = useEffectEvent(() => {
    autoFixUsedRef.current = true;
    fixPreviewError(true);
  });
  useEffect(() => {
    if (!previewError || busy || currentStep !== "EDIT" || liveCode !== code) return;
    if (autoFixUsedRef.current) return;
    const timer = setTimeout(() => autoFix(), 2000);
    return () => clearTimeout(timer);
  }, [previewError, busy, currentStep, liveCode, code]);

  const undo = () => {
    const previous = undoStack.at(-1);
    if (previous === undefined) return;
    setUndoStack(undoStack.slice(0, -1));
    setRedoStack([...redoStack, liveCode]);
    autoFixUsedRef.current = true; // don't auto-fix a version the user chose
    loadIntoEditor(previous);
  };
  const redo = () => {
    const next = redoStack.at(-1);
    if (next === undefined) return;
    setRedoStack(redoStack.slice(0, -1));
    setUndoStack([...undoStack, liveCode]);
    autoFixUsedRef.current = true;
    loadIntoEditor(next);
  };

  // Keep the saved project in sync with the editor (AI changes and manual edits).
  useEffect(() => {
    if (!projectId || !liveCode) return;
    const timer = setTimeout(() => {
      updateProject(projectId, { code: liveCode }).catch(() => {});
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [projectId, liveCode]);

  const openProject = (project: Project) => {
    cancel();
    setProjectId(project.id);
    setCodeFormat(project.format);
    setCodeKind(project.kind);
    setOriginalImages(project.images);
    setEditorFontCss(project.fontCss);
    setProjectCost(project.costUsd);
    setLastUsage(null);
    setUndoStack([]);
    setRedoStack([]);
    autoFixUsedRef.current = true; // opened code isn't fresh AI output
    loadIntoEditor(project.code);
    setStep("EDIT");
    setHistoryOpen(false);
  };

  const settingsNode = (
    <ProviderSettings
      provider={provider}
      setProvider={setProviderChoice}
      keys={keys}
      setKey={setKey}
      serverKeys={serverKeys}
      accessCode={accessCode}
      setAccessCode={setAccessCode}
      format={format}
      setFormat={setFormat}
      useScreenshots={useScreenshots}
      setUseScreenshots={setUseScreenshots}
    />
  );

  const toolbar = (
    <>
      <HistoryButton onClick={() => setHistoryOpen(true)} />
      <ThemeToggle choice={theme.choice} onChange={theme.setChoice} />
      {settingsNode}
    </>
  );

  const banner = (
    <>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <HistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onOpenProject={openProject}
        currentProjectId={currentStep === "EDIT" ? projectId : null}
      />
    </>
  );

  if (currentStep === "INPUT") {
    return (
      <>
        {banner}
        <UrlInput
          onScrape={handleScrape}
          onInvalid={setError}
          onCancel={cancel}
          isLoading={busy === "scrape"}
          toolbar={toolbar}
        />
      </>
    );
  }

  if (currentStep === "SELECT" && scrapeResult) {
    return (
      <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        {banner}
        {(busy === "generate" || busy === "scrape") && (
          <div className="fixed inset-0 bg-white/90 dark:bg-gray-950/90 backdrop-blur-sm z-50 flex items-center justify-center p-4 sm:p-6">
            <div className="w-full max-w-2xl">
              <BusyNotice
                message={
                  busy === "scrape"
                    ? "Loading the page again…"
                    : selectedIds.length >= 2
                      ? "Generating your page…"
                      : "Generating your component…"
                }
                onCancel={cancel}
              >
                <StreamingOutput text={streamText} />
              </BusyNotice>
            </div>
          </div>
        )}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b px-3 py-3 sm:p-4 backdrop-blur bg-white/90 border-gray-100 dark:bg-gray-950/90 dark:border-gray-800">
          <button
            type="button"
            onClick={() => setStep("INPUT")}
            className="flex shrink-0 items-center gap-2 text-gray-600 hover:text-black dark:text-gray-300 dark:hover:text-white"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden /> <span className="hidden sm:inline">New URL</span>
            <span className="sm:hidden">Back</span>
          </button>
          <h1 className="truncate font-semibold text-base sm:text-lg">Found {scrapeResult.sections.length} Sections</h1>
          <div className="flex shrink-0 items-center gap-2">{toolbar}</div>
        </div>
        <SectionSelector
          result={scrapeResult}
          onSelect={handleGenerate}
          selectedIds={selectedIds}
          onToggle={toggleSection}
          onClearSelection={() => setSelectedIds([])}
          onGeneratePage={handleGeneratePage}
          onRefresh={() => handleScrape(scrapeResult.url, { fresh: true })}
          disabled={busy !== null}
        />
      </div>
    );
  }

  return (
    <>
      {banner}
      <ComponentEditor
        format={codeFormat}
        kind={codeKind}
        originalImages={originalImages}
        code={code}
        editorVersion={editorVersion}
        liveCode={liveCode}
        fontCss={editorFontCss}
        onCodeChange={setLiveCode}
        previewError={previewError}
        onPreviewErrorChange={setPreviewError}
        onFixError={() => fixPreviewError()}
        onRefine={(instructions) => handleRefine(instructions)}
        isRefining={busy === "refine"}
        refineText={streamText}
        onCancelRefine={cancel}
        onUndo={undo}
        onRedo={redo}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        onBack={() => setStep(scrapeResult ? "SELECT" : "INPUT")}
        toolbar={toolbar}
        dark={theme.dark}
        lastUsage={lastUsage}
        projectCostUsd={projectCost}
      />
    </>
  );
}

// Rendered only in the browser: the app restores state from sessionStorage on load,
// which would otherwise mismatch the server-rendered HTML.
export default dynamic(() => Promise.resolve(App), { ssr: false });
