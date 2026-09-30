"use client";

import React, { useEffect, useId, useState } from "react";
import { Gauge, Loader2, RotateCw, WandSparkles, X } from "lucide-react";
import { cn } from "../lib/cn";
import type { FidelityResult } from "../lib/api";

/** The match score of some version of the code. */
export type FidelityState =
  | { status: "measuring"; code: string }
  | { status: "done"; code: string; result: FidelityResult }
  | { status: "error"; code: string; error: string };

export const FIDELITY_TARGETS = [80, 85, 90, 95] as const;
export const IMPROVE_ROUNDS = 3;

/** Green at or above the target, amber when close, red otherwise. */
function tone(score: number, target: number) {
  if (score >= target) return "text-green-700 dark:text-green-400";
  if (score >= target - 20) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

const Bar = ({ label, value, hint }: { label: string; value: number; hint?: string }) => (
  <div>
    <div className="flex justify-between text-xs">
      <span className="text-gray-600 dark:text-gray-300">
        {label}
        {hint && <span className="text-gray-400 dark:text-gray-500"> · {hint}</span>}
      </span>
      <span className="font-medium tabular-nums">{Math.round(value * 100)}%</span>
    </div>
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
      <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  </div>
);

/** One side of the side-by-side check: scrolls when tall. */
const Shot = ({ title, images }: { title: string; images: string[] }) => (
  <figure className="min-w-0 flex-1">
    <figcaption className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-300">{title}</figcaption>
    <div className="max-h-56 overflow-auto rounded border border-gray-200 bg-white dark:border-gray-700">
      {images.map((src, i) => (
        // eslint-disable-next-line @next/next/no-img-element -- local data URLs
        <img key={i} src={src} alt={`${title} ${i + 1}`} className="block w-full" />
      ))}
    </div>
  </figure>
);

/**
 * "Match 82%" badge for the editor header, with a panel showing how the score is made
 * up, the render next to the original, and Auto-improve.
 */
export const FidelityControl = ({
  state,
  liveCode,
  unsupportedReason,
  originalImages,
  width,
  target,
  onTargetChange,
  onRecheck,
  onAutoImprove,
  busy,
  lastRun,
}: {
  state: FidelityState | null;
  liveCode: string; // what the editor shows now; the score may be for an older version
  unsupportedReason: string | null; // why this code can't be scored, if it can't
  originalImages: string[];
  width: number; // render width in CSS px
  target: number;
  onTargetChange: (target: number) => void;
  onRecheck: () => void;
  onAutoImprove: () => void;
  busy: boolean; // an AI request is running
  lastRun: string | null; // summary of the last Auto-improve
}) => {
  const [open, setOpen] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!originalImages.length) return null; // nothing to compare with

  const stale = state !== null && state.status !== "measuring" && state.code !== liveCode;
  const result = state?.status === "done" ? state.result : null;

  let badge: React.ReactNode;
  let title: string;
  if (unsupportedReason) {
    badge = <>Match —</>;
    title = unsupportedReason;
  } else if (!state || state.status === "measuring") {
    badge = (
      <>
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Match…
      </>
    );
    title = "Measuring how closely the code matches the original…";
  } else if (state.status === "error") {
    badge = <>Match ?</>;
    title = state.error;
  } else {
    badge = (
      <>
        Match <span className={cn("font-semibold tabular-nums", tone(state.result.score, target))}>{state.result.score}%</span>
      </>
    );
    title = stale
      ? `${state.result.score}% before your edits. Open to re-check.`
      : `The rendered code matches the original screenshot ${state.result.score}%. Click for details and Auto-improve.`;
  }

  const heightHint =
    result && result.size < 0.95
      ? result.heightRatio > 1
        ? `${Math.round((result.heightRatio - 1) * 100)}% too tall`
        : `${Math.round((1 - result.heightRatio) * 100)}% too short`
      : undefined;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
          "border-gray-200 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800",
          stale && "border-dashed",
        )}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        aria-label={title}
        title={title}
        data-testid="fidelity-badge"
      >
        <Gauge className="h-3.5 w-3.5" aria-hidden />
        {badge}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[90]" onClick={() => setOpen(false)} aria-hidden />
          <div
            id={`${id}-panel`}
            role="dialog"
            aria-label="Match with the original"
            className="fixed inset-x-4 top-20 sm:absolute sm:inset-x-auto sm:left-0 sm:top-9 z-[100] sm:w-[28rem] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-xl border p-4 shadow-2xl bg-white border-gray-200 text-gray-900 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="font-bold">Match with the original</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  The code is rendered at {width}px and compared with the screenshot. Uses no AI tokens.
                </p>
              </div>
              {result && (
                <span className={cn("text-3xl font-bold tabular-nums", tone(result.score, target))} data-testid="fidelity-score">
                  {result.score}%
                </span>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            {unsupportedReason ? (
              <p className="text-sm text-gray-600 dark:text-gray-300">{unsupportedReason}</p>
            ) : (
              <div className="space-y-4">
                {state?.status === "measuring" && (
                  <p className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Rendering and comparing…
                  </p>
                )}
                {state?.status === "error" && (
                  <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
                    {state.error}
                  </p>
                )}
                {stale && (
                  <p className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600 dark:bg-gray-800/60 dark:text-gray-300">
                    You edited the code after this was measured.
                  </p>
                )}
                {result && (
                  <>
                    <div className="space-y-2">
                      <Bar label="Layout & shapes" value={result.structure} />
                      <Bar label="Colors" value={result.color} />
                      <Bar label="Height" value={result.size} hint={heightHint} />
                    </div>
                    <div className="flex gap-3">
                      <Shot title="Original" images={originalImages} />
                      <Shot title="Your code, rendered" images={[result.render]} />
                    </div>
                  </>
                )}

                <div className="flex flex-wrap items-center gap-2 border-t pt-3 border-gray-200 dark:border-gray-700">
                  <label className="flex items-center gap-1.5 text-sm">
                    Target
                    <select
                      value={target}
                      onChange={(e) => onTargetChange(Number(e.target.value))}
                      className="rounded-md border px-1.5 py-1 text-sm bg-white border-gray-300 dark:bg-gray-950 dark:border-gray-700"
                    >
                      {FIDELITY_TARGETS.map((t) => (
                        <option key={t} value={t}>
                          {t}%
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onAutoImprove();
                    }}
                    disabled={busy || state?.status === "measuring" || (!!result && !stale && result.score >= target)}
                    className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
                  >
                    <WandSparkles className="h-4 w-4" aria-hidden /> Auto-improve
                  </button>
                  <button
                    type="button"
                    onClick={onRecheck}
                    disabled={state?.status === "measuring"}
                    className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm border-gray-300 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800"
                  >
                    <RotateCw className="h-4 w-4" aria-hidden /> Re-check
                  </button>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Auto-improve shows the AI its render next to the original, for up to {IMPROVE_ROUNDS} rounds
                  (one AI request each) until the target is reached. The best version is kept; Undo restores yours.
                </p>
                {lastRun && <p className="text-xs font-medium text-gray-700 dark:text-gray-200" data-testid="fidelity-last-run">{lastRun}</p>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
