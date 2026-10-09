import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildStrategyPaperLab } from "./strategy-paper-lab.js";
import { buildStrategyOosSummary } from "./strategy-oos-tracker.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const previousCreateServer = http.createServer;
const files = ["strategy-oos-history.jsonl", "strategy-oos-selections.jsonl", "market-status-history.jsonl", "strategy-oos-summary.json", "strategy-oos-state.json"];
let cached = null;

function dataRoot() {
  return path.resolve(process.env.DASHBOARD_DATA_DIR || path.join(dirname, "data"));
}

function isAuthorized(req) {
  const password = process.env.DASHBOARD_PASSWORD || "";
  if (!password) return true;
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon >= 0
      && decoded.slice(0, colon) === (process.env.DASHBOARD_USERNAME || "gunhee")
      && decoded.slice(colon + 1) === password;
  } catch {
    return false;
  }
}

function send(res, code, payload) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function readJsonl(filename) {
  if (!existsSync(filename)) return [];
  const records = [];
  for (const line of readFileSync(filename, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* OOS tracker owns malformed lines. */ }
  }
  return records;
}

function readJson(filename, fallback = null) {
  if (!existsSync(filename)) return fallback;
  try { return JSON.parse(readFileSync(filename, "utf8")); } catch { return fallback; }
}

function getModel() {
  const dir = dataRoot();
  const stamps = files.map((f) => {
    const filename = path.join(dir, f);
    if (!existsSync(filename)) return `${f}:missing`;
    const stat = statSync(filename);
    return `${f}:${stat.size}:${stat.mtimeMs}`;
  }).join("|");
  const key = `${dir}|${stamps}`;
  if (cached?.key === key) return cached.model;
  const records = readJsonl(path.join(dir, files[0]));
  const selections = readJsonl(path.join(dir, files[1]));
  const marketStatuses = readJsonl(path.join(dir, files[2]));
  const summary = readJson(path.join(dir, files[3]))
    ?? buildStrategyOosSummary(records, selections, {
      state: readJson(path.join(dir, files[4]), {})
    });
  const model = buildStrategyPaperLab({ records, selections, marketStatuses, summary });
  cached = { key, model };
  return model;
}

function handle(req, res, listener) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/api/strategy-paper-lab") return listener(req, res);
  if (!isAuthorized(req)) {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Basic realm="Private Stock Dashboard"' });
    res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
    return;
  }
  if (req.method !== "GET") return send(res, 405, { error: "METHOD_NOT_ALLOWED" });
  try { return send(res, 200, getModel()); }
  catch (error) {
    console.error(`[strategy-paper-lab] ${error?.stack || error}`);
    return send(res, 500, { error: error?.message || "STRATEGY_PAPER_LAB_FAILED" });
  }
}

http.createServer = function patchedCreateServer(...args) {
  const idx = typeof args[0] === "function" ? 0 : typeof args[1] === "function" ? 1 : -1;
  if (idx < 0) return previousCreateServer.apply(this, args);
  const listener = args[idx];
  args[idx] = (req, res) => {
    Promise.resolve(handle(req, res, listener)).catch((error) => {
      if (!res.headersSent) send(res, 500, { error: error?.message || "STRATEGY_PAPER_LAB_FAILED" });
      else res.destroy(error);
    });
  };
  return previousCreateServer.apply(this, args);
};
