// Run with: npm test (Node's built-in test runner; Node 24 runs TypeScript directly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AxiosError, CanceledError } from "axios";
import { ApiError, describeError, formatCost, generate, normalizeUrl } from "./api.ts";

test("normalizeUrl adds https:// and rejects non-URLs", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
  assert.equal(normalizeUrl("  stripe.com/pricing "), "https://stripe.com/pricing");
  assert.equal(normalizeUrl("http://example.com/a?b=1"), "http://example.com/a?b=1");
  // (The backend's SSRF guard rejects localhost; the frontend only checks the shape.)
  assert.equal(normalizeUrl("localhost:3000"), "https://localhost:3000/");
  assert.equal(normalizeUrl("http://localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizeUrl("not a url"), null);
  assert.equal(normalizeUrl("hello"), null);
  assert.equal(normalizeUrl("ftp://example.com"), null);
  assert.equal(normalizeUrl(""), null);
});

test("describeError: cancelled requests produce no message", () => {
  assert.equal(describeError(new CanceledError(), "Scraping"), null);
  assert.equal(describeError(new DOMException("aborted", "AbortError"), "Scraping"), null);
});

test("describeError: backend reason, status and 401 hint", () => {
  const error = new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
    status: 401,
    statusText: "Unauthorized",
    data: { error: "Unauthorized." },
    headers: {},
    config: { headers: {} } as never,
  });
  const message = describeError(error, "Scraping the page")!;
  assert.match(message, /^Scraping the page failed \(401\): Unauthorized\./);
  assert.match(message, /Access Code/);
  assert.equal(describeError(new ApiError(504, "Too slow."), "Scraping"), "Scraping failed (504): Too slow.");
});

test("describeError: network failures and timeouts", () => {
  assert.match(describeError(new TypeError("Failed to fetch"), "Generating")!, /could not be reached/);
  const timeout = new AxiosError("timeout", "ECONNABORTED");
  assert.match(describeError(timeout, "Scraping")!, /timed out/);
});

/** Replaces fetch with one that streams the given chunks back. */
function mockFetch(chunks: string[], init: { status?: number; json?: unknown } = {}) {
  globalThis.fetch = (async () => {
    if (init.json !== undefined) {
      return new Response(JSON.stringify(init.json), { status: init.status ?? 400 });
    }
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

test("generate parses streamed events, even when split across chunks", async () => {
  mockFetch([
    '{"type":"delta","text":"import"}\n{"type":"del',
    'ta","text":" React"}\n',
    '{"type":"done","code":"import React from \'react\';","usage":{"inputTokens":1200,"outputTokens":300,"costUsd":0.006}}\n',
  ]);
  const seen: string[] = [];
  const { code, usage } = await generate({ html: "<p>", provider: "gemini", format: "react" }, "", new AbortController().signal, (t) => seen.push(t));
  assert.equal(code, "import React from 'react';");
  assert.deepEqual(usage, { inputTokens: 1200, outputTokens: 300, costUsd: 0.006 });
  assert.deepEqual(seen, ["import", "import React"]);
});

test("generate surfaces streamed errors and HTTP errors", async () => {
  mockFetch(['{"type":"error","error":"Model overloaded"}\n']);
  await assert.rejects(generate({ provider: "gemini", format: "react" }, "", new AbortController().signal, () => {}), /Model overloaded/);

  mockFetch([], { status: 429, json: { error: "Too many generate requests." } });
  await assert.rejects(
    generate({ provider: "gemini", format: "react" }, "", new AbortController().signal, () => {}),
    (error: unknown) => error instanceof ApiError && error.status === 429 && /Too many/.test(error.message),
  );

  mockFetch(['{"type":"delta","text":"partial"}\n']); // connection closes early
  await assert.rejects(generate({ provider: "gemini", format: "react" }, "", new AbortController().signal, () => {}), /closed before/);
});

test("formatCost shows tiny amounts with enough precision", () => {
  assert.equal(formatCost(0), "$0");
  assert.equal(formatCost(0.0034), "$0.0034");
  assert.equal(formatCost(0.0456), "$0.046");
  assert.equal(formatCost(1.2), "$1.200");
});
