// Keep Playwright's browsers inside node_modules instead of the user cache
// (~/.cache/ms-playwright). Hosts like Render only keep the project directory
// between build and runtime, so a browser installed during the build would
// otherwise be missing when the server starts. scripts/install-browsers.mjs
// installs to the same place. Playwright reads this when it is first imported,
// so this module must be imported before "playwright".
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";
