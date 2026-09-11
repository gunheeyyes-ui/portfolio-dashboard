import path from "node:path";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildMarketStatusFromKisQuote, marketStatusKey } from "./market-integrity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DASHBOARD_DATA_DIR || path.join(__dirname, "data"));
const CACHE_DIR = path.resolve(process.env.DASHBOARD_CACHE_DIR || path.join(__dirname, "backtest-cache"));
const STATUS_FILE = path.join(DATA_DIR, "market-status-history.jsonl");
const RECORD_FILE = path.join(DATA_DIR, "strategy-oos-history.jsonl");
const SELECTION_FILE = path.join(DATA_DIR, "strategy-oos-selections.jsonl");
const TOKEN_FILE = path.join(CACHE_DIR, "kis-token-server.json");
const KIS_BASE_URL = process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443";
const PAPER_SELECTION_IDS = new Set(["ACTIONABLE_ALL", "TIMING_TOP10", "RANKING_V2_TOP10", "LEADER_TOP10", "SCOUT_TOP10", "CAFE", "MTT"]);
let running = false;
let memoryToken = null;

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* fail-soft */ }
  }
  return rows;
}

function kstParts(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short"
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: parts.weekday
  };
}

function phaseFor(signalDate) {
  const now = kstParts();
  if (signalDate === now.date && now.minuteOfDay >= 15 * 60 + 35) return "EOD_PREENTRY";
  if (signalDate < now.date && ["Sat", "Sun"].includes(now.weekday)) return "WEEKEND_PREENTRY";
  if (signalDate < now.date && now.minuteOfDay < 9 * 60) return "PREOPEN";
  return null;
}

function consensusCount(row, field) {
  return Number(row?.frozenConsensus?.[field] ?? 0);
}

function derivedPaperCandidate(row) {
  const f = row?.factors ?? {};
  const core = Number(f.leaderRank ?? 9999) <= 10 && consensusCount(row, "strategyCount") >= 5 && consensusCount(row, "axisCount") >= 3;
  const strong = f.leaderGrade === "A" && Number(f.rs20 ?? -1) >= 80 && consensusCount(row, "axisCount") >= 3;
  const strategy = f.leaderRebound === true || f.deepRecovery === true || f.cafe === true || f.mtt === true || f.flags?.H2 === true || f.flags?.H3 === true;
  return core || strong || strategy;
}

function latestCandidates() {
  const records = readJsonl(RECORD_FILE);
  const signalDate = records.map((row) => row.signalDate).filter(Boolean).sort().at(-1) ?? null;
  if (!signalDate) return { signalDate: null, rows: [] };
  const latest = records.filter((row) => row.signalDate === signalDate);
  const wanted = new Set(latest.filter(derivedPaperCandidate).map((row) => marketStatusKey(row.signalDate, row.market, row.code)));
  for (const selection of readJsonl(SELECTION_FILE)) {
    if (selection.signalDate !== signalDate || !PAPER_SELECTION_IDS.has(selection.strategyId)) continue;
    for (const member of selection.members ?? []) wanted.add(marketStatusKey(signalDate, selection.market, member.code));
  }
  return { signalDate, rows: latest.filter((row) => wanted.has(marketStatusKey(row.signalDate, row.market, row.code))) };
}

function cachedToken() {
  if (memoryToken?.token && Date.now() - memoryToken.at < 45 * 60 * 1000) return memoryToken.token;
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
    const age = Date.now() - new Date(data.cachedAt ?? 0).getTime();
    if (data.access_token && Number.isFinite(age) && age < 45 * 60 * 1000) {
      memoryToken = { token: data.access_token, at: Date.now() - Math.max(0, age) };
      return data.access_token;
    }
  } catch { /* ignore */ }
  return null;
}

async function kisToken() {
  const cached = cachedToken();
  if (cached) return cached;
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  if (!appkey || !appsecret) throw new Error("KIS credentials unavailable");
  const response = await fetch(`${KIS_BASE_URL}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey, appsecret }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(data.msg1 || data.error_description || "KIS token failed");
  memoryToken = { token: data.access_token, at: Date.now() };
  try { writeFileSync(TOKEN_FILE, JSON.stringify({ ...data, cachedAt: new Date().toISOString() }, null, 2), "utf8"); } catch { /* convenience only */ }
  return data.access_token;
}

async function inquirePrice(code) {
  const token = await kisToken();
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  const url = new URL("/uapi/domestic-stock/v1/quotations/inquire-price", KIS_BASE_URL);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", code);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: "FHKST01010100", custtype: "P" },
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json();
  if (!response.ok || (data.rt_cd && data.rt_cd !== "0")) throw new Error(data.msg1 || `KIS quote ${response.status}`);
  return data.output ?? {};
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function collectMarketStatusSnapshots() {
  if (running) return { skipped: "RUNNING" };
  const { signalDate, rows } = latestCandidates();
  const phase = signalDate ? phaseFor(signalDate) : null;
  if (!signalDate || !phase || !rows.length) return { skipped: !signalDate ? "NO_SIGNAL" : !phase ? "NOT_PREENTRY_WINDOW" : "NO_CANDIDATES" };
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) return { skipped: "NO_KIS_CREDENTIALS" };

  running = true;
  try {
    const existing = new Set(readJsonl(STATUS_FILE).map((row) => marketStatusKey(row.signalDate, row.market, row.code)));
    const pending = rows.filter((row) => !existing.has(marketStatusKey(row.signalDate, row.market, row.code)));
    let recorded = 0;
    let failed = 0;
    for (const row of pending) {
      try {
        const output = await inquirePrice(row.code);
        const status = buildMarketStatusFromKisQuote(output, {
          signalDate, phase, market: row.market, code: row.code, name: row.name, checkedAt: new Date().toISOString()
        });
        appendFileSync(STATUS_FILE, `${JSON.stringify(status)}\n`, "utf8");
        recorded += 1;
      } catch (error) {
        failed += 1;
        console.error(`[market-integrity] ${row.code} ${error?.message ?? error}`);
      }
      await sleep(280);
    }
    const result = { signalDate, phase, candidates: rows.length, pending: pending.length, recorded, failed };
    console.log(JSON.stringify({ time: new Date().toISOString(), event: "MARKET_STATUS_SNAPSHOT", ...result }));
    return result;
  } finally {
    running = false;
  }
}

setTimeout(() => collectMarketStatusSnapshots().catch((error) => console.error(`[market-integrity] ${error?.stack ?? error}`)), 30_000);
setInterval(() => collectMarketStatusSnapshots().catch((error) => console.error(`[market-integrity] ${error?.stack ?? error}`)), 30 * 60 * 1000).unref?.();
