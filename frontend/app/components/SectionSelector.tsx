"use client";

import React from "react";
import { ArrowRight, Layers, Plus, RefreshCw } from "lucide-react";
import { cn } from "../lib/cn";
import type { ScrapeResult, ScrapedSection } from "../lib/api";

// Cards show at most this tall a slice of the section, relative to its width.
const MAX_PREVIEW_RATIO = 0.6;
// The screenshot is defined once in a <style> rule and shown as a background, so the
// (large) image data isn't repeated for every card.
const PREVIEW_CLASS = "section-shot";

export const MAX_PAGE_SECTIONS = 8; // matches the backend

/** The section's area of the page screenshot, or nothing if it isn't in the screenshot. */
const SectionPreview = ({
  section,
  imageSize,
}: {
  section: ScrapedSection;
  imageSize: { width: number; height: number };
}) => {
  const { x, y, width, height } = section.rect;
  const cropHeight = Math.min(height, width * MAX_PREVIEW_RATIO);
  if (width <= 0 || cropHeight <= 0 || y + cropHeight > imageSize.height) return null;
  // Percent background positions: p% aligns p% of the image with p% of the box, so
  // an offset of x (image px) is x / (imageWidth - boxWidth), in the image's own units.
  const posX = imageSize.width > width ? (x / (imageSize.width - width)) * 100 : 0;
  const posY = imageSize.height > cropHeight ? (y / (imageSize.height - cropHeight)) * 100 : 0;
  return (
    <div
      className={`${PREVIEW_CLASS} w-full bg-gray-100 bg-no-repeat border-b border-gray-100 dark:bg-gray-800 dark:border-gray-800`}
      style={{
        aspectRatio: `${width} / ${cropHeight}`,
        backgroundSize: `${(imageSize.width / width) * 100}% auto`,
        backgroundPosition: `${posX}% ${posY}%`,
      }}
      aria-hidden
    />
  );
};

/** "3 minutes ago" style age of a timestamp. */
function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
}

// 2. Section Selector
export const SectionSelector = ({
  result,
  onSelect,
  selectedIds,
  onToggle,
  onClearSelection,
  onGeneratePage,
  onRefresh,
  disabled,
}: {
  result: ScrapeResult;
  onSelect: (section: ScrapedSection) => void;
  /** Sections picked for a combined page, in the order they were picked. */
  selectedIds: string[];
  onToggle: (id: string) => void;
  onClearSelection: () => void;
  onGeneratePage: () => void;
  /** Scrape the URL again, skipping the server's cache. */
  onRefresh: () => void;
  disabled: boolean;
}) => {
  // The value goes into a <style> rule, so accept nothing but a base64 JPEG data URL.
  const showPreviews =
    !!result.screenshotSize &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(result.screenshot ?? "");
  const selectionFull = selectedIds.length >= MAX_PAGE_SECTIONS;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 sm:py-12 pb-32 animate-in fade-in duration-500">
      {showPreviews && (
        <style>{`.${PREVIEW_CLASS}{background-image:url("${result.screenshot}")}`}</style>
      )}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2 text-gray-900 dark:text-white">
            <span
              className="bg-blue-600 text-white w-8 h-8 rounded-full flex items-center justify-center text-sm"
              aria-hidden
            >
              2
            </span>
            Select a Section to Convert
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Click a card to convert that section, or use{" "}
            <Plus className="inline w-3.5 h-3.5" aria-label="the plus button" /> to combine up to{" "}
            {MAX_PAGE_SECTIONS} sections into one page.
          </p>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <span className="truncate max-w-[14rem] sm:max-w-[16rem]" title={result.url}>
            {result.url}
          </span>
          <span aria-hidden>·</span>
          <span>
            {result.cached ? "Saved copy from " : "Scraped "}
            {timeAgo(result.scrapedAt)}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={disabled}
            className="flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden /> Refresh
          </button>
        </p>
      </div>

      <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {result.sections.map((section) => {
          const selected = selectedIds.includes(section.id);
          const order = selectedIds.indexOf(section.id) + 1;
          return (
            <li key={section.id} className="relative">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect(section)}
                aria-label={`Generate a component from this ${section.tagName} section${
                  section.text ? `: ${section.text.slice(0, 80)}` : ""
                }`}
                className={cn(
                  "group w-full h-full text-left border rounded-xl overflow-hidden hover:border-blue-400 hover:shadow-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-200 dark:focus-visible:ring-blue-900 transition-all bg-white dark:bg-gray-900 flex flex-col disabled:cursor-wait",
                  selected ? "border-blue-500 ring-2 ring-blue-200 dark:ring-blue-900" : "border-gray-200 dark:border-gray-800",
                )}
              >
                <div className="bg-gray-50 dark:bg-gray-800/60 p-4 pr-14 border-b border-gray-100 dark:border-gray-800 flex justify-between items-center w-full">
                  <span className="font-mono text-xs px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded text-gray-600 dark:text-gray-300">
                    {section.tagName}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-gray-500">ID: {section.id}</span>
                </div>
                {showPreviews && (
                  <SectionPreview section={section} imageSize={result.screenshotSize!} />
                )}
                <div className="p-4 flex-1 w-full">
                  <p className="text-gray-600 dark:text-gray-300 line-clamp-4 font-mono text-xs leading-relaxed">
                    {section.text || section.html.substring(0, 150) + "..."}
                  </p>
                </div>
                <div className="p-4 bg-gray-50 dark:bg-gray-800/60 border-t border-gray-100 dark:border-gray-800 group-hover:bg-blue-50 dark:group-hover:bg-blue-950/50 transition-colors w-full">
                  <span className="w-full text-blue-600 dark:text-blue-400 font-medium text-sm flex items-center justify-center gap-2">
                    Generate Component <ArrowRight className="w-4 h-4" aria-hidden />
                  </span>
                </div>
              </button>
              {/* A sibling of the card button, because buttons can't be nested. */}
              <button
                type="button"
                onClick={() => onToggle(section.id)}
                disabled={disabled || (!selected && selectionFull)}
                aria-pressed={selected}
                aria-label={
                  selected
                    ? `Remove section ${section.id} from the page`
                    : `Add section ${section.id} to a page`
                }
                title={
                  selected
                    ? "Remove from page"
                    : selectionFull
                      ? `Up to ${MAX_PAGE_SECTIONS} sections`
                      : "Add to page"
                }
                className={cn(
                  "absolute top-3 right-3 w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold border transition-colors disabled:opacity-40",
                  selected
                    ? "bg-blue-600 border-blue-600 text-white"
                    : "bg-white border-gray-300 text-gray-500 hover:border-blue-500 hover:text-blue-600 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-400",
                )}
              >
                {selected ? order : <Plus className="w-4 h-4" aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>

      {selectedIds.length > 0 && (
        <div
          role="region"
          aria-label="Page builder"
          className="fixed bottom-4 inset-x-4 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 z-40 flex flex-wrap items-center justify-between sm:justify-start gap-x-4 gap-y-2 rounded-2xl sm:rounded-full bg-gray-900 dark:bg-gray-800 dark:ring-1 dark:ring-gray-700 text-white shadow-2xl pl-5 pr-2 py-2"
        >
          <span className="text-sm">
            {selectedIds.length} section{selectedIds.length === 1 ? "" : "s"} selected
            {selectedIds.length < 2 && <span className="text-gray-400"> · pick at least 2</span>}
          </span>
          <button
            type="button"
            onClick={onClearSelection}
            className="text-sm text-gray-300 hover:text-white"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onGeneratePage}
            disabled={disabled || selectedIds.length < 2}
            className="flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-50"
          >
            <Layers className="w-4 h-4" aria-hidden /> Generate page
          </button>
        </div>
      )}
    </div>
  );
};
