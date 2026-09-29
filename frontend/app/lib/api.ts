import axios from "axios";
import type { OutputFormat } from "./formats.ts";

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

// --- Types (mirror backend/src/extract.ts) ---
export interface ScrapedSection {
  id: string;
  tagName: string;
  html: string;
  text: string;
  /** Position in page coordinates, at a 1280px-wide viewport. */
  rect: { x: number; y: number; width: number; height: number };
}

export interface ScrapeResult {
  sections: ScrapedSection[];
  screenshot: string | null;
  screenshotSize: { width: number; height: number } | null;
  fonts: { families: string[]; css: string };
  /** The normalized URL that was scraped. */
  url: string;
  /** When the page was scraped (ISO timestamp). */
  scrapedAt: string;
  /** True when the server reused a recent scrape of the same URL. */
  cached: boolean;
}

export type Provider = "gemini" | "openai";

/** Tokens used by one generation and its estimated cost (mirrors backend/src/usage.ts). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface GenerateResult {
  code: string;
  usage: Usage;
}

/** The caller's AI usage today with the server's key, and the limits. */
export interface UsageSummary {
  requests: number;
  costUsd: number;
  remaining: number | null; // null = no per-user limit
  budgetExhausted: boolean;
  limits: { perUserPerDay: number; dailyBudgetUsd: number };
}

/** An error response from the backend, with its HTTP status. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Accepts "example.com" as well as full URLs. Returns null if it isn't a usable URL. */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isCancel(error: unknown): boolean {
  return (
    axios.isCancel(error) ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

/**
 * Builds a user-facing message for a failed request, including the backend's reason.
 * Returns null when the user cancelled the request.
 */
export function describeError(error: unknown, action: string): string | null {
  if (isCancel(error)) return null;

  let status: number | undefined;
  let detail: string | undefined;
  if (axios.isAxiosError(error)) {
    if (error.code === "ECONNABORTED") {
      return `${action} timed out. The page may be too slow or the server too busy; please try again.`;
    }
    status = error.response?.status;
    const data = error.response?.data as { error?: unknown } | undefined;
    if (typeof data?.error === "string") detail = data.error;
  } else if (error instanceof ApiError) {
    status = error.status;
    detail = error.message;
  } else if (error instanceof Error && !(error instanceof TypeError)) {
    // Errors reported inside a streamed response. (TypeError = network failure.)
    detail = error.message;
  }

  if (status === undefined && !detail) {
    return `${action} failed: the server could not be reached. If it was asleep (free hosting sleeps when idle), wait a minute and try again.`;
  }
  let message = `${action} failed${status ? ` (${status})` : ""}${detail ? `: ${detail}` : "."}`;
  if (status === 401) message += " Open Settings (⚙) and enter the correct Access Code.";
  return message;
}

/** Scrapes a page. `fresh` skips the server's cache of recent scrapes. */
export async function scrape(
  url: string,
  accessCode: string,
  signal: AbortSignal,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<ScrapeResult> {
  const { data } = await axios.post<ScrapeResult>(
    `${API_URL}/api/scrape`,
    { url, ...(fresh ? { fresh: true } : {}) },
    {
      headers: { "x-api-secret": accessCode },
      signal,
      // The server allows 90s per scrape, plus time waiting in its queue.
      timeout: 150_000,
    },
  );
  return data;
}

export interface GenerateRequest {
  /** One section (a component)... */
  html?: string;
  /** ...or several sections, combined into one page... */
  sections?: string[];
  /** ...or existing code to change according to `instructions`. */
  currentCode?: string;
  format: OutputFormat;
  instructions?: string;
  provider: Provider;
  apiKey?: string;
  fonts?: string[];
  /** Screenshots of the original section(s): one per section for a page (null if none). */
  images?: (string | null)[];
}

/**
 * Generates (or refines) a component, streaming the model's output.
 * `onText` receives the full text so far; the resolved value is the cleaned code.
 */
export async function generate(
  request: GenerateRequest,
  accessCode: string,
  signal: AbortSignal,
  onText: (textSoFar: string) => void,
): Promise<GenerateResult> {
  const response = await fetch(`${API_URL}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-secret": accessCode },
    body: JSON.stringify({ ...request, stream: true }),
    signal,
  });
  if (!response.ok || !response.body) {
    let message = response.statusText || "Request failed";
    try {
      const data = await response.json();
      if (typeof data?.error === "string") message = data.error;
    } catch {
      // Not JSON; keep the status text.
    }
    throw new ApiError(response.status, message);
  }

  // Newline-delimited JSON events: delta... then done or error.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line) as
        | { type: "delta"; text: string }
        | { type: "done"; code: string; usage?: Usage }
        | { type: "error"; error: string };
      if (event.type === "delta") {
        text += event.text;
        onText(text);
      } else if (event.type === "done") {
        return { code: event.code, usage: event.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      } else {
        throw new Error(event.error);
      }
    }
  }
  throw new Error("The connection closed before the component was finished.");
}

/** The caller's usage today, or null if unavailable. */
export async function fetchUsage(): Promise<UsageSummary | null> {
  try {
    const response = await fetch(`${API_URL}/api/usage`);
    return response.ok ? ((await response.json()) as UsageSummary) : null;
  } catch {
    return null;
  }
}

/** "$0.0123" style, with more precision for tiny amounts. */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

/** Which providers have a key on the server, or null if the backend can't be reached. */
export async function fetchServerProviders(): Promise<Record<Provider, boolean> | null> {
  try {
    const response = await fetch(`${API_URL}/api/providers`);
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<Record<Provider, unknown>>;
    return { gemini: data.gemini === true, openai: data.openai === true };
  } catch {
    return null;
  }
}

/** Wakes the backend early (free hosting sleeps when idle). Errors are ignored. */
export function wakeBackend() {
  fetch(`${API_URL}/`).catch(() => {});
}
