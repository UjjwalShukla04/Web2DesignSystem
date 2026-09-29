import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../src/config.js";

test("development defaults: open API and CORS, with warnings", () => {
  const config = loadConfig({});
  assert.equal(config.isProduction, false);
  assert.equal(config.apiSecret, null);
  assert.equal(config.allowedOrigins, "*");
  assert.equal(config.logFile, "server.log");
  assert.equal(config.port, 4000);
  assert.equal(config.warnings.length, 2);
});

test("production refuses to start without API_SECRET", () => {
  assert.throws(() => loadConfig({ RENDER: "true", ALLOWED_ORIGINS: "https://a.example" }), ConfigError);
  assert.throws(() => loadConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "*" }), ConfigError);
});

test("production can run an open API only when explicitly allowed", () => {
  const config = loadConfig({ RENDER: "true", ALLOW_OPEN_ACCESS: "true", ALLOWED_ORIGINS: "*" });
  assert.equal(config.apiSecret, null);
});

test("production refuses to start without ALLOWED_ORIGINS", () => {
  assert.throws(() => loadConfig({ RENDER: "true", API_SECRET: "s" }), ConfigError);
});

test("production config: origins list, log file off by default", () => {
  const config = loadConfig({
    RENDER: "true",
    API_SECRET: " s3cret ",
    ALLOWED_ORIGINS: "https://a.example, https://b.example",
  });
  assert.equal(config.apiSecret, "s3cret");
  assert.deepEqual(config.allowedOrigins, ["https://a.example", "https://b.example"]);
  assert.equal(config.logFile, null);
  assert.deepEqual(config.warnings, []);
});

test("LOG_FILE=off disables the log file; TRUST_PROXY is numeric", () => {
  const config = loadConfig({ LOG_FILE: "off", TRUST_PROXY: "2" });
  assert.equal(config.logFile, null);
  assert.equal(config.trustProxy, 2);
});
