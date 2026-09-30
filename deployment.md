# Deployment Guide

This guide explains how to deploy the **Scraper + Generator** application to production using **Vercel** (Frontend) and **Render** (Backend).

---

## 1. Prerequisites

- A [GitHub](https://github.com/) repository with your project code.
- A [Render](https://render.com/) account (for the Backend).
- A [Vercel](https://vercel.com/) account (for the Frontend).

---

## 2. Backend Deployment (Render)

We will deploy the Node.js/Express backend first because the Frontend needs the Backend URL.

1.  **Log in to Render** and click **"New + "** -> **"Web Service"**.
2.  **Connect your GitHub repository**.
3.  **Configure the Service**:
    - **Name**: `my-scraper-backend` (or similar)
    - **Region**: Choose one close to you (e.g., `Oregon`, `Frankfurt`).
    - **Branch**: `main` (or your working branch).
    - **Root Directory**: `backend` (Important!).
    - **Runtime**: `Node`
    - **Build Command**: `npm install && npm run build`
      - _Explanation_: Installs dependencies (which also installs Chromium for Playwright, via the `postinstall` script) and compiles TypeScript to JavaScript. Chromium is stored inside `node_modules`, so it is still there when the server starts; no extra `playwright install` step is needed.
    - **Start Command**: `npm start`
      - _Explanation_: Runs the compiled code (`node dist/index.js`).
4.  **Environment Variables**:
    - Scroll down to "Environment Variables" and add:
      - `GEMINI_API_KEY`: Your Google Gemini API Key.
      - `OPENAI_API_KEY`: (Optional) Your OpenAI API Key.
      - `API_SECRET`: **(Required)** A strong password to protect your API usage. The server refuses to start on Render without it, because anyone could otherwise use your AI keys and scraper. (To run a public API on purpose, set `ALLOW_OPEN_ACCESS=true` instead.)
      - `ALLOWED_ORIGINS`: **(Required)** Comma-separated frontend URLs allowed by CORS, e.g. `https://my-scraper-frontend.vercel.app`, or `*` to allow any site. The server refuses to start on Render without it.
      - `GEMINI_MODEL` / `OPENAI_MODEL`: (Optional) Model names, to upgrade models without code changes. Defaults: `gemini-flash-latest`, `gpt-4o`.
      - `TRUST_PROXY`: (Optional, default `1`) Number of reverse proxies in front of the server, used to find the real client IP for rate limiting. `1` is correct for Render.
      - `MAX_CONCURRENT_SCRAPES`: (Optional, default `1`) How many pages the shared headless browser may scrape at once. Up to 5 more requests wait in a queue; beyond that they get a 503 "busy" error. Raise it only if your instance has more than 512MB of RAM.
      - `SCRAPE_TIMEOUT_MS`: (Optional, default `90000`) Hard time limit for one scrape; slower pages get a 504 error.
      - `DAILY_GENERATIONS_PER_USER`: (Optional, default `50`) AI generations per user (client IP) per day that the server's keys pay for. `0` = unlimited. Users who paste their own key in ⚙ Settings aren't limited.
      - `DAILY_BUDGET_USD`: (Recommended) Estimated USD the server's keys may spend per day across all users, e.g. `5`. Off by default. Costs are estimated from the tokens the providers report and the price table (`*_PRICE_INPUT` / `*_PRICE_OUTPUT`, USD per 1M tokens).
      - `SCRAPE_CACHE_TTL_MS` / `SCRAPE_CACHE_MAX_ENTRIES`: (Optional, defaults `600000` / `10`) How long, and how many, scrape results are reused for repeat requests of the same URL. Each result can be up to ~1MB of memory; `SCRAPE_CACHE_TTL_MS=0` disables the cache.
      - `LOG_FILE`: (Optional, off by default on Render) File that logs are appended to, in addition to the console. Render's log viewer already shows console output, and its disk is wiped on every deploy.
      - `PORT`: (Optional, Render sets this automatically, usually 10000).
5.  **Deploy**: Click **"Create Web Service"**.
6.  **Wait**: The deployment might take a few minutes. Once live, copy the **Service URL** (e.g., `https://my-scraper-backend.onrender.com`).

---

## 3. Frontend Deployment (Vercel)

Now we deploy the Next.js frontend and connect it to the backend.

1.  **Log in to Vercel** and click **"Add New..."** -> **"Project"**.
2.  **Import your GitHub repository**.
3.  **Configure the Project**:
    - **Project Name**: `my-scraper-frontend`
    - **Framework Preset**: `Next.js` (should be auto-detected).
    - **Root Directory**: Click "Edit" and select `frontend`.
4.  **Environment Variables**:
    - Expand "Environment Variables".
    - Add `NEXT_PUBLIC_API_URL` with the value of your **Render Backend URL**.
      - Example: `https://my-scraper-backend.onrender.com` (no trailing slash).
5.  **Deploy**: Click **"Deploy"**.
6.  **Visit**: Once complete, your frontend is live!

---

## 4. Troubleshooting

- **Backend fails to start?**
  - Check the logs in Render.
  - Ensure the build log shows Chromium being downloaded (from the `postinstall` step). If it doesn't, check that the build command runs `npm install` without `--ignore-scripts`.
  - Visit `/health/browser` (with the `x-api-secret` header if `API_SECRET` is set) to check that the browser can start.
  - Run `npm run check:remote -- https://your-backend.onrender.com` from the `backend` folder to check that the server is reachable.
  - Ensure `GEMINI_API_KEY` is correct.
- **Frontend can't connect to Backend?**
  - Check the browser console (F12) for Network errors.
  - Verify `NEXT_PUBLIC_API_URL` is set correctly in Vercel (Settings -> Environment Variables).
  - If you see `CORS` errors, add your Vercel domain to `ALLOWED_ORIGINS` on Render (or leave it unset to allow all origins).
  - Getting `401 Unauthorized` on scrape? When `API_SECRET` is set, scraping always requires the Access Code in the frontend settings, even if you entered your own AI API key. Your own key only skips the Access Code for generation.

## 5. Security Notes

- The scraper refuses non-http(s) URLs and anything that resolves to a private, loopback, link-local (e.g. cloud metadata `169.254.169.254`) or other internal address. All headless-browser traffic, including redirects and requests made by the scraped page's own scripts, goes through a filtering proxy inside the backend.
- Rate limits per client IP: 10 scrapes/minute and 20 generations/minute.
- `/health/browser` requires the Access Code when `API_SECRET` is set.
- Chromium runs with its sandbox when the host supports it; otherwise it falls back to running without it and logs a warning at startup.

## 6. Limitations

- **Rate limits, daily AI limits, the scrape queue and the scrape cache live in memory.** They reset when the server restarts and are per instance. That's fine for a single Render instance; if you scale to several instances, each gets its own limits (a shared store such as Redis would be needed to enforce one global limit).
- **Sites with bot protection** (e.g. Cloudflare challenges) block headless browsers, so they return few or no sections. Users can capture such pages (and logged-in pages) with the browser extension instead (`extension/README.md`): in its settings, set the backend address to your Render URL and the app address to your Vercel URL.
- **Captures and match scores use memory and the browser slot.** Extension captures are kept in memory (at most 20 and 80MB, 30 minutes). Each match score renders the code in the shared browser, so it waits in the same queue as scrapes (`MAX_CONCURRENT_SCRAPES`).
- **Free Render instances sleep when idle.** The first request after a while can take up to a minute; the frontend wakes the backend when it loads and tells users when a request is slow.

