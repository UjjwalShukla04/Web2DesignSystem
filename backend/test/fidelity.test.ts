import "../src/browser-env.js"; // Must come before "playwright".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { measureFidelity, renderCode, renderForAI, RenderError } from "../src/fidelity.js";

// The original "screenshot" is itself a render of this page, so identical code must
// score 100. HTML renders need no network.
const ORIGINAL = `<!doctype html><html><body style="margin:0;font-family:sans-serif">
  <div style="height:120px;background:#5a2d82;color:#fff;padding:24px;font-size:32px">Brand header</div>
  <div style="display:flex;gap:24px;padding:24px">
    <div style="flex:1;height:160px;background:#eee;border-radius:12px"></div>
    <div style="flex:1;height:160px;background:#eee;border-radius:12px"></div>
    <div style="flex:1;height:160px;background:#eee;border-radius:12px"></div>
  </div>
  <p style="padding:0 24px;font-size:18px">Some body text that describes the product in a sentence or two.</p>
</body></html>`;

let browser: Browser;
let context: BrowserContext;
let original: string;
before(async () => {
  browser = await chromium.launch();
  context = await browser.newContext();
  original = await renderCode(context, { code: ORIGINAL, format: "html", fontCss: "" });
});
after(() => browser?.close());

const score = (code: string) =>
  measureFidelity(context, { code, format: "html", fontCss: "", originalImages: [original] });

test("renders only the content's height, not the whole viewport", async () => {
  const page = await context.newPage();
  const size = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  }, original);
  await page.close();
  assert.equal(size.width, 1280);
  assert.ok(size.height > 300 && size.height < 500, `height ${size.height}`);
});

test("identical output scores 100", async () => {
  const result = await score(ORIGINAL);
  assert.equal(result.score, 100);
  assert.match(result.render, /^data:image\/jpeg;base64,/);
});

test("closer output scores higher, and a blank render scores low", async () => {
  const wrongColor = await score(ORIGINAL.replace("#5a2d82", "#1a9e3a"));
  const stacked = await score(ORIGINAL.replace("display:flex;gap:24px", "display:grid;gap:24px"));
  const blank = await score("<!doctype html><html><body></body></html>");
  assert.ok(wrongColor.score < 100 && wrongColor.score >= 80, `wrong color: ${wrongColor.score}`);
  assert.ok(wrongColor.color < 1 && wrongColor.structure > 0.9, "a color change is a color difference");
  assert.ok(stacked.score < wrongColor.score && stacked.score < 75, `stacked cards: ${stacked.score}`);
  assert.ok(blank.score < 40, `blank: ${blank.score}`);
  assert.ok(blank.size < 0.2, "a blank page is far too short");
  assert.ok(blank.heightRatio < 0.2 && stacked.heightRatio > 1.5, `heightRatio says which way: ${blank.heightRatio}, ${stacked.heightRatio}`);
});

test("renders for the AI at a bounded size", async () => {
  const image = await renderForAI(context, { code: ORIGINAL, format: "html", fontCss: "", width: 1280 });
  const page = await context.newPage();
  const size = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  }, image);
  await page.close();
  assert.equal(size.width, 1024, "scaled to 1024px wide");
  assert.ok(size.height > 200 && size.height < 400);
});

test("code that doesn't compile is a RenderError", async () => {
  await assert.rejects(
    renderCode(context, { code: "export default function C() { return <div>; }", format: "react", fontCss: "" }),
    (error: any) => error instanceof RenderError && /compile/.test(error.message),
  );
});

test("renders React with Tailwind and lucide-react (needs internet)", async (t) => {
  const online = await fetch("https://esm.sh/react@19.2.0", { method: "HEAD" }).then((r) => r.ok, () => false);
  if (!online) return t.skip("esm.sh is not reachable");
  const code = `import { Star } from "lucide-react";
export default function Card() {
  return <div className="p-6 bg-indigo-600 text-white text-2xl flex items-center gap-2"><Star /> Hello</div>;
}`;
  const render = await renderCode(context, { code, format: "react", fontCss: "" });
  const page = await context.newPage();
  const pixel = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    return { height: img.naturalHeight, rgb: Array.from(ctx.getImageData(600, 10, 1, 1).data.slice(0, 3)) };
  }, render);
  await page.close();
  assert.ok(pixel.height > 40 && pixel.height < 200, `height ${pixel.height}`);
  // Tailwind's indigo-600 is rgb(79, 70, 229).
  assert.ok(Math.abs(pixel.rgb[0]! - 79) < 20 && Math.abs(pixel.rgb[2]! - 229) < 20, `rgb ${pixel.rgb}`);

  await assert.rejects(
    renderCode(context, { code: "export default function C() { throw new Error('boom'); }", format: "react", fontCss: "" }),
    (error: any) => error instanceof RenderError && /boom/.test(error.message),
  );
});
