export const PAPER_AUTO_POLICY = Object.freeze({
  id: "paper-auto-v1-actual-3d-20260907",
  label: "Shadow Auto V1",
  frozenAt: "2026-09-07T10:10:00.000Z",
  startSignalDate: "2026-09-07",
  sourceStrategyId: "ACTIONABLE_ALL",
  initialCapital: 100_000_000,
  maxPositions: 10,
  positionBudget: 10_000_000,
  entryRule: "signal EOD -> next trading-day open",
  exitRule: "entry + 3 trading days close",
  exitMode: "fixed-hold",
  holdTradingDays: 3,
  stopLossPct: null,
  takeProfitPct: null,
  sameWindowTieBreak: "stop-first",
  trackerRoundTripCostPct: 0.23,
  extraExecutionSlippagePct: 0.20,
  effectiveFrictionPct: 0.43,
  allowLeverage: false,
  allowShort: false,
  aiRole: "observe-only",
  backfillBeforeStart: false
});

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

function profitFactor(values) {
  const clean = values.filter(finite).map(Number);
  const gains = clean.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(clean.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  if (!clean.length || !losses) return null;
  return gains / losses;
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

function prioritySort(a, b) {
  const paperA = finite(a?.paperPriority) ? Number(a.paperPriority) : 999999;
  const paperB = finite(b?.paperPriority) ? Number(b.paperPriority) : 999999;
  if (paperA !== paperB) return paperA - paperB;
  return strategyCount(b) - strategyCount(a)
    || axisCount(b) - axisCount(a)
    || (Number(a?.factors?.leaderRank ?? 9999) - Number(b?.factors?.leaderRank ?? 9999))
    || (Number(b?.factors?.rs20 ?? -1) - Number(a?.factors?.rs20 ?? -1))
    || String(a.code).localeCompare(String(b.code));
}

function drawdownFromCurve(curve, initialCapital) {
  let peak = initialCapital;
  let maxDrawdownPct = 0;
  for (const point of curve) {
    if (!finite(point?.equity)) continue;
    peak = Math.max(peak, Number(point.equity));
    if (peak > 0) maxDrawdownPct = Math.min(maxDrawdownPct, (Number(point.equity) / peak - 1) * 100);
  }
  return maxDrawdownPct;
}

function selectedRecordKeys(selections, policy) {
  const result = [];
  const seen = new Set();
  for (const selection of selections ?? []) {
    if (selection?.strategyId !== policy.sourceStrategyId) continue;
    if (!selection?.signalDate || selection.signalDate < policy.startSignalDate) continue;
    for (const member of selection.members ?? []) {
      const recordKey = key(selection.signalDate, selection.market, member.code);
      if (seen.has(recordKey)) continue;
      seen.add(recordKey);
      result.push(recordKey);
    }
  }
  return result;
}

export function executionSlippagePct(row, policy = PAPER_AUTO_POLICY) {
  const tiers = policy?.slippageByLiquidity;
  if (tiers) {
    const liquidity = finite(row?.factors?.liquidityScore) ? Number(row.factors.liquidityScore) : null;
    if (liquidity !== null && liquidity >= Number(tiers.highThreshold ?? 70)) return Number(tiers.highPct ?? 0.10);
    if (liquidity !== null && liquidity >= Number(tiers.midThreshold ?? 45)) return Number(tiers.midPct ?? 0.20);
    return Number(tiers.lowPct ?? 0.35);
  }
  return Number(policy?.extraExecutionSlippagePct || 0);
}

function paperReturnPct(sourceReturnPct, row, policy) {
  return finite(sourceReturnPct) ? Number(sourceReturnPct) - executionSlippagePct(row, policy) : null;
}

function fixedHoldExit(row, policy) {
  const horizon = String(policy.holdTradingDays);
  const outcome = row?.outcomes?.[horizon];
  if (!outcome?.targetTradingDate || !finite(outcome.netReturnPct)) return null;
  return {
    reason: "TIME_EXIT",
    targetTradingDate: String(outcome.targetTradingDate),
    sourceNetReturnPct: Number(outcome.netReturnPct),
    grossReturnPct: finite(outcome.grossReturnPct) ? Number(outcome.grossReturnPct) : null,
    exitPrice: finite(outcome.exitPrice) ? Number(outcome.exitPrice) : null,
    triggerWindowHorizon: Number(policy.holdTradingDays),
    ambiguousBothHit: false
  };
}

function stopTakeStages(row, policy) {
  const stages = [];
  if (row?.entryDayOutcome) {
    stages.push({ horizon: 0, outcome: row.entryDayOutcome, targetTradingDate: row.entryDayOutcome.targetTradingDate || row.entryDate });
  }
  const numeric = Object.entries(row?.outcomes ?? {})
    .map(([horizon, outcome]) => ({ horizon: Number(horizon), outcome, targetTradingDate: outcome?.targetTradingDate }))
    .filter((stage) => Number.isFinite(stage.horizon) && stage.horizon > 0 && stage.horizon <= Number(policy.holdTradingDays))
    .sort((a, b) => a.horizon - b.horizon);
  stages.push(...numeric);
  return stages;
}

export function resolvePaperExit(row, policy = PAPER_AUTO_POLICY) {
  if (policy?.exitMode !== "stop-take") return fixedHoldExit(row, policy);

  const stopLossPct = finite(policy.stopLossPct) ? Number(policy.stopLossPct) : null;
  const takeProfitPct = finite(policy.takeProfitPct) ? Number(policy.takeProfitPct) : null;
  if (stopLossPct === null || takeProfitPct === null) return fixedHoldExit(row, policy);

  for (const stage of stopTakeStages(row, policy)) {
    const outcome = stage.outcome ?? {};
    const hitStop = finite(outcome.maePct) && Number(outcome.maePct) <= stopLossPct;
    const hitTake = finite(outcome.mfePct) && Number(outcome.mfePct) >= takeProfitPct;
    if (!hitStop && !hitTake) continue;

    const both = hitStop && hitTake;
    const stopFirst = both ? policy.sameWindowTieBreak !== "take-first" : hitStop;
    const grossReturnPct = stopFirst ? stopLossPct : takeProfitPct;
    const reason = stopFirst ? (both ? "STOP_LOSS_AMBIGUOUS" : "STOP_LOSS") : "TAKE_PROFIT";
    const entryOpen = finite(row?.entryOpen) ? Number(row.entryOpen) : null;
    return {
      reason,
      targetTradingDate: String(stage.targetTradingDate || row.entryDate || ""),
      sourceNetReturnPct: grossReturnPct - Number(policy.trackerRoundTripCostPct || 0),
      grossReturnPct,
      exitPrice: entryOpen !== null ? entryOpen * (1 + grossReturnPct / 100) : null,
      triggerWindowHorizon: stage.horizon,
      ambiguousBothHit: both
    };
  }

  return fixedHoldExit(row, policy);
}

function plannedExitText(policy) {
  if (policy?.exitMode === "stop-take") {
    return `SL ${policy.stopLossPct}% / TP +${policy.takeProfitPct}% / 최대 ${policy.holdTradingDays}D`;
  }
  return `${policy.holdTradingDays}거래일 종가`;
}

function openPositionView(position, policy) {
  const row = position.row;
  const sourceReturnPct = finite(row?.live?.currentReturnPct) ? Number(row.live.currentReturnPct) : 0;
  const slipPct = executionSlippagePct(row, policy);
  const currentReturnPct = paperReturnPct(sourceReturnPct, row, policy);
  const marketValue = position.principal * (1 + currentReturnPct / 100);
  return {
    signalDate: row.signalDate,
    market: row.market,
    code: row.code,
    name: row.name,
    entryDate: row.entryDate,
    entryPrice: Number(row.entryOpen),
    quantity: position.quantity,
    principal: round(position.principal, 0),
    currentPrice: finite(row?.live?.currentPrice) ? Number(row.live.currentPrice) : null,
    tradingDaysElapsed: finite(row?.live?.tradingDaysElapsed) ? Number(row.live.tradingDaysElapsed) : null,
    sourceNetReturnPct: round(sourceReturnPct),
    paperReturnPct: round(currentReturnPct),
    executionSlippagePct: round(slipPct),
    effectiveFrictionPct: round(Number(policy.trackerRoundTripCostPct || 0) + slipPct),
    marketValue: round(marketValue, 0),
    unrealizedPnl: round(marketValue - position.principal, 0),
    strategyCount: strategyCount(row),
    axisCount: axisCount(row),
    leaderRank: finite(row?.factors?.leaderRank) ? Number(row.factors.leaderRank) : null,
    rs20: finite(row?.factors?.rs20) ? Number(row.factors.rs20) : null,
    plannedExit: plannedExitText(policy)
  };
}

export function buildPaperAutoModel({ records = [], selections = [], policy = PAPER_AUTO_POLICY } = {}) {
  const recordIndex = new Map((records ?? []).map((row) => [key(row.signalDate, row.market, row.code), row]));
  const selectedKeys = selectedRecordKeys(selections, policy);
  const missingRecordKeys = selectedKeys.filter((recordKey) => !recordIndex.has(recordKey));
  const rows = selectedKeys.map((recordKey) => recordIndex.get(recordKey)).filter(Boolean);

  const queued = rows
    .filter((row) => !row.entryDate || !finite(row.entryOpen) || Number(row.entryOpen) <= 0)
    .sort((a, b) => String(b.signalDate).localeCompare(String(a.signalDate)) || prioritySort(a, b))
    .map((row) => ({
      signalDate: row.signalDate,
      market: row.market,
      code: row.code,
      name: row.name,
      signalPrice: finite(row.signalPrice) ? Number(row.signalPrice) : null,
      strategyCount: strategyCount(row),
      axisCount: axisCount(row),
      status: "QUEUED_NEXT_OPEN"
    }));

  const fillable = rows
    .filter((row) => row.entryDate && finite(row.entryOpen) && Number(row.entryOpen) > 0)
    .map((row) => ({ ...row, entryKey: String(row.entryDate), paperResolvedExit: resolvePaperExit(row, policy) }));
  const byEntry = new Map();
  const exitDates = new Set();
  for (const row of fillable) {
    if (!byEntry.has(row.entryKey)) byEntry.set(row.entryKey, []);
    byEntry.get(row.entryKey).push(row);
    if (row.paperResolvedExit?.targetTradingDate) exitDates.add(String(row.paperResolvedExit.targetTradingDate));
  }

  const dates = [...new Set([...byEntry.keys(), ...exitDates])].sort();
  let cash = Number(policy.initialCapital);
  let active = [];
  const closed = [];
  const skipped = [];
  const curve = [{ date: null, equity: Number(policy.initialCapital) }];

  for (const date of dates) {
    const entries = [...(byEntry.get(date) ?? [])].sort(prioritySort);
    for (const row of entries) {
      if (active.some((position) => position.row.code === row.code)) {
        skipped.push({ signalDate: row.signalDate, entryDate: row.entryDate, code: row.code, name: row.name, reason: "DUPLICATE_OPEN" });
        continue;
      }
      if (active.length >= Number(policy.maxPositions)) {
        skipped.push({ signalDate: row.signalDate, entryDate: row.entryDate, code: row.code, name: row.name, reason: "MAX_POSITIONS" });
        continue;
      }
      const entryPrice = Number(row.entryOpen);
      const slipPct = executionSlippagePct(row, policy);
      const entryFillPrice = policy?.slippageByLiquidity ? entryPrice * (1 + slipPct / 200) : entryPrice;
      const quantity = Math.floor(Number(policy.positionBudget) / entryFillPrice);
      if (quantity < 1) {
        skipped.push({ signalDate: row.signalDate, entryDate: row.entryDate, code: row.code, name: row.name, reason: "BUDGET_TOO_SMALL" });
        continue;
      }
      const principal = quantity * entryFillPrice;
      if (cash + 1e-6 < principal) {
        skipped.push({ signalDate: row.signalDate, entryDate: row.entryDate, code: row.code, name: row.name, reason: "INSUFFICIENT_CASH" });
        continue;
      }
      cash -= principal;
      active.push({ row, quantity, principal, resolvedExit: row.paperResolvedExit });
    }

    const closing = active.filter((position) => String(position.resolvedExit?.targetTradingDate ?? "") === date);
    if (closing.length) {
      for (const position of closing) {
        const exit = position.resolvedExit;
        const sourceNetReturnPct = Number(exit.sourceNetReturnPct);
        const slipPct = executionSlippagePct(position.row, policy);
        const effectiveReturnPct = paperReturnPct(sourceNetReturnPct, position.row, policy);
        const proceeds = position.principal * (1 + effectiveReturnPct / 100);
        const pnl = proceeds - position.principal;
        cash += proceeds;
        closed.push({
          signalDate: position.row.signalDate,
          market: position.row.market,
          code: position.row.code,
          name: position.row.name,
          entryDate: position.row.entryDate,
          entryPrice: Number(position.row.entryOpen),
          entryFillPrice: round(policy?.slippageByLiquidity ? Number(position.row.entryOpen) * (1 + slipPct / 200) : Number(position.row.entryOpen)),
          exitDate: String(exit.targetTradingDate),
          exitPrice: finite(exit.exitPrice) ? round(Number(exit.exitPrice)) : null,
          exitFillPrice: finite(exit.exitPrice) ? round(Number(exit.exitPrice) * (1 - slipPct / 200)) : null,
          exitReason: exit.reason,
          triggerWindowHorizon: exit.triggerWindowHorizon,
          ambiguousTrigger: exit.ambiguousBothHit === true,
          executionSlippagePct: round(slipPct),
          effectiveFrictionPct: round(Number(policy.trackerRoundTripCostPct || 0) + slipPct),
          quantity: position.quantity,
          principal: round(position.principal, 0),
          sourceNetReturnPct: round(sourceNetReturnPct),
          paperReturnPct: round(effectiveReturnPct),
          pnl: round(pnl, 0),
          strategyCount: strategyCount(position.row),
          axisCount: axisCount(position.row)
        });
      }
      active = active.filter((position) => !closing.includes(position));
      const openViews = active.map((position) => openPositionView(position, policy));
      const equity = cash + openViews.reduce((sum, position) => sum + Number(position.marketValue || 0), 0);
      curve.push({ date, equity: round(equity, 0) });
    }
  }

  const open = active.map((position) => openPositionView(position, policy));
  const openMarketValue = open.reduce((sum, position) => sum + Number(position.marketValue || 0), 0);
  const equity = cash + openMarketValue;
  const realizedPnl = closed.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const unrealizedPnl = open.reduce((sum, position) => sum + Number(position.unrealizedPnl || 0), 0);
  const closedReturns = closed.map((trade) => trade.paperReturnPct).filter(finite).map(Number);
  const allSlip = [...closed.map((trade) => trade.executionSlippagePct), ...open.map((position) => position.executionSlippagePct)].filter(finite).map(Number);

  return {
    schemaVersion: "paper-auto-v1",
    generatedAt: new Date().toISOString(),
    policy,
    summary: {
      signalCount: rows.length,
      queuedOrders: queued.length,
      openPositions: open.length,
      closedTrades: closed.length,
      skippedOrders: skipped.length,
      stopLossExits: closed.filter((trade) => String(trade.exitReason).startsWith("STOP_LOSS")).length,
      takeProfitExits: closed.filter((trade) => trade.exitReason === "TAKE_PROFIT").length,
      timeExits: closed.filter((trade) => trade.exitReason === "TIME_EXIT").length,
      ambiguousStopFirstExits: closed.filter((trade) => trade.exitReason === "STOP_LOSS_AMBIGUOUS").length,
      initialCapital: Number(policy.initialCapital),
      cash: round(cash, 0),
      equity: round(equity, 0),
      totalReturnPct: round((equity / Number(policy.initialCapital) - 1) * 100),
      realizedPnl: round(realizedPnl, 0),
      unrealizedPnl: round(unrealizedPnl, 0),
      winRatePct: closedReturns.length ? round((closedReturns.filter((value) => value > 0).length / closedReturns.length) * 100, 1) : null,
      averageTradeReturnPct: round(average(closedReturns)),
      profitFactor: round(profitFactor(closedReturns), 2),
      maxDrawdownPct: round(drawdownFromCurve(curve, Number(policy.initialCapital))),
      averageExecutionSlippagePct: round(average(allSlip)),
      averageEffectiveFrictionPct: round((Number(policy.trackerRoundTripCostPct || 0)) + (average(allSlip) ?? Number(policy.extraExecutionSlippagePct || 0)))
    },
    queued,
    open: open.sort((a, b) => String(b.entryDate).localeCompare(String(a.entryDate)) || String(a.code).localeCompare(String(b.code))),
    closed: closed.sort((a, b) => String(b.exitDate).localeCompare(String(a.exitDate)) || String(a.code).localeCompare(String(b.code))),
    skipped: skipped.slice(-100).reverse(),
    curve: curve.slice(-120),
    diagnostics: {
      selectedKeys: selectedKeys.length,
      missingRecordKeys,
      noBackfillBefore: policy.startSignalDate,
      exitMode: policy.exitMode,
      stopLossPct: policy.stopLossPct,
      takeProfitPct: policy.takeProfitPct,
      sameWindowTieBreak: policy.sameWindowTieBreak,
      intradaySequenceKnown: false,
      aiAffectsOrders: false,
      realOrderApiUsed: false
    }
  };
}
