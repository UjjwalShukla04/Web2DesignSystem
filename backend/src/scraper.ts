import "./browser-env.js"; // Must come before "playwright".
import { chromium, type Browser, type BrowserContext } from "playwright";
import { assertPublicUrl, getSafeProxyUrl, UnsafeUrlError } from "./netguard.js";
import { extractPage, DESKTOP_VIEWPORT, type ScrapeResult } from "./extract.js";
import { createCache } from "./cache.js";

export type { ScrapedSection, ScrapeResult } from "./extract.js";

export class ScraperBusyError extends Error {}
export class ScrapeTimeoutError extends Error {}

// --- Shared browser ---
// One Chromium is launched on first use and reused; each scrape gets its own
// isolated context. It is closed after a period of inactivity to free memory,
// and relaunched automatically if it crashes.
const BROWSER_IDLE_MS = 5 * 60_000;
let browserPromise: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function launchBrowser(): Promise<Browser> {
  const options = {
    headless: true,
    // All browser traffic goes through the SSRF-filtering proxy.
    proxy: { server: await getSafeProxyUrl() },
    // Note: '--single-process' and '--no-zygote' are deliberately absent. They make
    // Chromium crash with "Target page, context or browser has been closed".
    args: [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      // Keep traffic that could bypass the proxy switched off.
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
  };
  // Chromium's sandbox limits the damage a malicious page could do through a browser
  // bug. Some container hosts can't provide it; only then run without it.
  try {
    return await chromium.launch({ ...options, chromiumSandbox: true });
  } catch (error: any) {
    console.warn(
      "WARNING: Chromium could not start with its sandbox; running without it. " +
        `Reason: ${String(error?.message ?? error).split("\n")[0]}`,
    );
    return chromium.launch({ ...options, chromiumSandbox: false });
  }
}

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const launching = launchBrowser().then((browser) => {
      browser.on("disconnected", () => {
        if (browserPromise === launching) browserPromise = null;
      });
      return browser;
    });
    launching.catch(() => {
      if (browserPromise === launching) browserPromise = null;
    });
    browserPromise = launching;
  }
  return browserPromise;
}

/** Closes the shared browser; the next scrape launches a fresh one. */
function restartBrowser() {
  const old = browserPromise;
  browserPromise = null;
  old?.then((b) => b.close()).catch(() => {});
}

function scheduleIdleClose() {
  idleTimer = setTimeout(restartBrowser, BROWSER_IDLE_MS);
  idleTimer.unref();
}

// --- Concurrency ---
// Each open page is a Chromium renderer process, so cap how many scrapes run at once
// and let a few more wait for a free slot. The default of 1 suits small (512MB) hosts.
const MAX_CONCURRENT_SCRAPES = Number(process.env.MAX_CONCURRENT_SCRAPES) || 1;
const MAX_QUEUED_SCRAPES = 5;
let activeScrapes = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (activeScrapes < MAX_CONCURRENT_SCRAPES) {
    activeScrapes++;
    return;
  }
  if (waiting.length >= MAX_QUEUED_SCRAPES) {
    throw new ScraperBusyError("Server is busy. Please try again in a moment.");
  }
  // The releasing request hands its slot straight to us, so activeScrapes stays the same.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) {
    next();
    return;
  }
  activeScrapes--;
  if (activeScrapes === 0) scheduleIdleClose();
}

// --- Deadline ---
// Hard limit for one scrape, including navigation and extraction. Without it, a page
// that blocks its main thread would hang page.evaluate() forever and hold the slot.
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS) || 90_000;
const CONTEXT_CLOSE_TIMEOUT_MS = 10_000;

/** Rejects with `error` if `promise` hasn't settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, error: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Runs `fn` in a fresh, isolated context of the shared browser, with a hard deadline. */
async function withContext<T>(fn: (context: BrowserContext) => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({
      viewport: DESKTOP_VIEWPORT,
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    const work = fn(context);
    work.catch(() => {}); // It may reject after the deadline; don't leave that unhandled.
    try {
      return await withTimeout(
        work,
        SCRAPE_TIMEOUT_MS,
        new ScrapeTimeoutError(
          `The page took longer than ${Math.round(SCRAPE_TIMEOUT_MS / 1000)}s to scrape.`,
        ),
      );
    } finally {
      // Closing the context also kills a hung renderer. If even that doesn't
      // respond, restart the whole browser so the next scrape starts clean.
      await withTimeout(context.close(), CONTEXT_CLOSE_TIMEOUT_MS, new Error("close timeout"))
        .catch(() => restartBrowser());
    }
  } finally {
    releaseSlot();
  }
}

/** Starts the browser (if needed) and loads a blank page, for diagnostics. */
export async function checkBrowser(): Promise<void> {
  await withContext(async (context) => {
    const page = await context.newPage();
    await page.setContent("<p>ok</p>");
  });
}

// --- Result cache ---
// Re-scraping the same URL within this time reuses the result (SCRAPE_CACHE_TTL_MS=0 disables).
const scrapeCache = createCache<ScrapeResult>({
  ttlMs: Number(process.env.SCRAPE_CACHE_TTL_MS ?? 10 * 60_000),
  maxEntries: Number(process.env.SCRAPE_CACHE_MAX_ENTRIES) || 10,
});

export interface ScrapeResponse extends ScrapeResult {
  /** The normalized URL that was scraped. */
  url: string;
  /** When the page was scraped (ISO timestamp). */
  scrapedAt: string;
  /** True when this result was reused from an earlier scrape. */
  cached: boolean;
}

/** Scrapes `rawUrl`, reusing a recent result unless `fresh` is set. */
export async function scrapeWebsite(
  rawUrl: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<ScrapeResponse> {
  // Validated on every request, including cache hits.
  const url = await assertPublicUrl(rawUrl);
  const { value, cached, producedAt } = await scrapeCache.get(url, () => runScrape(url), { fresh });
  return { ...value, url, scrapedAt: new Date(producedAt).toISOString(), cached };
}

async function runScrape(url: string): Promise<ScrapeResult> {
  console.log(`Scraping: ${url}`);
  return withContext(async (context) => {
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (!/^https?:$/.test(new URL(page.url()).protocol)) {
      throw new UnsafeUrlError("Page navigated to a disallowed URL");
    }
    // Give client-rendered (SPA) content time to appear. Both waits are capped and
    // best-effort: pages with analytics or long polling never go fully idle.
    await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

    const result = await extractPage(page);
    console.log(`Found ${result.sections.length} sections.`);
    return result;
  });
}
