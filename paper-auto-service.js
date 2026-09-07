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
  holdTradingDays: 3,
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

function paperReturnPct(sourceReturnPct, policy) {
  return finite(sourceReturnPct) ? Number(sourceReturnPct) - Number(policy.extraExecutionSlippagePct || 0) : null;
}

function openPositionView(position, policy) {
  const row = position.row;
  const sourceReturnPct = finite(row?.live?.currentReturnPct) ? Number(row.live.currentReturnPct) : 0;
  const currentReturnPct = paperReturnPct(sourceReturnPct, policy);
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
    marketValue: round(marketValue, 0),
    unrealizedPnl: round(marketValue - position.principal, 0),
    strategyCount: strategyCount(row),
    axisCount: axisCount(row),
    leaderRank: finite(row?.factors?.leaderRank) ? Number(row.factors.leaderRank) : null,
    rs20: finite(row?.factors?.rs20) ? Number(row.factors.rs20) : null,
    plannedExit: `${policy.holdTradingDays}거래일 종가`
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
    .map((row) => ({ ...row, entryKey: String(row.entryDate) }));
  const byEntry = new Map();
  const exitDates = new Set();
  for (const row of fillable) {
    if (!byEntry.has(row.entryKey)) byEntry.set(row.entryKey, []);
    byEntry.get(row.entryKey).push(row);
    const exit = row?.outcomes?.[String(policy.holdTradingDays)];
    if (exit?.targetTradingDate) exitDates.add(String(exit.targetTradingDate));
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
      const quantity = Math.floor(Number(policy.positionBudget) / entryPrice);
      if (quantity < 1) {
        skipped.push({ signalDate: row.signalDate, entryDate: row.entryDate, code: row.code, name: row.name, reason: "BUDGET_TOO_SMALL" });
        continue;
      }
      const principal = quantity * entryPrice;
      if (cash + 1e-6 < principal) {
        skipped.push({ signalDate: row.signalDate, entryDate: row.entryDate, code: row.code, name: row.name, reason: "INSUFFICIENT_CASH" });
        continue;
      }
      cash -= principal;
      active.push({ row, quantity, principal });
    }

    const closing = active.filter((position) => {
      const exit = position.row?.outcomes?.[String(policy.holdTradingDays)];
      return String(exit?.targetTradingDate ?? "") === date;
    });
    if (closing.length) {
      for (const position of closing) {
        const exit = position.row.outcomes[String(policy.holdTradingDays)];
        const sourceNetReturnPct = Number(exit.netReturnPct);
        const effectiveReturnPct = paperReturnPct(sourceNetReturnPct, policy);
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
          exitDate: String(exit.targetTradingDate),
          exitPrice: finite(exit.exitPrice) ? Number(exit.exitPrice) : null,
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
      initialCapital: Number(policy.initialCapital),
      cash: round(cash, 0),
      equity: round(equity, 0),
      totalReturnPct: round((equity / Number(policy.initialCapital) - 1) * 100),
      realizedPnl: round(realizedPnl, 0),
      unrealizedPnl: round(unrealizedPnl, 0),
      winRatePct: closedReturns.length ? round((closedReturns.filter((value) => value > 0).length / closedReturns.length) * 100, 1) : null,
      averageTradeReturnPct: round(average(closedReturns)),
      profitFactor: round(profitFactor(closedReturns), 2),
      maxDrawdownPct: round(drawdownFromCurve(curve, Number(policy.initialCapital)))
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
      aiAffectsOrders: false,
      realOrderApiUsed: false
    }
  };
}
