// Reads and validates the server's environment configuration.

import { loadLimits, type Limits } from "./usage.js";

export class ConfigError extends Error {}

export interface ServerConfig {
  port: number;
  /** Access code required by the API, or null if the API is open. */
  apiSecret: string | null;
  /** Allowed CORS origins, or "*" for any origin. */
  allowedOrigins: string[] | "*";
  trustProxy: number;
  /** Log file path, or null to log to the console only. */
  logFile: string | null;
  isProduction: boolean;
  /** Daily AI limits for requests that use the server's keys. */
  limits: Limits;
  warnings: string[];
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): ServerConfig {
  // Render sets RENDER=true on its services.
  const isProduction = env.NODE_ENV === "production" || env.RENDER === "true";
  const warnings: string[] = [];

  // --- Access control ---
  // In production an open API would let anyone spend the server's AI keys and
  // scraper, so it must be an explicit choice.
  const apiSecret = env.API_SECRET?.trim() || null;
  if (!apiSecret) {
    if (isProduction && env.ALLOW_OPEN_ACCESS !== "true") {
      throw new ConfigError(
        "API_SECRET is not set. Set it to an access code, or set ALLOW_OPEN_ACCESS=true to run a public API on purpose.",
      );
    }
    warnings.push("API_SECRET is not set. Anyone can use this server's AI keys and scraper.");
  }

  // --- CORS ---
  // Comma-separated list, e.g. "https://my-app.vercel.app,http://localhost:3000", or "*".
  const originsSetting = env.ALLOWED_ORIGINS?.trim() || "";
  let allowedOrigins: string[] | "*";
  if (originsSetting === "*") {
    allowedOrigins = "*";
  } else if (originsSetting) {
    allowedOrigins = originsSetting.split(",").map((o) => o.trim()).filter(Boolean);
  } else if (isProduction) {
    throw new ConfigError(
      'ALLOWED_ORIGINS is not set. Set it to your frontend URL(s), e.g. "https://my-app.vercel.app", or to "*" to allow any site.',
    );
  } else {
    allowedOrigins = "*";
    warnings.push("ALLOWED_ORIGINS is not set. CORS allows every origin (fine for local development).");
  }

  // --- Logging ---
  // Hosts like Render capture the console and have an ephemeral disk, so the log
  // file is off by default in production.
  const logSetting = env.LOG_FILE ?? (isProduction ? "off" : "server.log");
  const logFile = logSetting === "off" || logSetting === "" ? null : logSetting;

  return {
    port: Number(env.PORT) || 4000,
    apiSecret,
    allowedOrigins,
    // Render (and most hosts) sit behind one reverse proxy; this makes req.ip the
    // real client IP for rate limiting. Set TRUST_PROXY=0 if not behind a proxy.
    trustProxy: Number(env.TRUST_PROXY ?? 1),
    logFile,
    isProduction,
    limits: loadLimits(env),
    warnings,
  };
}
