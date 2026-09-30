import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import crypto from "crypto";
import type { ServerConfig } from "./config.js";
import { log, logError } from "./logger.js";
import {
  scrapeWebsite,
  checkBrowser,
  ScraperBusyError,
  ScrapeTimeoutError,
  withContext,
} from "./scraper.js";
import { measureFidelity, renderForAI, FIDELITY_FORMATS, RenderError, type FidelityFormat } from "./fidelity.js";
import {
  generateComponent,
  parseImageDataUrl,
  serverProviders,
  FORMATS,
  MAX_PAGE_SECTIONS,
  PROVIDERS,
  type OutputFormat,
  type Provider,
} from "./generator.js";
import { UnsafeUrlError } from "./netguard.js";
import { createUsageTracker, QuotaError } from "./usage.js";
import { createCaptureStore, validateCapture, CAPTURE_TTL_MS } from "./captures.js";

const MAX_HTML_BODY_CHARS = 200_000;
const MAX_CURRENT_CODE_CHARS = 100_000;
const MAX_INSTRUCTIONS_CHARS = 2_000;
const MAX_URL_CHARS = 2_048;
const MAX_API_KEY_CHARS = 500;
const MAX_IMAGES = 8;
const MAX_IMAGE_CHARS = 3_000_000; // ~2.2MB of image data per screenshot
const MAX_FONT_CSS_CHARS = 50_000;

function safeEqual(a: string, b: string): boolean {
  // Hash both sides so the comparison is constant-time regardless of length.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createApp(config: ServerConfig) {
  const app = express();
  const usageTracker = createUsageTracker(config.limits);
  const captures = createCaptureStore();
  app.set("trust proxy", config.trustProxy);
  app.use(cors(config.allowedOrigins === "*" ? {} : { origin: config.allowedOrigins }));
  // Room for a page request: up to 8 sections of scraped HTML plus their screenshots.
  // Extension captures carry a whole page (up to 40 sections and a full-page screenshot).
  const json = express.json({ limit: "12mb" });
  const captureJson = express.json({ limit: "20mb" });
  app.use((req, res, next) => (req.path === "/api/captures" ? captureJson : json)(req, res, next));

  // --- Health Check (Public) ---
  app.get("/", (req, res) => {
    res.send("Scraper Backend is Running!");
  });

  // --- Which AI providers have a server-side key (Public; booleans only) ---
  // Lets the app show whether users need to bring their own key.
  // --- The caller's AI usage today and the limits (Public; only the caller's own numbers) ---
  app.get("/api/usage", (req, res) => {
    res.json(usageTracker.summary(req.ip ?? "unknown"));
  });

  app.get("/api/providers", (req, res) => {
    res.json(serverProviders());
  });

  // --- Authentication Middleware ---
  app.use((req, res, next) => {
    const adminSecret = config.apiSecret;

    // 1. If no secret is set on the server, it's open to the public (or user accepts risk)
    if (!adminSecret) {
      return next();
    }

    // 2. A user who brings their OWN AI key may generate without the secret (they pay for it).
    // This only applies to /api/generate: scraping runs on our servers regardless of whose key it is.
    if (
      req.method === "POST" &&
      req.path === "/api/generate" &&
      typeof req.body?.apiKey === "string" &&
      req.body.apiKey.trim() !== ""
    ) {
      return next();
    }

    // 3. Otherwise, they must provide the correct x-api-secret header
    const clientSecret = req.headers["x-api-secret"];
    if (typeof clientSecret === "string" && safeEqual(clientSecret, adminSecret)) {
      return next();
    }

    // 4. Reject
    logError("[AUTH] Unauthorized access attempt", {
      url: req.url,
      ip: req.ip,
    });
    res.status(401).json({
      error: "Unauthorized. Please provide a valid 'x-api-secret' header or your own 'apiKey' in the request body.",
    });
  });

  // --- Rate Limits (per client IP) ---
  const scrapeLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many scrape requests. Please wait a minute and try again." },
  });
  const generateLimiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many generate requests. Please wait a minute and try again." },
  });

  const fidelityLimiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many match checks. Please wait a minute and try again." },
  });

  const captureLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many captures. Please wait a minute and try again." },
  });

  // --- Browser Health Check (authenticated, for diagnostics) ---
  app.get("/health/browser", scrapeLimiter, async (req, res) => {
    try {
      await checkBrowser();
      res.send("Browser launch successful!");
    } catch (error: any) {
      logError("[HEALTH] Browser launch failed:", error);
      res.status(500).send("Browser launch failed. See server logs.");
    }
  });

  app.post("/api/scrape", scrapeLimiter, async (req, res) => {
    try {
      const { url, fresh } = req.body ?? {};
      if (typeof url !== "string" || !url.trim()) {
        return res.status(400).json({ error: "URL is required" });
      }
      if (url.length > MAX_URL_CHARS) {
        return res.status(400).json({ error: "URL is too long" });
      }
      if (fresh !== undefined && typeof fresh !== "boolean") {
        return res.status(400).json({ error: "fresh must be true or false" });
      }
      log(`[SCRAPE] Request received for URL: ${JSON.stringify(url)}${fresh ? " (fresh)" : ""}`);
      const result = await scrapeWebsite(url, { fresh: fresh === true });
      log(`[SCRAPE] Success. Found ${result.sections.length} sections${result.cached ? " (cached)" : ""}.`);
      res.json(result);
    } catch (error: any) {
      if (error instanceof UnsafeUrlError) {
        log(`[SCRAPE] Rejected: ${error.message}`);
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof ScraperBusyError) {
        return res.status(503).json({ error: error.message });
      }
      if (error instanceof ScrapeTimeoutError) {
        log(`[SCRAPE] Timed out: ${error.message}`);
        return res.status(504).json({ error: error.message });
      }
      logError("[SCRAPE] Error:", error);
      // Only the first line: Playwright appends a call log with internal details.
      const summary = String(error?.message ?? "").split("\n")[0];
      res.status(500).json({ error: `Failed to scrape page. ${summary}`.trim() });
    }
  });

  // --- Captures from the browser extension ---
  app.post("/api/captures", captureLimiter, (req, res) => {
    const result = validateCapture(req.body);
    if ("error" in result) return res.status(400).json({ error: result.error });
    const id = captures.put(result.capture);
    log(`[CAPTURE] Stored ${result.capture.sections.length} sections from ${JSON.stringify(result.capture.url)}`);
    res.status(201).json({ id, expiresInSeconds: CAPTURE_TTL_MS / 1000 });
  });

  app.get("/api/captures/:id", scrapeLimiter, (req, res) => {
    const id = String(req.params.id);
    const capture = /^[0-9a-f-]{36}$/.test(id) ? captures.get(id) : null;
    if (!capture) {
      return res.status(404).json({
        error: `This capture doesn't exist or has expired (captures are kept for ${CAPTURE_TTL_MS / 60_000} minutes). Capture the page again.`,
      });
    }
    const { capturedAt, ...rest } = capture;
    // Same shape as a scrape result, so the app treats both alike.
    res.json({ ...rest, scrapedAt: capturedAt, cached: false, captured: true });
  });

  // --- Fidelity: render code in the headless browser and compare it with the original ---
  app.post("/api/fidelity", fidelityLimiter, async (req, res) => {
    const { code, format = "react", images, fontCss = "", width } = req.body ?? {};
    if (typeof code !== "string" || !code.trim() || code.length > MAX_CURRENT_CODE_CHARS) {
      return res.status(400).json({ error: "code must be a non-empty string" });
    }
    if (!FIDELITY_FORMATS.includes(format)) {
      return res.status(400).json({
        error: `The match score supports ${FIDELITY_FORMATS.join(" and ")} code only`,
      });
    }
    if (
      !Array.isArray(images) ||
      images.length < 1 ||
      images.length > MAX_IMAGES ||
      !images.every(
        (img) => typeof img === "string" && img.length <= MAX_IMAGE_CHARS && parseImageDataUrl(img) !== null,
      )
    ) {
      return res.status(400).json({
        error: `images must be a list of 1 to ${MAX_IMAGES} base64 JPEG/PNG/WebP data URLs of the original`,
      });
    }
    if (typeof fontCss !== "string" || fontCss.length > MAX_FONT_CSS_CHARS) {
      return res.status(400).json({ error: "fontCss must be a string" });
    }
    if (width !== undefined && !(Number.isInteger(width) && width >= 320 && width <= 1920)) {
      return res.status(400).json({ error: "width must be a whole number from 320 to 1920" });
    }
    try {
      const result = await withContext((context) =>
        measureFidelity(context, { code, format: format as FidelityFormat, fontCss, originalImages: images, width }),
      );
      log(`[FIDELITY] Score ${result.score}`);
      res.json(result);
    } catch (error: any) {
      if (error instanceof RenderError) return res.status(422).json({ error: error.message });
      if (error instanceof ScraperBusyError) return res.status(503).json({ error: error.message });
      if (error instanceof ScrapeTimeoutError) {
        return res.status(504).json({ error: "Rendering the code took too long." });
      }
      logError("[FIDELITY] Error:", error);
      const summary = String(error?.message ?? "").split("\n")[0];
      res.status(500).json({ error: `Could not measure the match. ${summary}`.trim() });
    }
  });

  // --- Render code to an image (shown to the AI with a refinement request) ---
  app.post("/api/render", fidelityLimiter, async (req, res) => {
    const { code, format = "react", fontCss = "", width } = req.body ?? {};
    if (typeof code !== "string" || !code.trim() || code.length > MAX_CURRENT_CODE_CHARS) {
      return res.status(400).json({ error: "code must be a non-empty string" });
    }
    if (!FIDELITY_FORMATS.includes(format)) {
      return res.status(400).json({ error: `Rendering supports ${FIDELITY_FORMATS.join(" and ")} code only` });
    }
    if (typeof fontCss !== "string" || fontCss.length > MAX_FONT_CSS_CHARS) {
      return res.status(400).json({ error: "fontCss must be a string" });
    }
    if (width !== undefined && !(Number.isInteger(width) && width >= 320 && width <= 1920)) {
      return res.status(400).json({ error: "width must be a whole number from 320 to 1920" });
    }
    try {
      const render = await withContext((context) =>
        renderForAI(context, { code, format: format as FidelityFormat, fontCss, width }),
      );
      res.json({ render });
    } catch (error: any) {
      if (error instanceof RenderError) return res.status(422).json({ error: error.message });
      if (error instanceof ScraperBusyError) return res.status(503).json({ error: error.message });
      if (error instanceof ScrapeTimeoutError) return res.status(504).json({ error: "Rendering the code took too long." });
      logError("[RENDER] Error:", error);
      res.status(500).json({ error: "Could not render the code." });
    }
  });

  app.post("/api/generate", generateLimiter, async (req, res) => {
    log("[GENERATE] Request received");
    const {
      html, sections, currentCode, instructions, provider, format, apiKey, fonts, images, renderImage, stream,
    } = req.body ?? {};
    // Refinements send the current code; first generations send one section's HTML,
    // or several sections to combine into a page.
    if (currentCode !== undefined) {
      if (typeof currentCode !== "string" || !currentCode.trim()) {
        return res.status(400).json({ error: "currentCode must be a non-empty string" });
      }
      if (currentCode.length > MAX_CURRENT_CODE_CHARS) {
        return res.status(400).json({ error: "Component code is too long to refine" });
      }
    } else if (sections !== undefined) {
      if (
        !Array.isArray(sections) ||
        sections.length < 2 ||
        sections.length > MAX_PAGE_SECTIONS ||
        !sections.every((s) => typeof s === "string" && s && s.length <= MAX_HTML_BODY_CHARS)
      ) {
        return res.status(400).json({
          error: `sections must be a list of 2 to ${MAX_PAGE_SECTIONS} HTML strings`,
        });
      }
    } else if (typeof html !== "string" || !html) {
      return res.status(400).json({ error: "HTML content is required" });
    } else if (html.length > MAX_HTML_BODY_CHARS) {
      return res.status(400).json({ error: "HTML content is too long" });
    }
    if (
      images !== undefined &&
      !(
        Array.isArray(images) &&
        images.length <= MAX_IMAGES &&
        images.every(
          (img) =>
            img === null ||
            (typeof img === "string" && img.length <= MAX_IMAGE_CHARS && parseImageDataUrl(img) !== null),
        )
      )
    ) {
      return res.status(400).json({
        error: `images must be a list of up to ${MAX_IMAGES} base64 JPEG/PNG/WebP data URLs (or null)`,
      });
    }
    if (
      renderImage !== undefined &&
      !(
        currentCode !== undefined &&
        typeof renderImage === "string" &&
        renderImage.length <= MAX_IMAGE_CHARS &&
        parseImageDataUrl(renderImage) !== null
      )
    ) {
      return res.status(400).json({
        error: "renderImage must be a base64 JPEG/PNG/WebP data URL, sent with currentCode",
      });
    }
    if (format !== undefined && !FORMATS.includes(format)) {
      return res.status(400).json({ error: `format must be one of: ${FORMATS.join(", ")}` });
    }
    if (instructions !== undefined && typeof instructions !== "string") {
      return res.status(400).json({ error: "instructions must be a string" });
    }
    if (instructions && instructions.length > MAX_INSTRUCTIONS_CHARS) {
      return res.status(400).json({
        error: `Instructions must be at most ${MAX_INSTRUCTIONS_CHARS} characters`,
      });
    }
    if (provider !== undefined && !PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: "provider must be 'gemini' or 'openai'" });
    }
    if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > MAX_API_KEY_CHARS)) {
      return res.status(400).json({ error: "apiKey must be a string" });
    }
    if (
      fonts !== undefined &&
      !(Array.isArray(fonts) && fonts.length <= 20 && fonts.every((f) => typeof f === "string" && f.length <= 100))
    ) {
      return res.status(400).json({ error: "fonts must be a list of font family names" });
    }

    // Stop the AI call if the client goes away (e.g. the user pressed Cancel).
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    const options = {
      html: typeof html === "string" ? html : "",
      sections,
      instructions,
      format: format as OutputFormat | undefined,
      provider: (provider as Provider | undefined) ?? "gemini",
      apiKey: apiKey || undefined,
      currentCode,
      fonts,
      images,
      renderImage,
      signal: abort.signal,
    };

    // Daily limits apply only when the server's key pays (no key of the user's own).
    const userId = req.ip ?? "unknown";
    const usesServerKey = !options.apiKey;
    if (usesServerKey) {
      try {
        usageTracker.reserve(userId);
      } catch (error) {
        if (error instanceof QuotaError) return res.status(429).json({ error: error.message });
        throw error;
      }
    }
    const run = async (onDelta?: (text: string) => void) => {
      try {
        const result = await generateComponent(options, onDelta);
        if (usesServerKey) usageTracker.record(userId, result.usage);
        return result;
      } catch (error) {
        if (usesServerKey) usageTracker.release(userId); // failed requests don't count
        throw error;
      }
    };

    if (stream === true) {
      // Newline-delimited JSON events: {type:"delta",text} ... then {type:"done",code,usage} or {type:"error",error}.
      res.status(200);
      res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("x-accel-buffering", "no");
      res.flushHeaders();
      const send = (event: object) => res.write(JSON.stringify(event) + "\n");
      try {
        const { code, usage } = await run((text) => send({ type: "delta", text }));
        log(`[GENERATE] Success (streamed). ~$${usage.costUsd.toFixed(4)}`);
        send({ type: "done", code, usage });
      } catch (error: any) {
        if (!abort.signal.aborted) logError("[GENERATE] Error:", error);
        send({ type: "error", error: error.message });
      }
      return res.end();
    }

    try {
      const { code, usage } = await run();
      log(`[GENERATE] Success. ~$${usage.costUsd.toFixed(4)}`);
      res.json({ code, usage });
    } catch (error: any) {
      logError("[GENERATE] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Catch-all error handler (e.g. malformed or oversized JSON). Never expose stack traces.
  app.use(
    (error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      const status = Number(error?.status || error?.statusCode) || 500;
      if (status >= 500) logError("[UNHANDLED] Error:", error);
      res.status(status).json({
        error: status < 500 ? error.message : "Internal server error",
      });
    },
  );

  return app;
}
