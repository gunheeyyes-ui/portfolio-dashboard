// Entry verdict used by the simulator (which stocks it opens positions on) and
// surfaced on the main table as `simCategory`.
//
// Extracted verbatim from server.mjs so the strategy OOS tracker and its tests
// can score "진입후보" with the exact same function the live simulator uses,
// instead of re-implementing (and eventually drifting from) the rule. The
// judgement itself is unchanged: do not edit the thresholds here without
// deciding to change the live simulator.
export function simulationCategory(row) {
  const flags = row.strategy?.flags ?? {};
  const supply = row.supply ?? {};
  const dayChange = row.changeRate ?? row.strategy?.dayChangePct ?? 0;
  const change3d = row.changeRate3d ?? row.strategy?.change3dPct ?? 0;
  const overheat = Boolean(row.strategy?.overheat) || dayChange >= 10 || change3d >= 12;
  const streak = (supply.foreignStreak ?? 0) >= 2 || (supply.instStreak ?? 0) >= 2;
  const smartMoney = (supply.smartMoneyBodyPct ?? 0) >= 0.3 || (supply.smartMoneyTradingSharePct ?? 0) >= 10;
  const explosion = (supply.tradingValueRatio20 ?? 0) >= 3;

  if (flags.I) return { key: "avoid", label: "매수보류", targetDays: 0, actionable: false, tone: "danger" };
  if (overheat) return { key: "overheat", label: "추격주의", targetDays: 0, actionable: false, tone: "danger" };
  if (flags.H3) return { key: "special", label: "단기 특수", targetDays: 3, actionable: true, tone: "watch" };
  if (flags.R) return { key: "ready", label: "우선 검토", targetDays: 5, actionable: true, tone: "buy" };
  if (flags.F || flags.F2 || (flags.B && (supply.liquidityScore ?? 0) >= 50)) {
    return { key: "candidate", label: "분할 후보", targetDays: 10, actionable: true, tone: "buy" };
  }
  if (streak || smartMoney || explosion || flags.C) return { key: "observe", label: "관심 관찰", targetDays: 0, actionable: false, tone: "hold" };
  return { key: "none", label: "관망", targetDays: 0, actionable: false, tone: "hold" };
}
