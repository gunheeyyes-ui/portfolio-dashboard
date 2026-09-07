import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildPaperAutoArena } from "./paper-auto-arena.js";

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
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Existing tracker diagnostics own malformed-line accounting. This
      // extension stays fail-soft and simply ignores unreadable rows.
    }
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
    if (separator < 0) return false;
    return decoded.slice(0, separator) === (process.env.DASHBOARD_USERNAME || "gunhee")
      && decoded.slice(separator + 1) === password;
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
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

function handlePaperAuto(req, res) {
  if (!isAuthorized(req)) return unauthorized(res);
  try {
    const dir = dataDir();
    const records = readJsonl(path.join(dir, "strategy-oos-history.jsonl"));
    const selections = readJsonl(path.join(dir, "strategy-oos-selections.jsonl"));
    return sendJson(res, 200, buildPaperAutoArena({ records, selections }));
  } catch (error) {
    console.error(`[paper-auto] ${error?.stack || error}`);
    return sendJson(res, 500, { error: error?.message || "PAPER_AUTO_FAILED" });
  }
}

async function handleExtensionRoute(req, res, listener) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/api/paper-auto") return listener(req, res);
  if (req.method === "GET") return handlePaperAuto(req, res);
  return sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
}

http.createServer = function patchedCreateServer(...args) {
  const listenerIndex = typeof args[0] === "function" ? 0 : (typeof args[1] === "function" ? 1 : -1);
  if (listenerIndex < 0) return originalCreateServer.apply(this, args);
  const listener = args[listenerIndex];
  args[listenerIndex] = (req, res) => {
    Promise.resolve(handleExtensionRoute(req, res, listener)).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: error?.message || "PAPER_AUTO_HOOK_FAILED" });
      else res.destroy(error);
    });
  };
  return originalCreateServer.apply(this, args);
};
