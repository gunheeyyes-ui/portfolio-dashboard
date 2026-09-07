import { buildPaperAutoModel, PAPER_AUTO_POLICY } from "./paper-auto-service.js";

export const PAPER_AUTO_ARENA_POLICY = Object.freeze({
  id: "shadow-auto-arena-v2-20260907",
  label: "Shadow Auto Arena V2",
  frozenAt: "2026-09-07T12:37:00.000Z",
  startSignalDate: "2026-09-07",
  initialCapitalPerAccount: 100_000_000,
  maxPositions: 10,
  positionBudget: 10_000_000,
  holdTradingDays: 3,
  trackerRoundTripCostPct: 0.23,
  slippageByLiquidity: Object.freeze({
    highThreshold: 70,
    highPct: 0.10,
    midThreshold: 45,
    midPct: 0.20,
    lowPct: 0.35
  }),
  entryRule: "signal EOD -> next trading-day open",
  exitRule: "entry + 3 trading days close",
  aiRole: "observe-only",
  allowLeverage: false,
  allowShort: false,
  backfillBeforeStart: false
});

export const PAPER_AUTO_ACCOUNTS = Object.freeze([
  { id: "actual", label: "✅ 실제진입", kind: "selection", strategyId: "ACTIONABLE_ALL", order: "timing", description: "기존 실제진입 판정" },
  { id: "core", label: "🔥 핵심", kind: "derived", selector: "core", order: "entry-review", description: "Leader TOP10 + 5전략+ + 3계열+" },
  { id: "strong", label: "⭐ 강한", kind: "derived", selector: "strong-only", order: "entry-review", description: "Leader A + RS80+ + 3계열+, 핵심 제외" },
  { id: "timing", label: "종합타이밍 TOP10", kind: "selection", strategyId: "TIMING_TOP10", order: "selection-rank", description: "메인 종합타이밍 시장별 TOP10" },
  { id: "rebound", label: "반등우선 TOP10", kind: "selection", strategyId: "RANKING_V2_TOP10", order: "selection-rank", description: "Ranking V2 시장별 TOP10" },
  { id: "leader", label: "주도주 TOP10", kind: "selection", strategyId: "LEADER_TOP10", order: "selection-rank", description: "Leader 시장별 TOP10" },
  { id: "scout", label: "반등후보 TOP10", kind: "selection", strategyId: "SCOUT_TOP10", order: "selection-rank", description: "Scout 반등후보 시장별 TOP10" },
  { id: "strategy", label: "전략후보", kind: "derived", selector: "strategy-page", order: "strategy-page", description: "전략후보 화면의 확인 배지 후보" },
  { id: "cafe", label: "CAFE", kind: "selection", strategyId: "CAFE", order: "timing", description: "CAFE 통과 종목" },
  { id: "mtt", label: "MTT", kind: "selection", strategyId: "MTT", order: "timing", description: "MTT 통과 종목" }
]);

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function key(signalDate, market, code) {
  return `${signalDate}|${market}|${code}`;
}

function strategyCount(row) {
  return Number(row?.frozenConsensus?.strategyCount ?? 0);
}

function axisCount(row) {
  return Number(row?.frozenConsensus?.axisCount ?? 0);
}

function coreCandidate(row) {
  return finite(row?.factors?.leaderRank)
    && Number(row.factors.leaderRank) <= 10
    && strategyCount(row) >= 5
    && axisCount(row) >= 3;
}

function strongCandidate(row) {
  return row?.factors?.leaderGrade === "A"
    && finite(row?.factors?.rs20)
    && Number(row.factors.rs20) >= 80
    && axisCount(row) >= 3;
}

function strategyBadgeCount(row) {
  const f = row?.factors ?? {};
  return Number(f.leaderRebound === true)
    + Number(f.deepRecovery === true)
    + Number(f.cafe === true)
    + Number(f.mtt === true)
    + Number(f.flags?.H2 === true || f.flags?.H3 === true);
}

function basePriority(a, b) {
  return strategyCount(b) - strategyCount(a)
    || axisCount(b) - axisCount(a)
    || (Number(a?.factors?.leaderRank ?? 9999) - Number(b?.factors?.leaderRank ?? 9999))
    || (Number(b?.factors?.rs20 ?? -1) - Number(a?.factors?.rs20 ?? -1))
    || String(a.code).localeCompare(String(b.code));
}

function timingPriority(a, b) {
  return Number(b?.factors?.combinedTier ?? 0) - Number(a?.factors?.combinedTier ?? 0)
    || Number(b?.factors?.combinedScore ?? 0) - Number(a?.factors?.combinedScore ?? 0)
    || basePriority(a, b);
}

function strategyPagePriority(a, b) {
  const af = a?.factors ?? {};
  const bf = b?.factors ?? {};
  return strategyBadgeCount(b) - strategyBadgeCount(a)
    || Number(bf.leaderRebound === true) - Number(af.leaderRebound === true)
    || Number(bf.cafe === true && bf.mtt === true) - Number(af.cafe === true && af.mtt === true)
    || Number(af.riskScore ?? 100) - Number(bf.riskScore ?? 100)
    || Number(bf.stabilizeScore ?? 0) - Number(af.stabilizeScore ?? 0)
    || Number(bf.combinedScore ?? 0) - Number(af.combinedScore ?? 0)
    || basePriority(a, b);
}

function rowsAfterStart(records, startSignalDate) {
  return (records ?? []).filter((row) => row?.signalDate && row.signalDate >= startSignalDate);
}

function selectedRanks(selections, strategyId, startSignalDate) {
  const ranks = new Map();
  for (const selection of selections ?? []) {
    if (selection?.strategyId !== strategyId || !selection.signalDate || selection.signalDate < startSignalDate) continue;
    for (const member of selection.members ?? []) {
      ranks.set(key(selection.signalDate, selection.market, member.code), finite(member.rank) ? Number(member.rank) : null);
    }
  }
  return ranks;
}

function derivedPredicate(account, row) {
  if (account.selector === "core") return coreCandidate(row);
  if (account.selector === "strong-only") return strongCandidate(row) && !coreCandidate(row);
  if (account.selector === "strategy-page") return strategyBadgeCount(row) > 0;
  return false;
}

function priorityForAccount(account, rows, sourceRanks = new Map()) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.signalDate)) groups.set(row.signalDate, []);
    groups.get(row.signalDate).push(row);
  }
  const priorities = new Map();
  for (const dayRows of groups.values()) {
    const sorted = [...dayRows].sort((a, b) => {
      if (account.order === "selection-rank") {
        const ar = sourceRanks.get(key(a.signalDate, a.market, a.code));
        const br = sourceRanks.get(key(b.signalDate, b.market, b.code));
        const rankDiff = (finite(ar) ? Number(ar) : 9999) - (finite(br) ? Number(br) : 9999);
        if (rankDiff) return rankDiff;
        return basePriority(a, b);
      }
      if (account.order === "strategy-page") return strategyPagePriority(a, b);
      if (account.order === "timing") return timingPriority(a, b);
      return basePriority(a, b);
    });
    sorted.forEach((row, index) => priorities.set(key(row.signalDate, row.market, row.code), index + 1));
  }
  return priorities;
}

function prepareAccountInput(records, selections, account, arenaPolicy) {
  const eligible = rowsAfterStart(records, arenaPolicy.startSignalDate);
  let sourceRanks = new Map();
  let chosen;
  if (account.kind === "selection") {
    sourceRanks = selectedRanks(selections, account.strategyId, arenaPolicy.startSignalDate);
    chosen = eligible.filter((row) => sourceRanks.has(key(row.signalDate, row.market, row.code)));
  } else {
    chosen = eligible.filter((row) => derivedPredicate(account, row));
  }

  const priorities = priorityForAccount(account, chosen, sourceRanks);
  const preparedRecords = chosen.map((row) => ({
    ...row,
    paperPriority: priorities.get(key(row.signalDate, row.market, row.code)) ?? 999999
  }));

  const grouped = new Map();
  for (const row of preparedRecords) {
    const groupKey = `${row.signalDate}|${row.market}`;
    if (!grouped.has(groupKey)) grouped.set(groupKey, { signalDate: row.signalDate, market: row.market, members: [] });
    grouped.get(groupKey).members.push({ code: row.code, rank: row.paperPriority });
  }
  const syntheticSelections = [...grouped.values()].map((group) => ({
    signalDate: group.signalDate,
    market: group.market,
    strategyId: `PAPER_${account.id.toUpperCase()}`,
    members: group.members
  }));
  return { preparedRecords, syntheticSelections };
}

function accountPolicy(account, arenaPolicy) {
  return {
    ...PAPER_AUTO_POLICY,
    id: `paper-auto-v2-${account.id}-3d-20260907`,
    label: account.label,
    startSignalDate: arenaPolicy.startSignalDate,
    sourceStrategyId: `PAPER_${account.id.toUpperCase()}`,
    initialCapital: arenaPolicy.initialCapitalPerAccount,
    maxPositions: arenaPolicy.maxPositions,
    positionBudget: arenaPolicy.positionBudget,
    holdTradingDays: arenaPolicy.holdTradingDays,
    trackerRoundTripCostPct: arenaPolicy.trackerRoundTripCostPct,
    slippageByLiquidity: arenaPolicy.slippageByLiquidity,
    extraExecutionSlippagePct: arenaPolicy.slippageByLiquidity.midPct,
    effectiveFrictionPct: null,
    aiRole: arenaPolicy.aiRole,
    backfillBeforeStart: false
  };
}

export function buildPaperAutoArena({ records = [], selections = [], arenaPolicy = PAPER_AUTO_ARENA_POLICY } = {}) {
  const accounts = PAPER_AUTO_ACCOUNTS.map((account) => {
    const { preparedRecords, syntheticSelections } = prepareAccountInput(records, selections, account, arenaPolicy);
    const model = buildPaperAutoModel({
      records: preparedRecords,
      selections: syntheticSelections,
      policy: accountPolicy(account, arenaPolicy)
    });
    return {
      id: account.id,
      label: account.label,
      description: account.description,
      source: account.kind === "selection" ? account.strategyId : account.selector,
      ...model
    };
  });

  const ranked = [...accounts].sort((a, b) => Number(b.summary?.totalReturnPct ?? 0) - Number(a.summary?.totalReturnPct ?? 0));
  return {
    schemaVersion: "paper-auto-arena-v2",
    generatedAt: new Date().toISOString(),
    arenaPolicy,
    accounts,
    leaderboard: ranked.map((account, index) => ({
      rank: index + 1,
      id: account.id,
      label: account.label,
      totalReturnPct: account.summary.totalReturnPct,
      equity: account.summary.equity,
      closedTrades: account.summary.closedTrades,
      maxDrawdownPct: account.summary.maxDrawdownPct
    })),
    diagnostics: {
      realOrderApiUsed: false,
      aiAffectsOrders: false,
      accountCount: accounts.length,
      noBackfillBefore: arenaPolicy.startSignalDate,
      nextOpenGapIncluded: true,
      wholeShareSizing: true,
      cashAndCapacityEnforced: true,
      duplicateOpenBlocked: true,
      unmodeledMicrostructure: ["limit-up/down queue", "partial fills", "order-book depth beyond liquidity-score slippage proxy"]
    }
  };
}
