import fs from "fs";
import path from "path";

// Everything goes to the console, and is also appended to a log file when one is configured.
let logStream: fs.WriteStream | null = null;

export function initLogFile(file: string | null) {
  logStream?.end();
  logStream = file ? fs.createWriteStream(path.resolve(file), { flags: "a" }) : null;
  logStream?.on("error", (err) => console.error("Log file error:", err));
}

export function log(message: string) {
  const timestamp = new Date().toISOString();
  logStream?.write(`[${timestamp}] ${message}\n`);
  console.log(message);
}

export function logError(message: string, error: any) {
  const timestamp = new Date().toISOString();
  logStream?.write(`[${timestamp}] [ERROR] ${message} ${error?.stack || error}\n`);
  console.error(message, error);
}
