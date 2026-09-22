import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const originalCreateServer = http.createServer;
const MARKETS = ["KOSPI", "KOSDAQ"];

function dataDir() {
  return path.resolve(process.env.DASHBOARD_DATA_DIR || path.join(__dirname, "data"));
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

function readActionableSelections(limitPerMarket = 120) {
  const filePath = path.join(dataDir(), "strategy-oos-selections.jsonl");
  if (!existsSync(filePath)) return [];
  const rows = [];
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.strategyId !== "ACTIONABLE_ALL" || !MARKETS.includes(row?.market)) continue;
      rows.push({
        signalDate: row.signalDate,
        market: row.market,
        strategyId: "ACTIONABLE_ALL",
        members: (row.members ?? []).map((member) => ({
          code: String(member?.code ?? ""),
          name: member?.name ?? ""
        })).filter((member) => member.code)
      });
    } catch {
      // Fail-soft: malformed lines are owned by the OOS tracker diagnostics.
    }
  }

  return MARKETS.flatMap((market) => rows
    .filter((row) => row.market === market)
    .sort((a, b) => b.signalDate.localeCompare(a.signalDate))
    .slice(0, limitPerMarket));
}

function handle(req, res) {
  if (!isAuthorized(req)) return unauthorized(res);
  const selections = readActionableSelections();
  return sendJson(res, 200, {
    schemaVersion: "entry-transition-history-v1",
    selections
  });
}

async function route(req, res, listener) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/api/entry-transition-history") return listener(req, res);
  if (req.method === "GET") return handle(req, res);
  return sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
}

http.createServer = function patchedCreateServer(...args) {
  const listenerIndex = typeof args[0] === "function" ? 0 : (typeof args[1] === "function" ? 1 : -1);
  if (listenerIndex < 0) return originalCreateServer.apply(this, args);
  const listener = args[listenerIndex];
  args[listenerIndex] = (req, res) => {
    Promise.resolve(route(req, res, listener)).catch((error) => {
      console.error(`[entry-transition] ${error?.stack || error}`);
      if (!res.headersSent) sendJson(res, 500, { error: error?.message || "ENTRY_TRANSITION_HISTORY_FAILED" });
      else res.destroy(error);
    });
  };
  return originalCreateServer.apply(this, args);
};
