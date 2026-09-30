# Architecture & Workflow Documentation

## 1. Project Overview

**Goal**: A web app that converts sections of public websites into editable React + Tailwind CSS components.
**Core Value**: Automates the process of "inspiration -> code" by combining server-side scraping with generative AI.

---

## 2. System Architecture

The application follows a decoupled **Client-Server** architecture:

### **Frontend (Client)** — `frontend/`

- **Framework**: Next.js 16 (App Router), React 19 with the React Compiler
- **Styling**: Tailwind CSS v4 (configured in `app/globals.css`, no `tailwind.config` file)
- **Live Preview**: `@codesandbox/sandpack-react` (runs the generated component in an isolated iframe)
- **Icons**: `lucide-react`
- **State**: React state, saved to `sessionStorage` so a refresh keeps your place. The page renders client-side only (so restored state can't mismatch server HTML).

| File | Responsibility |
|---|---|
| `app/page.tsx` | App state and flow: `INPUT` → `SELECT` → `EDIT`, requests, cancel, undo/redo, auto-fix |
| `app/lib/api.ts` | Backend client: scrape, streamed generate, URL normalization, error messages |
| `app/lib/storage.ts` | `usePersistentState` (sessionStorage) |
| `app/lib/formats.ts` | Output formats: Sandpack template, files and download name for React / Vue / Svelte / HTML |
| `app/lib/download.ts` | Browser file download |
| `app/lib/history.ts` | Saved projects in IndexedDB (last 50) |
| `app/lib/theme.ts`, `theme-boot.ts` | Light / dark / system theme (class-based `dark:` variant, applied before first paint) |
| `app/lib/media.ts` | `useMediaQuery` (phone layout) |
| `app/components/HistoryPanel.tsx` | History drawer |
| `app/components/FidelityPanel.tsx` | "Match X%" badge and panel: score breakdown, render next to the original, target, Auto-improve |
| `app/components/ThemeToggle.tsx` | Theme button |
| `app/components/UrlInput.tsx` | Step 1: URL entry |
| `app/components/SectionSelector.tsx` | Step 2: section cards with screenshot previews |
| `app/components/ComponentEditor.tsx` | Step 3: Sandpack editor/preview, refine bar, undo/redo, "Fix with AI" |
| `app/components/ProviderSettings.tsx` | Provider, API key, access code |
| `app/components/Feedback.tsx` | Error banner, progress/cancel notice, streaming output |

### **Backend (Server)** — `backend/`

- **Runtime**: Node.js 24 (Express 5), TypeScript (ES modules)
- **Scraping Engine**: Playwright (one shared headless Chromium)
- **AI Engine**: Google Gemini via `@google/genai` (default) or OpenAI; models set by `GEMINI_MODEL` / `OPENAI_MODEL`
- **API Structure**: RESTful JSON API, with optional streaming for generation

| File | Responsibility |
|---|---|
| `src/index.ts` | Entry point: loads config, starts the server |
| `src/config.ts` | Reads and validates environment settings (production safety checks) |
| `src/app.ts` | Express app: CORS, auth, rate limits, input validation, routes |
| `src/scraper.ts` | Shared browser, sandbox, concurrency queue, per-scrape deadline, result cache |
| `src/usage.ts` | Token usage → estimated cost; per-user daily limit and daily budget for the server's keys |
| `src/cache.ts` | In-memory result cache (TTL, LRU eviction, sharing of identical in-flight requests) |
| `src/extract.ts` | Scrape orchestration with Playwright: scrolling, the two passes, screenshot |
| `src/inpage.ts` | Code that runs inside the page (section detection, style capture, fonts). Shared with the browser extension, which bundles it |
| `src/fidelity.ts` | Match score: renders React (esbuild + esm.sh) or HTML in the shared browser and compares it with the original screenshot |
| `src/captures.ts` | Validation and in-memory store for extension captures (30 min, at most 20, 80MB) |
| `src/netguard.ts` | SSRF protection: URL validation and the filtering proxy the browser uses |
| `src/generator.ts` | Prompts per output format, page prompts with a shared palette, Gemini/OpenAI streaming calls, extracting code from the reply |
| `src/logger.ts` | Console + optional log file |
| `src/browser-env.ts` | Keeps Playwright's Chromium inside `node_modules` (see deployment.md) |

---

## 3. End-to-End Workflow

### **Step 1: User Input (URL Entry)**

1.  **Action**: User types a URL. `example.com` works; `https://` is added automatically.
2.  **Request**: Frontend sends `POST /api/scrape` with `{ url }` and the `x-api-secret` header. The user can cancel; after 8 seconds a note explains that a sleeping server can take a minute to wake. (The frontend also pings the backend on load to start waking it early.)

### **Step 2: Server-Side Scraping**

1.  **Validation**: Only `http`/`https` URLs are accepted, and the host must resolve to a public IP address (see Security).
2.  **Cache**: If the same URL was scraped in the last 10 minutes (`SCRAPE_CACHE_TTL_MS`), that result is returned immediately (`"cached": true`); identical requests arriving during a scrape share it. Up to 10 results are kept, least recently used evicted first; failures are never cached. `"fresh": true` (the **Refresh** button) always scrapes again.
3.  **Queue**: At most `MAX_CONCURRENT_SCRAPES` scrapes (default 1) run at once; up to 5 more wait. Beyond that the server answers `503`.
4.  **Browser**: A single Chromium (sandboxed when the host allows it) is launched on first use and reused. Each scrape gets its own isolated context at a 1280×800 viewport. The browser closes after 5 idle minutes and relaunches automatically if it crashes.
5.  **Deadline**: Each scrape has a hard limit (`SCRAPE_TIMEOUT_MS`, default 90s). A page that hangs (e.g. blocks its main thread) gets a `504`, its context is closed, and the queue moves on.
6.  **Navigation**: Waits for `domcontentloaded`, then (best-effort, capped) for `load` and for the network to go idle.
7.  **Scroll-through**: Scrolls the page with real mouse-wheel events (also inside a scrolling container, if the site uses one), so lazy images load and scroll-reveal animations run, then returns to the top.
8.  **Section Detection** (`extract.ts`, inside the page):
    - **Candidates**: `<section>`, `<header>`, `<footer>`, `<main>`, `<nav>`, direct `<div>` children of `<body>`/`<main>`, and divs whose class or id contains "section". Must be at least 100×100px with text or an image.
    - **Remove overlaps**: drop *wrappers* — elements whose height is at least 70% covered by 2+ other candidates (e.g. `<main>` around several `<section>`s) — then anything nested inside a kept candidate. A container holding a few small candidates plus other content is kept instead (dropping it would lose that content).
    - **Split containers**: replaced by their child blocks when those are stacked one per row (not side-by-side columns, tabs or cards) and the container is either "mixed" (see above) or oversized: taller than 2 viewports, or 3 for a `<section>`. Header, footer and nav are never split.
    - **Drop decorative layers**: `aria-hidden` elements, and — when two sections cover mostly the same area (e.g. a hero background layer) — the one with less text.
    - **Recover missed content**: walking down from `<body>`, any visible block that no section touches becomes a section (e.g. a hero or banner that isn't a candidate). A block holding one or two small sections entirely inside it (e.g. a sidebar in a hero's product screenshot) replaces them, so the hero stays whole.
    - **Limits**: at most 40 sections; IDs made unique.
9.  **HTML Copy** for each section (built in a separate inert document):
    - **Computed styles inlined** as `style` (colors, fonts, spacing, flex/grid, borders, shadows...); inherited properties only where they change.
    - **Phone styles**: the viewport is resized to 390px and styles that differ are recorded in `data-mobile-style`, so the AI can write responsive classes.
    - **Pseudo-elements**: `::before`/`::after` content and styles go into `data-before`/`data-after`.
    - **Shadow DOM**: open shadow roots and slots are flattened into the copy.
    - **URLs made absolute**: images (loaded source, `data-src`, or the largest `srcset` candidate), videos, links. Large inline `data:` images are dropped.
    - **Removed**: scripts, styles, iframes, `<source>`, comments, `data-*`/`on*` attributes, SVG path data.
    - **Size cap**: 100,000 characters per section, cut at a tag boundary.
10.  **Page extras**: a JPEG screenshot of the top of the page (up to 8,000px) for previews, and the page's web fonts (family names plus the `@font-face`/`@import` CSS that loads them).

### **Step 3: Section Selection**

1.  **UI Display**: One card per section with its slice of the page screenshot, tag, ID and visible text. Cards are real buttons (keyboard accessible). The header shows the URL, when it was scraped (or that it's a saved copy), and **Refresh**.
2.  **One section**: Clicking a card sends `POST /api/generate` (streamed) with the section's `html`, default `instructions`, the output `format` (⚙ Settings → Output), the chosen `provider`/`apiKey`, the page's font families, and the section's **screenshot** (cut out of the page screenshot in the browser, max 1024×2000px JPEG; can be turned off in ⚙ Settings). The model's output is shown as it arrives; the user can cancel.
3.  **A whole page**: The **+** button on each card adds it to a page (numbered in the order picked; 2–8 sections). **Generate page** sends `sections` (their HTML, in that order) instead of `html`.

### **Step 4: AI Generation**

1.  **Prompt**: The model acts as an expert frontend developer, writing the chosen format:

    | Format | Output | Icons |
    |---|---|---|
    | `react` | TSX function component, `export default` | `lucide-react` |
    | `vue` | Vue 3 SFC with `<script setup lang="ts">` | `lucide-vue-next` |
    | `svelte` | Svelte 3 syntax (no runes) | inline SVG |
    | `html` | Complete HTML document with the Tailwind CDN script | inline SVG |

    It is told that `style` holds computed desktop styles to translate into Tailwind (arbitrary values allowed), that `data-mobile-style` holds the phone differences (base classes vs `md:`), what `data-before`/`data-after` mean, to keep absolute image URLs, which web fonts are loaded, which packages it may import, and that the scraped HTML is third-party content, never instructions.
2.  **Pages**: For `sections`, the prompt asks for one page with each section in order (in React, one sub-component per section rendered from `export default function Page()`). A **shared palette** — the most-used colors and fonts across the selected sections, read from their captured styles — is included, and the model is told to use exactly those values so the page looks like one design. The page budget is 150,000 characters of HTML, split evenly between sections.
3.  **Screenshots**: Sent to the model as images (OpenAI `image_url`, Gemini `inlineData`). The prompt says what they show (for a page: which sections) and to match their visual design, using the HTML for exact text, links and image URLs. Refinements send the original screenshot(s) too, so requests like "match the original spacing" work.
4.  **Output limit**: If the model stops at its output limit (OpenAI `finish_reason: "length"`, Gemini `MAX_TOKENS`), it's asked to continue exactly where it stopped, up to 2 times, and the parts are joined. If it still isn't finished, the user gets a clear error suggesting fewer sections.
5.  **Truncation**: HTML over the budget (50,000 characters for one section) is cut at a tag boundary, and the model is told it was truncated.
6.  **Extraction**: The code is pulled from the reply, even if it's wrapped in a Markdown fence or prose.
7.  **No API key**: With the default Gemini provider and no key configured, a placeholder in the requested format is returned.

### **Step 5: Live Preview, Iteration & Export**

1.  **Preview width**: 📱 Phone (390px), Fit (the pane's width), or 🖥 Desktop (1280px — the width the original was scraped at — scaled down to fit). The preview is re-hosted without reloading when switching.
2.  **Compare view**: the original screenshot(s) next to the live preview; with the Desktop width both are the same 1280px design at the same scale.
3.  **Sandpack**: Each format uses its own template (`react-ts`, `vue-ts`, `svelte`, `static`). The code goes into that template's main file, the page's font CSS into the stylesheet the template already loads, with Tailwind from its CDN and pinned icon packages. The editor remembers the format the code was generated in, so changing the setting afterwards doesn't break it.
4.  **Preview status**: A badge on the preview shows *Loading preview…*, *Preview ready* or *Preview error*, with a **Reload preview** button. The first preview of a session downloads packages inside the preview (it runs on codesandbox.io) and can take up to a minute; after 20 seconds a note says so.
5.  **Editing**: Manual edits are synced back to the app, so **Copy** and refinements use what is on screen.
6.  **Refinement Loop**: The user describes a change; the frontend sends `currentCode` (the editor's contents) and the instruction, streamed. The model applies only the requested change.
7.  **Undo/Redo**: Every AI change can be undone (up to 20 steps).
8.  **Preview errors**: If the preview fails, an error bar offers **Fix with AI**. Fresh AI output that fails is sent back for a fix automatically, once — never while the user is editing by hand.
9.  **Export**: **Download** saves the code (`Component.tsx`, `Page.vue`, `index.html`, ...), plus `fonts.css` when the original site had web fonts; **Copy** copies it; **Open in CodeSandbox** (in the preview) opens it as a full sandbox.
10.  **Back** returns to the section list; **New URL** starts over.

---

## 4. API Reference

All `/api/*` routes and `/health/browser` require the `x-api-secret` header when the server has `API_SECRET` set. Exception: `POST /api/generate` is also allowed when the body contains the caller's own `apiKey` (they pay for the AI call). Scraping always needs the secret, because it runs on the server's resources.

Errors are returned as `{ "error": "message" }`; stack traces are never sent.

### `POST /api/scrape`

Rate limit: 10 requests/minute per IP.

- **Body**: `{ "url": "https://...", "fresh": false }` — `fresh: true` skips the cache.
- **Response**:
  ```json
  {
    "sections": [
      {
        "id": "section-0",
        "tagName": "section",
        "html": "<section style=\"...\" data-mobile-style=\"...\">...</section>",
        "text": "Visible text preview (max 200 chars)",
        "rect": { "x": 0, "y": 640, "width": 1280, "height": 500 }
      }
    ],
    "screenshot": "data:image/jpeg;base64,...",
    "screenshotSize": { "width": 1280, "height": 8000 },
    "fonts": { "families": ["Inter"], "css": "@font-face { ... }" },
    "url": "https://example.com/",
    "scrapedAt": "2026-09-26T10:00:00.000Z",
    "cached": false
  }
  ```
  `rect` is in page coordinates at a 1280px-wide viewport (matching the screenshot). `cached` is true when a recent scrape of the same URL was reused; `scrapedAt` is when that scrape happened.
- **Errors**: `400` invalid or internal/private URL, `401` missing secret, `429` rate limited, `503` scrape queue full, `504` page took too long, `500` page failed to load.

### `POST /api/generate`

Rate limit: 20 requests/minute per IP.

- **Body** (first generation):
  ```json
  {
    "html": "<div>...</div>",
    "instructions": "Make it modern",
    "format": "react",
    "provider": "gemini",
    "apiKey": "optional, the caller's own key",
    "fonts": ["Inter"],
    "images": ["data:image/jpeg;base64,..."],
    "stream": true
  }
  ```
- **Body** (page): same, but `sections` (2–8 HTML strings, in page order) instead of `html`.
- **Body** (refinement): same, but `currentCode` (the code to modify) instead of `html`; `format` should be the format of that code.
- **Limits**: `html` and each section ≤ 200,000 characters (the model sees at most 50,000 for one section, 150,000 for a page); `currentCode` ≤ 100,000; `instructions` ≤ 2,000; `fonts` ≤ 20 names; `format` is `"react"` (default), `"vue"`, `"svelte"` or `"html"`; `provider` is `"gemini"` or `"openai"`. `images`: up to 8 base64 JPEG/PNG/WebP data URLs (≤ ~2MB each; for a page one per section, `null` where missing). Request bodies can be up to 12MB.
- **Response** without `stream`: `{ "code": "import React from 'react'; ..." }`
- **Response** with `"stream": true`: `application/x-ndjson`, one JSON event per line:
  ```
  {"type":"delta","text":"import React"}
  {"type":"delta","text":" from 'react';..."}
  {"type":"done","code":"import React from 'react'; ..."}
  ```
  or `{"type":"error","error":"..."}` as the last line. Closing the connection cancels the AI call.

### `POST /api/fidelity`

Rate limit: 20 requests/minute per IP. Needs the access code (like scraping: it uses the server's browser). Costs no AI tokens.

- **Body**: `{ "code": "...", "format": "react" | "html", "images": ["data:image/jpeg;base64,..."], "fontCss": "@font-face ...", "width": 1232 }`. `images`: 1–8 screenshots of the original, top to bottom. `width` (320–1920, default 1280): the original section's width in CSS pixels; the code is rendered at that viewport width.
- **How**: React code is compiled with esbuild and rendered with React 19, lucide-react (from esm.sh) and the Tailwind CDN, like the editor's preview; HTML is rendered as is. The full-height render is screenshotted and compared with the original: both are scaled to 192px wide and split into 16px tiles, each tile is matched with a small position tolerance in both directions, and tiles with content or color count more than empty background.
- **Response**: `{ score: 0–100, structure: 0–1, color: 0–1, size: 0–1, heightRatio, render }`. `score` = 50% structure (SSIM of matched tiles) + 35% color + 15% size (height ratio). `heightRatio` > 1 means the render is taller. `render` is a JPEG data URL of the render (≤1024×2000).
- **Errors**: `422` when the code doesn't compile, throws, or doesn't finish rendering in 30s; `503`/`504` when the browser is busy or too slow.
- **Calibration** (Aetna footer): identical 100, shifted 30px 92, the AI's first version 55, a hand-fixed version 74, a different section 31–38.

`POST /api/generate` also accepts `renderImage` (a data URL, only with `currentCode`): a screenshot of how `currentCode` renders now, attached after the originals, so the AI sees what a request refers to. The app sends it with every change request (reusing the match score's render, or getting one from `POST /api/render`, which takes the same body as `/api/fidelity` without `images` and returns `{ render }`) and with Auto-improve.

Refinements must return the complete file: a reply that skips code with placeholder comments ("// ...rest unchanged") is sent back once for the full file, and if it's shortened again the request fails and the user's code stays as it was.

### `POST /api/captures` and `GET /api/captures/:id`

Used by the browser extension (`extension/`). Both need the access code. Rate limits: 10 uploads/minute; reads share the scrape limit.

- **POST body** (up to 20MB): `{ url, sections: [{ id, tagName, text, html, rect }], screenshot, screenshotSize, fonts: { families, css } }`, the same shape as a scrape result. Validated field by field (1–40 sections, each HTML ≤ 100,000 characters, screenshot ≤ 8,000px tall). Returns `201 { id, expiresInSeconds }`.
- **GET** returns the capture like a scrape result, plus `captured: true`; `404` once it has expired (30 minutes) or was dropped (at most 20 captures and 80MB are kept; oldest first).

### `GET /api/usage`

Public. The caller's (client IP's) usage of the server's keys today and the limits: `{ requests, costUsd, remaining, budgetExhausted, limits: { perUserPerDay, dailyBudgetUsd } }`. Generations that use the server's key return `429` when the per-user limit or the daily budget is reached; failed generations don't count. Every generate response includes `usage: { inputTokens, outputTokens, costUsd }` (estimated from the provider's reported tokens and the price table).

### `GET /api/providers`

Public (no access code needed). Reports which AI providers have a key configured on the server — booleans only, never the keys: `{ "gemini": true, "openai": false }`. The settings panel uses it to tell users whether they need their own key.

### `GET /health/browser`

Starts the shared browser if needed and loads a blank page. Returns `200` "Browser launch successful!" or `500`.

---

## 5. Security

- **SSRF protection**: All of the headless browser's traffic (navigation, redirects, subresources, `fetch`/XHR from the page's own scripts, WebSockets) goes through a small proxy inside the backend (`netguard.ts`). The proxy resolves each hostname itself, rejects private, loopback, link-local (e.g. `169.254.169.254`) and other reserved ranges — including those addresses wrapped in IPv4-mapped or NAT64 IPv6 form — and connects to the exact IP it checked, which also defeats DNS rebinding. QUIC, non-proxied WebRTC, downloads and service workers are disabled so nothing bypasses the proxy.
- **Browser sandbox**: Chromium's sandbox is used when the host supports it.
- **Hang protection**: every scrape has a hard deadline.
- **Auth**: `API_SECRET` compared in constant time. In production the server won't start without `API_SECRET` (unless `ALLOW_OPEN_ACCESS=true`) or without `ALLOWED_ORIGINS`.
- **Rate limits**: per client IP (`TRUST_PROXY` controls how the IP is read behind a reverse proxy).
- **Input and output limits**: JSON bodies up to 12MB (20MB for extension captures), typed and length-checked fields, capped section count and size.
- **Match score rendering**: generated code runs in its own isolated browser context of the shared browser, with the same SSRF-filtering proxy, deadline and queue as scraping; the render page itself is served by request interception, never from the network.
- **Extension captures**: stored under random (UUID) ids for 30 minutes, readable only with the access code; only the expected fields are kept.
- **Generated code** runs only inside Sandpack's iframe, on a separate origin.
- **Browser storage**: the API key and access code are kept in `sessionStorage` (cleared when the tab closes).

---

## 6. Key Design Decisions

1.  **Why Playwright?**: Needed for modern SPAs that render with JavaScript. It also gives access to computed styles, layout and screenshots.
2.  **Why one shared browser?**: Launching Chromium takes about a second and a lot of memory. Reusing one browser with an isolated context per scrape is faster, and contexts don't share cookies or storage.
3.  **Why a filtering proxy instead of request interception?**: Playwright's request interception doesn't see redirect hops, so a public URL could redirect to an internal address. A proxy sees every connection.
4.  **Why inline computed styles (desktop and phone)?**: Without them the AI only sees class names that refer to CSS it never receives, so it can't reproduce the look or the responsive behavior.
5.  **Why one page screenshot instead of one per section?**: One image, shared by all cards as a CSS background, is much smaller than 20–40 separate images.
6.  **Why stream generation?**: Generating a component can take 10–60 seconds; seeing the code arrive (and being able to cancel) is much better than a spinner.
7.  **Why one prompt for a whole page (not one per section)?**: The model sees every section at once, so it can keep spacing, headings and colors consistent; the palette extracted from the captured styles pins the colors down. It's also one request instead of up to eight.
8.  **Why inline SVG icons for Svelte?**: Sandpack's Svelte preview compiles with an older Svelte 3 compiler that current `lucide-svelte` doesn't support. Inline SVG works in the preview and in any Svelte version.
9.  **Why cache scrapes?**: Scraping takes 5–30 seconds and a browser slot; users often go back to the same page (e.g. to pick another section or change the format).
10. **Why Sandpack?**: A secure, browser-in-browser execution environment that bundles imports like `lucide-react` automatically.
11. **Why Gemini Flash by default?**: Optimized for speed and low latency.

---

## 7. Testing

- `backend/test/` (`npm test`): SSRF guard and proxy, config rules, API routes (auth, validation, CORS, rate limits, streaming, captures, fidelity), capture validation and store, section extraction against a local fixture page, and the match score (identical output scores 100, closer output scores higher, a blank render scores low) in headless Chromium. One test renders React from esm.sh and is skipped without internet.
- CI also checks that `extension/content.js` is up to date with `npm run build:extension`.
- `frontend/app/lib/api.test.ts` (`npm test`): URL normalization, error messages, streamed-response parsing.
- CI (`.github/workflows/ci.yml`): type-check, lint, tests and production builds for both halves on every push and pull request.

---

## 8. Directory Structure

```
/
├── .github/workflows/ci.yml   # CI: typecheck, lint, test, build
├── .nvmrc                     # Node 24
├── backend/
│   ├── src/
│   │   ├── index.ts           # Entry point
│   │   ├── config.ts          # Environment settings + production checks
│   │   ├── app.ts             # Express app: auth, limits, routes
│   │   ├── scraper.ts         # Shared browser, queue, deadline, cache
│   │   ├── cache.ts           # Scrape result cache
│   │   ├── extract.ts         # Scrape orchestration (Playwright)
│   │   ├── inpage.ts          # In-page extraction (shared with the extension)
│   │   ├── fidelity.ts        # Match score: render + compare
│   │   ├── captures.ts        # Extension captures
│   │   ├── netguard.ts        # SSRF protection + filtering proxy
│   │   ├── generator.ts       # Prompts (formats, pages) + Gemini/OpenAI streaming
│   │   ├── logger.ts          # Logging
│   │   └── browser-env.ts     # Playwright browser location
│   ├── test/                  # node:test suites (run with tsx)
│   ├── scripts/
│   │   ├── install-browsers.mjs  # postinstall: installs Chromium
│   │   ├── check-connection.mjs  # npm run check:remote -- <url>
│   │   └── build-extension.mjs   # npm run build:extension
│   ├── package.json
│   ├── tsconfig.json
│   └── tsconfig.test.json
│
├── frontend/
│   ├── app/
│   │   ├── page.tsx           # App state and flow
│   │   ├── components/        # UrlInput, SectionSelector, ComponentEditor, ...
│   │   ├── lib/               # API client, formats, storage, download (+ tests)
│   │   ├── layout.tsx
│   │   └── globals.css        # Tailwind v4 setup
│   ├── next.config.ts
│   └── package.json
│
├── extension/                 # Chrome extension (Manifest V3): capture the page you're viewing
│   ├── manifest.json
│   ├── popup.html, popup.js   # Consent, settings, Capture button
│   ├── background.js          # Capture, stitched screenshot, upload, open the app
│   ├── src/content.ts         # In-page entry (bundles backend/src/inpage.ts)
│   └── content.js             # Built by npm run build:extension
│
├── README.md                  # Overview & local setup
├── archReadme.md              # This document
├── deployment.md              # Render + Vercel deployment
└── TECHNICAL_WRITEUP.txt      # Development write-up
```
