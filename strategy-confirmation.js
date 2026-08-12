const finite = (value) => Number.isFinite(Number(value));

function reboundState(scout = {}) {
  const drawdown = Number(scout.drawdownFromHighPct ?? 0);
  const stabilize = Number(scout.stabilizeScore ?? 0);
  const risk = Number(scout.riskScore ?? 100);
  if (risk >= 65) return { key: "risk", label: "고위험 / 제외", tone: "danger" };
  if (drawdown <= -20 && stabilize >= 65 && risk <= 35) return { key: "ready", label: "반등 1차 후보", tone: "buy" };
  if (drawdown <= -20 && stabilize >= 45 && risk <= 50) return { key: "stopped", label: "하락 정지 확인", tone: "watch" };
  if (scout.noNewLow5 && ((scout.slope5 ?? -1) > 0 || stabilize >= 35)) return { key: "early", label: "초기 반등 관찰", tone: "hold" };
  return { key: "falling", label: "아직 하락 중", tone: "danger" };
}

export function buildStrategyConfirmation(row = {}) {
  const leader = row.leader ?? {};
  const scout = row.scout ?? {};
  const supply = row.supply ?? {};
  const investor = row.investor ?? {};
  const flags = row.strategy?.flags ?? {};
  const drawdown52w = Number(leader.drawdown52wPct);
  const ret5 = finite(leader.ret5) ? Number(leader.ret5) : Number(scout.ret5);
  const foreign5 = Number(investor.foreignNetAmount5d ?? 0);
  const inst5 = Number(investor.instNetAmount5d ?? 0);
  const dayChange = Number(row.changeRate ?? row.strategy?.dayChangePct ?? 0);
  const change3d = Number(row.changeRate3d ?? row.strategy?.change3dPct ?? 0);

  // V2.1 CAFE_PULLBACK_5_20: technical + supply proxy, not a financial-results model.
  const cafePass = leader.grade === "A"
    && Boolean(leader.monthAboveMa5)
    && Boolean(leader.monthMa5Rising)
    && (foreign5 > 0 || inst5 > 0)
    && finite(drawdown52w) && drawdown52w >= -20 && drawdown52w <= -5
    && finite(ret5) && ret5 >= -8 && ret5 <= 2
    && dayChange < 10 && change3d < 12;

  // V2.1 Minervini MTT price-template proxy.
  const price = Number(row.price ?? leader.latest);
  const minerviniPass = finite(leader.ma200)
    && price > leader.ma150 && price > leader.ma200
    && leader.ma150 > leader.ma200
    && finite(leader.ma200Prev20) && leader.ma200 > leader.ma200Prev20
    && leader.ma50 > leader.ma150 && leader.ma50 > leader.ma200
    && price > leader.ma50
    && finite(leader.low52w) && price >= leader.low52w * 1.30
    && finite(leader.high52w) && price >= leader.high52w * 0.75;

  // Exact V2.1 LEADER_A_AND_SCOUT_STOP definition.
  const leaderReboundPass = leader.grade === "A"
    && Number(scout.stabilizeScore ?? 0) >= 45
    && Number(scout.riskScore ?? 100) <= 39
    && Number(scout.drawdownFromHighPct ?? 0) <= -20;
  const deepRecoveryPass = Number(scout.drawdownFromHighPct ?? 0) <= -35
    && Number(scout.stabilizeScore ?? 0) >= 45
    && Number(scout.riskScore ?? 100) <= 39;
  const experimentalNakjuPass = Boolean(flags.H2 || flags.H3);
  const state = reboundState(scout);
  const badges = [
    leaderReboundPass ? "좋은종목 반등" : null,
    deepRecoveryPass ? "깊은낙폭 회복" : null,
    cafePass ? "CAFE" : null,
    minerviniPass ? "MTT" : null,
    experimentalNakjuPass ? "실험: 낙주" : null
  ].filter(Boolean);

  return {
    cafePass,
    minerviniPass,
    leaderReboundPass,
    deepRecoveryPass,
    experimentalNakjuPass,
    cafeAndMtt: cafePass && minerviniPass,
    reboundState: state,
    badges,
    liquidityScore: Number(supply.liquidityScore ?? 0)
  };
}

