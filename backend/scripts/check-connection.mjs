// Checks that a deployed backend is reachable and whether it requires the access code.
// Usage: npm run check:remote -- https://your-backend.onrender.com
const base = (process.argv[2] || "https://scraper-backend-ys3q.onrender.com").replace(/\/+$/, "");
const url = `${base}/api/scrape`;
console.log(`Testing connection to: ${url}`);

try {
  // We expect 401 (if secured) or 400 (if open but missing body).
  // A network error or 404 means something is wrong.
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  console.log("✅ Server Responded!");
  console.log("Status:", res.status, res.statusText);
  console.log("Data:", await res.text());

  if (res.status === 401) {
    console.log("\n--- DIAGNOSIS ---");
    console.log("The backend is SECURE and working.");
    console.log("You must enter the API Access Code in the frontend settings.");
  } else if (res.status === 400) {
    console.log("\n--- DIAGNOSIS ---");
    console.log("The backend is OPEN and working (no secret required).");
  }
} catch (error) {
  console.log("❌ Connection Failed:", error.message);
  console.log("\n--- DIAGNOSIS ---");
  console.log("The backend is NOT reachable. Check Render status.");
}
