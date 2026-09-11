import { simulatePortfolio } from "./simulation-v2-service.js";
import { buildMarketStatusMap, classifyOutcomeIntegrity } from "./market-integrity.js";

export const INTEGRITY_HORIZONS = [0, 1, 3, 5, 10, 20];
export const INTEGRITY_PORTFOLIO_HORIZONS = [5, 10, 20];
export const INTEGRITY_COHORTS = [
  { id: "actual", label: "✅ 진입판정" },
  { id: "core", label: "🔥 핵심후보" },
  { id: "strong", label: "⭐ 강한후보" }
];

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function round(value, digits = 3) {
  return finite(value) ? Number(Number(value).toFixed(digits)) : null;
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
  return clean.length && losses ? gains / losses : null;
}

function key(signalDate, market, code) {
  return `${signalDate}|${market}|${code}`;
}

function selectionKeys(selections, strategyId) {
  const result = new Set();
  for (const selection of selections ?? []) {
    if (selection?.strategyId !== strategyId) continue;
    for (const member of selection.members ?? []) result.add(key(selection.signalDate, selection.market, member.code));
  }
  return result;
}

function intersect(a, b) {
  return new Set([...a].filter((value) => b.has(value)));
}

function outcomeFor(row, horizon) {
  return Number(horizon) === 0 ? row?.entryDayOutcome ?? null : row?.outcomes?.[String(horizon)] ?? null;
}

function metric(rows, horizon) {
  const returns = rows.map((row) => outcomeFor(row, horizon)?.netReturnPct).filter(finite).map(Number);
  return {
    n: returns.length,
    avgReturnPct: round(average(returns)),
    medianReturnPct: round(median(returns)),
    winRatePct: returns.length ? round((returns.filter((value) => value > 0).length / returns.length) * 100, 1) : null,
    profitFactor: round(profitFactor(returns), 2)
  };
}

function rowFlags(records, selections) {
  const recordIndex = new Map((records ?? []).map((row) => [key(row.signalDate, row.market, row.code), row]));
  const actual = selectionKeys(selections, "ACTIONABLE_ALL");
  const core = intersect(selectionKeys(selections, "LEADER_TOP10"), selectionKeys(selections, "CONSENSUS_5S_3A"));
  const strong = intersect(selectionKeys(selections, "LEADER_A_AND_RS80"), selectionKeys(selections, "CONSENSUS_AXIS_3_PLUS"));
  const all = new Set([...actual, ...core, ...strong]);
  return [...all].map((recordKey) => {
    const row = recordIndex.get(recordKey);
    if (!row) return null;
    return { ...row, actual: actual.has(recordKey), core: core.has(recordKey), strong: strong.has(recordKey) };
  }).filter(Boolean);
}

function portfolioRow(row, cohortId) {
  const outcomesV2 = {};
  for (const horizon of INTEGRITY_PORTFOLIO_HORIZONS) {
    const outcome = outcomeFor(row, horizon);
    if (outcome) outcomesV2[String(horizon)] = outcome;
  }
  return {
    ...row,
    [cohortId]: true,
    outcomesV2,
    strategyCount: Number(row?.frozenConsensus?.strategyCount ?? 0),
    axisCount: Number(row?.frozenConsensus?.axisCount ?? 0)
  };
}

export function buildSimulationIntegrityModel({
  records = [],
  selections = [],
  marketStatuses = [],
  initialCapital = 100_000_000,
  maxPositions = 10
} = {}) {
  const statusMap = buildMarketStatusMap(marketStatuses);
  const rows = rowFlags(records, selections);
  const quarantined = [];
  const cohorts = {};
  const portfolio = {};

  for (const cohort of INTEGRITY_COHORTS) {
    const members = rows.filter((row) => row[cohort.id] === true);
    const horizons = {};
    portfolio[cohort.id] = {};

    for (const horizon of INTEGRITY_HORIZONS) {
      const comparable = [];
      for (const row of members) {
        const outcome = outcomeFor(row, horizon);
        if (!finite(outcome?.netReturnPct)) continue;
        const integrity = classifyOutcomeIntegrity(row, horizon, statusMap);
        if (integrity.comparable) comparable.push(row);
        else quarantined.push({
          signalDate: row.signalDate,
          market: row.market,
          code: row.code,
          name: row.name,
          cohort: cohort.id,
          horizon,
          netReturnPct: round(outcome.netReturnPct),
          reasons: integrity.reasons
        });
      }
      horizons[String(horizon)] = {
        raw: metric(members, horizon),
        comparable: metric(comparable, horizon),
        quarantined: metric(members, horizon).n - metric(comparable, horizon).n
      };
    }

    for (const horizon of INTEGRITY_PORTFOLIO_HORIZONS) {
      const cleanRows = members
        .filter((row) => classifyOutcomeIntegrity(row, horizon, statusMap).comparable)
        .map((row) => portfolioRow(row, cohort.id));
      portfolio[cohort.id][String(horizon)] = simulatePortfolio(cleanRows, {
        cohortId: cohort.id,
        horizon,
        initialCapital,
        maxPositions
      });
    }

    cohorts[cohort.id] = {
      id: cohort.id,
      label: cohort.label,
      trades: members.length,
      signalDays: new Set(members.map((row) => row.signalDate)).size,
      horizons
    };
  }

  const uniqueQuarantine = new Map();
  for (const item of quarantined) {
    const id = `${item.signalDate}|${item.market}|${item.code}|${item.horizon}`;
    if (!uniqueQuarantine.has(id)) uniqueQuarantine.set(id, item);
  }
  const recent = [...uniqueQuarantine.values()]
    .sort((a, b) => String(b.signalDate).localeCompare(String(a.signalDate)) || Number(a.horizon) - Number(b.horizon))
    .slice(0, 100);

  return {
    schemaVersion: "simulation-integrity-v1",
    generatedAt: new Date().toISOString(),
    policy: {
      rawOosPreserved: true,
      futureOutcomeNeverBlocksPastEntry: true,
      signalTimeMarketStatusCanBlockFuturePaperEntry: true,
      cleanViewOnly: true,
      note: "원본 OOS/가상계좌 손익은 삭제하지 않고, 명시적 특수시장 상태 또는 강한 가격단절 의심만 비교용 정합성 뷰에서 격리"
    },
    marketStatusSnapshots: marketStatuses.length,
    quarantineEvents: uniqueQuarantine.size,
    cohorts,
    portfolio,
    quarantinedRecent: recent
  };
}
