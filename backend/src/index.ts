import dotenv from "dotenv";
import { loadConfig, ConfigError } from "./config.js";
import { initLogFile, logError } from "./logger.js";
import { createApp } from "./app.js";
import { checkServerKeys } from "./generator.js";

dotenv.config();

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

initLogFile(config.logFile);
const app = createApp(config);

const server = app.listen(config.port, () => {
  console.log(`Backend server running on http://localhost:${config.port}`);
  for (const warning of config.warnings) console.warn(`WARNING: ${warning}`);

  // Check the AI keys in the background (free "list models" calls), so a broken key
  // is reported now rather than on the first generation.
  checkServerKeys().then((status) => {
    const names = { gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY" } as const;
    for (const provider of Object.keys(status) as (keyof typeof status)[]) {
      if (status[provider] === "valid") console.log(`${names[provider]}: OK`);
      if (status[provider] === "invalid") {
        console.warn(`WARNING: ${names[provider]} was rejected by the provider. Fix it in backend/.env.`);
      }
    }
  });
});

server.on("error", (err) => {
  logError("Server failed to start:", err);
});
