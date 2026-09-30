// Page captures uploaded by the browser extension. The extension extracts the sections
// in the user's own tab (logged-in pages, pages that block headless browsers) and uploads
// them here; the app then opens the capture by its id. Kept in memory for a short time.

import crypto from "crypto";
import { CAPTURE_LIMITS } from "./inpage.js";
import { parseImageDataUrl } from "./generator.js";
import type { ScrapeResult } from "./extract.js";

export const CAPTURE_TTL_MS = 30 * 60_000;
const MAX_CAPTURES = 20;
/** All stored captures together; the oldest are dropped to stay under it. */
const MAX_TOTAL_BYTES = 80_000_000;
const MAX_SCREENSHOT_CHARS = 8_000_000;
const MAX_TEXT_CHARS = 1_000;
const MAX_URL_CHARS = 2_048;

export interface Capture extends ScrapeResult {
  /** The captured page's address. */
  url: string;
  /** When the extension uploaded it (ISO timestamp). */
  capturedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isString = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** Checks an uploaded capture. Returns the capture, or a message saying what's wrong. */
export function validateCapture(body: unknown): { capture: Omit<Capture, "capturedAt"> } | { error: string } {
  if (!isObject(body)) return { error: "The capture must be a JSON object" };
  const { url, sections, screenshot, screenshotSize, fonts } = body;

  if (!isString(url, MAX_URL_CHARS)) return { error: "url must be the captured page's address" };
  let pageUrl: URL;
  try {
    pageUrl = new URL(url);
  } catch {
    return { error: "url must be the captured page's address" };
  }
  if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") {
    return { error: "Only http and https pages can be captured" };
  }

  if (!Array.isArray(sections) || sections.length < 1 || sections.length > CAPTURE_LIMITS.maxSections) {
    return { error: `sections must be a list of 1 to ${CAPTURE_LIMITS.maxSections} sections` };
  }
  for (const s of sections) {
    if (
      !isObject(s) ||
      !isString(s.id, 200) ||
      !(typeof s.tagName === "string" && /^[a-z][a-z0-9-]{0,39}$/i.test(s.tagName)) ||
      !isString(s.text, MAX_TEXT_CHARS) ||
      !isString(s.html, CAPTURE_LIMITS.maxSectionHtmlChars) ||
      !isObject(s.rect) ||
      !["x", "y", "width", "height"].every((k) => isNumber((s.rect as Record<string, unknown>)[k])) ||
      (s.rect as { width: number }).width < 0 ||
      (s.rect as { height: number }).height < 0
    ) {
      return { error: "Each section needs id, tagName, text, html and rect {x, y, width, height}" };
    }
  }

  if (screenshot !== null) {
    if (!isString(screenshot, MAX_SCREENSHOT_CHARS) || !parseImageDataUrl(screenshot)) {
      return { error: "screenshot must be a JPEG/PNG/WebP data URL (or null)" };
    }
    if (
      !isObject(screenshotSize) ||
      !isNumber(screenshotSize.width) ||
      !isNumber(screenshotSize.height) ||
      screenshotSize.width <= 0 ||
      screenshotSize.width > 4_000 ||
      screenshotSize.height <= 0 ||
      screenshotSize.height > CAPTURE_LIMITS.maxScreenshotHeight
    ) {
      return { error: "screenshotSize must be the screenshot's {width, height} in CSS pixels" };
    }
  }

  if (
    !isObject(fonts) ||
    !Array.isArray(fonts.families) ||
    fonts.families.length > 50 ||
    !fonts.families.every((f) => isString(f, 200)) ||
    !isString(fonts.css, CAPTURE_LIMITS.maxFontCssChars)
  ) {
    return { error: "fonts must be {families: string[], css: string}" };
  }

  // Rebuilt field by field, so nothing else in the upload is kept.
  return {
    capture: {
      url: pageUrl.toString(),
      sections: sections.map((s: any) => ({
        id: s.id,
        tagName: s.tagName.toLowerCase(),
        text: s.text,
        html: s.html,
        rect: { x: s.rect.x, y: s.rect.y, width: s.rect.width, height: s.rect.height },
      })),
      screenshot: screenshot as string | null,
      screenshotSize: screenshot === null ? null : { width: (screenshotSize as any).width, height: (screenshotSize as any).height },
      fonts: { families: fonts.families as string[], css: fonts.css as string },
    },
  };
}

/** Approximate memory used by a capture. */
function sizeOf(capture: Omit<Capture, "capturedAt">): number {
  return (
    (capture.screenshot?.length ?? 0) +
    capture.fonts.css.length +
    capture.sections.reduce((sum, s) => sum + s.html.length + s.text.length + 200, 0)
  );
}

export function createCaptureStore({
  ttlMs = CAPTURE_TTL_MS,
  maxEntries = MAX_CAPTURES,
  maxBytes = MAX_TOTAL_BYTES,
  now = Date.now,
}: { ttlMs?: number; maxEntries?: number; maxBytes?: number; now?: () => number } = {}) {
  // Insertion order = age, so the first entry is always the oldest.
  const entries = new Map<string, { capture: Capture; bytes: number; expires: number }>();
  let totalBytes = 0;

  const remove = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;
    totalBytes -= entry.bytes;
    entries.delete(id);
  };
  const pruneExpired = () => {
    for (const [id, entry] of entries) if (entry.expires <= now()) remove(id);
  };

  return {
    /** Stores a capture and returns its id (unguessable: it is the only key to it). */
    put(capture: Omit<Capture, "capturedAt">): string {
      pruneExpired();
      const bytes = sizeOf(capture);
      while (entries.size && (entries.size >= maxEntries || totalBytes + bytes > maxBytes)) {
        remove(entries.keys().next().value!);
      }
      const id = crypto.randomUUID();
      entries.set(id, {
        capture: { ...capture, capturedAt: new Date(now()).toISOString() },
        bytes,
        expires: now() + ttlMs,
      });
      totalBytes += bytes;
      return id;
    },
    /** The capture, or null if it doesn't exist or has expired. */
    get(id: string): Capture | null {
      const entry = entries.get(id);
      if (!entry) return null;
      if (entry.expires <= now()) {
        remove(id);
        return null;
      }
      return entry.capture;
    },
    get size() {
      return entries.size;
    },
  };
}
