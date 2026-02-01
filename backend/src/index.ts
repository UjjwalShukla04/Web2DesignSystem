import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { scrapeWebsite } from "./scraper.js";
import { generateComponent } from "./generator.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(bodyParser.json({ limit: "50mb" })); // Allow large payloads for HTML

// --- Health Check (Public) ---
app.get("/", (req, res) => {
  res.send("Scraper Backend is Running!");
});

// --- Browser Health Check (Public, for diagnostics) ---
import { chromium } from "playwright";
app.get("/health/browser", async (req, res) => {
  try {
    const browser = await chromium.launch({ 
      headless: true, 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] 
    });
    await browser.close();
    res.send("Browser launch successful!");
  } catch (error: any) {
    res.status(500).send(`Browser launch failed: ${error.message}`);
  }
});

// --- Authentication Middleware ---
app.use((req, res, next) => {
  const adminSecret = process.env.API_SECRET;
  
  // 1. If no secret is set on the server, it's open to the public (or user accepts risk)
  if (!adminSecret) {
    return next();
  }

  // 2. If the user provides their OWN API key, we let them through (they pay for it)
  // Check body for apiKey (if applicable to the route)
  if (req.body && req.body.apiKey && req.body.apiKey.trim() !== "") {
    return next();
  }

  // 3. Otherwise, they must provide the correct x-api-secret header
  const clientSecret = req.headers["x-api-secret"];
  if (clientSecret === adminSecret) {
    return next();
  }

  // 4. Reject
  logError("[AUTH] Unauthorized access attempt", { 
    url: req.url, 
    ip: req.ip 
  });
  res.status(401).json({ 
    error: "Unauthorized. Please provide a valid 'x-api-secret' header or your own 'apiKey' in the request body." 
  });
});

import fs from "fs";
import path from "path";

const logFile = path.join(process.cwd(), "server.log");

function log(message: string) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
  console.log(message);
}

function logError(message: string, error: any) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(
    logFile,
    `[${timestamp}] [ERROR] ${message} ${error?.stack || error}\n`,
  );
  console.error(message, error);
}

app.post("/api/scrape", async (req, res) => {
  try {
    log(`[SCRAPE] Request received for URL: ${req.body.url}`);
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }
    const sections = await scrapeWebsite(url);
    log(`[SCRAPE] Success. Found ${sections.length} sections.`);
    res.json({ sections });
  } catch (error: any) {
    logError("[SCRAPE] Error:", error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    log("[GENERATE] Request received");
    const { html, instructions, provider, apiKey } = req.body;
    if (!html) {
      return res.status(400).json({ error: "HTML content is required" });
    }
    const code = await generateComponent(html, instructions, provider, apiKey);
    log("[GENERATE] Success.");
    res.json({ code });
  } catch (error: any) {
    logError("[GENERATE] Error:", error);
    res.status(500).json({ error: error.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log("SERVER STARTING VERSION 3");
});

server.on("error", (err) => {
  logError("Server failed to start:", err);
});
