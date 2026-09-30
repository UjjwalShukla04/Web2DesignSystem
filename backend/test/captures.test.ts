import { test } from "node:test";
import assert from "node:assert/strict";
import { createCaptureStore, validateCapture } from "../src/captures.js";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const validCapture = () => ({
  url: "https://intranet.example/dashboard",
  sections: [
    { id: "section-0", tagName: "HEADER", text: "Welcome", html: "<header>Welcome</header>", rect: { x: 0, y: 0, width: 1440, height: 120 } },
  ],
  screenshot: PNG,
  screenshotSize: { width: 1440, height: 900 },
  fonts: { families: ["Inter"], css: "@font-face{}" },
});

test("a valid capture is accepted and rebuilt without extra fields", () => {
  const result = validateCapture({ ...validCapture(), extra: "dropped", sections: [{ ...validCapture().sections[0], evil: 1 }] });
  assert.ok("capture" in result);
  assert.equal(result.capture.sections[0]!.tagName, "header");
  assert.ok(!("extra" in result.capture));
  assert.ok(!("evil" in result.capture.sections[0]!));
});

test("invalid captures are rejected with a reason", () => {
  const bad = (patch: object) => validateCapture({ ...validCapture(), ...patch });
  assert.ok("error" in bad({ url: "file:///etc/passwd" }));
  assert.ok("error" in bad({ url: "not a url" }));
  assert.ok("error" in bad({ sections: [] }));
  assert.ok("error" in bad({ sections: Array(41).fill(validCapture().sections[0]) }));
  assert.ok("error" in bad({ sections: [{ ...validCapture().sections[0], tagName: "<script>" }] }));
  assert.ok("error" in bad({ sections: [{ ...validCapture().sections[0], rect: { x: 0, y: 0, width: -1, height: 1 } }] }));
  assert.ok("error" in bad({ sections: [{ ...validCapture().sections[0], html: "x".repeat(100_001) }] }));
  assert.ok("error" in bad({ screenshot: "https://evil.example/a.png" }));
  assert.ok("error" in bad({ screenshotSize: { width: 1440, height: 9000 } }));
  assert.ok("error" in bad({ fonts: { families: "Inter", css: "" } }));
  assert.ok("capture" in bad({ screenshot: null, screenshotSize: null }), "a capture without a screenshot is fine");
  assert.ok("error" in validateCapture(null));
});

test("captures expire, and the oldest are dropped when the store is full", () => {
  let clock = 0;
  const store = createCaptureStore({ ttlMs: 1000, maxEntries: 2, now: () => clock });
  const capture = (validateCapture(validCapture()) as { capture: any }).capture;
  const a = store.put(capture);
  const b = store.put(capture);
  assert.ok(store.get(a) && store.get(b));
  assert.match(a, /^[0-9a-f-]{36}$/);
  const c = store.put(capture);
  assert.equal(store.get(a), null, "oldest dropped");
  assert.ok(store.get(c));
  assert.equal(store.get(c)!.capturedAt, new Date(0).toISOString());
  clock = 1000;
  assert.equal(store.get(b), null, "expired");
  assert.equal(store.get(c), null);
});

test("the store stays under its memory budget", () => {
  const store = createCaptureStore({ maxBytes: 5_000 });
  const capture = (validateCapture({ ...validCapture(), screenshot: null, screenshotSize: null }) as { capture: any }).capture;
  const big = { ...capture, sections: [{ ...capture.sections[0], html: "x".repeat(3_000) }] };
  const first = store.put(big);
  const second = store.put(big);
  assert.equal(store.get(first), null);
  assert.ok(store.get(second));
  assert.equal(store.size, 1);
});
