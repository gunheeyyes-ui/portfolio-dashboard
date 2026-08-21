// Adds the live dashboard's base-strategy overlap counts to an existing V3
// feature matrix. This is deliberately a phase-2 transform: old matrices can
// be reused without downloading prices or rebuilding the expensive matrix.

import { evaluateBaseConsensus } from "../public/strategy-consensus.js";

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function actionableFromMatrix(row) {
  if (row.I === true || row.overheat === true) return false;
  if (row.H3 === true || row.R === true || row.F === true || row.F2 === true) return true;
  return row.B === true && Number(row.liquidityScore ?? 0) >= 50;
}

function toFeature(row, rsRank) {
  return {
    code: String(row.code ?? ""),
    name: row.name ?? "",
    market: row.market ?? "",
    signalPrice: null,
    leaderScore: finite(row.leaderScore) ? Number(row.leaderScore) : null,
    leaderGrade: row.leaderGrade && row.leaderGrade !== "계산불가" ? row.leaderGrade : null,
    leaderRank: finite(row.leaderRank) ? Number(row.leaderRank) : null,
    rs20: finite(row.rs20) ? Number(row.rs20) : null,
    rsRank,
    combinedScore: finite(row.combinedScore) ? Number(row.combinedScore) : null,
    combinedRank: finite(row.combinedRank) ? Number(row.combinedRank) : null,
    combinedDecision: row.combinedLabel || null,
    combinedTier: finite(row.combinedTier) ? Number(row.combinedTier) : null,
    rankingV2Tier: finite(row.rankingTier) ? Number(row.rankingTier) : null,
    rankingV2Rank: finite(row.rankingV2Rank) ? Number(row.rankingV2Rank) : null,
    scoutRank: finite(row.scoutRank) ? Number(row.scoutRank) : null,
    scoutStatus: row.scoutStatus && row.scoutStatus !== "계산불가" ? row.scoutStatus : null,
    reboundStatus: row.reboundStateKey ?? null,
    drawdownPct: finite(row.drawdownFromHighPct) ? Number(row.drawdownFromHighPct) : null,
    riskScore: finite(row.scoutRiskScore) ? Number(row.scoutRiskScore) : null,
    stabilizeScore: finite(row.scoutStabilizeScore) ? Number(row.scoutStabilizeScore) : null,
    liquidityScore: finite(row.liquidityScore) ? Number(row.liquidityScore) : null,
    foreignStreak: finite(row.foreignStreak) ? Number(row.foreignStreak) : null,
    institutionStreak: finite(row.instStreak) ? Number(row.instStreak) : null,
    flags: {
      R: row.R === true,
      F: row.F === true,
      F2: row.F2 === true,
      B: row.B === true,
      C: row.C === true,
      H2: row.H2 === true,
      H3: row.H3 === true,
      I: row.I === true
    },
    cafe: row.cafePass === true,
    mtt: row.minerviniPass === true,
    leaderRebound: row.leaderReboundPass === true,
    deepRecovery: row.deepRecoveryPass === true,
    actionable: actionableFromMatrix(row),
    simCategory: null,
    simCategoryLabel: null
  };
}

export function annotateConsensusRows(rows) {
  const groups = new Map();
  for (const row of rows ?? []) {
    const key = `${row.date}|${row.market}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  for (const group of groups.values()) {
    const rsOrder = group
      .filter((row) => finite(row.rs20))
      .sort((a, b) => Number(b.rs20) - Number(a.rs20) || String(a.code).localeCompare(String(b.code)));
    const rsRank = new Map(rsOrder.map((row, index) => [String(row.code), index + 1]));

    for (const row of group) {
      const feature = toFeature(row, rsRank.get(String(row.code)) ?? null);
      const consensus = evaluateBaseConsensus(feature);
      row.strategyMatchCount = consensus.strategyMatchCount;
      row.strategyAxisCount = consensus.strategyAxisCount;
      row.strategyHasLeaderAxis = consensus.strategyHasLeaderAxis;
      row.strategyHasRsAxis = consensus.strategyHasRsAxis;
      row.strategyHasTimingAxis = consensus.strategyHasTimingAxis;
      row.strategyHasEntryAxis = consensus.strategyHasEntryAxis;
      row.strategyHasReboundAxis = consensus.strategyHasReboundAxis;
      row.strategyHasConfirmAxis = consensus.strategyHasConfirmAxis;
      row.actionable = feature.actionable;
    }
  }
  return rows;
}
