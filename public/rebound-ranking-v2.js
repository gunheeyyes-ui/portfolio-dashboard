const scoutStatuses = new Set(["정찰병 1주", "하락 정지 확인"]);

function finite(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

function isExistingHardBlock(row) {
  const combined = row?.combined ?? {};
  const flags = row?.strategy?.flags ?? {};
  const risk = row?.scout?.riskScore;
  const drawdown = row?.scout?.drawdownFromHighPct;
  const dayChange = Number(row?.changeRate ?? row?.strategy?.dayChangePct ?? 0);
  const change3d = Number(row?.changeRate3d ?? row?.strategy?.change3dPct ?? 0);
  const gateReason = combined.gateReason;
  return combined.blocked === true
    || flags.I === true
    || Number(risk) >= 65
    || !finite(risk)
    || !finite(drawdown)
    || row?.scout?.status === "계산불가"
    || row?.scout?.status === "추가매수 금지"
    || combined.label === "계산불가"
    || combined.label === "매수보류"
    || combined.label === "추격주의"
    || (gateReason && gateReason !== "PASS")
    || Boolean(row?.strategy?.overheat)
    || dayChange >= 10
    || change3d >= 12;
}

export function reboundRankingTier(row) {
  if (isExistingHardBlock(row)) return 6;
  const drawdown = Number(row.scout.drawdownFromHighPct);
  const risk = Number(row.scout.riskScore);
  const status = row.scout.status;
  const mtt = row.confirmation?.minerviniPass === true;

  if (drawdown <= -20 && drawdown >= -40 && mtt && risk <= 39) return 1;
  if (drawdown <= -20 && risk <= 50 && scoutStatuses.has(status)) return 2;
  if (drawdown <= -20 && risk <= 39) return 3;
  if (drawdown <= -20 && risk < 65) return 4;
  if (drawdown > -20) return 5;
  return 6;
}

export function strategyPriority(row) {
  const cafe = row?.confirmation?.cafePass === true;
  const mtt = row?.confirmation?.minerviniPass === true;
  if (cafe && mtt) return 0;
  if (mtt) return 1;
  if (cafe) return 2;
  return 3;
}

export function stabilizeBand(score) {
  if (!finite(score)) return 6;
  const value = Number(score);
  if (value >= 90) return 0;
  if (value >= 80) return 1;
  if (value >= 70) return 2;
  if (value >= 60) return 3;
  if (value >= 45) return 4;
  return 5;
}

export function riskBand(score) {
  if (!finite(score)) return 5;
  const value = Number(score);
  if (value <= 24) return 0;
  if (value <= 39) return 1;
  if (value <= 50) return 2;
  if (value <= 64) return 3;
  return 4;
}

export function drawdownBand(drawdown) {
  if (!finite(drawdown)) return 5;
  const value = Number(drawdown);
  if (value <= -20 && value >= -40) return 0;
  if (value < -40 && value >= -50) return 1;
  if (value < -50) return 2;
  if (value <= -15) return 3;
  return 4;
}

function descending(a, b, fallback = 0) {
  return Number(b ?? fallback) - Number(a ?? fallback);
}

// Review-priority ranking only; not an investment score.
export function compareReboundRankingV2(a, b) {
  const aSupply = a?.supply ?? {};
  const bSupply = b?.supply ?? {};
  const aScout = a?.scout ?? {};
  const bScout = b?.scout ?? {};
  const aStreakSum = Number(aSupply.foreignStreak ?? 0) + Number(aSupply.instStreak ?? 0);
  const bStreakSum = Number(bSupply.foreignStreak ?? 0) + Number(bSupply.instStreak ?? 0);
  const aStreakMax = Math.max(Number(aSupply.foreignStreak ?? 0), Number(aSupply.instStreak ?? 0));
  const bStreakMax = Math.max(Number(bSupply.foreignStreak ?? 0), Number(bSupply.instStreak ?? 0));

  return reboundRankingTier(a) - reboundRankingTier(b)
    || strategyPriority(a) - strategyPriority(b)
    || stabilizeBand(aScout.stabilizeScore) - stabilizeBand(bScout.stabilizeScore)
    || descending(a?.leader?.score, b?.leader?.score, -1)
    || riskBand(aScout.riskScore) - riskBand(bScout.riskScore)
    || drawdownBand(aScout.drawdownFromHighPct) - drawdownBand(bScout.drawdownFromHighPct)
    || descending(aSupply.liquidityScore, bSupply.liquidityScore)
    || descending(aSupply.totalNetAmount, bSupply.totalNetAmount)
    || bStreakSum - aStreakSum
    || bStreakMax - aStreakMax
    || descending(aSupply.smartMoneyBodyPct, bSupply.smartMoneyBodyPct)
    || descending(aSupply.smartMoneyTradingSharePct, bSupply.smartMoneyTradingSharePct)
    || descending(a?.combined?.score, b?.combined?.score)
    || descending(aScout.stabilizeScore, bScout.stabilizeScore)
    || String(a?.code ?? "").localeCompare(String(b?.code ?? ""));
}

export function rankMarketRowsV2(rows) {
  return [...rows].sort(compareReboundRankingV2);
}
