import "../src/browser-env.js"; // Must come before "playwright".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { extractPage, DESKTOP_VIEWPORT, type ScrapeResult } from "../src/extract.js";

// A page exercising each extraction rule. No network: images point at a <base>
// URL and are never loaded.
const FIXTURE = `<!doctype html>
<html><head>
<base href="https://site.example/">
<style>
  body { margin: 0; font-family: sans-serif; }
  section, header, footer { min-height: 200px; }
  .row { display: flex; flex-direction: row; gap: 24px; }
  @media (max-width: 600px) { .row { flex-direction: column; } }
  .hero { position: relative; }
  .hero-bg { position: absolute; inset: 0; }
  .fancy::before { content: "★"; color: rgb(255, 0, 0); }
</style>
</head><body>
  <header id="top">
    <nav><a href="/pricing">Pricing</a> <a href="/docs">Docs</a> navigation links here</nav>
    <h1>Site header</h1>
  </header>
  <main>
    <section id="dup">
      <!-- a comment that should be removed -->
      <h2 class="fancy">First section</h2>
      <div class="row"><p>Left column text</p><p>Right column text</p></div>
      <img src="/img/photo.png" alt="photo">
      <img data-src="/img/lazy.png" alt="lazy">
      <img srcset="/img/small.png 400w, /img/large.png 1200w" alt="srcset only">
      <svg width="24" height="24"><path d="M0 0L24 24"/></svg>
      <script>window.shouldNotAppear = true;</script>
    </section>
    <section id="dup">
      <h2>Second section with the same id</h2>
      <p>More content in the second section.</p>
      <fancy-card></fancy-card>
    </section>
    <div class="hero" style="height: 300px">
      <div class="hero-bg" aria-hidden="true">decorative background layer text</div>
      <section style="height: 300px"><h2>Hero content</h2><p>The real hero section.</p></section>
    </div>
  </main>
  <footer><p>Footer text</p></footer>
  <script>
    customElements.define("fancy-card", class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).innerHTML =
          "<div style='height:120px'><strong>Shadow DOM content</strong><slot></slot></div>";
      }
    });
  </script>
</body></html>`;

let browser: Browser;
let result: ScrapeResult;

before(async () => {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  // Offline: every network request is answered with an empty response.
  await page.route("**/*", (route) => route.fulfill({ status: 204, body: "" }));
  await page.setContent(FIXTURE);
  result = await extractPage(page);
});
after(() => browser?.close());

const byText = (text: string) => result.sections.find((s) => s.html.includes(text));

test("finds the sections and drops wrappers, nested parts and decorative layers", () => {
  const tags = result.sections.map((s) => s.tagName);
  assert.ok(!tags.includes("main"), "the <main> wrapper around sections is not a section");
  assert.ok(!tags.includes("nav"), "the <nav> inside <header> is not separate");
  assert.ok(byText("Site header"), "header");
  assert.ok(byText("First section"), "first section");
  assert.ok(byText("Second section"), "second section");
  assert.ok(byText("Hero content"), "hero");
  assert.ok(byText("Footer text"), "footer");
  assert.ok(!result.sections.some((s) => s.html.includes("decorative background layer") && !s.html.includes("Hero content")),
    "aria-hidden background layer is not its own section");
});

test("section IDs are unique", () => {
  const ids = result.sections.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(","));
});

test("image and link URLs are absolute, including lazy and srcset-only images", () => {
  const html = byText("First section")!.html;
  assert.match(html, /src="https:\/\/site\.example\/img\/photo\.png"/);
  assert.match(html, /src="https:\/\/site\.example\/img\/lazy\.png"/);
  assert.match(html, /src="https:\/\/site\.example\/img\/large\.png"/);
  assert.doesNotMatch(html, /srcset=/);
  assert.match(byText("Site header")!.html, /href="https:\/\/site\.example\/pricing"/);
});

test("scripts, comments and SVG path data are removed", () => {
  const html = byText("First section")!.html;
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /shouldNotAppear/);
  assert.doesNotMatch(html, /a comment that should be removed/);
  assert.match(html, /<svg[^>]*><\/svg>/);
  assert.doesNotMatch(html, /<path/);
});

test("computed styles are inlined, with phone-width differences", () => {
  const html = byText("First section")!.html;
  assert.match(html, /class="row" style="[^"]*display:flex/);
  assert.match(html, /class="row"[^>]*data-mobile-style="[^"]*flex-direction:column/);
});

test("pseudo-elements and shadow DOM content are captured", () => {
  assert.match(byText("First section")!.html, /data-before="content:&quot;★&quot;/);
  assert.ok(byText("Shadow DOM content"), "open shadow root content is flattened into the copy");
});

test("returns a screenshot and page-coordinate rects", () => {
  assert.match(result.screenshot ?? "", /^data:image\/jpeg;base64,/);
  assert.equal(result.screenshotSize?.width, DESKTOP_VIEWPORT.width);
  const header = byText("Site header")!;
  const footer = byText("Footer text")!;
  assert.ok(footer.rect.y > header.rect.y, "rects are in page order");
});

// Page shapes that used to lose content (seen on aetnastudenthealth.com and linear.app).
const MIXED_WRAPPER_FIXTURE = `<!doctype html><html><head><style>
  body { margin: 0; font-family: sans-serif; }
  .block { padding: 40px; }
</style></head><body>
  <div class="root">
    <header style="height:160px">Site header with navigation links</header>
    <main>
      <div class="grid">
        <div class="hero" style="height:500px"><div class="hero__topsection" style="height:300px">Welcome hero text</div></div>
        <div class="half block" style="width:640px;height:200px;margin:0 auto">Already a member? Log in here</div>
        <div class="block" style="height:350px">The right care makes all the difference</div>
        <div class="block" style="height:500px">Get the mobile app for your health</div>
        <div class="block" style="height:450px">Questions? We are here to help</div>
        <div class="block" style="height:250px">Legal notices and plan details</div>
      </div>
    </main>
    <footer style="height:400px">Footer links and copyright</footer>
  </div>
</body></html>`;

const HIDDEN_HERO_FIXTURE = `<!doctype html><html><head><style>
  body { margin: 0; font-family: sans-serif; }
</style></head><body>
  <div class="page">
    <div class="hero" style="height:700px;position:relative">
      <h1>The product system for teams</h1>
      <div class="app-mock" style="position:relative;height:500px">
        <nav style="position:absolute;left:0;top:0;width:200px;height:480px">Inbox Issues Projects</nav>
        <div style="margin-left:220px;height:480px">Issue detail view with comments</div>
      </div>
    </div>
    <section style="height:900px">Intake and integrations</section>
    <section style="height:900px">Planning and monitoring</section>
    <section style="height:900px">AI and automations</section>
    <section style="height:900px">Build, review and ship</section>
  </div>
</body></html>`;

async function extractFixture(html: string) {
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  await page.route("**/*", (route) => route.fulfill({ status: 204, body: "" }));
  await page.setContent(html);
  const out = await extractPage(page);
  await page.close();
  return out.sections.map((s) => s.text);
}

test("a container holding a few small candidates plus other content keeps all of it", async () => {
  const texts = await extractFixture(MIXED_WRAPPER_FIXTURE);
  for (const expected of [
    "Site header", "Welcome hero text", "Already a member?", "The right care",
    "Get the mobile app", "Questions?", "Legal notices", "Footer links",
  ]) {
    assert.ok(texts.some((t) => t.includes(expected)), `missing "${expected}" in ${JSON.stringify(texts)}`);
  }
  assert.equal(texts.length, 8, JSON.stringify(texts));
});

test("content outside every candidate is recovered, without splitting a hero apart", async () => {
  const texts = await extractFixture(HIDDEN_HERO_FIXTURE);
  const hero = texts.filter((t) => t.includes("The product system") || t.includes("Inbox Issues"));
  assert.equal(hero.length, 1, `hero should be one section: ${JSON.stringify(texts)}`);
  assert.ok(hero[0]!.includes("The product system") && hero[0]!.includes("Inbox Issues"), hero[0]);
  for (const expected of ["Intake", "Planning", "AI and automations", "Build, review"]) {
    assert.ok(texts.some((t) => t.includes(expected)), `missing "${expected}"`);
  }
  assert.equal(texts.length, 5, JSON.stringify(texts));
});
