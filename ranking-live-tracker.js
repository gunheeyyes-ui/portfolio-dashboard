import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { rankMarketRowsV2, reboundRankingTier } from "./public/rebound-ranking-v2.js";

export const RANKING_LIVE_SCHEMA = "ranking-v2-live-1";
export const RANKING_LIVE_COST_PCT = 0.23;
export const RANKING_LIVE_HORIZONS = [3, 5, 10];

function finite(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

function numberOrNull(value) {
  return finite(value) ? Number(value) : null;
}

function observationKey(row) {
  return `${row.signalDate}|${row.market}|${row.ticker}`;
}

function ensureParent(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function atomicWrite(filePath, content) {
  ensureParent(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, content, "utf8");
  renameSync(tempPath, filePath);
}

export function readRankingLiveJsonl(filePath) {
  if (!existsSync(filePath)) return { records: [], invalidLines: 0 };
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const records = [];
  let invalidLines = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      invalidLines += 1;
    }
  }
  return { records, invalidLines };
}

function writeRankingLiveJsonl(filePath, records) {
  atomicWrite(filePath, records.length ? `${records.map((row) => JSON.stringify(row)).join("\n")}\n` : "");
}

function latestTradingDate(history) {
  return (history ?? []).map((row) => String(row?.date ?? "")).filter((date) => /^\d{8}$/.test(date)).sort().at(-1) ?? null;
}

export function deriveSignalDate(historyByCode) {
  const counts = new Map();
  for (const history of historyByCode?.values?.() ?? []) {
    const date = latestTradingDate(history);
    if (date) counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0];
  return best ? `${best.slice(0, 4)}-${best.slice(4, 6)}-${best.slice(6, 8)}` : null;
}

function marketRegimes(rowsByMarket) {
  return Object.fromEntries(["KOSPI", "KOSDAQ"].map((market) => {
    const values = (rowsByMarket?.[market] ?? []).map((row) => row.scout?.ret20).filter(finite).map(Number);
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const regime = average === null ? "계산불가" : average >= 3 ? "강세" : average <= -3 ? "약세" : "중립";
    return [market, regime];
  }));
}

function snapshotObservation(row, market, rank, signalDate, recordedAt, regime) {
  const supply = row.supply ?? {};
  const combined = row.combined ?? {};
  return {
    schemaVersion: RANKING_LIVE_SCHEMA,
    signalDate,
    recordedAt,
    market,
    ticker: String(row.code ?? ""),
    name: row.name ?? "",
    reviewRank: rank,
    rankingTier: reboundRankingTier(row),
    currentPrice: numberOrNull(row.price),
    dayReturn: numberOrNull(row.changeRate),
    ret3: numberOrNull(row.changeRate3d),
    leaderScore: numberOrNull(row.leader?.score),
    leaderGrade: row.leader?.grade ?? "계산불가",
    drawdownFromHighPct: numberOrNull(row.scout?.drawdownFromHighPct),
    riskScore: numberOrNull(row.scout?.riskScore),
    stabilizeScore: numberOrNull(row.scout?.stabilizeScore),
    scoutStatus: row.scout?.status ?? "계산불가",
    cafePass: row.confirmation?.cafePass === true,
    minerviniPass: row.confirmation?.minerviniPass === true,
    liquidityScore: numberOrNull(supply.liquidityScore),
    foreignNet: numberOrNull(supply.foreignNetAmount),
    institutionNet: numberOrNull(supply.instNetAmount),
    foreignStreak: numberOrNull(supply.foreignStreak) ?? 0,
    institutionStreak: numberOrNull(supply.instStreak) ?? 0,
    timingScore: numberOrNull(combined.score),
    timingLabel: combined.label ?? "계산불가",
    marketRegime: regime,
    combinedBlocked: combined.blocked === true,
    gateReason: combined.gateReason ?? (combined.blocked ? combined.reason ?? "BLOCK" : "PASS"),
    entryTradingDate: null,
    entryPrice: null,
    outcome3: null,
    outcome5: null,
    outcome10: null
  };
}

export function buildRankingLiveObservations(payload, historyByCode, now = new Date()) {
  if ((payload?.errors?.length ?? 0) > 0 || !(payload?.rows?.KOSPI?.length) || !(payload?.rows?.KOSDAQ?.length)) return [];
  const signalDate = deriveSignalDate(historyByCode);
  if (!signalDate) return [];
  const regimes = marketRegimes(payload?.rows ?? {});
  const recordedAt = now.toISOString();
  const observations = [];
  for (const market of ["KOSPI", "KOSDAQ"]) {
    const ranked = rankMarketRowsV2(payload?.rows?.[market] ?? []);
    ranked.forEach((row, index) => observations.push(snapshotObservation(row, market, index + 1, signalDate, recordedAt, regimes[market])));
  }
  return observations;
}

function normalizedSeries(history) {
  const byDate = new Map();
  for (const row of history ?? []) {
    if (!/^\d{8}$/.test(String(row?.date ?? "")) || !finite(row.close)) continue;
    byDate.set(String(row.date), {
      date: String(row.date),
      open: numberOrNull(row.open),
      high: numberOrNull(row.high),
      low: numberOrNull(row.low),
      close: Number(row.close)
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function compactDate(date) {
  return String(date ?? "").replace(/-/g, "");
}

function seoulDate(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function evaluateObservation(record, history, evaluatedAt = new Date().toISOString(), costPct = RANKING_LIVE_COST_PCT) {
  const series = normalizedSeries(history);
  const signalIndex = series.findIndex((row) => row.date === compactDate(record.signalDate));
  if (signalIndex < 0) return record;
  const entry = series[signalIndex + 1];
  if (!entry?.open) return record;
  let changed = false;
  const next = { ...record };
  if (!next.entryTradingDate || !finite(next.entryPrice)) {
    next.entryTradingDate = entry.date;
    next.entryPrice = entry.open;
    changed = true;
  }
  for (const horizon of RANKING_LIVE_HORIZONS) {
    const field = `outcome${horizon}`;
    if (next[field]) continue;
    const exit = series[signalIndex + 1 + horizon];
    if (!exit?.close) continue;
    const window = series.slice(signalIndex + 1, signalIndex + 2 + horizon);
    const highs = window.map((row) => row.high ?? row.close).filter(finite).map(Number);
    const lows = window.map((row) => row.low ?? row.close).filter(finite).map(Number);
    const grossReturnPct = (exit.close / entry.open - 1) * 100;
    next[field] = {
      targetTradingDate: exit.date,
      evaluatedAt,
      exitPrice: exit.close,
      grossReturnPct,
      netReturnPct: grossReturnPct - costPct,
      returnPct: grossReturnPct - costPct,
      maxFavorablePct: highs.length ? (Math.max(...highs) / entry.open - 1) * 100 : null,
      maxAdversePct: lows.length ? (Math.min(...lows) / entry.open - 1) * 100 : null,
      marketReturnPct: null,
      excessReturnPct: null
    };
    changed = true;
  }
  return changed ? next : record;
}

function attachMarketBenchmarks(records) {
  for (const horizon of RANKING_LIVE_HORIZONS) {
    const field = `outcome${horizon}`;
    const groups = new Map();
    for (const row of records) {
      const outcome = row[field];
      if (!finite(outcome?.netReturnPct)) continue;
      const key = `${row.signalDate}|${row.market}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(Number(outcome.netReturnPct));
    }
    for (const row of records) {
      const outcome = row[field];
      if (!outcome) continue;
      const values = groups.get(`${row.signalDate}|${row.market}`) ?? [];
      const marketReturnPct = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      row[field] = {
        ...outcome,
        marketReturnPct,
        excessReturnPct: finite(marketReturnPct) ? Number(outcome.netReturnPct) - marketReturnPct : null
      };
    }
  }
}

function average(values) {
  const clean = values.filter(finite).map(Number);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function median(values) {
  const clean = values.filter(finite).map(Number).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function metricBlock(rows, horizon) {
  const outcomes = rows.map((row) => row[`outcome${horizon}`]).filter((outcome) => finite(outcome?.netReturnPct));
  const returns = outcomes.map((outcome) => outcome.netReturnPct);
  return {
    n: outcomes.length,
    averageReturnPct: average(returns),
    medianReturnPct: median(returns),
    winRatePct: outcomes.length ? outcomes.filter((outcome) => outcome.netReturnPct > 0).length / outcomes.length * 100 : null,
    averageExcessReturnPct: average(outcomes.map((outcome) => outcome.excessReturnPct)),
    averageMfePct: average(outcomes.map((outcome) => outcome.maxFavorablePct)),
    averageMaePct: average(outcomes.map((outcome) => outcome.maxAdversePct))
  };
}

function groupedMetrics(records, groups) {
  return Object.fromEntries(Object.entries(groups).map(([label, test]) => [label, Object.fromEntries(RANKING_LIVE_HORIZONS.map((horizon) => [horizon, metricBlock(records.filter(test), horizon)]))]));
}

export function buildRankingLiveSummary(records, { market = "ALL", signalDate = null, invalidLines = 0 } = {}) {
  const filtered = records.filter((row) => (market === "ALL" || row.market === market) && (!signalDate || row.signalDate === signalDate));
  const dates = [...new Set(records.map((row) => row.signalDate))].sort().reverse();
  const rankBuckets = {
    "1": (row) => row.reviewRank === 1,
    "2~3": (row) => row.reviewRank >= 2 && row.reviewRank <= 3,
    "4~5": (row) => row.reviewRank >= 4 && row.reviewRank <= 5,
    "6~10": (row) => row.reviewRank >= 6 && row.reviewRank <= 10,
    "11~30": (row) => row.reviewRank >= 11 && row.reviewRank <= 30,
    "31+": (row) => row.reviewRank >= 31
  };
  const cumulative = {
    Top1: (row) => row.reviewRank <= 1,
    Top3: (row) => row.reviewRank <= 3,
    Top5: (row) => row.reviewRank <= 5,
    Top10: (row) => row.reviewRank <= 10
  };
  const tiers = Object.fromEntries([1, 2, 3, 4, 5, 6].map((tier) => [`T${tier}`, (row) => row.rankingTier === tier]));
  const scout = Object.fromEntries(["정찰병 1주", "하락 정지 확인", "1차 매수 검토", "관찰 목록", "추가매수 금지"].map((status) => [status, (row) => row.scoutStatus === status]));
  const strategy = {
    "CAFE O": (row) => row.cafePass,
    "CAFE X": (row) => !row.cafePass,
    "MTT O": (row) => row.minerviniPass,
    "MTT X": (row) => !row.minerviniPass,
    "CAFE+MTT": (row) => row.cafePass && row.minerviniPass,
    "둘 다 없음": (row) => !row.cafePass && !row.minerviniPass
  };
  return {
    schemaVersion: RANKING_LIVE_SCHEMA,
    generatedAt: new Date().toISOString(),
    filter: { market, signalDate },
    startDate: [...dates].sort()[0] ?? null,
    observationTradingDays: dates.length,
    observationCount: filtered.length,
    completedObservationCount: filtered.filter((row) => row.outcome10).length,
    completedAnyCount: filtered.filter((row) => RANKING_LIVE_HORIZONS.some((horizon) => row[`outcome${horizon}`])).length,
    invalidLines,
    dates,
    rankBuckets: groupedMetrics(filtered, rankBuckets),
    cumulativeRanks: groupedMetrics(filtered, cumulative),
    tiers: groupedMetrics(filtered, tiers),
    scoutStatuses: groupedMetrics(filtered, scout),
    strategies: groupedMetrics(filtered, strategy),
    marketRegimes: groupedMetrics(filtered, Object.fromEntries(["강세", "중립", "약세", "계산불가"].map((regime) => [regime, (row) => row.marketRegime === regime]))),
    recent: Object.fromEntries(["KOSPI", "KOSDAQ"].map((itemMarket) => [itemMarket, filtered.filter((row) => row.market === itemMarket).sort((a, b) => b.signalDate.localeCompare(a.signalDate) || a.reviewRank - b.reviewRank).slice(0, 10)]))
  };
}

export function safeTrackerTask(task, onError = () => {}) {
  try {
    return { ok: true, value: task() };
  } catch (error) {
    onError(error);
    return { ok: false, error };
  }
}

export function createRankingLiveTracker({ historyFile, summaryFile, costPct = RANKING_LIVE_COST_PCT, now = () => new Date() }) {
  function read() {
    return readRankingLiveJsonl(historyFile);
  }

  function writeSummary(records, invalidLines = 0) {
    if (!summaryFile) return;
    atomicWrite(summaryFile, `${JSON.stringify(buildRankingLiveSummary(records, { invalidLines }), null, 2)}\n`);
  }

  function recordSnapshot(payload, historyByCode) {
    const loaded = read();
    if (loaded.invalidLines) writeRankingLiveJsonl(historyFile, loaded.records);
    const keys = new Set(loaded.records.map(observationKey));
    const fresh = buildRankingLiveObservations(payload, historyByCode, now()).filter((row) => !keys.has(observationKey(row)));
    if (fresh.length) {
      ensureParent(historyFile);
      appendFileSync(historyFile, `${fresh.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    }
    const records = [...loaded.records, ...fresh];
    writeSummary(records, 0);
    return { added: fresh.length, total: records.length, signalDate: fresh[0]?.signalDate ?? null };
  }

  async function evaluatePending(loadHistory) {
    const loaded = read();
    const currentDate = seoulDate(now());
    const pending = loaded.records.filter((row) => row.signalDate < currentDate && RANKING_LIVE_HORIZONS.some((horizon) => !row[`outcome${horizon}`]));
    if (!pending.length) return { updated: 0, total: loaded.records.length };
    const tickers = [...new Set(pending.map((row) => row.ticker))];
    const histories = new Map();
    for (let index = 0; index < tickers.length; index += 3) {
      const batch = tickers.slice(index, index + 3);
      const resolved = await Promise.all(batch.map(async (ticker) => [ticker, await loadHistory(ticker)]));
      resolved.forEach(([ticker, history]) => histories.set(ticker, history));
    }
    const evaluatedAt = now().toISOString();
    let updated = 0;
    const records = loaded.records.map((row) => {
      if (!pending.includes(row)) return row;
      const next = evaluateObservation(row, histories.get(row.ticker), evaluatedAt, costPct);
      if (next !== row) updated += 1;
      return next;
    });
    attachMarketBenchmarks(records);
    if (updated || loaded.invalidLines) writeRankingLiveJsonl(historyFile, records);
    writeSummary(records, 0);
    return { updated, total: records.length };
  }

  function summary(options = {}) {
    const loaded = read();
    return buildRankingLiveSummary(loaded.records, { ...options, invalidLines: loaded.invalidLines });
  }

  return { read, recordSnapshot, evaluatePending, summary };
}
