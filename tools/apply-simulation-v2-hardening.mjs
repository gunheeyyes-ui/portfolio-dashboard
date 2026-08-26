import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(file, search, replacement) {
  const source = readFileSync(file, "utf8");
  const count = source.split(search).length - 1;
  if (count !== 1) throw new Error(`${file}: expected exactly one match, got ${count}: ${search.slice(0, 100)}`);
  writeFileSync(file, source.replace(search, replacement), "utf8");
}

// ---- strategy-oos-tracker.js -------------------------------------------------
replaceOnce(
  "strategy-oos-tracker.js",
  'import path from "node:path";\nimport { rankMarketRowsV2, reboundRankingTier } from "./public/rebound-ranking-v2.js";',
  'import path from "node:path";\nimport { freezeBaseConsensus } from "./public/strategy-consensus.js";\nimport { rankMarketRowsV2, reboundRankingTier } from "./public/rebound-ranking-v2.js";'
);

replaceOnce(
  "strategy-oos-tracker.js",
`export function buildUniverseRecords({ byMarket }, { signalDate, recordedAt }) {
  const records = [];
  for (const market of MARKETS) {
    for (const feature of byMarket[market] ?? []) {
      const { code, name, market: featureMarket, signalPrice, baseValid, ...factors } = feature;
      records.push({
        schemaVersion: STRATEGY_OOS_SCHEMA,
        signalDate,
        recordedAt,
        market: featureMarket,
        code,
        name,
        signalPrice,
        factors,
        entryDate: null,
        entryOpen: null,
        outcomes: {},
        live: null,
        status: "PENDING"
      });
    }
  }
  return records;
}`,
`export function buildUniverseRecords({ byMarket }, { signalDate, recordedAt, universeMeta = null }) {
  const records = [];
  for (const market of MARKETS) {
    for (const feature of byMarket[market] ?? []) {
      const { code, name, market: featureMarket, signalPrice, baseValid, ...factors } = feature;
      records.push({
        schemaVersion: STRATEGY_OOS_SCHEMA,
        signalDate,
        recordedAt,
        market: featureMarket,
        code,
        name,
        signalPrice,
        factors,
        frozenConsensus: freezeBaseConsensus(factors),
        universeMeta,
        entryDate: null,
        entryOpen: null,
        entryGapPct: null,
        entryDayOutcome: null,
        outcomes: {},
        live: null,
        status: "PENDING"
      });
    }
  }
  return records;
}`
);

replaceOnce(
  "strategy-oos-tracker.js",
`  let changed = false;
  const next = { ...record, outcomes: { ...(record.outcomes ?? {}) } };
  if (!next.entryDate || !finite(next.entryOpen)) {
    next.entryDate = entry.date;
    next.entryOpen = entry.open;
    changed = true;
  }

  for (const horizon of horizons) {`,
`  let changed = false;
  const next = { ...record, outcomes: { ...(record.outcomes ?? {}) } };
  if (!next.frozenConsensus && next.factors) {
    next.frozenConsensus = freezeBaseConsensus(next.factors);
    changed = true;
  }
  if (!next.entryDate || !finite(next.entryOpen)) {
    next.entryDate = entry.date;
    next.entryOpen = entry.open;
    changed = true;
  }
  if (!finite(next.entryGapPct) && finite(next.signalPrice) && Number(next.signalPrice) > 0) {
    next.entryGapPct = (entry.open / Number(next.signalPrice) - 1) * 100;
    changed = true;
  }
  if (!next.entryDayOutcome && finite(entry.close)) {
    const grossReturnPct = (entry.close / entry.open - 1) * 100;
    const high = finite(entry.high) ? Number(entry.high) : Number(entry.close);
    const low = finite(entry.low) ? Number(entry.low) : Number(entry.close);
    next.entryDayOutcome = {
      targetTradingDate: entry.date,
      evaluatedAt,
      exitPrice: entry.close,
      grossReturnPct,
      netReturnPct: grossReturnPct - costPct,
      returnPct: grossReturnPct - costPct,
      mfePct: (high / entry.open - 1) * 100,
      maePct: (low / entry.open - 1) * 100,
      benchmarkReturnPct: null,
      excessReturnPct: null
    };
    changed = true;
  }

  for (const horizon of horizons) {`
);

replaceOnce(
  "strategy-oos-tracker.js",
`    const universeRecords = buildUniverseRecords(features, { signalDate, recordedAt });
    const selections = buildSelections(features, { signalDate, recordedAt });`,
`    const baseLimit = Math.max(1, Number(payload?.limit ?? 100));
    const volumeExtra = Math.min(30, baseLimit);
    const universeMeta = {
      version: \`screener-v1-mcap\${baseLimit}-vol\${volumeExtra}\`,
      baseLimit,
      volumeExtra,
      marketCounts: Object.fromEntries(MARKETS.map((market) => [market, (features.byMarket[market] ?? []).length]))
    };
    const universeRecords = buildUniverseRecords(features, { signalDate, recordedAt, universeMeta });
    const selections = buildSelections(features, { signalDate, recordedAt });`
);

replaceOnce(
  "strategy-oos-tracker.js",
`          droppedRows: features.diagnostics,
          kisErrors: errors.length`,
`          droppedRows: features.diagnostics,
          kisErrors: errors.length,
          universeMeta`
);

replaceOnce(
  "strategy-oos-tracker.js",
`  async function evaluatePending(loadHistory) {
    const loaded = readAll();
    if (!loaded.records.length) return { updated: 0, total: 0 };
    const today = seoulParts(now()).date;
    const pending = loaded.records.filter((row) => row.status !== "COMPLETE" && row.signalDate < today);
    if (!pending.length) return { updated: 0, total: loaded.records.length };
    const pendingSet = new Set(pending);
    const codes = [...new Set(pending.map((row) => row.code))];
    const histories = new Map();
    for (let index = 0; index < codes.length; index += 3) {
      const batch = codes.slice(index, index + 3);
      const resolved = await Promise.all(batch.map(async (code) => [code, await loadHistory(code)]));
      resolved.forEach(([code, history]) => histories.set(code, history));
    }
    const evaluatedAt = now().toISOString();
    let updated = 0;
    const records = loaded.records.map((row) => {
      if (!pendingSet.has(row)) return row;
      const next = evaluateUniverseRecord(row, histories.get(row.code), { evaluatedAt, costPct, horizons });
      if (next !== row) updated += 1;
      return next;
    });
    attachBenchmarks(records, horizons);
    if (updated || loaded.invalidLines) writeJsonl(historyFile, records);
    const state = { ...readState(), lastEvaluatedAt: evaluatedAt };
    writeState(state);
    writeSummary(records, loaded.selections, 0, state);
    return { updated, total: records.length };
  }`,
`  async function evaluatePending(loadHistory) {
    const loaded = readAll();
    if (!loaded.records.length) return { updated: 0, total: 0 };
    const today = seoulParts(now()).date;
    const historyNeeded = loaded.records.filter((row) => row.signalDate < today && (
      row.status !== "COMPLETE"
      || !row.entryDayOutcome
      || !finite(row.entryGapPct)
      || !row.entryDate
      || !finite(row.entryOpen)
    ));
    const localUpgradeNeeded = loaded.records.some((row) => !row.frozenConsensus && row.factors);
    if (!historyNeeded.length && !localUpgradeNeeded) return { updated: 0, total: loaded.records.length };
    const historySet = new Set(historyNeeded);
    const codes = [...new Set(historyNeeded.map((row) => row.code))];
    const histories = new Map();
    for (let index = 0; index < codes.length; index += 3) {
      const batch = codes.slice(index, index + 3);
      const resolved = await Promise.all(batch.map(async (code) => [code, await loadHistory(code)]));
      resolved.forEach(([code, history]) => histories.set(code, history));
    }
    const evaluatedAt = now().toISOString();
    let updated = 0;
    const records = loaded.records.map((row) => {
      let next = row;
      if (!next.frozenConsensus && next.factors) next = { ...next, frozenConsensus: freezeBaseConsensus(next.factors) };
      if (historySet.has(row)) next = evaluateUniverseRecord(next, histories.get(row.code), { evaluatedAt, costPct, horizons });
      if (next !== row) updated += 1;
      return next;
    });
    attachBenchmarks(records, horizons);
    if (updated || loaded.invalidLines) writeJsonl(historyFile, records);
    const state = { ...readState(), lastEvaluatedAt: evaluatedAt };
    writeState(state);
    writeSummary(records, loaded.selections, 0, state);
    return { updated, total: records.length };
  }`
);

// ---- server.mjs --------------------------------------------------------------
replaceOnce(
  "server.mjs",
  'import { createStockEasyCache } from "./stockeasy.js";\nimport {',
  'import { createStockEasyCache } from "./stockeasy.js";\nimport { createMarketIndexTracker, MARKET_INDEX_CODES } from "./market-index-tracker.js";\nimport { buildSimulationV2ServerModel } from "./simulation-v2-service.js";\nimport {'
);

replaceOnce(
  "server.mjs",
`const strategyOosTracker = createStrategyOosTracker({
  historyFile: STRATEGY_OOS_HISTORY_FILE,
  selectionFile: STRATEGY_OOS_SELECTION_FILE,
  summaryFile: STRATEGY_OOS_SUMMARY_FILE,
  stateFile: STRATEGY_OOS_STATE_FILE
});
// Supplemental, display-only external-strategy badges. Fail-soft: a`,
`const strategyOosTracker = createStrategyOosTracker({
  historyFile: STRATEGY_OOS_HISTORY_FILE,
  selectionFile: STRATEGY_OOS_SELECTION_FILE,
  summaryFile: STRATEGY_OOS_SUMMARY_FILE,
  stateFile: STRATEGY_OOS_STATE_FILE
});
const MARKET_INDEX_HISTORY_FILE = path.join(DASHBOARD_DATA_DIR, "market-index-history.json");
const marketIndexTracker = createMarketIndexTracker({ file: MARKET_INDEX_HISTORY_FILE });
let marketIndexMaintenanceRunning = false;
// Supplemental, display-only external-strategy badges. Fail-soft: a`
);

replaceOnce(
  "server.mjs",
`  if (record && payload) {
    const outcome = safeStrategyTask(() => strategyOosTracker.recordSnapshot(payload, historyByCode), strategyTrackerError);
    if (outcome.ok) {
      structuredLog("STRATEGY_OOS_SNAPSHOT", {
        recorded: outcome.value.recorded === true,
        reason: outcome.value.reason,
        signalDate: outcome.value.signalDate,
        records: outcome.value.addedRecords,
        selections: outcome.value.addedSelections
      });
    }
  }
  if (strategyMaintenanceRunning || !process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) return;`,
`  if (record && payload) {
    const outcome = safeStrategyTask(() => strategyOosTracker.recordSnapshot(payload, historyByCode), strategyTrackerError);
    if (outcome.ok) {
      structuredLog("STRATEGY_OOS_SNAPSHOT", {
        recorded: outcome.value.recorded === true,
        reason: outcome.value.reason,
        signalDate: outcome.value.signalDate,
        records: outcome.value.addedRecords,
        selections: outcome.value.addedSelections
      });
    }
    scheduleMarketIndexMaintenance({ force: true });
  }
  if (strategyMaintenanceRunning || !process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) return;`
);

replaceOnce(
  "server.mjs",
`async function fetchHistory(code, force = false) {
  const cached = force ? null : cacheGet(\`history:\${code}\`, 1000 * 60 * 30);
  if (cached) return cached;
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 160);
  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: yyyymmdd(start),
      FID_INPUT_DATE_2: yyyymmdd(end),
      FID_PERIOD_DIV_CODE: "D",
      FID_ORG_ADJ_PRC: "0"
    },
    "FHKST03010100"
  );
  const rows = (data.output2 ?? []).map((row) => ({
    date: row.stck_bsop_date,
    close: toNumber(row.stck_clpr),
    open: toNumber(row.stck_oprc),
    high: toNumber(row.stck_hgpr),
    low: toNumber(row.stck_lwpr),
    volume: toNumber(row.acml_vol)
  })).filter((row) => row.date && Number.isFinite(row.close)).reverse();
  return cacheSet(\`history:\${code}\`, rows);
}

function buildBacktestPriceFileIndex() {`,
`async function fetchHistory(code, force = false) {
  const cached = force ? null : cacheGet(\`history:\${code}\`, 1000 * 60 * 30);
  if (cached) return cached;
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 160);
  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: yyyymmdd(start),
      FID_INPUT_DATE_2: yyyymmdd(end),
      FID_PERIOD_DIV_CODE: "D",
      FID_ORG_ADJ_PRC: "0"
    },
    "FHKST03010100"
  );
  const rows = (data.output2 ?? []).map((row) => ({
    date: row.stck_bsop_date,
    close: toNumber(row.stck_clpr),
    open: toNumber(row.stck_oprc),
    high: toNumber(row.stck_hgpr),
    low: toNumber(row.stck_lwpr),
    volume: toNumber(row.acml_vol)
  })).filter((row) => row.date && Number.isFinite(row.close)).reverse();
  return cacheSet(\`history:\${code}\`, rows);
}

async function fetchMarketIndexHistory(market, force = false) {
  const code = MARKET_INDEX_CODES[market];
  if (!code) return [];
  const cacheKey = \`market-index-history:\${market}\`;
  const cached = force ? null : cacheGet(cacheKey, 1000 * 60 * 60 * 6);
  if (cached) return cached;
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 365 * 5);
  const startDate = yyyymmdd(start);
  let cursorEnd = yyyymmdd(end);
  const byDate = new Map();
  for (let page = 0; page < 10; page += 1) {
    const data = await kisGet(
      "/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice",
      {
        FID_COND_MRKT_DIV_CODE: "U",
        FID_INPUT_ISCD: code,
        FID_INPUT_DATE_1: startDate,
        FID_INPUT_DATE_2: cursorEnd,
        FID_PERIOD_DIV_CODE: "D"
      },
      "FHKUP03500100"
    );
    const chunk = data.output2 ?? [];
    if (!chunk.length) break;
    for (const row of chunk) {
      const date = String(row.stck_bsop_date ?? "");
      if (!/^\\d{8}$/.test(date)) continue;
      const close = toNumber(row.bstp_nmix_prpr);
      if (!Number.isFinite(close)) continue;
      byDate.set(date, {
        date,
        open: toNumber(row.bstp_nmix_oprc),
        high: toNumber(row.bstp_nmix_hgpr),
        low: toNumber(row.bstp_nmix_lwpr),
        close,
        volume: toNumber(row.acml_vol)
      });
    }
    const oldest = chunk.at(-1)?.stck_bsop_date;
    if (!oldest || oldest <= startDate || chunk.length < 100) break;
    const parsed = parseYmd(oldest);
    if (!parsed) break;
    cursorEnd = yyyymmdd(addDays(parsed, -1));
  }
  return cacheSet(cacheKey, [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)));
}

function scheduleMarketIndexMaintenance({ force = false } = {}) {
  if (marketIndexMaintenanceRunning || !process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) return;
  marketIndexMaintenanceRunning = true;
  setTimeout(async () => {
    try {
      const KOSPI = await withRetry(() => fetchMarketIndexHistory("KOSPI", force), 2);
      const KOSDAQ = await withRetry(() => fetchMarketIndexHistory("KOSDAQ", force), 2);
      const merged = marketIndexTracker.mergeMany({ KOSPI, KOSDAQ });
      structuredLog("MARKET_INDEX_UPDATED", {
        kospi: merged.markets.KOSPI.length,
        kosdaq: merged.markets.KOSDAQ.length,
        updatedAt: merged.updatedAt
      });
    } catch (error) {
      structuredLog("MARKET_INDEX_UPDATE_FAILED", { message: error?.message ?? String(error) });
    } finally {
      marketIndexMaintenanceRunning = false;
    }
  }, 0);
}

function buildBacktestPriceFileIndex() {`
);

replaceOnce(
  "server.mjs",
  '  const marketScreener = await buildMarketScreener(100, true, "ALL");',
  '  const screenerLimit = Math.min(150, Math.max(60, Number(process.env.CLOUD_SCREENER_LIMIT || 100)));\n  const marketScreener = await buildMarketScreener(screenerLimit, true, "ALL");'
);

replaceOnce(
  "server.mjs",
`    if (url.pathname === "/api/simulation") {`,
`    if (url.pathname === "/api/simulation-v2") {
      if (process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET) scheduleMarketIndexMaintenance();
      const loaded = strategyOosTracker.readAll();
      const state = strategyOosTracker.readState();
      const cohort = String(url.searchParams.get("cohort") || "ALL");
      const regime = String(url.searchParams.get("regime") || "ALL");
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)));
      const initialCapital = Math.max(1_000_000, Number(url.searchParams.get("capital") || 100_000_000));
      const maxPositions = Math.min(50, Math.max(1, Number(url.searchParams.get("maxPositions") || 10)));
      json(res, 200, buildSimulationV2ServerModel({
        records: loaded.records,
        selections: loaded.selections,
        invalidLines: loaded.invalidLines,
        state,
        indexData: marketIndexTracker.read(),
        cohort,
        regime,
        offset,
        limit,
        initialCapital,
        maxPositions
      }));
      return;
    }
    if (url.pathname === "/api/simulation") {`
);

replaceOnce(
  "server.mjs",
`  if (existsSync(STRATEGY_OOS_HISTORY_FILE)) scheduleStrategyOosMaintenance();
  // Fire-and-forget: never awaited, never blocks server startup or any request.`,
`  if (existsSync(STRATEGY_OOS_HISTORY_FILE)) scheduleStrategyOosMaintenance();
  scheduleMarketIndexMaintenance();
  // Fire-and-forget: never awaited, never blocks server startup or any request.`
);

// Small wording updates; the richer panels are injected by simulator-v2.js.
replaceOnce(
  "public/simulator.html",
  "장마감 OOS 스냅샷을 그대로 사용합니다. ✅ 실제진입 · 🔥 핵심후보 · ⭐ 강한후보를 동시에 추적하고, 신호일 종가가 아니라 다음 거래일 시가로 진입해 1·3·5·10·20 거래일 순수익과 MFE/MAE를 비교합니다.",
  "장마감 OOS 스냅샷 전체 이력을 사용합니다. ✅ 실제진입 · 🔥 핵심후보 · ⭐ 강한후보를 동시에 추적하고, 다음 거래일 시가 진입 후 0D·1·3·5·10·20 거래일 순수익, MFE/MAE, 지수대비 초과수익, 비용 스트레스와 실제운용 포트폴리오까지 비교합니다."
);

console.log("Simulation V2 hardening patches applied");
