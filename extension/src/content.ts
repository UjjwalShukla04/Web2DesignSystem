// Injected into the tab being captured (only when the user clicks Capture).
// Bundled into ../content.js by `npm run build:extension` in backend/.
// Uses the same section-extraction code as the backend scraper.

import { CAPTURE_LIMITS, desktopPass, finishPass, scrollThrough } from "../../backend/src/inpage";

/** Finds and copies the sections. Called once, at the top of the page. */
async function prepare() {
  await scrollThrough(); // load lazy images, run scroll-reveal animations
  const desktop = desktopPass({
    maxSections: CAPTURE_LIMITS.maxSections,
    maxCopiedElements: CAPTURE_LIMITS.maxCopiedElements,
    maxStyledElements: CAPTURE_LIMITS.maxStyledElements,
    maxFontCssChars: CAPTURE_LIMITS.maxFontCssChars,
  });
  // The user's tab can't be resized to a phone width, so no mobile styles are recorded.
  const htmls = finishPass({ maxSectionHtmlChars: CAPTURE_LIMITS.maxSectionHtmlChars, recordMobile: false });
  return {
    url: location.href,
    sections: desktop.sections.map((section, i) => ({ ...section, html: htmls[i] ?? "" })),
    fonts: desktop.fonts,
    pageHeight: desktop.pageHeight,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    maxScreenshotHeight: CAPTURE_LIMITS.maxScreenshotHeight,
  };
}

/** Scrolls to `y` without animation; resolves with where the page really is after painting. */
function scrollToY(y: number): Promise<number> {
  window.scrollTo({ top: y, left: 0, behavior: "instant" as ScrollBehavior });
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.scrollY))));
}

// Fixed and sticky elements (headers, cookie bars, chat buttons) would repeat in every
// slice of the full-page screenshot, so they're hidden after the first slice.
let hidden: { el: HTMLElement; value: string; priority: string }[] = [];

function hideFixed(): number {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
    const position = getComputedStyle(el).position;
    if (position !== "fixed" && position !== "sticky") continue;
    hidden.push({ el, value: el.style.getPropertyValue("visibility"), priority: el.style.getPropertyPriority("visibility") });
    el.style.setProperty("visibility", "hidden", "important");
  }
  return hidden.length;
}

function restore(scrollY: number) {
  for (const { el, value, priority } of hidden) {
    if (value) el.style.setProperty("visibility", value, priority);
    else el.style.removeProperty("visibility");
  }
  hidden = [];
  window.scrollTo({ top: scrollY, left: 0, behavior: "instant" as ScrollBehavior });
}

(globalThis as any).__w2c = { prepare, scrollToY, hideFixed, restore, startScrollY: window.scrollY };
