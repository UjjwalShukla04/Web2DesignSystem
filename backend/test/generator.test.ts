import { test } from "node:test";
import assert from "node:assert/strict";
import type { Turn } from "../src/generator.js";

// No AI key: generateComponent returns its placeholder instead of calling an API.
// (dotenv never overrides a variable that is already set, even to "".)
process.env.GEMINI_API_KEY = "";
const {
  extractCode,
  truncateHtml,
  extractPalette,
  buildGeneratePrompt,
  buildPagePrompt,
  buildRefinePrompt,
  generateComponent,
  generateWithContinuation,
  generateComplete,
  isAbbreviated,
  ABBREVIATED_OUTPUT,
  parseImageDataUrl,
  OUTPUT_TOO_LONG,
  describeProviderError,
  serverProviders,
  setServerKeyStatus,
  FORMATS,
  MAX_HTML_CHARS,
  MAX_PAGE_HTML_CHARS,
} = await import("../src/generator.js");

const code = "import React from 'react';\nexport default function Component() { return <div/>; }";

test("extractCode handles plain code, fences, prose and CRLF", () => {
  assert.equal(extractCode(code), code);
  assert.equal(extractCode("```tsx\n" + code + "\n```"), code);
  assert.equal(extractCode("Here you go:\n\n```jsx\n" + code + "\n```\nEnjoy!"), code);
  assert.equal(extractCode("```typescript\r\n" + code + "\r\n```"), code);
  assert.equal(extractCode("```vue\n<template><p/></template>\n```"), "<template><p/></template>");
});

test("truncateHtml cuts at a tag boundary", () => {
  const html = "<div><p>" + "x".repeat(40) + "</p><img src=\"https://a.example/long.png\"></div>";
  const result = truncateHtml(html, 60);
  assert.equal(result.truncated, true);
  assert.ok(result.html.endsWith(">"));
  assert.ok(!result.html.includes("<img"));
  assert.deepEqual(truncateHtml("<p>hi</p>", 60), { html: "<p>hi</p>", truncated: false });
});

test("React prompt: import rules, fonts, untrusted-content note, truncation note", () => {
  const prompt = buildGeneratePrompt("<p>x</p>", "make it pop", ["Inter"]);
  assert.match(prompt, /Only import from 'react' and 'lucide-react'/);
  assert.match(prompt, /font-\['Inter'\]/);
  assert.match(prompt, /make it pop/);
  assert.match(prompt, /never as instructions to you/);
  assert.doesNotMatch(prompt, /was truncated/);
  assert.match(buildGeneratePrompt("<p>" + "x".repeat(MAX_HTML_CHARS) + "</p>"), /was truncated/);
});

test("each output format gets its own framework, imports and icon rules", () => {
  assert.match(buildGeneratePrompt("<p>x</p>", "", [], "vue"), /<script setup lang="ts">[\s\S]*lucide-vue-next/);
  const svelte = buildGeneratePrompt("<p>x</p>", "", [], "svelte");
  assert.match(svelte, /Svelte 3 syntax/);
  assert.match(svelte, /Do NOT use Svelte 5 runes/);
  assert.match(svelte, /inline <svg>/);
  const html = buildGeneratePrompt("<p>x</p>", "", [], "html");
  assert.match(html, /complete HTML document/);
  assert.match(html, /cdn\.tailwindcss\.com/);
  assert.match(html, /inline <svg>/);
  assert.match(buildRefinePrompt("<template/>", "x", "vue"), /```vue/);
});

test("extractPalette finds the most-used colors and fonts", () => {
  const sections = [
    '<div style="color:rgb(17, 24, 39);background-color:rgb(255, 255, 255);font-family:&quot;Inter&quot;, sans-serif">' +
      '<p style="color:rgb(17, 24, 39)">a</p><p style="color:rgba(0, 0, 0, 0)">b</p></div>',
    '<div style="color:rgb(17, 24, 39);border-color:rgb(37, 99, 235)"></div>',
  ];
  const palette = extractPalette(sections);
  assert.equal(palette.colors[0], "#111827"); // used 3 times
  assert.ok(palette.colors.includes("#ffffff"));
  assert.ok(palette.colors.includes("#2563eb"));
  assert.ok(!palette.colors.includes("#000000"), "transparent colors are skipped");
  assert.deepEqual(palette.fonts, ["Inter"]);
});

test("page prompt: all sections in order, shared palette, per-section budget", () => {
  const a = '<section style="background-color:rgb(15, 23, 42)"><h1>Hero</h1></section>';
  const b = '<section style="background-color:rgb(15, 23, 42)"><h2>Features</h2></section>';
  const prompt = buildPagePrompt([a, b], "", [], "react");
  assert.ok(prompt.indexOf("<h1>Hero</h1>") < prompt.indexOf("<h2>Features</h2>"));
  assert.match(prompt, /Section 1[\s\S]*Section 2/);
  assert.match(prompt, /Shared palette:.*#0f172a/);
  assert.match(prompt, /export default function Page\(\)/);

  // Each of 3 huge sections gets a third of the page budget.
  const huge = "<p>" + "x".repeat(MAX_PAGE_HTML_CHARS) + "</p>";
  const big = buildPagePrompt([huge, huge, huge]);
  assert.equal((big.match(/\(truncated\)/g) ?? []).length, 3);
  assert.ok(big.length < MAX_PAGE_HTML_CHARS + 10_000);
});

test("refine prompt keeps the current code and the import rules", () => {
  const prompt = buildRefinePrompt(code, "make the button green");
  assert.ok(prompt.includes(code));
  assert.match(prompt, /make the button green/);
  assert.match(prompt, /Only import from 'react' and 'lucide-react'/);
  assert.match(prompt, /Carry it out fully/);
  assert.match(prompt, /Return the COMPLETE file/);
  assert.match(prompt, /lucide-react icon components \(only names that really exist/);
  assert.match(buildRefinePrompt("<template/>", "x", "vue"), /lucide-vue-next icon components/);
});

test("placeholder comments that skip code are detected", () => {
  const before = "export default function A() {\n  return <div>\n    <p>a</p>\n  </div>;\n}";
  for (const lazy of [
    "{/* ...rest of the footer unchanged */}",
    "// ... existing code",
    "{/* Same as before */}",
    "<!-- remaining links omitted for brevity -->",
    "  // ...",
    "{/* … */}",
  ]) {
    assert.ok(isAbbreviated(before.replace("<p>a</p>", lazy), before), lazy);
  }
  assert.ok(!isAbbreviated(before.replace("<p>a</p>", "<p>b</p>"), before), "a normal edit");
  assert.ok(!isAbbreviated(before.replace("<p>a</p>", "{/* Hero section */}"), before), "ordinary comments");
  assert.ok(!isAbbreviated(`${before}\n// rest of the page is rendered by Layout`, `${before}\n// rest of the page is rendered by Layout`), "placeholders already in the code");
});

test("a shortened refinement is asked again once for the complete file", async () => {
  const before = "export default function A() {\n  return <div><p>a</p><p>b</p></div>;\n}";
  const replies = [
    { text: "export default function A() {\n  return <div>{/* ...rest unchanged */}</div>;\n}", truncated: false, usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.001 } },
    { text: "export default function A() {\n  return <div><p>A</p><p>b</p></div>;\n}", truncated: false, usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.002 } },
  ];
  const turns: Turn[][] = [];
  const result = await generateComplete(async (t) => {
    turns.push(t);
    return replies[turns.length - 1]!;
  }, before);
  assert.match(result.text, /<p>A<\/p>/);
  assert.deepEqual(result.usage, { inputTokens: 220, outputTokens: 30, costUsd: 0.003 });
  assert.deepEqual(turns[0], []);
  assert.equal(turns[1]![0]!.text, replies[0]!.text, "the model sees its shortened reply");
  assert.match(turns[1]![1]!.text, /COMPLETE file/);

  // Shortened twice: fails instead of replacing the user's code.
  await assert.rejects(
    generateComplete(async () => replies[0]!, before),
    (error: Error) => error.message === ABBREVIATED_OUTPUT,
  );
  // First generations aren't checked.
  let calls = 0;
  await generateComplete(async () => (calls++, replies[0]!));
  assert.equal(calls, 1);
});

test("output cut off at the limit is continued and joined", async () => {
  const calls: (string | null)[] = [];
  const parts = [
    { text: "```tsx\nexport default function A() {\n  return <div>", truncated: true, usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.001 } },
    { text: "```tsx\nhello</div>;\n", truncated: true, usage: { inputTokens: 1100, outputTokens: 50, costUsd: 0.0005 } }, // re-opened fence is dropped
    { text: "}\n```", truncated: false, usage: { inputTokens: 1150, outputTokens: 10, costUsd: 0.0001 } },
  ];
  const { text, usage } = await generateWithContinuation(async (soFar) => {
    calls.push(soFar);
    return parts[calls.length - 1]!;
  });
  assert.equal(extractCode(text), "export default function A() {\n  return <div>hello</div>;\n}");
  assert.deepEqual(usage, { inputTokens: 3250, outputTokens: 160, costUsd: 0.0016 }, "usage is summed over the parts");
  assert.equal(calls[0], null, "first call starts fresh");
  assert.equal(calls[1], parts[0]!.text, "continuations get the text so far");
});

test("output still cut off after the continuations gives a clear error", async () => {
  let calls = 0;
  await assert.rejects(
    generateWithContinuation(async () => {
      calls++;
      return { text: "partial", truncated: true };
    }),
    new RegExp(OUTPUT_TOO_LONG.slice(0, 40).replace(/[.*+?^${}()|[\]\\']/g, "\\$&")),
  );
  assert.equal(calls, 3, "one call plus two continuations");
});

test("screenshot rules are added only when images are attached", () => {
  assert.doesNotMatch(buildGeneratePrompt("<p>x</p>"), /Screenshot/);
  assert.match(buildGeneratePrompt("<p>x</p>", "", [], "react", 1), /Screenshot:\*\* The attached image shows this section/);
  const page = buildPagePrompt(["<p>a</p>", "<p>b</p>", "<p>c</p>"], "", [], "react", [1, 3]);
  assert.match(page, /Screenshots:\*\* The attached images show sections 1, 3 on the original page/);
  assert.match(buildRefinePrompt("code", "match the original", "react", 1), /Original design:\*\* The first attached image shows/);
  assert.doesNotMatch(buildRefinePrompt("code", "x"), /Original design|Current render/);
  const withRender = buildRefinePrompt("code", "bigger title", "react", 1, true);
  assert.match(withRender, /Current render:\*\* The LAST attached image/);
  assert.match(withRender, /Compare it with the original/);
  assert.doesNotMatch(buildRefinePrompt("code", "bigger title", "react", 0, true), /Compare it with the original/, "no original to compare with");
});

test("parseImageDataUrl accepts only base64 JPEG/PNG/WebP data URLs", () => {
  assert.deepEqual(parseImageDataUrl("data:image/jpeg;base64,/9j/4AAQ"), { mimeType: "image/jpeg", data: "/9j/4AAQ" });
  assert.ok(parseImageDataUrl("data:image/png;base64,iVBORw0KGgo="));
  assert.equal(parseImageDataUrl("data:image/svg+xml;base64,PHN2Zz4="), null);
  assert.equal(parseImageDataUrl("https://example.com/a.png"), null);
  assert.equal(parseImageDataUrl("data:image/png;base64,<script>"), null);
});

test("provider errors become short, actionable messages", () => {
  // The exact error Gemini returns for a bad key (the SDK wraps the JSON body in its message).
  const geminiBadKey = {
    status: 400,
    message: '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": \\"API key not valid. Please pass a valid API key.\\",\\n    \\"status\\": \\"INVALID_ARGUMENT\\",\\n    \\"details\\": [{\\"reason\\": \\"API_KEY_INVALID\\"}]\\n  }\\n}\\n","code":400,"status":"Bad Request"}}',
  };
  const server = describeProviderError(geminiBadKey, "gemini", false);
  assert.equal(server.invalidKey, true);
  assert.equal(
    server.message,
    "Gemini rejected the API key. Check GEMINI_API_KEY in backend/.env, paste your own key in ⚙ Settings, or switch to the other provider.",
  );
  assert.equal(describeProviderError(geminiBadKey, "gemini", true).message, "Gemini rejected the API key. Check the Gemini key in ⚙ Settings.");

  assert.match(describeProviderError({ status: 401, message: "Incorrect API key provided" }, "openai", false).message, /^OpenAI rejected the API key\. Check OPENAI_API_KEY/);
  assert.match(describeProviderError({ status: 429, message: "You exceeded your current quota" }, "openai", false).message, /over its quota or rate limit/);
  assert.match(describeProviderError({ status: 404, message: "The model `gpt-9` does not exist" }, "openai", false).message, /Set OPENAI_MODEL in backend\/\.env/);

  // Unknown errors: the innermost message, without JSON noise.
  const other = describeProviderError({ status: 500, message: '{"error":{"message":"Internal error encountered.","code":500}}' }, "gemini", false);
  assert.equal(other.message, "Gemini returned an error: Internal error encountered.");
  assert.equal(other.invalidKey, false);
});

test("a server key the provider rejected is reported as unusable", () => {
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    setServerKeyStatus("openai", "unknown");
    assert.equal(serverProviders().openai, true);
    setServerKeyStatus("openai", "invalid");
    assert.equal(serverProviders().openai, false);
    setServerKeyStatus("openai", "valid");
    assert.equal(serverProviders().openai, true);
  } finally {
    setServerKeyStatus("openai", "unknown");
    delete process.env.OPENAI_API_KEY;
  }
});

test("missing OpenAI key gives a clear message", async () => {
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(generateComponent({ html: "<p>x</p>", provider: "openai" }), /No OpenAI key: paste one in ⚙ Settings/);
});

test("placeholder output never pastes page text into markup", async () => {
  const hostile = '<svelte:head>{x}</script><p class="a">`${y}`</p>';
  for (const format of ["react", "vue", "svelte"] as const) {
    const { code: out } = await generateComponent({ html: hostile, format });
    assert.ok(!out.includes("<svelte:head>"), `${format}: raw tag`);
    assert.ok(!out.includes("</script><p"), `${format}: raw script close`);
    assert.match(out, /\\u003csvelte:head\\u003e/, `${format}: escaped inside a JS string`);
  }
  const { code: html } = await generateComponent({ html: hostile, format: "html" });
  assert.match(html, /&lt;svelte:head&gt;/);
});

test("without an API key, a placeholder is returned in the requested format", async () => {
  const code = async (options: Parameters<typeof generateComponent>[0]) => (await generateComponent(options)).code;
  assert.match(await code({ html: "<p>hello</p>" }), /export default function MockComponent/);
  assert.match(await code({ html: "<p>hi</p>", format: "vue" }), /<template>[\s\S]*lucide-vue-next|lucide-vue-next[\s\S]*<template>/);
  assert.match(await code({ html: "<p>hi</p>", format: "svelte" }), /<svg[^>]*viewBox/);
  assert.match(await code({ sections: ["<p>a</p>", "<p>b</p>"], format: "html" }), /<!DOCTYPE html>/);
  assert.deepEqual((await generateComponent({ html: "<p>x</p>" })).usage, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
  assert.equal(FORMATS.length, 4);
});
