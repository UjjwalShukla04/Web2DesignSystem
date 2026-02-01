import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { scrapeWebsite } from "./scraper";
import { generateComponent } from "./generator";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(bodyParser.json({ limit: "50mb" })); // Allow large payloads for HTML

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
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    log("[GENERATE] Request received");
    const { html, instructions } = req.body;
    if (!html) {
      return res.status(400).json({ error: "HTML content is required" });
    }
    const code = await generateComponent(html, instructions);
    log("[GENERATE] Success.");
    res.json({ code });
  } catch (error: any) {
    logError("[GENERATE] Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  log("SERVER STARTING VERSION 2");
});
