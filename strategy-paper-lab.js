// Independent forward-only paper portfolios for EVERY frozen OOS strategy.
// Does not change the registry, OOS snapshots, old Shadow Auto or real orders.
import { enabledStrategies, STRATEGY_OOS_COST_PCT } from "./strategy-oos-registry.js";
import { PAPER_AUTO_ARENA_POLICY } from "./paper-auto-arena.js";
import { PAPER_AUTO_POLICY, buildPaperAutoModel } from "./paper-auto-service.js";
import { buildMarketStatusMap, isEntryBlocked, classifyOutcomeIntegrity, marketStatusKey } from "./market-integrity.js";

export const STRATEGY_PAPER_LAB_START_DATE = "2026-10-12";
export const STRATEGY_PAPER_HOLDS = Object.freeze([3, 5, 10, 20]);
export const STRATEGY_PAPER_MIN_COHORTS = 20;

const finite = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const rowKey = (date, market, code) => `${date}|${market}|${code}`;
const round = (x) => Math.round(x * 1000) / 1000;

function oosNumbers(strategy) {
  const block = strategy?.horizons?.["10"]?.cohorts ?? {};
  return {
    n: Number(block.n || 0),
    netPct: finite(block.avgReturnPct) ? Number(block.avgReturnPct) : null,
    excessPct: finite(block.avgExcessReturnPct) ? Number(block.avgExcessReturnPct) : null,
    winRatePct: finite(block.winRatePct) ? Number(block.winRatePct) : null
  };
}

function similarity(a, b) {
  if (!a?.size || !b?.size) return 0;
  let shared = 0;
  for (const key of a) if (b.has(key)) shared++;
  return shared / (a.size + b.size - shared);
}

function comparableTenDayByStrategy(records, selections, marketStatuses) {
  const index = new Map(records.map((row) => [rowKey(row.signalDate, row.market, row.code), row]));
  const statuses = buildMarketStatusMap(marketStatuses);
  const cohorts = new Map();
  const excluded = new Map();
  for (const selection of selections) {
    const returns = [];
    const excess = [];
    for (const member of selection.members ?? []) {
      const record = index.get(rowKey(selection.signalDate, selection.market, member.code));
      const outcome = record?.outcomes?.["10"];
      if (!finite(outcome?.netReturnPct) || !finite(outcome?.excessReturnPct)) continue;
      if (!classifyOutcomeIntegrity(record, 10, statuses).comparable) {
        excluded.set(selection.strategyId, (excluded.get(selection.strategyId) ?? 0) + 1);
        continue;
      }
      returns.push(Number(outcome.netReturnPct));
      excess.push(Number(outcome.excessReturnPct));
    }
    if (!returns.length) continue;
    if (!cohorts.has(selection.strategyId)) cohorts.set(selection.strategyId, []);
    cohorts.get(selection.strategyId).push({
      net: returns.reduce((a, b) => a + b, 0) / returns.length,
      excess: excess.reduce((a, b) => a + b, 0) / excess.length
    });
  }
  const result = new Map();
  for (const [id, values] of cohorts) {
    result.set(id, {
      n: values.length,
      netPct: round(values.reduce((sum, x) => sum + x.net, 0) / values.length),
      excessPct: round(values.reduce((sum, x) => sum + x.excess, 0) / values.length),
      winRatePct: round(100 * values.filter((x) => x.net > 0).length / values.length),
      quarantinedTrades: excluded.get(id) ?? 0,
      integrityFiltered: true
    });
  }
  return result;
}

export function rankStrategyPaperCandidates({ summary, selections = [], records = null, marketStatuses = [], registry = enabledStrategies(), maxShortlist = 8 } = {}) {
  const byId = new Map((summary?.markets?.ALL ?? []).map((s) => [s.id, s]));
  const comparable = records?.length ? comparableTenDayByStrategy(records, selections, marketStatuses) : new Map();
  const dates = [...new Set(selections.map((s) => s.signalDate))].sort();
  const recentDates = new Set(dates.slice(-5));
  const recentByStrategy = new Map();
  for (const s of selections) {
    if (!recentDates.has(s.signalDate)) continue;
    if (!recentByStrategy.has(s.strategyId)) recentByStrategy.set(s.strategyId, new Set());
    for (const m of s.members ?? []) recentByStrategy.get(s.strategyId).add(rowKey(s.signalDate, s.market, m.code));
  }

  const candidates = registry.map((strategy) => {
    const rawOos = oosNumbers(byId.get(strategy.id));
    const oos = records?.length ? (comparable.get(strategy.id) ?? { n: 0, netPct: null, excessPct: null, winRatePct: null, quarantinedTrades: 0, integrityFiltered: true }) : rawOos;
    const control = strategy.id === "FLAG_C" || strategy.id === "FLAG_I";
    const qualified = !control && oos.n >= STRATEGY_PAPER_MIN_COHORTS && oos.netPct > 0 && oos.excessPct > 0;
    return {
      id: strategy.id,
      name: strategy.displayName,
      group: strategy.group,
      oos,
      rawOos,
      qualified,
      reason: control ? "CONTROL_GROUP" : oos.n < STRATEGY_PAPER_MIN_COHORTS
        ? "SAMPLE_TOO_SMALL" : oos.netPct <= 0 || oos.excessPct <= 0 ? "NO_POSITIVE_EXCESS" : "EARLY_POSITIVE"
    };
  }).sort((a, b) => Number(b.qualified) - Number(a.qualified)
    || (b.oos.excessPct ?? -Infinity) - (a.oos.excessPct ?? -Infinity)
    || b.oos.n - a.oos.n
    || a.id.localeCompare(b.id));

  const shortlisted = [];
  for (const item of candidates) {
    if (!item.qualified || shortlisted.length >= maxShortlist) continue;
    // OOS strategies with almost identical frozen selections do not count
    // as independent discoveries, though both keep paper accounts.
    if (shortlisted.some((selected) =>
      similarity(recentByStrategy.get(item.id), recentByStrategy.get(selected.id)) >= 0.85)) {
      item.reason = "NEAR_DUPLICATE_OF_SELECTED";
      continue;
    }
    shortlisted.push(item);
  }
  return { candidates, shortlistedIds: shortlisted.map((s) => s.id), eligibleCount: candidates.filter((x) => x.qualified).length };
}

function policyFor(strategyId, hold, startSignalDate) {
  return {
    ...PAPER_AUTO_POLICY,
    id: `strategy-paper-lab-${strategyId}-${hold}d-${startSignalDate}`,
    label: `${strategyId} / ${hold}D`,
    sourceStrategyId: `LAB_${strategyId}`,
    startSignalDate,
    initialCapital: PAPER_AUTO_ARENA_POLICY.initialCapitalPerAccount,
    positionBudget: PAPER_AUTO_ARENA_POLICY.positionBudget,
    maxPositions: PAPER_AUTO_ARENA_POLICY.maxPositions,
    holdTradingDays: hold,
    exitMode: "fixed-hold",
    exitRule: `entry + ${hold} trading days close`,
    stopLossPct: null,
    takeProfitPct: null,
    trackerRoundTripCostPct: STRATEGY_OOS_COST_PCT,
    slippageByLiquidity: PAPER_AUTO_ARENA_POLICY.slippageByLiquidity,
    extraExecutionSlippagePct: PAPER_AUTO_ARENA_POLICY.slippageByLiquidity.midPct,
    effectiveFrictionPct: null,
    backfillBeforeStart: false,
    aiRole: "observe-only"
  };
}

function preparePortfolio(strategyId, allSelections, recordIndex, statusMap, startSignalDate) {
  const selected = allSelections.filter((s) => s.strategyId === strategyId && s.signalDate >= startSignalDate);
  const inputs = [];
  const missing = [];
  const blocked = [];
  const seen = new Set();
  for (const s of selected) {
    for (const member of s.members ?? []) {
      const k = rowKey(s.signalDate, s.market, member.code);
      if (seen.has(k)) continue;
      seen.add(k);
      const row = recordIndex.get(k);
      if (!row) { missing.push(k); continue; }
      const status = isEntryBlocked(row, statusMap);
      if (status) { blocked.push({ key: k, reasons: status.blockReasons }); continue; }
      inputs.push({ row, rank: finite(member.rank) ? Number(member.rank) : 999999 });
    }
  }
  const byDay = new Map();
  for (const input of inputs) {
    const date = input.row.signalDate;
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(input);
  }
  for (const members of byDay.values()) {
    members.sort((a, b) => a.rank - b.rank
      || String(a.row.market).localeCompare(String(b.row.market))
      || String(a.row.code).localeCompare(String(b.row.code)));
    members.forEach((input, index) => { input.paperPriority = index + 1; });
  }
  const records = inputs.map(({ row, paperPriority }) => ({ ...row, paperPriority }));
  const synthetic = new Map();
  for (const row of records) {
    const key = `${row.signalDate}|${row.market}`;
    if (!synthetic.has(key)) synthetic.set(key, {
      signalDate: row.signalDate, market: row.market, strategyId: `LAB_${strategyId}`, members: []
    });
    synthetic.get(key).members.push({ code: row.code, rank: row.paperPriority });
  }
  return { records, selections: [...synthetic.values()], missing, blocked };
}

function paperSummary(prepared, strategyId, hold, statusMap, startSignalDate) {
  const model = buildPaperAutoModel({
    records: prepared.records,
    selections: prepared.selections,
    policy: policyFor(strategyId, hold, startSignalDate)
  });
  const recordIndex = new Map(prepared.records.map((r) => [marketStatusKey(r.signalDate, r.market, r.code), r]));
  const quarantined = model.closed.filter((trade) => {
    const row = recordIndex.get(marketStatusKey(trade.signalDate, trade.market, trade.code));
    return row && !classifyOutcomeIntegrity(row, hold, statusMap).comparable;
  });
  const badPnl = quarantined.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
  return {
    holdDays: hold,
    ...model.summary,
    comparableReturnPct: round((Number(model.summary.equity) - badPnl) / Number(model.summary.initialCapital) * 100 - 100),
    quarantinedClosedTrades: quarantined.length,
    blockedSignals: prepared.blocked.length,
    missingRecords: prepared.missing.length,
    // This is a diagnostic overlay, not a full counterfactual re-simulation.
    comparableMethod: "subtract quarantined trade pnl; do not reallocate capacity"
  };
}

export function buildStrategyPaperLab({
  records = [], selections = [], marketStatuses = [], summary,
  registry = enabledStrategies(), startSignalDate = STRATEGY_PAPER_LAB_START_DATE
} = {}) {
  if (!summary?.markets?.ALL) throw new Error("STRATEGY_OOS_SUMMARY_MISSING");
  const { candidates, shortlistedIds, eligibleCount } = rankStrategyPaperCandidates({ summary, selections, records, marketStatuses, registry });
  const byCandidate = new Map(candidates.map((c) => [c.id, c]));
  const recordIndex = new Map(records.map((r) => [rowKey(r.signalDate, r.market, r.code), r]));
  const statusMap = buildMarketStatusMap(marketStatuses);
  const accounts = [];
  for (const strategy of registry) {
    const prepared = preparePortfolio(strategy.id, selections, recordIndex, statusMap, startSignalDate);
    const byHold = Object.fromEntries(STRATEGY_PAPER_HOLDS.map((hold) =>
      [String(hold), paperSummary(prepared, strategy.id, hold, statusMap, startSignalDate)]));
    accounts.push({
      id: strategy.id, name: strategy.displayName, group: strategy.group,
      qualified: byCandidate.get(strategy.id)?.qualified === true,
      shortlisted: shortlistedIds.includes(strategy.id),
      oos: byCandidate.get(strategy.id)?.oos ?? null,
      rawOos: byCandidate.get(strategy.id)?.rawOos ?? null,
      reason: byCandidate.get(strategy.id)?.reason ?? "MISSING",
      holds: byHold
    });
  }
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  return {
    schemaVersion: "strategy-paper-lab-v1",
    generatedAt: new Date().toISOString(),
    startSignalDate,
    policy: {
      initialCapitalPerAccount: PAPER_AUTO_ARENA_POLICY.initialCapitalPerAccount,
      positionBudget: PAPER_AUTO_ARENA_POLICY.positionBudget,
      maxPositions: PAPER_AUTO_ARENA_POLICY.maxPositions,
      holdTradingDays: STRATEGY_PAPER_HOLDS,
      roundTripCostPct: STRATEGY_OOS_COST_PCT,
      slippageByLiquidity: PAPER_AUTO_ARENA_POLICY.slippageByLiquidity,
      provisionalMin10DayCohorts: STRATEGY_PAPER_MIN_COHORTS,
      selection: "10D integrity-comparable positive net and market excess, >=20 completed market-day cohorts; recent high-overlap strategies deduplicated in shortlist",
      realOrderApiUsed: false, historicalSignalsBackfilled: false,
      liveExecutionConnected: false
    },
    diagnostics: {
      strategyCount: accounts.length,
      independentAccountCount: accounts.length * STRATEGY_PAPER_HOLDS.length,
      provisionalQualified: eligibleCount,
      shortlistCount: shortlistedIds.length,
      oosLastSignalDate: summary.meta?.lastDate ?? null,
      oosMissingSnapshotDates: summary.meta?.missingSnapshotDates ?? [],
      marketStatusSnapshots: marketStatuses.length,
      futureOnly: true,
      shortlistedBasedOnObservedOos: true,
      anyShortlistProfitIsNotIndependentOfSelection: true,
      noBackfillBefore: startSignalDate
    },
    shortlist: shortlistedIds.map((id) => accountById.get(id)),
    leaderboard: candidates.map((c) => accountById.get(c.id))
  };
}
