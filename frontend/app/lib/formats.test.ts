import { test } from "node:test";
import assert from "node:assert/strict";
import { FORMATS, FORMAT_KEYS, downloadName } from "./formats.ts";

test("every format has a preview template, main file and fonts stylesheet", () => {
  assert.deepEqual(FORMAT_KEYS, ["react", "vue", "svelte", "html"]);
  for (const key of FORMAT_KEYS) {
    const config = FORMATS[key];
    assert.ok(config.mainFile.startsWith("/"), key);
    assert.ok(config.fontsFile.endsWith(".css"), key);
    assert.notEqual(config.mainFile, config.fontsFile, key);
  }
});

test("download names match the format and kind", () => {
  assert.equal(downloadName("react", "component"), "Component.tsx");
  assert.equal(downloadName("react", "page"), "Page.tsx");
  assert.equal(downloadName("vue", "component"), "Component.vue");
  assert.equal(downloadName("svelte", "page"), "Page.svelte");
  assert.equal(downloadName("html", "page"), "index.html");
  assert.equal(downloadName("html", "component"), "component.html");
});
