import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildSimulationIntegrityModel } from "./simulation-integrity-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const originalCreateServer = http.createServer;

function dataDir() {
  return path.resolve(process.env.DASHBOARD_DATA_DIR || path.join(__dirname, "data"));
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  const rows = [];
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* fail-soft */ }
  }
  return rows;
}

function isAuthorized(req) {
  const password = process.env.DASHBOARD_PASSWORD || "";
  if (!password) return true;
  const authorization = String(req.headers.authorization || "");
  if (!authorization.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0
      && decoded.slice(0, separator) === (process.env.DASHBOARD_USERNAME || "gunhee")
      && decoded.slice(separator + 1) === password;
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function unauthorized(res) {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "www-authenticate": 'Basic realm="Private Stock Dashboard", charset="UTF-8"'
  });
  res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
}

function handle(req, res) {
  if (!isAuthorized(req)) return unauthorized(res);
  const dir = dataDir();
  const records = readJsonl(path.join(dir, "strategy-oos-history.jsonl"));
  const selections = readJsonl(path.join(dir, "strategy-oos-selections.jsonl"));
  const marketStatuses = readJsonl(path.join(dir, "market-status-history.jsonl"));
  return sendJson(res, 200, buildSimulationIntegrityModel({ records, selections, marketStatuses }));
}

async function route(req, res, listener) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/api/simulation-integrity") return listener(req, res);
  if (req.method === "GET") return handle(req, res);
  return sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
}

http.createServer = function patchedCreateServer(...args) {
  const listenerIndex = typeof args[0] === "function" ? 0 : (typeof args[1] === "function" ? 1 : -1);
  if (listenerIndex < 0) return originalCreateServer.apply(this, args);
  const listener = args[listenerIndex];
  args[listenerIndex] = (req, res) => {
    Promise.resolve(route(req, res, listener)).catch((error) => {
      console.error(`[simulation-integrity] ${error?.stack || error}`);
      if (!res.headersSent) sendJson(res, 500, { error: error?.message || "SIMULATION_INTEGRITY_FAILED" });
      else res.destroy(error);
    });
  };
  return originalCreateServer.apply(this, args);
};
