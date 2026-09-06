import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  batchKeyForRequest,
  inputHashForRequest,
  requestLunaReviews,
  sanitizeReviewRequest
} from "./ai-review-service.js";
import { createAiReviewStore } from "./ai-review-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const originalCreateServer = http.createServer;
let store = null;

function envInt(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function config() {
  return {
    enabled: Boolean(process.env.OPENAI_API_KEY) && process.env.AI_REVIEW_ENABLED !== "0",
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.AI_REVIEW_MODEL || "gpt-5.6-luna",
    reasoningEffort: process.env.AI_REVIEW_REASONING_EFFORT || "low",
    maxCandidates: envInt("AI_REVIEW_MAX_CANDIDATES", 5, 1, 5),
    maxDailyBatches: envInt("AI_REVIEW_MAX_DAILY_BATCHES", 3, 1, 12),
    timeoutMs: envInt("AI_REVIEW_TIMEOUT_MS", 60_000, 5_000, 120_000),
    dataDir: path.resolve(process.env.DASHBOARD_DATA_DIR || path.join(__dirname, "data"))
  };
}

function aiStore() {
  const cfg = config();
  if (!store || store.paths.historyFile !== path.join(cfg.dataDir, "ai-review-history.jsonl")) {
    store = createAiReviewStore({ dataDir: cfg.dataDir });
  }
  return store;
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

function unauthorized(res) {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "www-authenticate": 'Basic realm="Private Stock Dashboard", charset="UTF-8"'
  });
  res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("AI_REVIEW_REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function kstStatus(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function isRecordEligible(request, now = new Date()) {
  const kst = kstStatus(now);
  return request.dataMode === "EOD_FULL"
    && request.signalDate === kst.date
    && request.marketDataAsOf === request.signalDate
    && kst.minuteOfDay >= 15 * 60 + 30;
}

async function handleReview(req, res) {
  if (!isAuthorized(req)) return unauthorized(res);
  const cfg = config();
  if (!cfg.enabled) {
    return sendJson(res, 503, {
      error: "AI_REVIEW_DISABLED",
      message: "OPENAI_API_KEY가 설정되지 않았거나 AI_REVIEW_ENABLED=0 입니다.",
      model: cfg.model
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message || "INVALID_JSON" });
  }

  let request;
  try {
    request = sanitizeReviewRequest(body, cfg.maxCandidates);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const batchKey = batchKeyForRequest(request);
  const reviewStore = aiStore();
  const cached = reviewStore.getBatch(batchKey);
  if (cached) {
    const record = reviewStore.recordBatchOnce({ ...cached, recordEligible: isRecordEligible(request) });
    return sendJson(res, 200, { ...cached, cached: true, record });
  }

  if (reviewStore.dailyBatchCount(request.signalDate) >= cfg.maxDailyBatches) {
    return sendJson(res, 429, {
      error: "AI_REVIEW_DAILY_BATCH_LIMIT",
      maxDailyBatches: cfg.maxDailyBatches,
      signalDate: request.signalDate
    });
  }

  try {
    const inputHash = inputHashForRequest(request, cfg.model);
    const result = await requestLunaReviews({
      request,
      apiKey: cfg.apiKey,
      model: cfg.model,
      reasoningEffort: cfg.reasoningEffort,
      timeoutMs: cfg.timeoutMs
    });
    const createdAt = new Date().toISOString();
    const candidateByCode = Object.fromEntries(request.candidates.map((item) => [item.code, item]));
    const batch = {
      schemaVersion: "ai-review-batch-v1",
      batchKey,
      signalDate: request.signalDate,
      marketDataAsOf: request.marketDataAsOf,
      dataMode: request.dataMode,
      createdAt,
      model: result.model,
      inputHash,
      reviews: result.reviews,
      usage: result.usage,
      candidateByCode,
      recordEligible: isRecordEligible(request)
    };
    reviewStore.saveBatch(batchKey, batch);
    const record = reviewStore.recordBatchOnce(batch);
    return sendJson(res, 200, { ...batch, cached: false, record });
  } catch (error) {
    console.error(`[ai-review] ${error?.stack || error}`);
    return sendJson(res, 502, { error: error?.message || "AI_REVIEW_FAILED" });
  }
}

async function handleAiRoute(req, res, listener) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (!url.pathname.startsWith("/api/ai-review")) return listener(req, res);

  if (url.pathname === "/api/ai-review/status" && req.method === "GET") {
    if (!isAuthorized(req)) return unauthorized(res);
    const cfg = config();
    return sendJson(res, 200, {
      enabled: cfg.enabled,
      model: cfg.model,
      reasoningEffort: cfg.reasoningEffort,
      maxCandidates: cfg.maxCandidates,
      maxDailyBatches: cfg.maxDailyBatches,
      oosTracking: true
    });
  }

  if (url.pathname === "/api/ai-review/summary" && req.method === "GET") {
    if (!isAuthorized(req)) return unauthorized(res);
    try {
      return sendJson(res, 200, aiStore().buildSummary());
    } catch (error) {
      return sendJson(res, 500, { error: error?.message || "AI_REVIEW_SUMMARY_FAILED" });
    }
  }

  if (url.pathname === "/api/ai-review" && req.method === "POST") {
    return handleReview(req, res);
  }

  return sendJson(res, 405, { error: "METHOD_NOT_ALLOWED" });
}

http.createServer = function patchedCreateServer(...args) {
  const listenerIndex = typeof args[0] === "function" ? 0 : (typeof args[1] === "function" ? 1 : -1);
  if (listenerIndex < 0) return originalCreateServer.apply(this, args);
  const listener = args[listenerIndex];
  args[listenerIndex] = (req, res) => {
    Promise.resolve(handleAiRoute(req, res, listener)).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: error?.message || "AI_REVIEW_HOOK_FAILED" });
      else res.destroy(error);
    });
  };
  return originalCreateServer.apply(this, args);
};
