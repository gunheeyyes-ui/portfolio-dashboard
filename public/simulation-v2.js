import { evaluateBaseConsensus } from "./strategy-consensus.js";

export const SIMULATION_V2_HORIZONS = [1, 3, 5, 10, 20];

export const SIMULATION_V2_COHORTS = [
  { id: "actual", label: "✅ 실제진입" },
  { id: "core", label: "🔥 핵심후보" },
  { id: "strong", label: "⭐ 강한후보" }
];

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

function rowKey(signalDate, market, code) {
  return `${signalDate}|${market}|${code}`;
}

function detailRows(detail) {
  const rows = [];
  for (const cohort of detail?.cohorts ?? []) {
    for (const row of cohort.rows ?? []) {
      rows.push({
        ...row,
        signalDate: cohort.signalDate,
        market: cohort.market,
        recordedAt: cohort.recordedAt ?? null
      });
    }
  }
  return rows;
}

function detailIndex(detail) {
  return new Map(detailRows(detail).map((row) => [rowKey(row.signalDate, row.market, row.code), row]));
}

function setIntersection(left, right) {
  return new Set([...left].filter((key) => right.has(key)));
}

function membershipSet(index) {
  return new Set(index.keys());
}

function cohortPriority(row) {
  if (row.core && row.actual) return 60;
  if (row.core && row.strong) return 55;
  if (row.core) return 50;
  if (row.strong && row.actual) return 40;
  if (row.strong) return 30;
  if (row.actual) return 20;
  return 0;
}

function bestSourceRow(key, indexes) {
  for (const index of indexes) {
    const row = index.get(key);
    if (row) return row;
  }
  return null;
}

function enrichRow(row, flags) {
  const consensus = row?.factors ? evaluateBaseConsensus(row.factors) : {
    strategyMatchCount: 0,
    strategyAxisCount: 0,
    matches: [],
    axes: []
  };
  const tags = SIMULATION_V2_COHORTS.filter((cohort) => flags[cohort.id]).map((cohort) => cohort.id);
  return {
    ...row,
    ...flags,
    tags,
    strategyCount: consensus.strategyMatchCount,
    axisCount: consensus.strategyAxisCount,
    strategyIds: consensus.matches.map((strategy) => strategy.id),
    strategyNames: consensus.matches.map((strategy) => strategy.displayName),
    axisIds: consensus.axes.map((axis) => axis.id),
    axisLabels: consensus.axes.map((axis) => axis.label)
  };
}

function cohortStats(rows, cohortId) {
  const members = rows.filter((row) => row[cohortId] === true);
  const horizons = {};
  for (const horizon of SIMULATION_V2_HORIZONS) {
    const outcomes = members.map((row) => row.outcomes?.[String(horizon)]).filter((outcome) => finite(outcome?.netReturnPct));
    const returns = outcomes.map((outcome) => Number(outcome.netReturnPct));
    horizons[String(horizon)] = {
      n: returns.length,
      avgReturnPct: average(returns),
      medianReturnPct: median(returns),
      winRatePct: returns.length ? (returns.filter((value) => value > 0).length / returns.length) * 100 : null,
      avgMfePct: average(outcomes.map((outcome) => outcome.mfePct)),
      avgMaePct: average(outcomes.map((outcome) => outcome.maePct)),
      avgExcessReturnPct: average(outcomes.map((outcome) => outcome.excessReturnPct))
    };
  }
  const pending = members.filter((row) => row.status !== "COMPLETE");
  return {
    id: cohortId,
    label: SIMULATION_V2_COHORTS.find((cohort) => cohort.id === cohortId)?.label ?? cohortId,
    trades: members.length,
    pending: pending.length,
    latestSignalDate: members.map((row) => row.signalDate).sort().at(-1) ?? null,
    liveAvgReturnPct: average(pending.map((row) => row.live?.currentReturnPct)),
    horizons
  };
}

export function buildSimulationV2(details) {
  const actualIndex = detailIndex(details?.actual);
  const leaderTop10Index = detailIndex(details?.leaderTop10);
  const consensus5s3aIndex = detailIndex(details?.consensus5s3a);
  const leaderARs80Index = detailIndex(details?.leaderARs80);
  const axis3plusIndex = detailIndex(details?.axis3plus);

  const actualKeys = membershipSet(actualIndex);
  const coreKeys = setIntersection(membershipSet(leaderTop10Index), membershipSet(consensus5s3aIndex));
  const strongKeys = setIntersection(membershipSet(leaderARs80Index), membershipSet(axis3plusIndex));
  const allKeys = new Set([...actualKeys, ...coreKeys, ...strongKeys]);
  const sourceIndexes = [actualIndex, leaderTop10Index, consensus5s3aIndex, leaderARs80Index, axis3plusIndex];

  const rows = [...allKeys].map((key) => {
    const row = bestSourceRow(key, sourceIndexes);
    return enrichRow(row, {
      actual: actualKeys.has(key),
      core: coreKeys.has(key),
      strong: strongKeys.has(key)
    });
  }).filter(Boolean).sort((a, b) =>
    String(b.signalDate).localeCompare(String(a.signalDate))
    || cohortPriority(b) - cohortPriority(a)
    || String(a.market).localeCompare(String(b.market))
    || String(a.name).localeCompare(String(b.name))
  );

  const latestSignalDate = rows.map((row) => row.signalDate).sort().at(-1) ?? null;
  return {
    schemaVersion: "simulation-v2-derived-oos-1",
    source: "strategy-oos",
    horizons: SIMULATION_V2_HORIZONS,
    latestSignalDate,
    rows,
    cohorts: Object.fromEntries(SIMULATION_V2_COHORTS.map((cohort) => [cohort.id, cohortStats(rows, cohort.id)]))
  };
}

export function latestExcursion(row) {
  for (const horizon of [...SIMULATION_V2_HORIZONS].reverse()) {
    const outcome = row?.outcomes?.[String(horizon)];
    if (outcome && (finite(outcome.mfePct) || finite(outcome.maePct))) {
      return { horizon, mfePct: outcome.mfePct ?? null, maePct: outcome.maePct ?? null };
    }
  }
  if (row?.live && (finite(row.live.currentMFE) || finite(row.live.currentMAE))) {
    return {
      horizon: row.live.tradingDaysElapsed ?? 0,
      mfePct: row.live.currentMFE ?? null,
      maePct: row.live.currentMAE ?? null
    };
  }
  return { horizon: null, mfePct: null, maePct: null };
}
