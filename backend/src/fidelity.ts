// Fidelity score: renders generated code in the headless browser, screenshots it at the
// width the original was captured at, and measures how closely it matches the original
// section screenshot(s). Measuring costs no AI tokens.

import { transform } from "esbuild";
import type { BrowserContext } from "playwright";

export const FIDELITY_FORMATS = ["react", "html"] as const;
export type FidelityFormat = (typeof FIDELITY_FORMATS)[number];

export class RenderError extends Error {}

// Pinned like the editor preview, so a score matches what the user sees.
const TAILWIND_CDN = "https://cdn.tailwindcss.com/3.4.17";
const IMPORT_MAP = {
  imports: {
    react: "https://esm.sh/react@19.2.0",
    "react/jsx-runtime": "https://esm.sh/react@19.2.0/jsx-runtime",
    "react-dom/client": "https://esm.sh/react-dom@19.2.0/client?external=react",
    "lucide-react": "https://esm.sh/lucide-react@0.563.0?external=react",
  },
};
const RENDER_ORIGIN = "https://render.local";
export const DEFAULT_RENDER_WIDTH = 1280;
const MAX_RENDER_HEIGHT = 8_000;

/** Makes text safe to put inside a <script> or <style> element. */
const inScript = (text: string) => text.replace(/</g, "\\u003c");
const inStyle = (css: string) => css.replace(/<\/?style/gi, "");

/** The HTML page that renders one generated React component. */
async function reactPage(code: string, fontCss: string): Promise<string> {
  let compiled: string;
  try {
    compiled = (await transform(code, { loader: "tsx", jsx: "automatic", format: "esm", target: "es2020" })).code;
  } catch (error: any) {
    const first = error?.errors?.[0];
    throw new RenderError(`The code doesn't compile: ${first?.text ?? error.message}`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">
<script src="${TAILWIND_CDN}"></script>
<style>${inStyle(fontCss)}</style>
<script type="importmap">${inScript(JSON.stringify(IMPORT_MAP))}</script>
</head><body style="margin:0"><div id="root"></div>
<script type="module">
window.addEventListener("error", (e) => { window.__renderError = String(e.message || e.error || "error"); });
try {
  const { createRoot } = await import("react-dom/client");
  const { createElement } = await import("react");
  const url = URL.createObjectURL(new Blob([${inScript(JSON.stringify(compiled))}], { type: "text/javascript" }));
  const mod = await import(url);
  if (typeof mod.default !== "function") throw new Error("The code has no default-exported component.");
  createRoot(document.getElementById("root"), {
    onUncaughtError: (error) => { window.__renderError = String(error && error.message || error); },
  }).render(createElement(mod.default));
  setTimeout(() => { window.__renderDone = true; }, 300);
} catch (error) {
  window.__renderError = String(error && error.message || error);
}
</script></body></html>`;
}

export interface RenderInput {
  code: string;
  format: FidelityFormat;
  fontCss: string;
  /** Viewport width in CSS px: the width the original section had on the page. */
  width?: number;
}

/** Renders the code and returns a full-page JPEG screenshot (data URL). */
export async function renderCode(
  context: BrowserContext,
  { code, format, fontCss, width = DEFAULT_RENDER_WIDTH }: RenderInput,
): Promise<string> {
  const page = await context.newPage();
  try {
    const html = format === "react" ? await reactPage(code, fontCss) : code;
    // The render page is served by request interception, so it never touches the network
    // (CDN requests still go through the browser's SSRF-filtering proxy).
    await page.route(`${RENDER_ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/fonts.css")) {
        return route.fulfill({ status: 200, contentType: "text/css", body: fontCss });
      }
      return route.fulfill({ status: 200, contentType: "text/html", body: html });
    });
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${RENDER_ORIGIN}/`, { waitUntil: "load", timeout: 30_000 });
    if (format === "react") {
      await page
        .waitForFunction(() => (window as any).__renderDone || (window as any).__renderError, null, { timeout: 30_000 })
        .catch(() => {
          throw new RenderError("The component didn't finish rendering within 30 seconds.");
        });
      const error = await page.evaluate(() => (window as any).__renderError as string | undefined);
      if (error) throw new RenderError(`The component fails when rendered: ${error}`);
    }
    // Images, fonts, and the Tailwind CDN's styles.
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(300);
    // The content's height, not the viewport's: a short section must not be padded to
    // 800px. The viewport stays 800px tall so `min-h-screen` means what it did on the page.
    const height = await page.evaluate(() => {
      const body = document.body;
      const margin = parseFloat(getComputedStyle(body).marginBottom) || 0;
      let bottom = body.getBoundingClientRect().bottom + margin;
      // Absolutely positioned or overflowing content can extend past the body.
      if (document.documentElement.scrollHeight > innerHeight) bottom = Math.max(bottom, document.documentElement.scrollHeight);
      return Math.ceil(bottom + scrollY);
    });
    const image = await page.screenshot({
      type: "jpeg",
      quality: 85,
      fullPage: true,
      clip: { x: 0, y: 0, width, height: Math.max(1, Math.min(height, MAX_RENDER_HEIGHT)) },
    });
    return `data:image/jpeg;base64,${image.toString("base64")}`;
  } finally {
    await page.close().catch(() => {});
  }
}

export interface FidelityBreakdown {
  /** 0–100 overall similarity. */
  score: number;
  /** 0–1: layout and shapes (structural similarity of matching regions). */
  structure: number;
  /** 0–1: colors of matching regions. */
  color: number;
  /** 0–1: height ratio (missing or extra content). */
  size: number;
  /** Render height ÷ original height (at the same width): above 1 = the render is taller. */
  heightRatio: number;
}

/**
 * Runs INSIDE a browser page: compares the original screenshot(s) (stacked top to
 * bottom) with the render. Self-contained, because page.evaluate() sends only its source.
 *
 * Both images are scaled to the same small size and split into tiles. Each tile is
 * matched against the other image with a small position tolerance (content that moved
 * a little still counts), in both directions (missing and extra content both count).
 * Tiles with content or color weigh more than empty background, so a blank render
 * scores low. Returns the scores and a scaled-down copy of the render for the UI/AI.
 */
export async function compareInPage({ originals, render }: { originals: string[]; render: string }) {
  const load = (src: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not load an image to compare"));
      img.src = src;
    });
  const originalImgs = await Promise.all(originals.map(load));
  const renderImg = await load(render);

  // Scaled-down render for the UI and the AI.
  const scale = Math.min(1, 1024 / renderImg.naturalWidth, 2000 / renderImg.naturalHeight);
  const preview = document.createElement("canvas");
  preview.width = Math.max(1, Math.round(renderImg.naturalWidth * scale));
  preview.height = Math.max(1, Math.round(renderImg.naturalHeight * scale));
  preview.getContext("2d")!.drawImage(renderImg, 0, 0, preview.width, preview.height);
  const renderPreview = preview.toDataURL("image/jpeg", 0.85);

  // Relative heights, measured at a common width.
  const relHeight = (img: HTMLImageElement) => img.naturalHeight / img.naturalWidth;
  const heightA = originalImgs.reduce((sum, img) => sum + relHeight(img), 0);
  const heightB = relHeight(renderImg);
  const size = Math.min(heightA, heightB) / Math.max(heightA, heightB);

  // Both images are drawn at W × H (the render is stretched to the original's
  // proportions; the height difference is scored separately by `size`).
  const W = 192;
  const TILE = 16;
  const H = Math.max(TILE, Math.min(1600, Math.round(W * heightA / TILE) * TILE));
  const draw = (imgs: HTMLImageElement[], total: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    let y = 0;
    for (const img of imgs) {
      const h = (relHeight(img) / total) * H;
      ctx.drawImage(img, 0, y, W, h);
      y += h;
    }
    const data = ctx.getImageData(0, 0, W, H).data;
    const rgb = new Float32Array(W * H * 3);
    const gray = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      rgb[i * 3] = data[i * 4]!;
      rgb[i * 3 + 1] = data[i * 4 + 1]!;
      rgb[i * 3 + 2] = data[i * 4 + 2]!;
      gray[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
    }
    return { rgb, gray };
  };
  const A = draw(originalImgs, heightA);
  const B = draw([renderImg], heightB);

  /** The most common (quantized) color: the page background. */
  const background = (img: { rgb: Float32Array }) => {
    const counts = new Map<number, number>();
    let best = 0;
    let bestCount = 0;
    for (let i = 0; i < W * H; i += 3) {
      const key = ((img.rgb[i * 3]! >> 4) << 8) | ((img.rgb[i * 3 + 1]! >> 4) << 4) | (img.rgb[i * 3 + 2]! >> 4);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > bestCount) {
        bestCount = count;
        best = key;
      }
    }
    return [((best >> 8) << 4) + 8, (((best >> 4) & 15) << 4) + 8, ((best & 15) << 4) + 8];
  };

  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const maxDy = 2 * Math.max(1, Math.round(H * 0.04)); // even, so the search includes dy = 0
  const maxDx = 4;

  /** Matches every tile of X within Y; returns weighted sums of structure and color similarity. */
  const match = (X: typeof A, Y: typeof A) => {
    const bg = background(X);
    let weightSum = 0;
    let structureSum = 0;
    let colorSum = 0;
    for (let ty = 0; ty + TILE <= H; ty += TILE) {
      for (let tx = 0; tx + TILE <= W; tx += TILE) {
        // Statistics of X's tile.
        let sx = 0, sxx = 0, r = 0, g = 0, b = 0;
        for (let y = ty; y < ty + TILE; y++) {
          for (let x = tx; x < tx + TILE; x++) {
            const i = y * W + x;
            const v = X.gray[i]!;
            sx += v;
            sxx += v * v;
            r += X.rgb[i * 3]!;
            g += X.rgb[i * 3 + 1]!;
            b += X.rgb[i * 3 + 2]!;
          }
        }
        const n = TILE * TILE;
        const mx = sx / n;
        const vx = Math.max(0, sxx / n - mx * mx);
        r /= n; g /= n; b /= n;
        const bgDistance = (Math.abs(r - bg[0]!) + Math.abs(g - bg[1]!) + Math.abs(b - bg[2]!)) / 3;
        const weight = 0.2 + Math.min(1, Math.sqrt(vx) / 32) + Math.min(1, bgDistance / 48);

        // The best-matching position in Y, within the tolerance.
        let best = -1, bestStructure = 0, bestColor = 0;
        for (let dy = -maxDy; dy <= maxDy; dy += 2) {
          const oy = ty + dy;
          if (oy < 0 || oy + TILE > H) continue;
          for (let dx = -maxDx; dx <= maxDx; dx += 2) {
            const ox = tx + dx;
            if (ox < 0 || ox + TILE > W) continue;
            let sy = 0, syy = 0, sxy = 0, r2 = 0, g2 = 0, b2 = 0;
            for (let y = 0; y < TILE; y++) {
              for (let x = 0; x < TILE; x++) {
                const iy = (oy + y) * W + ox + x;
                const v = Y.gray[iy]!;
                sy += v;
                syy += v * v;
                sxy += X.gray[(ty + y) * W + tx + x]! * v;
                r2 += Y.rgb[iy * 3]!;
                g2 += Y.rgb[iy * 3 + 1]!;
                b2 += Y.rgb[iy * 3 + 2]!;
              }
            }
            const my = sy / n;
            const vy = Math.max(0, syy / n - my * my);
            const cov = sxy / n - mx * my;
            const structure = Math.max(0, ((2 * mx * my + C1) * (2 * cov + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2)));
            // A difference of 25% or more (e.g. a different brand color) counts as no match.
            const colorDiff = (Math.abs(r - r2 / n) + Math.abs(g - g2 / n) + Math.abs(b - b2 / n)) / (3 * 255);
            const color = Math.max(0, 1 - 4 * colorDiff);
            const combined = 0.6 * structure + 0.4 * color;
            if (combined > best) {
              best = combined;
              bestStructure = structure;
              bestColor = color;
            }
          }
        }
        weightSum += weight;
        structureSum += weight * bestStructure;
        colorSum += weight * bestColor;
      }
    }
    return { weight: weightSum, structure: structureSum, color: colorSum };
  };

  const forward = match(A, B); // is everything in the original also in the render?
  const backward = match(B, A); // does the render add things the original doesn't have?
  // Pooled by weight: an empty render has little to compare backward, so it can't
  // make up for everything it's missing.
  const total = forward.weight + backward.weight;
  const structure = (forward.structure + backward.structure) / total;
  const color = (forward.color + backward.color) / total;

  const score = Math.round(100 * (0.5 * structure + 0.35 * color + 0.15 * size));
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    score,
    structure: round(structure),
    color: round(color),
    size: round(size),
    heightRatio: round(heightB / heightA),
    renderPreview,
  };
}

/** Runs INSIDE a browser page: scales an image down to fit maxWidth × maxHeight (JPEG data URL). */
export async function scaleDownInPage({ src, maxWidth, maxHeight }: { src: string; maxWidth: number; maxHeight: number }) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const scale = Math.min(1, maxWidth / img.naturalWidth, maxHeight / img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** Renders the code and returns a screenshot sized for the AI and the UI (≤1024×2000). */
export async function renderForAI(context: BrowserContext, input: RenderInput): Promise<string> {
  const render = await renderCode(context, input);
  const page = await context.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    return await page.evaluate(scaleDownInPage, { src: render, maxWidth: 1024, maxHeight: 2000 });
  } finally {
    await page.close().catch(() => {});
  }
}

/** Renders the code and compares it with the original screenshot(s). */
export async function measureFidelity(
  context: BrowserContext,
  input: RenderInput & { originalImages: string[] },
): Promise<FidelityBreakdown & { render: string }> {
  const render = await renderCode(context, input);
  const page = await context.newPage();
  try {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn)"); // tsx helper, see extract.ts
    const result = await page.evaluate(compareInPage, { originals: input.originalImages, render });
    return {
      score: result.score,
      structure: result.structure,
      color: result.color,
      size: result.size,
      heightRatio: result.heightRatio,
      render: result.renderPreview,
    };
  } finally {
    await page.close().catch(() => {});
  }
}
