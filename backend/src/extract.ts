import type { Page } from "playwright";
import { CAPTURE_LIMITS, desktopPass, finishPass } from "./inpage.js";

// Section extraction with Playwright. The in-page logic lives in inpage.ts (shared
// with the browser extension).

export interface ScrapedSection {
  id: string;
  tagName: string;
  html: string;
  text: string;
  /** Position in page coordinates (at the top of the page), at a 1280px-wide viewport. */
  rect: { x: number; y: number; width: number; height: number };
}

export interface ScrapeResult {
  sections: ScrapedSection[];
  /** JPEG of the top of the page as a data URL, for section previews (null if unavailable). */
  screenshot: string | null;
  /** Size of the area the screenshot covers, in CSS pixels. */
  screenshotSize: { width: number; height: number } | null;
  /** Web fonts used by the page: family names and CSS that loads them. */
  fonts: { families: string[]; css: string };
}

export const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

// Size limits, so one huge page can't produce an enormous response.
const {
  maxSections: MAX_SECTIONS,
  maxSectionHtmlChars: MAX_SECTION_HTML_CHARS,
  maxCopiedElements: MAX_COPIED_ELEMENTS,
  maxStyledElements: MAX_STYLED_ELEMENTS,
  maxFontCssChars: MAX_FONT_CSS_CHARS,
  maxScreenshotHeight: MAX_SCREENSHOT_HEIGHT,
} = CAPTURE_LIMITS;

/**
 * Scrolls through the page so lazy images load and scroll-reveal animations run.
 * Uses real mouse-wheel events: smooth-scroll libraries often ignore window.scrollBy(),
 * which then never triggers their lazy loading.
 */
async function scrollThroughPage(page: Page) {
  // Some sites scroll an inner container instead of the window. Find the scrollable
  // element under the middle of the viewport (if any) and point the mouse there.
  const center = { x: DESKTOP_VIEWPORT.width / 2, y: DESKTOP_VIEWPORT.height / 2 };
  await page.evaluate(({ x, y }) => {
    let el = document.elementFromPoint(x, y);
    while (el && el !== document.documentElement) {
      const overflowY = getComputedStyle(el).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 50) {
        (window as any).__scrollBox = el;
        return;
      }
      el = el.parentElement;
    }
  }, center);
  await page.mouse.move(center.x, center.y);
  // How far we've scrolled, in the window and in the inner container.
  const position = () =>
    page.evaluate(() => window.scrollY + ((window as any).__scrollBox?.scrollTop ?? 0));

  const step = Math.round(DESKTOP_VIEWPORT.height * 0.8);
  let unchanged = 0;
  for (let i = 0; i < 40 && unchanged < 3; i++) {
    const before = await position();
    await page.mouse.wheel(0, step);
    await page.waitForTimeout(120);
    unchanged = (await position()) === before ? unchanged + 1 : 0; // stop at the bottom
  }
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const box = (window as any).__scrollBox as Element | undefined;
    if (box) box.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
}

/**
 * Finds the page's sections and returns their HTML with computed styles inlined.
 * Expects the page to be loaded at DESKTOP_VIEWPORT; leaves it at a phone viewport.
 */
export async function extractPage(page: Page): Promise<ScrapeResult> {
  // tsx (dev mode, tests) wraps named functions in a `__name` helper, which doesn't
  // exist in the page when page.evaluate() serializes our callbacks. Provide a no-op one.
  await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn)");
  await scrollThroughPage(page);

  // --- Pass 1 (desktop): choose sections, copy them with desktop styles ---
  const desktop = await page.evaluate(
    desktopPass,
    {
      maxSections: MAX_SECTIONS,
      maxCopiedElements: MAX_COPIED_ELEMENTS,
      maxStyledElements: MAX_STYLED_ELEMENTS,
      maxFontCssChars: MAX_FONT_CSS_CHARS,
    },
  );

  // --- Screenshot for section previews (desktop) ---
  let screenshot: string | null = null;
  let screenshotSize: ScrapeResult["screenshotSize"] = null;
  if (desktop.sections.length) {
    try {
      const height = Math.min(desktop.pageHeight, MAX_SCREENSHOT_HEIGHT);
      const image = await page.screenshot({
        type: "jpeg",
        quality: 45,
        fullPage: true,
        clip: { x: 0, y: 0, width: DESKTOP_VIEWPORT.width, height },
        timeout: 15_000,
      });
      screenshot = `data:image/jpeg;base64,${image.toString("base64")}`;
      screenshotSize = { width: DESKTOP_VIEWPORT.width, height };
    } catch (error) {
      console.warn("Section screenshot failed:", error);
    }
  }

  // --- Pass 2 (phone width): record styles that differ, then serialize ---
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.waitForTimeout(400); // let layout and resize handlers settle
  const htmls = await page.evaluate(finishPass, {
    maxSectionHtmlChars: MAX_SECTION_HTML_CHARS,
    recordMobile: true,
  });

  return {
    sections: desktop.sections.map((section, i) => ({ ...section, html: htmls[i] ?? "" })),
    screenshot,
    screenshotSize,
    fonts: desktop.fonts,
  };
}
