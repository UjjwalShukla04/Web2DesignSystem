// Installs Chromium for Playwright into node_modules (see src/browser-env.ts for why).
// Runs automatically after `npm install` / `npm ci`.
import { execSync } from "node:child_process";

execSync("npx playwright install chromium", {
  stdio: "inherit",
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || "0",
  },
});
