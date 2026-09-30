# Capture extension (Chrome, Manifest V3)

Captures the page you're looking at, in your own browser, and opens its sections in the app.

Use it when the server's scraper can't get the page:

- **Logged-in pages** (dashboards, admin panels, intranets): the server never sees your login.
- **Pages that block headless browsers** (Cloudflare and other bot checks): the capture runs in your normal browser.
- **Clear consent:** each capture asks you to confirm that you own the page or have permission to copy its design, and that the result is for your own project.

## Install (unpacked)

1. Build the content script (run it again after changing `backend/src/inpage.ts` or `src/content.ts`):
   ```bash
   cd backend
   npm run build:extension   # writes extension/content.js
   ```
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose this `extension/` folder.
3. Pin the extension. Click it and, under **Settings**, enter:
   - **App address**: where the frontend runs (default `http://localhost:3000`).
   - **Backend address**: where the backend runs (default `http://localhost:4000`).
   - **Access Code**: the backend's `API_SECRET`, if it has one.

## Use

1. Open the page and scroll to the state you want (open menus, accept cookie banners, etc.).
2. Click the extension, tick the confirmation, and click **Capture page**.
3. The app opens with the page's sections, just like after scraping a URL.

The first capture asks for permission to send data to your backend's address; Chrome remembers the answer.

## How it works

| Step | Where | What happens |
|---|---|---|
| 1 | `background.js` | Injects `content.js` into the active tab. Access comes from `activeTab`: only the tab you clicked the button on, only then. |
| 2 | `content.js` (from `src/content.ts`) | Scrolls through the page (lazy images, animations), then finds and copies the sections with the **same code the backend scraper uses** (`backend/src/inpage.ts`). |
| 3 | `background.js` | Takes a full-page screenshot: scrolls one screen at a time, captures each with `captureVisibleTab`, and stitches them (fixed and sticky elements are hidden after the first screen so they appear once). Up to 8,000px tall. |
| 4 | `content.js` | Restores the page: scroll position and hidden elements. |
| 5 | `background.js` | Uploads the capture to `POST /api/captures` and opens `<app>/?capture=<id>`. |

## Limits

- No phone-width styles: the extension can't resize your tab, so captured sections have desktop styles only (the scraper records both).
- Pages that scroll inside an inner container (not the window) get a screenshot of the visible screen only.
- Browser pages (`chrome://`, the Chrome Web Store, the PDF viewer) can't be captured.
- Captures are kept in the backend's memory for 30 minutes (at most 20); after that, capture again.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read and screenshot the tab you clicked the button on, only when you click it. |
| `scripting` | Run the capture code in that tab. |
| `storage` | Remember the app/backend addresses and access code. |
| Optional host permission for your backend's address | Upload the capture. Asked on first capture. |

There is no access to other tabs or pages, and nothing runs until you click **Capture page**.
