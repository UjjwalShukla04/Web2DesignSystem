"use client";

import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import {
  describeError,
  errorStatus,
  fetchCapture,
  generate,
  measureFidelity,
  renderPreview,
  scrape,
  fetchServerProviders,
  wakeBackend,
  FIDELITY_FORMATS,
  type FidelityResult,
  type Provider,
  type ScrapeResult,
  type ScrapedSection,
  type Usage,
} from "./lib/api";
import { newProjectId, saveProject, updateProject, type Project } from "./lib/history";
import { useTheme } from "./lib/theme";
import { readStored, usePersistentState } from "./lib/storage";
import { FORMATS, type OutputFormat } from "./lib/formats";
import { cropSection } from "./lib/crop";
import { ProviderSettings } from "./components/ProviderSettings";
import { UrlInput } from "./components/UrlInput";
import { SectionSelector } from "./components/SectionSelector";
import { ComponentEditor } from "./components/ComponentEditor";
import { BusyNotice, ErrorBanner, StreamingOutput } from "./components/Feedback";
import { HistoryButton, HistoryPanel } from "./components/HistoryPanel";
import { ThemeToggle } from "./components/ThemeToggle";
import { FidelityControl, IMPROVE_ROUNDS, type FidelityState } from "./components/FidelityPanel";

type Step = "INPUT" | "SELECT" | "EDIT";

const MAX_UNDO_STEPS = 20;
const DEFAULT_INSTRUCTIONS = "Make it a modern, responsive, faithful version of the original.";
// Saved projects keep the latest editor contents, a moment after typing stops.
const AUTOSAVE_DELAY_MS = 800;

/** Width the original section had on the page (the match score renders at it). */
function sectionWidth(picked: ScrapedSection[]): number {
  if (picked.length !== 1) return 1280; // a page: the full scraped width
  return Math.min(1920, Math.max(320, Math.round(picked[0]!.rect.width)));
}

/** What the AI should fix, from the weakest parts of the match score. */
function improveInstructions(result: FidelityResult, target: number): string {
  const parts = [
    `Make the rendered result match the original design as closely as possible. It matches ${result.score}% now; the goal is ${target}% or more.`,
  ];
  if (result.structure < 0.85) {
    parts.push("Layout and shapes differ most: check alignment, column widths, gaps, element sizes, and missing or extra elements.");
  }
  if (result.color < 0.9) parts.push("Colors differ: match background, text and border colors exactly.");
  if (result.size < 0.95) {
    const off = Math.round(Math.abs(result.heightRatio - 1) * 100);
    parts.push(
      `The render is ${off}% ${result.heightRatio > 1 ? "taller" : "shorter"} than the original: adjust padding, margins, line heights and font sizes.`,
    );
  }
  parts.push("Keep the text, links and images as they are.");
  return parts.join(" ");
}

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
  // --- Match score (fidelity) ---
  const [originalWidth, setOriginalWidth] = usePersistentState("originalWidth", 1280);
  const [fidelityTarget, setFidelityTarget] = usePersistentState("fidelityTarget", 90);
  const [fidelity, setFidelity] = useState<FidelityState | null>(null);
  const [improveProgress, setImproveProgress] = useState<string | null>(null);
  const [improveSummary, setImproveSummary] = useState<string | null>(null);
  // Scores by code, so undo/redo shows them at once. Cleared for each new project.
  const scoresRef = useRef(new Map<string, FidelityResult>());
  const measureAbortRef = useRef<AbortController | null>(null);

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
    measureAbortRef.current?.abort();
    setFidelity(null);
  };

  /** Starts a new project: scores of other code don't apply to it. */
  const resetFidelity = () => {
    scoresRef.current.clear();
    setImproveSummary(null);
  };

  const fidelityUnsupported = FIDELITY_FORMATS.includes(codeFormat)
    ? null
    : `The match score works for React and HTML output; ${FORMATS[codeFormat].label} isn't supported yet.`;

  /** Renders `target` on the server and scores it against the original (no AI tokens). */
  const scoreCode = async (target: string, signal: AbortSignal): Promise<FidelityResult> => {
    const result = await measureFidelity(
      { code: target, format: codeFormat, images: originalImages, fontCss: editorFontCss, width: originalWidth },
      accessCode,
      signal,
    );
    const scores = scoresRef.current;
    scores.set(target, result);
    if (scores.size > 30) scores.delete(scores.keys().next().value!);
    return result;
  };

  const checkFidelity = async (target: string) => {
    measureAbortRef.current?.abort();
    const known = scoresRef.current.get(target);
    if (known) {
      setFidelity({ status: "done", code: target, result: known });
      return;
    }
    const controller = new AbortController();
    measureAbortRef.current = controller;
    setFidelity({ status: "measuring", code: target });
    try {
      const result = await scoreCode(target, controller.signal);
      if (measureAbortRef.current === controller) setFidelity({ status: "done", code: target, result });
    } catch (err) {
      if (measureAbortRef.current !== controller) return; // replaced by a newer check
      const message = describeError(err, "Measuring the match");
      setFidelity(message ? { status: "error", code: target, error: message } : null);
    } finally {
      if (measureAbortRef.current === controller) measureAbortRef.current = null;
    }
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

  // Opened from the browser extension: /?capture=<id> loads that capture. Retried when
  // the Access Code changes (a 401 asks for it); the address is cleaned up once loaded.
  const loadCapture = useEffectEvent(async (id: string) => {
    const controller = begin("scrape");
    try {
      const result = await fetchCapture(id, accessCode, controller.signal);
      setScrapeResult(result);
      setSelectedIds([]);
      setStep("SELECT");
      window.history.replaceState(null, "", window.location.pathname);
    } catch (err) {
      fail(err, "Opening the captured page");
    } finally {
      finish(controller);
    }
  });
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("capture");
    if (!id) return;
    const timer = setTimeout(() => void loadCapture(id), 400);
    return () => clearTimeout(timer);
  }, [accessCode]);

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
      setOriginalWidth(sectionWidth(picked));
      resetFidelity();
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
        width: sectionWidth(picked),
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

  /**
   * How `target` looks when rendered, so the AI can see what a request refers to.
   * Reuses the match score's render when there is one. Null when it can't be made
   * (screenshots turned off, unsupported format, code that doesn't render, slow server).
   */
  const renderForRequest = async (target: string, signal: AbortSignal): Promise<string | null> => {
    if (!useScreenshots || fidelityUnsupported) return null;
    const known = scoresRef.current.get(target);
    if (known) return known.render;
    try {
      return await renderPreview(
        { code: target, format: codeFormat, fontCss: editorFontCss, width: originalWidth },
        accessCode,
        AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
      );
    } catch (err) {
      if (signal.aborted) throw err; // cancelled by the user
      return null; // the request still works without it
    }
  };

  const handleRefine = async (instructions: string, { auto = false } = {}) => {
    if (!auto) autoFixUsedRef.current = false;
    const before = liveCode;
    const controller = begin("refine");
    try {
      // Fixing a preview error: the code doesn't render, so there's nothing to show.
      let renderImage: string | null = null;
      if (!auto) {
        setImproveProgress("Looking at the current version…");
        renderImage = await renderForRequest(before, controller.signal);
        setImproveProgress(null);
      }
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
          // How it looks now, so requests like "make the title bigger" are applied precisely.
          ...(renderImage ? { renderImage } : {}),
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
      setImproveProgress(null);
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

  // Score fresh AI output (and undo/redo steps) automatically. Not while the user is
  // editing by hand: then the badge shows the older score until they press Re-check.
  const autoCheck = useEffectEvent(() => void checkFidelity(code));
  useEffect(() => {
    if (currentStep !== "EDIT" || fidelityUnsupported || !originalImages.length || !code) return;
    if (busy || liveCode !== code || fidelity?.code === code) return;
    // Give the preview a head start: both load the same CDN packages.
    const timer = setTimeout(() => autoCheck(), scoresRef.current.has(code) ? 0 : 1000);
    return () => clearTimeout(timer);
  }, [currentStep, fidelityUnsupported, originalImages.length, code, busy, liveCode, fidelity?.code]);

  /**
   * Shows the AI its own render next to the original and asks it to close the gap, up
   * to IMPROVE_ROUNDS times or until the target is reached. Each round builds on the
   * best version so far; the best one is loaded (one Undo step restores the start).
   */
  const autoImprove = async () => {
    if (busy || fidelityUnsupported || !originalImages.length) return;
    const start = liveCode;
    const target = fidelityTarget;
    measureAbortRef.current?.abort();
    const controller = begin("refine");
    setImproveSummary(null);
    let best: { code: string; result: FidelityResult } | null = null;
    let rounds = 0;
    let spent = 0;
    try {
      setImproveProgress("Auto-improve: measuring the current version…");
      const startResult = scoresRef.current.get(start) ?? (await scoreCode(start, controller.signal));
      best = { code: start, result: startResult };
      while (rounds < IMPROVE_ROUNDS && best.result.score < target) {
        rounds++;
        setImproveProgress(
          `Auto-improve: round ${rounds} of ${IMPROVE_ROUNDS} · best so far ${best.result.score}% · target ${target}%`,
        );
        setStreamText("");
        const { code: candidate, usage } = await generate(
          {
            currentCode: best.code,
            instructions: improveInstructions(best.result, target),
            format: codeFormat,
            provider,
            apiKey,
            images: originalImages,
            renderImage: best.result.render,
          },
          accessCode,
          controller.signal,
          setStreamText,
        );
        spent += usage.costUsd;
        setLastUsage(usage);
        setImproveProgress(`Auto-improve: round ${rounds} of ${IMPROVE_ROUNDS} · measuring the new version…`);
        let result: FidelityResult;
        try {
          result = await scoreCode(candidate, controller.signal);
        } catch (err) {
          if (errorStatus(err) === 422) continue; // the new version doesn't render; retry from the best
          throw err;
        }
        if (result.score > best.result.score) best = { code: candidate, result };
      }
    } catch (err) {
      fail(err, "Auto-improve");
    } finally {
      if (spent > 0) {
        const total = projectCost + spent;
        setProjectCost(total);
        if (projectId) updateProject(projectId, { costUsd: total }).catch(() => {});
      }
      if (best) {
        const from = scoresRef.current.get(start)?.score ?? best.result.score;
        if (best.code !== start) {
          setUndoStack((stack) => [...stack, start].slice(-MAX_UNDO_STEPS));
          setRedoStack([]);
          autoFixUsedRef.current = true;
          loadIntoEditor(best.code);
          setImproveSummary(
            `Auto-improve: ${from}% → ${best.result.score}% in ${rounds} round${rounds === 1 ? "" : "s"}` +
              (best.result.score >= target ? "." : ` (target ${target}% not reached).`) +
              " Undo restores the previous version.",
          );
        } else {
          setImproveSummary(
            rounds
              ? `Auto-improve: no new version beat ${from}% in ${rounds} round${rounds === 1 ? "" : "s"}, so your code is unchanged.`
              : `Already at ${from}%, the target is ${target}%.`,
          );
        }
        setFidelity({ status: "done", code: best.code, result: best.result });
      }
      setImproveProgress(null);
      finish(controller);
    }
  };

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
    setOriginalWidth(project.width ?? 1280);
    resetFidelity();
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
        busyMessage={improveProgress}
        notice={improveSummary}
        onDismissNotice={() => setImproveSummary(null)}
        fidelity={
          <FidelityControl
            state={fidelity}
            liveCode={liveCode}
            unsupportedReason={fidelityUnsupported}
            originalImages={originalImages}
            width={originalWidth}
            target={fidelityTarget}
            onTargetChange={setFidelityTarget}
            onRecheck={() => {
              scoresRef.current.delete(liveCode);
              void checkFidelity(liveCode);
            }}
            onAutoImprove={() => void autoImprove()}
            busy={busy !== null}
            lastRun={improveSummary}
          />
        }
      />
    </>
  );
}

// Rendered only in the browser: the app restores state from sessionStorage on load,
// which would otherwise mismatch the server-rendered HTML.
export default dynamic(() => Promise.resolve(App), { ssr: false });
