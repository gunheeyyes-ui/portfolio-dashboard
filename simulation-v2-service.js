import { evaluateBaseConsensus } from "./public/strategy-consensus.js";

export const SIM_V2_HORIZONS = [0, 1, 3, 5, 10, 20];
export const SIM_V2_PORTFOLIO_HORIZONS = [5, 10, 20];
export const SIM_V2_COHORTS = [
  { id: "actual", label: "✅ 실제진입" },
  { id: "core", label: "🔥 핵심후보" },
  { id: "strong", label: "⭐ 강한후보" }
];
export const SIM_V2_STRESS_COSTS = [0.2, 0.5];

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
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

function profitFactor(values) {
  const clean = values.filter(finite).map(Number);
  const gains = clean.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(clean.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  if (!clean.length || !losses) return null;
  return gains / losses;
}

function round(value, digits = 3) {
  return finite(value) ? Number(Number(value).toFixed(digits)) : null;
}

function compactDate(value) {
  return String(value ?? "").replace(/-/g, "");
}

function recordKey(signalDate, market, code) {
  return `${signalDate}|${market}|${code}`;
}

function selectionMemberKeys(selections, strategyId) {
  const keys = new Set();
  for (const selection of selections ?? []) {
    if (selection.strategyId !== strategyId) continue;
    for (const member of selection.members ?? []) {
      keys.add(recordKey(selection.signalDate, selection.market, member.code));
    }
  }
  return keys;
}

function intersect(left, right) {
  return new Set([...left].filter((key) => right.has(key)));
}

function frozenConsensus(record) {
  if (record?.frozenConsensus) {
    return {
      ...record.frozenConsensus,
      source: "frozen"
    };
  }
  const derived = record?.factors ? evaluateBaseConsensus(record.factors) : null;
  return {
    version: "legacy-recomputed-current-registry",
    strategyCount: derived?.strategyMatchCount ?? 0,
    axisCount: derived?.strategyAxisCount ?? 0,
    strategyIds: derived?.matches?.map((strategy) => strategy.id) ?? [],
    strategyNames: derived?.matches?.map((strategy) => strategy.displayName) ?? [],
    axisIds: derived?.axes?.map((axis) => axis.id) ?? [],
    axisLabels: derived?.axes?.map((axis) => axis.label) ?? [],
    source: "legacy-recomputed"
  };
}

function outcomeFor(row, horizon) {
  return horizon === 0 ? row?.entryDayOutcome ?? null : row?.outcomes?.[String(horizon)] ?? null;
}

function indexMaps(indexData) {
  return Object.fromEntries(["KOSPI", "KOSDAQ"].map((market) => [
    market,
    new Map((indexData?.markets?.[market] ?? []).map((row) => [String(row.date), row]))
  ]));
}

function indexOutcome(row, outcome, maps) {
  const marketMap = maps[row.market];
  if (!marketMap || !outcome || !row.entryDate) return null;
  const entry = marketMap.get(compactDate(row.entryDate));
  const targetDate = compactDate(outcome.targetTradingDate ?? row.entryDate);
  const exit = marketMap.get(targetDate);
  if (!finite(entry?.open) || !finite(exit?.close) || Number(entry.open) <= 0) return null;
  return (Number(exit.close) / Number(entry.open) - 1) * 100;
}

function dailyReturns(series) {
  const result = [];
  for (let index = 1; index < series.length; index += 1) {
    const prev = Number(series[index - 1]?.close);
    const current = Number(series[index]?.close);
    if (prev > 0 && current > 0) result.push((current / prev - 1) * 100);
  }
  return result;
}

function stddev(values) {
  const clean = values.filter(finite).map(Number);
  if (clean.length < 2) return null;
  const mean = average(clean);
  return Math.sqrt(clean.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / clean.length);
}

export function marketRegimeForDate(market, signalDate, indexData) {
  const rows = indexData?.markets?.[market] ?? [];
  const target = compactDate(signalDate);
  const index = rows.findIndex((row) => String(row.date) === target);
  if (index < 0) return { key: "unknown", label: "지수자료 없음", ret20: null, vol20: null };
  const start = Math.max(0, index - 20);
  const window = rows.slice(start, index + 1);
  const first = Number(window[0]?.close);
  const last = Number(window.at(-1)?.close);
  const ret20 = first > 0 && last > 0 ? (last / first - 1) * 100 : null;
  const vol20 = stddev(dailyReturns(window));
  let key = "neutral";
  let label = "중립장";
  if (finite(vol20) && Number(vol20) >= 2.2) {
    key = "high-vol";
    label = "고변동장";
  } else if (finite(ret20) && Number(ret20) >= 5) {
    key = "bull";
    label = "상승장";
  } else if (finite(ret20) && Number(ret20) <= -5) {
    key = "bear";
    label = "하락장";
  }
  return { key, label, ret20: round(ret20), vol20: round(vol20) };
}

function enrichRecord(record, flags, maps, indexData) {
  const consensus = frozenConsensus(record);
  const entryGapPct = finite(record?.entryGapPct)
    ? Number(record.entryGapPct)
    : finite(record?.signalPrice) && finite(record?.entryOpen) && Number(record.signalPrice) > 0
      ? (Number(record.entryOpen) / Number(record.signalPrice) - 1) * 100
      : null;
  const regime = marketRegimeForDate(record.market, record.signalDate, indexData);
  const outcomes = {};
  for (const horizon of SIM_V2_HORIZONS) {
    const source = outcomeFor(record, horizon);
    if (!source) continue;
    const indexReturnPct = indexOutcome(record, source, maps);
    outcomes[String(horizon)] = {
      ...source,
      indexReturnPct,
      indexExcessReturnPct: finite(indexReturnPct) && finite(source.netReturnPct)
        ? Number(source.netReturnPct) - Number(indexReturnPct)
        : null,
      stress: Object.fromEntries(SIM_V2_STRESS_COSTS.map((extraCost) => [
        String(extraCost),
        finite(source.netReturnPct) ? Number(source.netReturnPct) - extraCost : null
      ]))
    };
  }
  return {
    ...record,
    ...flags,
    tags: SIM_V2_COHORTS.filter((cohort) => flags[cohort.id]).map((cohort) => cohort.id),
    frozenConsensus: consensus,
    strategyCount: consensus.strategyCount,
    axisCount: consensus.axisCount,
    strategyIds: consensus.strategyIds,
    strategyNames: consensus.strategyNames,
    axisIds: consensus.axisIds,
    axisLabels: consensus.axisLabels,
    entryGapPct,
    regime,
    outcomesV2: outcomes,
    universeVersion: record?.universeMeta?.version ?? "legacy-unversioned"
  };
}

function tradeBlock(rows, horizon) {
  const outcomes = rows.map((row) => row.outcomesV2?.[String(horizon)]).filter((outcome) => finite(outcome?.netReturnPct));
  const returns = outcomes.map((outcome) => Number(outcome.netReturnPct));
  return {
    n: returns.length,
    avgReturnPct: round(average(returns)),
    medianReturnPct: round(median(returns)),
    winRatePct: returns.length ? round((returns.filter((value) => value > 0).length / returns.length) * 100, 1) : null,
    profitFactor: round(profitFactor(returns), 2),
    avgMfePct: round(average(outcomes.map((outcome) => outcome.mfePct))),
    avgMaePct: round(average(outcomes.map((outcome) => outcome.maePct))),
    avgUniverseExcessReturnPct: round(average(outcomes.map((outcome) => outcome.excessReturnPct))),
    avgIndexExcessReturnPct: round(average(outcomes.map((outcome) => outcome.indexExcessReturnPct))),
    stress: Object.fromEntries(SIM_V2_STRESS_COSTS.map((extraCost) => {
      const stressed = outcomes.map((outcome) => outcome.stress?.[String(extraCost)]).filter(finite).map(Number);
      return [String(extraCost), {
        avgReturnPct: round(average(stressed)),
        winRatePct: stressed.length ? round((stressed.filter((value) => value > 0).length / stressed.length) * 100, 1) : null
      }];
    }))
  };
}

function dayBasketBlock(rows, horizon) {
  const byDay = new Map();
  for (const row of rows) {
    const outcome = row.outcomesV2?.[String(horizon)];
    if (!finite(outcome?.netReturnPct)) continue;
    if (!byDay.has(row.signalDate)) byDay.set(row.signalDate, []);
    byDay.get(row.signalDate).push(Number(outcome.netReturnPct));
  }
  const baskets = [...byDay.entries()].map(([signalDate, values]) => ({
    signalDate,
    members: values.length,
    returnPct: average(values)
  }));
  const returns = baskets.map((row) => row.returnPct).filter(finite).map(Number);
  return {
    n: returns.length,
    avgReturnPct: round(average(returns)),
    medianReturnPct: round(median(returns)),
    winRatePct: returns.length ? round((returns.filter((value) => value > 0).length / returns.length) * 100, 1) : null,
    best: baskets.filter((row) => finite(row.returnPct)).sort((a, b) => b.returnPct - a.returnPct)[0] ?? null,
    worst: baskets.filter((row) => finite(row.returnPct)).sort((a, b) => a.returnPct - b.returnPct)[0] ?? null
  };
}

function gapBlock(rows) {
  const gaps = rows.map((row) => row.entryGapPct).filter(finite).map(Number);
  return {
    n: gaps.length,
    avgPct: round(average(gaps)),
    medianPct: round(median(gaps)),
    gapUp5Pct: gaps.length ? round((gaps.filter((value) => value >= 5).length / gaps.length) * 100, 1) : null,
    gapDown5Pct: gaps.length ? round((gaps.filter((value) => value <= -5).length / gaps.length) * 100, 1) : null
  };
}

function regimeBlocks(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.regime?.key ?? "unknown";
    if (!groups.has(key)) groups.set(key, { key, label: row.regime?.label ?? key, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].map((group) => ({
    key: group.key,
    label: group.label,
    trades: group.rows.length,
    signalDays: new Set(group.rows.map((row) => row.signalDate)).size,
    horizons: Object.fromEntries([5, 10, 20].map((horizon) => [String(horizon), tradeBlock(group.rows, horizon)]))
  })).sort((a, b) => b.trades - a.trades);
}

function universeVersionCounts(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.universeVersion, (counts.get(row.universeVersion) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

function cohortSummary(allRows, cohort) {
  const rows = allRows.filter((row) => row[cohort.id] === true);
  return {
    id: cohort.id,
    label: cohort.label,
    trades: rows.length,
    signalDays: new Set(rows.map((row) => row.signalDate)).size,
    pending: rows.filter((row) => row.status !== "COMPLETE").length,
    latestSignalDate: rows.map((row) => row.signalDate).sort().at(-1) ?? null,
    liveAvgReturnPct: round(average(rows.filter((row) => row.status !== "COMPLETE").map((row) => row.live?.currentReturnPct))),
    gap: gapBlock(rows),
    universeVersions: universeVersionCounts(rows),
    horizons: Object.fromEntries(SIM_V2_HORIZONS.map((horizon) => [String(horizon), {
      trades: tradeBlock(rows, horizon),
      signalDays: dayBasketBlock(rows, horizon)
    }])),
    regimes: regimeBlocks(rows)
  };
}

function drawdownFromCurve(curve, initialCapital) {
  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDrawdown = Math.min(maxDrawdown, ((point.equity / peak) - 1) * 100);
  }
  return maxDrawdown;
}

function portfolioSort(a, b) {
  return (b.strategyCount ?? 0) - (a.strategyCount ?? 0)
    || (b.axisCount ?? 0) - (a.axisCount ?? 0)
    || (Number(a.factors?.leaderRank ?? 9999) - Number(b.factors?.leaderRank ?? 9999))
    || (Number(b.factors?.rs20 ?? -1) - Number(a.factors?.rs20 ?? -1))
    || String(a.code).localeCompare(String(b.code));
}

export function simulatePortfolio(rows, {
  cohortId,
  horizon = 10,
  initialCapital = 100_000_000,
  maxPositions = 10
} = {}) {
  const candidates = rows
    .filter((row) => row[cohortId] === true)
    .filter((row) => row.entryDate && finite(row.outcomesV2?.[String(horizon)]?.netReturnPct))
    .map((row) => ({
      ...row,
      entryKey: compactDate(row.entryDate),
      exitKey: compactDate(row.outcomesV2[String(horizon)].targetTradingDate),
      netReturnPct: Number(row.outcomesV2[String(horizon)].netReturnPct)
    }))
    .filter((row) => /^\d{8}$/.test(row.entryKey) && /^\d{8}$/.test(row.exitKey));

  const byEntry = new Map();
  const exitDates = new Set();
  for (const row of candidates) {
    if (!byEntry.has(row.entryKey)) byEntry.set(row.entryKey, []);
    byEntry.get(row.entryKey).push(row);
    exitDates.add(row.exitKey);
  }
  const dates = [...new Set([...byEntry.keys(), ...exitDates])].sort();
  let equity = initialCapital;
  let active = [];
  let skippedDuplicate = 0;
  let skippedCapacity = 0;
  const trades = [];
  const curve = [{ date: dates[0] ?? null, equity }];

  for (const date of dates) {
    const entries = [...(byEntry.get(date) ?? [])].sort(portfolioSort);
    for (const row of entries) {
      if (active.some((position) => position.code === row.code)) {
        skippedDuplicate += 1;
        continue;
      }
      if (active.length >= maxPositions) {
        skippedCapacity += 1;
        continue;
      }
      const allocation = equity / maxPositions;
      active.push({
        code: row.code,
        name: row.name,
        entryDate: date,
        exitDate: row.exitKey,
        returnPct: row.netReturnPct,
        allocation
      });
    }

    const closing = active.filter((position) => position.exitDate === date);
    if (closing.length) {
      for (const position of closing) {
        const pnl = position.allocation * position.returnPct / 100;
        equity += pnl;
        trades.push({ ...position, pnl, equityAfter: equity });
      }
      active = active.filter((position) => position.exitDate !== date);
      curve.push({ date, equity });
    }
  }

  const returns = trades.map((trade) => trade.returnPct);
  return {
    cohortId,
    horizon,
    initialCapital,
    maxPositions,
    completedTrades: trades.length,
    skippedDuplicate,
    skippedCapacity,
    endingEquity: round(equity, 0),
    totalReturnPct: round((equity / initialCapital - 1) * 100),
    realizedMaxDrawdownPct: round(drawdownFromCurve(curve, initialCapital)),
    winRatePct: trades.length ? round((trades.filter((trade) => trade.returnPct > 0).length / trades.length) * 100, 1) : null,
    avgTradeReturnPct: round(average(returns)),
    profitFactor: round(profitFactor(returns), 2),
    curve: curve.slice(-120),
    activeAtEnd: active.length
  };
}

function healthBlock({ records, selections, invalidLines, state, indexData }) {
  const signalDates = [...new Set(records.map((row) => row.signalDate).filter(Boolean))].sort();
  const missing = state?.missingSnapshotDates ?? [];
  const frozen = records.filter((row) => row.frozenConsensus).length;
  const entryDay = records.filter((row) => row.entryDayOutcome).length;
  const indexLast = Object.fromEntries(["KOSPI", "KOSDAQ"].map((market) => [market, indexData?.markets?.[market]?.at(-1)?.date ?? null]));
  let status = "good";
  if (invalidLines > 0 || missing.length > 0) status = "warn";
  if (!signalDates.length) status = "empty";
  return {
    status,
    signalDates: signalDates.length,
    firstSignalDate: signalDates[0] ?? null,
    lastSignalDate: signalDates.at(-1) ?? null,
    recordCount: records.length,
    selectionCount: selections.length,
    invalidLines,
    missingSnapshotDates: missing,
    lastSnapshotAt: state?.lastSnapshotAt ?? null,
    lastEvaluatedAt: state?.lastEvaluatedAt ?? null,
    frozenConsensusRecords: frozen,
    frozenConsensusCoveragePct: records.length ? round((frozen / records.length) * 100, 1) : null,
    entryDayRecords: entryDay,
    entryDayCoveragePct: records.length ? round((entryDay / records.length) * 100, 1) : null,
    indexUpdatedAt: indexData?.updatedAt ?? null,
    indexLastDate: indexLast,
    recentSkipped: (state?.skipped ?? []).slice(-10)
  };
}

export function buildSimulationV2ServerModel({
  records = [],
  selections = [],
  invalidLines = 0,
  state = {},
  indexData = { markets: { KOSPI: [], KOSDAQ: [] } },
  offset = 0,
  limit = 100,
  cohort = "ALL",
  regime = "ALL",
  initialCapital = 100_000_000,
  maxPositions = 10
} = {}) {
  const recordIndex = new Map(records.map((row) => [recordKey(row.signalDate, row.market, row.code), row]));
  const actualKeys = selectionMemberKeys(selections, "ACTIONABLE_ALL");
  const coreKeys = intersect(
    selectionMemberKeys(selections, "LEADER_TOP10"),
    selectionMemberKeys(selections, "CONSENSUS_5S_3A")
  );
  const strongKeys = intersect(
    selectionMemberKeys(selections, "LEADER_A_AND_RS80"),
    selectionMemberKeys(selections, "CONSENSUS_AXIS_3_PLUS")
  );
  const allKeys = new Set([...actualKeys, ...coreKeys, ...strongKeys]);
  const maps = indexMaps(indexData);
  const allRows = [...allKeys]
    .map((key) => {
      const record = recordIndex.get(key);
      if (!record) return null;
      return enrichRecord(record, {
        actual: actualKeys.has(key),
        core: coreKeys.has(key),
        strong: strongKeys.has(key)
      }, maps, indexData);
    })
    .filter(Boolean)
    .sort((a, b) => String(b.signalDate).localeCompare(String(a.signalDate))
      || (b.strategyCount ?? 0) - (a.strategyCount ?? 0)
      || (b.axisCount ?? 0) - (a.axisCount ?? 0)
      || String(a.market).localeCompare(String(b.market))
      || String(a.code).localeCompare(String(b.code)));

  const filtered = allRows.filter((row) => {
    if (cohort !== "ALL" && row[cohort] !== true) return false;
    if (regime !== "ALL" && row.regime?.key !== regime) return false;
    return true;
  });
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const cohorts = Object.fromEntries(SIM_V2_COHORTS.map((item) => [item.id, cohortSummary(allRows, item)]));
  const portfolio = Object.fromEntries(SIM_V2_COHORTS.map((item) => [item.id, Object.fromEntries(
    SIM_V2_PORTFOLIO_HORIZONS.map((horizon) => [String(horizon), simulatePortfolio(allRows, {
      cohortId: item.id,
      horizon,
      initialCapital,
      maxPositions
    })])
  )]));

  return {
    schemaVersion: "simulation-v2-server-2",
    generatedAt: new Date().toISOString(),
    horizons: SIM_V2_HORIZONS,
    portfolioHorizons: SIM_V2_PORTFOLIO_HORIZONS,
    stressExtraCostsPct: SIM_V2_STRESS_COSTS,
    cohortDefinitions: SIM_V2_COHORTS,
    health: healthBlock({ records, selections, invalidLines, state, indexData }),
    meta: {
      totalCandidateRows: allRows.length,
      filteredRows: filtered.length,
      offset: safeOffset,
      limit: safeLimit,
      universeVersions: universeVersionCounts(allRows),
      latestSignalDate: allRows.map((row) => row.signalDate).sort().at(-1) ?? null,
      note: "통계는 전체 OOS 원자료, rows만 페이지네이션"
    },
    cohorts,
    portfolio,
    rows: filtered.slice(safeOffset, safeOffset + safeLimit)
  };
}
