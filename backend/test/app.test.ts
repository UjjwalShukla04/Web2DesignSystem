import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerConfig } from "../src/config.js";

// No AI key: generation returns its placeholder instead of calling an API.
process.env.GEMINI_API_KEY = "";
const { createApp } = await import("../src/app.js");

const SECRET = "s3cret";
const config: ServerConfig = {
  port: 0,
  apiSecret: SECRET,
  allowedOrigins: ["https://ok.example"],
  trustProxy: 0,
  logFile: null,
  isProduction: false,
  limits: { perUserPerDay: 0, dailyBudgetUsd: 0 },
  warnings: [],
};

let server: Server;
let base: string;
before(async () => {
  server = createApp(config).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const withSecret = { "x-api-secret": SECRET };

test("health check is public", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
});

test("scrape requires the secret, even with an apiKey in the body", async () => {
  assert.equal((await post("/api/scrape", { url: "https://example.com" })).status, 401);
  assert.equal((await post("/api/scrape", { url: "https://example.com", apiKey: "x" })).status, 401);
  assert.equal((await post("/api/scrape", { url: "https://example.com" }, { "x-api-secret": "wrong" })).status, 401);
});

test("providers endpoint is public and reports only which keys exist", async () => {
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  try {
    const res = await fetch(base + "/api/providers");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { gemini: false, openai: true });
    assert.ok(!JSON.stringify(body).includes("sk-test"), "never exposes a key");
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("browser health check requires the secret", async () => {
  assert.equal((await fetch(base + "/health/browser")).status, 401);
});

test("generate accepts the caller's own apiKey instead of the secret", async () => {
  // An invalid provider gives 400 *after* auth, proving auth let the request through.
  const res = await post("/api/generate", { html: "<p>x</p>", provider: "evil", apiKey: "their-key" });
  assert.equal(res.status, 400);
});

test("scrape rejects internal URLs before starting a browser", async () => {
  const res = await post("/api/scrape", { url: "http://169.254.169.254/" }, withSecret);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /internal address/);
});

test("input validation", async () => {
  assert.equal((await post("/api/scrape", { url: 42 }, withSecret)).status, 400);
  assert.equal((await post("/api/scrape", { url: "https://a.example/" + "x".repeat(3000) }, withSecret)).status, 400);
  assert.equal((await post("/api/generate", {}, withSecret)).status, 400);
  assert.equal((await post("/api/generate", { html: "<p>", instructions: "x".repeat(2001) }, withSecret)).status, 400);
  assert.equal((await post("/api/generate", { currentCode: "" }, withSecret)).status, 400);
  assert.equal((await post("/api/generate", { html: "<p>", fonts: "Inter" }, withSecret)).status, 400);
  assert.equal((await post("/api/generate", { html: "<p>", format: "angular" }, withSecret)).status, 400);
  assert.equal((await post("/api/generate", { sections: ["<p>only one</p>"] }, withSecret)).status, 400);
  assert.equal((await post("/api/generate", { sections: Array(9).fill("<p>x</p>") }, withSecret)).status, 400);
  assert.equal((await post("/api/generate", { sections: ["<p>a</p>", 5] }, withSecret)).status, 400);
  assert.equal((await post("/api/scrape", { url: "https://a.example", fresh: "yes" }, withSecret)).status, 400);
});

test("screenshots are validated", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  assert.equal((await post("/api/generate", { html: "<p>x</p>", images: [png] }, withSecret)).status, 200);
  assert.equal((await post("/api/generate", { sections: ["<p>a</p>", "<p>b</p>"], images: [png, null] }, withSecret)).status, 200);
  assert.equal((await post("/api/generate", { html: "<p>x</p>", images: ["https://evil.example/a.png"] }, withSecret)).status, 400);
  assert.equal((await post("/api/generate", { html: "<p>x</p>", images: "not-a-list" }, withSecret)).status, 400);
  assert.equal((await post("/api/generate", { html: "<p>x</p>", images: Array(9).fill(png) }, withSecret)).status, 400);
});

test("the render screenshot is only accepted for refinements", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const code = "export default function C() { return <div />; }";
  assert.equal((await post("/api/generate", { currentCode: code, images: [png], renderImage: png }, withSecret)).status, 200);
  assert.equal((await post("/api/generate", { html: "<p>x</p>", renderImage: png }, withSecret)).status, 400);
});

test("extension captures: upload, then open by id", async () => {
  const capture = {
    url: "https://intranet.example/dashboard",
    sections: [{ id: "section-0", tagName: "header", text: "Hi", html: "<header>Hi</header>", rect: { x: 0, y: 0, width: 1440, height: 120 } }],
    screenshot: null,
    screenshotSize: null,
    fonts: { families: [], css: "" },
  };
  assert.equal((await post("/api/captures", capture)).status, 401);
  assert.equal((await post("/api/captures", { ...capture, sections: [] }, withSecret)).status, 400);
  const created = await post("/api/captures", capture, withSecret);
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal((await fetch(`${base}/api/captures/${id}`)).status, 401);
  const res = await fetch(`${base}/api/captures/${id}`, { headers: withSecret });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.url, capture.url);
  assert.equal(body.sections[0].html, "<header>Hi</header>");
  assert.equal(body.captured, true);
  assert.ok(body.scrapedAt);
  const missing = await fetch(`${base}/api/captures/00000000-0000-0000-0000-000000000000`, { headers: withSecret });
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /expired/);
  // Bigger than the normal 12mb body limit, within the 20mb capture limit.
  const big = { ...capture, sections: Array.from({ length: 40 }, (_, i) => ({ ...capture.sections[0], id: `s${i}`, html: "x".repeat(99_000) })) };
  const screenshot = "data:image/jpeg;base64," + "A".repeat(7_000_000);
  const large = await post("/api/captures", { ...big, screenshot, screenshotSize: { width: 1440, height: 8000 } }, withSecret);
  assert.equal(large.status, 201);
});

test("fidelity requires the secret and validates its input before rendering", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const code = "export default function C() { return <div />; }";
  assert.equal((await post("/api/fidelity", { code, images: [png] })).status, 401);
  assert.equal((await post("/api/fidelity", { code, images: [png], apiKey: "x" })).status, 401);
  assert.equal((await post("/api/fidelity", { code: "", images: [png] }, withSecret)).status, 400);
  assert.equal((await post("/api/fidelity", { code, images: [] }, withSecret)).status, 400);
  assert.equal((await post("/api/fidelity", { code, images: ["https://evil.example/a.png"] }, withSecret)).status, 400);
  assert.equal((await post("/api/fidelity", { code, images: [png], width: 5000 }, withSecret)).status, 400);
  assert.equal((await post("/api/fidelity", { code, images: [png], fontCss: 1 }, withSecret)).status, 400);
  assert.equal((await post("/api/render", { code })).status, 401);
  assert.equal((await post("/api/render", { code: "" }, withSecret)).status, 400);
  assert.equal((await post("/api/render", { code, format: "svelte" }, withSecret)).status, 400);
  assert.equal((await post("/api/render", { code, width: 100 }, withSecret)).status, 400);
  const vue = await post("/api/fidelity", { code, images: [png], format: "vue" }, withSecret);
  assert.equal(vue.status, 400);
  assert.match((await vue.json()).error, /react and html/);
});

test("daily limit for the server's key, not for users' own keys", async () => {
  const limited = createApp({ ...config, limits: { perUserPerDay: 2, dailyBudgetUsd: 0 } }).listen(0);
  await new Promise((resolve) => limited.once("listening", resolve));
  const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
  const gen = (body: object) =>
    fetch(url + "/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", ...withSecret },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await gen({ html: "<p>1</p>" })).status, 200);
    const usage = await (await fetch(url + "/api/usage")).json();
    assert.equal(usage.requests, 1);
    assert.equal(usage.remaining, 1);
    assert.equal((await gen({ html: "<p>2</p>" })).status, 200);
    const blocked = await gen({ html: "<p>3</p>" });
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error, /Daily limit reached: 2 generations per day/);
    // With their own key, a user isn't limited (provider "evil" fails validation after the quota check would have run).
    assert.equal((await gen({ html: "<p>4</p>", apiKey: "their-key", provider: "evil" })).status, 400);
    assert.equal((await (await fetch(url + "/api/usage")).json()).remaining, 0);
  } finally {
    limited.close();
  }
});

test("generate responses include the estimated usage", async () => {
  const res = await post("/api/generate", { html: "<p>x</p>", stream: true }, withSecret);
  const done = (await res.text()).trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual(done.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0 }); // placeholder = free
});

test("generate combines sections into a page, in the requested format", async () => {
  const res = await post("/api/generate", { sections: ["<p>a</p>", "<p>b</p>"], format: "vue" }, withSecret);
  assert.equal(res.status, 200);
  assert.match((await res.json()).code, /<template>/);
});

test("malformed JSON gets a clean 400 without a stack trace", async () => {
  const res = await post("/api/scrape", "{bad", withSecret);
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.ok(!/at .*\.(js|ts):\d+/.test(text), "no stack trace");
  assert.ok(JSON.parse(text).error);
});

test("CORS allows only the configured origins", async () => {
  const ok = await fetch(base + "/", { headers: { origin: "https://ok.example" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://ok.example");
  const evil = await fetch(base + "/", { headers: { origin: "https://evil.example" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
});

test("generate returns JSON, or streams NDJSON events when asked", async () => {
  const plain = await post("/api/generate", { html: "<p>hello</p>" }, withSecret);
  assert.equal(plain.status, 200);
  assert.match((await plain.json()).code, /MockComponent/);

  const streamed = await post("/api/generate", { html: "<p>hello</p>", stream: true }, withSecret);
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get("content-type") ?? "", /ndjson/);
  const events = (await streamed.text()).trim().split("\n").map((line) => JSON.parse(line));
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.match(done.code, /MockComponent/);
});

test("scrape is rate limited per client", async () => {
  // Cheap requests (rejected by URL validation) still count towards the limit.
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) {
    statuses.push((await post("/api/scrape", { url: "ftp://x" }, withSecret)).status);
  }
  assert.ok(statuses.includes(429), `statuses: ${statuses.join(",")}`);
});
