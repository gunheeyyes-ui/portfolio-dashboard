import { buildPaperAutoModel, PAPER_AUTO_POLICY } from "./paper-auto-service.js";
import { PAPER_AUTO_ACCOUNTS, PAPER_AUTO_ARENA_POLICY, PAPER_AUTO_EXIT_VARIANTS } from "./paper-auto-arena.js";
import { buildMarketStatusMap, classifyOutcomeIntegrity, isEntryBlocked, marketStatusKey } from "./market-integrity.js";

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

function prepareAccountInput(records, selections, account, arenaPolicy, statusMap) {
  const eligible = rowsAfterStart(records, arenaPolicy.startSignalDate);
  let sourceRanks = new Map();
  let chosen;
  if (account.kind === "selection") {
    sourceRanks = selectedRanks(selections, account.strategyId, arenaPolicy.startSignalDate);
    chosen = eligible.filter((row) => sourceRanks.has(key(row.signalDate, row.market, row.code)));
  } else {
    chosen = eligible.filter((row) => derivedPredicate(account, row));
  }

  const blocked = [];
  const tradable = [];
  for (const row of chosen) {
    const status = isEntryBlocked(row, statusMap);
    if (status) {
      blocked.push({
        signalDate: row.signalDate,
        market: row.market,
        code: row.code,
        name: row.name,
        reasons: status.blockReasons ?? ["MARKET_STATUS_BLOCK"],
        checkedAt: status.checkedAt,
        phase: status.phase
      });
    } else {
      tradable.push(row);
    }
  }

  const priorities = priorityForAccount(account, tradable, sourceRanks);
  const preparedRecords = tradable.map((row) => ({
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
  return { preparedRecords, syntheticSelections, blocked, originalSignalCount: chosen.length };
}

function accountPolicy(account, arenaPolicy, variant) {
  const stopTake = arenaPolicy.stopTakeExperiment ?? {};
  const isStopTake = variant.exitMode === "stop-take";
  return {
    ...PAPER_AUTO_POLICY,
    id: `paper-auto-v2-${account.id}-${variant.id}-20260907`,
    label: isStopTake ? `${account.label} · ${variant.label}` : account.label,
    startSignalDate: arenaPolicy.startSignalDate,
    sourceStrategyId: `PAPER_${account.id.toUpperCase()}`,
    initialCapital: arenaPolicy.initialCapitalPerAccount,
    maxPositions: arenaPolicy.maxPositions,
    positionBudget: arenaPolicy.positionBudget,
    holdTradingDays: arenaPolicy.holdTradingDays,
    exitMode: variant.exitMode,
    exitRule: isStopTake
      ? `stop ${variant.stopLossPct ?? stopTake.stopLossPct}% / take +${variant.takeProfitPct ?? stopTake.takeProfitPct}% / max ${arenaPolicy.holdTradingDays}D close`
      : `entry + ${arenaPolicy.holdTradingDays} trading days close`,
    stopLossPct: isStopTake ? Number(variant.stopLossPct ?? stopTake.stopLossPct) : null,
    takeProfitPct: isStopTake ? Number(variant.takeProfitPct ?? stopTake.takeProfitPct) : null,
    sameWindowTieBreak: isStopTake ? (variant.sameWindowTieBreak ?? stopTake.sameWindowTieBreak ?? "stop-first") : "stop-first",
    trackerRoundTripCostPct: arenaPolicy.trackerRoundTripCostPct,
    slippageByLiquidity: arenaPolicy.slippageByLiquidity,
    extraExecutionSlippagePct: arenaPolicy.slippageByLiquidity.midPct,
    effectiveFrictionPct: null,
    aiRole: arenaPolicy.aiRole,
    backfillBeforeStart: false
  };
}

function integrityOverlay(model, records, blocked, originalSignalCount, statusMap, arenaPolicy) {
  const recordIndex = new Map(records.map((row) => [marketStatusKey(row.signalDate, row.market, row.code), row]));
  const quarantinedTrades = [];
  for (const trade of model.closed ?? []) {
    const row = recordIndex.get(marketStatusKey(trade.signalDate, trade.market, trade.code));
    if (!row) continue;
    const integrity = classifyOutcomeIntegrity(row, arenaPolicy.holdTradingDays, statusMap);
    if (!integrity.comparable) quarantinedTrades.push({ ...trade, integrityReasons: integrity.reasons });
  }
  const quarantinedPnl = quarantinedTrades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const comparableEquity = Number(model.summary?.equity ?? arenaPolicy.initialCapitalPerAccount) - quarantinedPnl;
  const comparableReturnPct = (comparableEquity / Number(arenaPolicy.initialCapitalPerAccount) - 1) * 100;
  return {
    ...model,
    blocked,
    summary: {
      ...model.summary,
      signalCountBeforeIntegrity: originalSignalCount,
      marketStatusBlockedOrders: blocked.length,
      integrityQuarantinedClosedTrades: quarantinedTrades.length,
      comparableEquity: Math.round(comparableEquity),
      comparableReturnPct: Number(comparableReturnPct.toFixed(3))
    },
    integrity: {
      rawPnlPreserved: true,
      quarantinedTrades,
      quarantinedPnl: Math.round(quarantinedPnl),
      comparableMethod: "raw equity minus quarantined trade PnL; capacity history is not rewritten"
    }
  };
}

function buildAccountVariant(account, variant, prepared, arenaPolicy, statusMap) {
  const model = buildPaperAutoModel({
    records: prepared.preparedRecords,
    selections: prepared.syntheticSelections,
    policy: accountPolicy(account, arenaPolicy, variant)
  });
  const overlaid = integrityOverlay(model, prepared.preparedRecords, prepared.blocked, prepared.originalSignalCount, statusMap, arenaPolicy);
  const isBaseline = variant.id === "fixed3d";
  return {
    id: isBaseline ? account.id : `${account.id}-${variant.id}`,
    baseId: account.id,
    exitVariant: variant.id,
    label: isBaseline ? account.label : `${account.label} · ${variant.label}`,
    description: `${account.description} · ${isBaseline ? "3D 고정청산" : "-5% 손절 / +8% 익절"}`,
    source: account.kind === "selection" ? account.strategyId : account.selector,
    ...overlaid
  };
}

export function buildPaperAutoIntegrityArena({ records = [], selections = [], marketStatuses = [], arenaPolicy = PAPER_AUTO_ARENA_POLICY } = {}) {
  const statusMap = buildMarketStatusMap(marketStatuses);
  const preparedByAccount = new Map(PAPER_AUTO_ACCOUNTS.map((account) => [
    account.id,
    prepareAccountInput(records, selections, account, arenaPolicy, statusMap)
  ]));
  const comparisonAccounts = PAPER_AUTO_ACCOUNTS.flatMap((account) => {
    const prepared = preparedByAccount.get(account.id);
    return PAPER_AUTO_EXIT_VARIANTS.map((variant) => buildAccountVariant(account, variant, prepared, arenaPolicy, statusMap));
  });
  const accounts = comparisonAccounts.filter((account) => account.exitVariant === "fixed3d");
  const ranked = [...comparisonAccounts].sort((a, b) => Number(b.summary?.comparableReturnPct ?? b.summary?.totalReturnPct ?? 0) - Number(a.summary?.comparableReturnPct ?? a.summary?.totalReturnPct ?? 0));
  return {
    schemaVersion: "paper-auto-arena-v2-integrity1",
    generatedAt: new Date().toISOString(),
    arenaPolicy,
    accounts,
    comparisonAccounts,
    exitVariants: PAPER_AUTO_EXIT_VARIANTS,
    leaderboard: ranked.map((account, index) => ({
      rank: index + 1,
      id: account.id,
      baseId: account.baseId,
      exitVariant: account.exitVariant,
      label: account.label,
      totalReturnPct: account.summary.totalReturnPct,
      comparableReturnPct: account.summary.comparableReturnPct,
      equity: account.summary.equity,
      closedTrades: account.summary.closedTrades,
      maxDrawdownPct: account.summary.maxDrawdownPct
    })),
    diagnostics: {
      realOrderApiUsed: false,
      aiAffectsOrders: false,
      accountCount: accounts.length,
      comparisonAccountCount: comparisonAccounts.length,
      exitVariantCount: PAPER_AUTO_EXIT_VARIANTS.length,
      noBackfillBefore: arenaPolicy.startSignalDate,
      marketStatusSnapshots: marketStatuses.length,
      marketStatusPreEntryBlockEnabled: true,
      rawPnlPreserved: true,
      futureOutcomeNeverCancelsHistoricalOrder: true,
      nextOpenGapIncluded: true,
      wholeShareSizing: true,
      cashAndCapacityEnforced: true,
      duplicateOpenBlocked: true,
      stopTakeUsesStoredExcursionWindows: true,
      sameWindowBothHitPolicy: "stop-first",
      unmodeledMicrostructure: [
        "limit-up/down queue",
        "partial fills",
        "order-book depth beyond liquidity-score slippage proxy",
        "exact intraday ordering when stop and take are both touched inside one stored OOS window"
      ]
    }
  };
}
