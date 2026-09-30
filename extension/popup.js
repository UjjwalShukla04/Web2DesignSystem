const DEFAULTS = { appUrl: "http://localhost:3000", backendUrl: "http://localhost:4000", accessCode: "" };

const $ = (id) => document.getElementById(id);
const consent = $("consent");
const captureButton = $("capture");
const status = $("status");

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

function validUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  for (const key of Object.keys(DEFAULTS)) $(key).value = stored[key] ?? DEFAULTS[key];
  // First use: open the settings so the addresses can be checked.
  const { configured } = await chrome.storage.local.get("configured");
  if (!configured) $("settings").open = true;
}

function readSettings() {
  return {
    appUrl: $("appUrl").value.trim() || DEFAULTS.appUrl,
    backendUrl: $("backendUrl").value.trim() || DEFAULTS.backendUrl,
    accessCode: $("accessCode").value,
  };
}

$("save").addEventListener("click", async () => {
  const settings = readSettings();
  if (!validUrl(settings.appUrl) || !validUrl(settings.backendUrl)) {
    $("saved").textContent = "Enter http(s) addresses.";
    return;
  }
  await chrome.storage.local.set({ ...settings, configured: true });
  $("saved").textContent = "Saved.";
});

consent.addEventListener("change", () => {
  captureButton.disabled = !consent.checked;
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "progress") setStatus(message.text);
});

captureButton.addEventListener("click", async () => {
  if (!consent.checked) return;
  const settings = readSettings();
  if (!validUrl(settings.appUrl) || !validUrl(settings.backendUrl)) {
    $("settings").open = true;
    setStatus("Check the app and backend addresses in Settings.", true);
    return;
  }
  // Uploading to the backend needs permission for its address. Asked here, while the
  // click still counts as a user action; Chrome remembers the answer.
  const origin = `${new URL(settings.backendUrl).origin}/*`;
  let allowed = false;
  try {
    allowed = await chrome.permissions.request({ origins: [origin] });
  } catch (error) {
    setStatus(String(error?.message ?? error), true);
    return;
  }
  if (!allowed) {
    setStatus("The extension needs permission to send the capture to your backend.", true);
    return;
  }
  await chrome.storage.local.set({ ...settings, configured: true });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("No tab to capture.", true);
    return;
  }
  captureButton.disabled = true;
  consent.disabled = true;
  setStatus("Starting…");
  const result = await chrome.runtime.sendMessage({ type: "capture", tabId: tab.id, windowId: tab.windowId, settings });
  if (result?.ok) {
    setStatus(`Captured ${result.sections} sections. Opening the app…`);
  } else {
    setStatus(result?.error ?? "The capture failed.", true);
    captureButton.disabled = false;
    consent.disabled = false;
  }
});

loadSettings();
