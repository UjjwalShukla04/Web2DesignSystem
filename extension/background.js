// Runs the capture: extracts the sections in the user's tab, takes a full-page
// screenshot by scrolling and stitching, uploads both to the backend, and opens the app.
// Access to the tab comes from "activeTab": it's granted only when the user clicks the
// extension's button, and only for that tab.

// Chrome allows about two captureVisibleTab calls per second.
const CAPTURE_INTERVAL_MS = 550;
const SCREENSHOT_QUALITY = 0.6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `func` in the tab (in the content script's world) and returns its result. */
async function inTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result?.result;
}

function progress(text) {
  chrome.runtime.sendMessage({ type: "progress", text }).catch(() => {}); // the popup may be closed
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

/**
 * Screenshots the page top to bottom, one viewport at a time, into one image at CSS-pixel
 * size. Fixed and sticky elements are hidden after the first slice so they appear once.
 */
async function captureFullPage(tabId, windowId, page) {
  const { width, height: viewportHeight } = page.viewport;
  const targetHeight = Math.min(page.pageHeight, page.maxScreenshotHeight);
  const canvas = new OffscreenCanvas(width, Math.max(1, targetHeight));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let covered = 0;
  let requested = 0;
  let previous = -1;
  let lastShot = 0;
  for (let slice = 0; covered < targetHeight; slice++) {
    const y = await inTab(tabId, (top) => globalThis.__w2c.scrollToY(top), [requested]);
    if (y === previous) break; // the window doesn't scroll further (e.g. an inner scroll area)
    previous = y;
    await sleep(Math.max(0, lastShot + CAPTURE_INTERVAL_MS - Date.now()));
    progress(`Taking screenshots… ${Math.min(100, Math.round(((y + viewportHeight) / targetHeight) * 100))}%`);
    const shot = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 90 });
    lastShot = Date.now();
    const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
    // The shot is in device pixels; draw it at CSS-pixel size.
    ctx.drawImage(bitmap, 0, y, width, (bitmap.height * width) / bitmap.width);
    bitmap.close();
    covered = y + viewportHeight;
    if (slice === 0) await inTab(tabId, () => globalThis.__w2c.hideFixed());
    requested = y + viewportHeight;
  }

  const height = Math.max(1, Math.min(targetHeight, covered));
  let output = canvas;
  if (height < canvas.height) {
    output = new OffscreenCanvas(width, height);
    output.getContext("2d").drawImage(canvas, 0, 0);
  }
  const blob = await output.convertToBlob({ type: "image/jpeg", quality: SCREENSHOT_QUALITY });
  return { screenshot: await blobToDataUrl(blob), screenshotSize: { width, height } };
}

async function capture({ tabId, windowId, settings }) {
  progress("Finding sections…");
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch {
    throw new Error("This page can't be captured. Browser pages (chrome://, the Web Store, PDFs) are protected.");
  }
  const startY = await inTab(tabId, () => globalThis.__w2c.startScrollY);
  let page;
  let shot = { screenshot: null, screenshotSize: null };
  try {
    page = await inTab(tabId, () => globalThis.__w2c.prepare());
    if (!page?.sections?.length) {
      throw new Error("No sections were found on this page. Scroll to where the content is and try again.");
    }
    try {
      shot = await captureFullPage(tabId, windowId, page);
    } catch (error) {
      console.warn("Screenshot failed; continuing without it.", error);
    }
  } finally {
    await inTab(tabId, (y) => globalThis.__w2c.restore(y), [startY ?? 0]).catch(() => {});
  }

  progress(`Uploading ${page.sections.length} sections…`);
  const backend = settings.backendUrl.replace(/\/+$/, "");
  let response;
  try {
    response = await fetch(`${backend}/api/captures`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-secret": settings.accessCode || "" },
      body: JSON.stringify({ url: page.url, sections: page.sections, fonts: page.fonts, ...shot }),
    });
  } catch {
    throw new Error(`Couldn't reach the backend at ${backend}. Check the address in Settings.`);
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      detail = (await response.json()).error || detail;
    } catch {
      // not JSON
    }
    if (response.status === 401) detail += " Enter the Access Code in Settings.";
    throw new Error(`Upload failed (${response.status}): ${detail}`);
  }
  const { id } = await response.json();
  const app = settings.appUrl.replace(/\/+$/, "");
  await chrome.tabs.create({ url: `${app}/?capture=${encodeURIComponent(id)}` });
  return { id, sections: page.sections.length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "capture" || sender.id !== chrome.runtime.id) return;
  capture(message).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }),
  );
  return true; // responds asynchronously
});
