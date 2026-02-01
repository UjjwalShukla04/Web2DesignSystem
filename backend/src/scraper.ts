import { chromium, type Page } from "playwright";

export interface ScrapedSection {
  id: string;
  tagName: string;
  html: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
}

export async function scrapeWebsite(url: string): Promise<ScrapedSection[]> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    console.log(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

    // Inject a script to identify sections
    const sections = await page.evaluate(() => {
      const meaningfulTags = ["SECTION", "HEADER", "FOOTER", "MAIN", "NAV"];
      const candidates: Element[] = [];

      // 1. Get all semantic tags
      document.querySelectorAll("*").forEach((el) => {
        if (meaningfulTags.includes(el.tagName)) {
          candidates.push(el);
        }
      });

      // 2. Also look for divs that look like sections (direct children of body or main, or full width)
      document
        .querySelectorAll(
          'body > div, main > div, div[class*="section"], div[id*="section"]',
        )
        .forEach((el) => {
          if (!candidates.includes(el)) {
            candidates.push(el);
          }
        });

      // Filter candidates
      const validSections = candidates.filter((el) => {
        const rect = el.getBoundingClientRect();
        // Must be visible and have some height
        if (rect.height < 100 || rect.width < 100) return false;
        // Must have some text content or images
        if (!el.textContent?.trim() && el.querySelectorAll("img").length === 0)
          return false;
        return true;
      });

      // Map to serializable format
      return validSections.map((el, index) => {
        // Create a unique ID if not present
        const id = el.id || `section-${index}`;

        // Clean up HTML slightly (optional, remove scripts/styles inside)
        const clone = el.cloneNode(true) as Element;
        clone
          .querySelectorAll("script, style, noscript, iframe")
          .forEach((e) => e.remove());

        // Simplify images to avoid huge data URIs if possible (though we need src)
        // We keep src as is.

        return {
          id: id,
          tagName: el.tagName.toLowerCase(),
          html: clone.outerHTML,
          text: (el.textContent || "").substring(0, 200).trim(), // Preview text
          rect: {
            x: el.getBoundingClientRect().x,
            y: el.getBoundingClientRect().y,
            width: el.getBoundingClientRect().width,
            height: el.getBoundingClientRect().height,
          },
        };
      });
    });

    console.log(`Found ${sections.length} sections.`);
    return sections;
  } catch (error) {
    console.error("Scraping error:", error);
    throw error;
  } finally {
    await browser.close();
  }
}
