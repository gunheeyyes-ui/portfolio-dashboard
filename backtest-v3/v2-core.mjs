// V2 computation core, extracted verbatim from backtest-lab-v2.mjs so that
// V3 reproduces the existing Scout / combined-score / flag maths exactly
// rather than reimplementing it. backtest-lab-v2.mjs itself is left
// untouched; selftest.mjs compares this adapter against V2 output.
//

export const LIQUIDITY_BINS = [[0,29],[30,39],[40,49],[50,59],[60,69],[70,79],[80,89],[90,100]];
export const eok = 100000000;
// Injected by the V3 runner before use so cost/horizons stay CLI-driven.
export const runtime = { roundTripCostPct: 0.23, holdingDaysList: [1,3,5,10,20,60] };

// Point-in-time only: every function receives history slices that end at the
// signal date, and none of them look at later rows.

export function calcScoutBaseAt(history) {
  const rows = history.slice(-520).filter((x) => Number.isFinite(x.close));
  const closes = rows.map((x) => x.close);
  const latest = closes.at(-1) ?? null;
  if (!latest) return null;
  const high2y = Math.max(...closes);
  const low2y = Math.min(...closes);
  const median2y = median(closes);
  const rawPos = high2y > low2y ? ((latest - low2y) / (high2y - low2y)) * 100 : null;
  const ma5 = maAt(closes, 5);
  const ma20 = maAt(closes, 20);
  const ma60 = maAt(closes, 60);
  const ma120 = maAt(closes, 120);
  const daysSinceLow = countDaysSinceLatestLow(rows);
  const vol = volumeProfile(rows);
  return {
    dataDays: rows.length,
    enoughData: rows.length >= 360,
    high2y,
    low2y,
    median2y,
    pricePositionPct: Number.isFinite(rawPos) ? clamp(rawPos, 0, 100) : null,
    drawdownFromHighPct: high2y ? (latest / high2y - 1) * 100 : null,
    reboundFromLowPct: low2y ? (latest / low2y - 1) * 100 : null,
    medianGapPct: median2y ? (latest / median2y - 1) * 100 : null,
    ma5, ma20, ma60, ma120,
    dist5: ma5 ? (latest / ma5 - 1) * 100 : null,
    dist20: ma20 ? (latest / ma20 - 1) * 100 : null,
    dist60: ma60 ? (latest / ma60 - 1) * 100 : null,
    dist120: ma120 ? (latest / ma120 - 1) * 100 : null,
    slope5: slopePct(closes, 5),
    slope20: slopePct(closes, 20),
    slope60: slopePct(closes, 60),
    slope120: slopePct(closes, 120),
    daysSinceLow,
    noNewLow5: Number.isFinite(daysSinceLow) ? daysSinceLow >= 5 : false,
    ret5: returnPctFrom(closes, 5),
    ret20: returnPctFrom(closes, 20),
    volumeUpDownRatio: vol.upAvg && vol.downAvg ? vol.upAvg / vol.downAvg : null,
    volumeImproving: vol.improving,
    volatility20: calcVolatility(closes, 20)
  };
}

export function calcLeaderBaseAt(history) {
  const rows = history.filter((x) => Number.isFinite(x.close));
  const closes = rows.map((x) => x.close);
  const latest = closes.at(-1) ?? null;
  if (!latest) return null;
  const ma20 = maAt(closes, 20);
  const ma50 = maAt(closes, 50);
  const ma60 = maAt(closes, 60);
  const ma120 = maAt(closes, 120);
  const ma150 = maAt(closes, 150);
  const ma200 = maAt(closes, 200);
  const ma200Prev20 = maAt(closes, 200, closes.length - 20);
  const high52w = closes.length >= 252 ? Math.max(...closes.slice(-252)) : null;
  const low52w = closes.length >= 252 ? Math.min(...closes.slice(-252)) : null;
  const drawdown52wPct = high52w ? (latest / high52w - 1) * 100 : null;
  const month = monthlyFeatures(rows);

  let trendScore = 0;
  if (ma20 && latest > ma20) trendScore += 5;
  if (ma20 && ma60 && ma20 > ma60) trendScore += 5;
  if (ma60 && ma120 && ma60 > ma120) trendScore += 5;
  if ((slopePct(closes, 60) ?? -Infinity) > 0) trendScore += 7.5;
  if ((slopePct(closes, 120) ?? -Infinity) > 0) trendScore += 7.5;

  const highRetentionScore = Number.isFinite(drawdown52wPct)
    ? 20 * clamp((drawdown52wPct + 30) / 25, 0, 1) // -5% or better=20, -30%=0
    : null;

  let persistenceScore = 0;
  const ret60 = returnPctFrom(closes, 60);
  const ret120 = returnPctFrom(closes, 120);
  if ((ret60 ?? -Infinity) > 0) persistenceScore += 5;
  if ((ret120 ?? -Infinity) > 0) persistenceScore += 5;
  if (month.closeAboveMa5) persistenceScore += 5;
  if (month.ma5Rising) persistenceScore += 5;

  return {
    dataDays: closes.length,
    latest,
    ma20, ma50, ma60, ma120, ma150, ma200, ma200Prev20,
    slope60: slopePct(closes, 60),
    slope120: slopePct(closes, 120),
    ret20: returnPctFrom(closes, 20),
    ret60,
    ret120,
    high52w,
    low52w,
    drawdown52wPct,
    trendScore,
    highRetentionScore,
    persistenceScore,
    monthlyClose: month.monthlyClose,
    monthlyMa5: month.ma5,
    monthlyMa5Prev: month.ma5Prev,
    monthlyCloseAboveMa5: month.closeAboveMa5,
    monthlyMa5Rising: month.ma5Rising
  };
}

export function monthlyFeatures(rows) {
  const monthEnds = [];
  let currentKey = null;
  let currentClose = null;
  for (const row of rows) {
    const key = String(row.date).slice(0, 6);
    if (currentKey !== null && key !== currentKey) monthEnds.push(currentClose);
    currentKey = key;
    currentClose = row.close; // current month's partial close: no future month-end leak
  }
  if (currentClose !== null) monthEnds.push(currentClose);
  const ma5 = monthEnds.length >= 5 ? avg(monthEnds.slice(-5)) : null;
  const ma5Prev = monthEnds.length >= 6 ? avg(monthEnds.slice(-6, -1)) : null;
  const monthlyClose = monthEnds.at(-1) ?? null;
  return {
    monthlyClose,
    ma5,
    ma5Prev,
    closeAboveMa5: Boolean(monthlyClose && ma5 && monthlyClose > ma5),
    ma5Rising: Boolean(ma5 && ma5Prev && ma5 > ma5Prev)
  };
}

export function enrichCrossSection(rows) {
  const validScout = rows.filter((r) => r.scoutBase);
  const marketStats = {
    avgRet5: avg(validScout.map((r) => r.scoutBase.ret5)),
    avgRet20: avg(validScout.map((r) => r.scoutBase.ret20)),
    avgDist120: avg(validScout.map((r) => r.scoutBase.dist120))
  };

  const p20 = percentileMap(rows, (r) => r.leaderBase?.ret20);
  const p60 = percentileMap(rows, (r) => r.leaderBase?.ret60);
  const p120 = percentileMap(rows, (r) => r.leaderBase?.ret120);

  for (const row of rows) {
    row.scout = row.scoutBase ? enrichScoutScores(row.scoutBase, marketStats) : null;
    row.leader = row.leaderBase ? enrichLeaderScores(row.leaderBase, p20.get(row.code), p60.get(row.code), p120.get(row.code)) : null;
  }
}

export function enrichScoutScores(base, marketStats) {
  const relative5 = finite2(base.ret5, marketStats.avgRet5, (a, b) => a - b);
  const relative20 = finite2(base.ret20, marketStats.avgRet20, (a, b) => a - b);
  const relativeDist120 = finite2(base.dist120, marketStats.avgDist120, (a, b) => a - b);
  const lowPriceScore = clamp((30 - (base.pricePositionPct ?? 100)) / 30, 0, 1) * 40;
  const drawdownScore = clamp((Math.abs(base.drawdownFromHighPct ?? 0) - 15) / 35, 0, 1) * 30;
  const medianGapScore = clamp(Math.abs(Math.min(base.medianGapPct ?? 0, 0)) / 35, 0, 1) * 15;
  const dataScore = base.enoughData ? 15 : 5;
  const cheapScore = Math.round(lowPriceScore + drawdownScore + medianGapScore + dataScore);

  const noLowScore = clamp((base.daysSinceLow ?? 0) / 20, 0, 1) * 25;
  const slope5Score = (base.slope5 ?? -1) > 0 ? 20 : clamp((base.slope5 ?? -5) + 5, 0, 5) / 5 * 8;
  const slope20Score = (base.slope20 ?? -1) > 0 ? 20 : clamp((base.slope20 ?? -5) + 5, 0, 5) / 5 * 8;
  const relativeScore = clamp(((relative20 ?? -10) + 8) / 16, 0, 1) * 20;
  const volumeScore = base.volumeImproving ? 15 : clamp(((base.volumeUpDownRatio ?? 0) - 0.8) / 0.7, 0, 1) * 8;
  const stabilizeScore = Math.round(noLowScore + slope5Score + slope20Score + relativeScore + volumeScore);

  let riskScore = 15;
  const riskReasons = ["하락 원인 미확인"];
  if (Number.isFinite(relativeDist120) && relativeDist120 <= -12) { riskScore += 15; riskReasons.push("시장 대비 120일선 괴리 과도"); }
  if (Number.isFinite(relative20) && relative20 <= -8) { riskScore += 15; riskReasons.push("20일 시장 대비 약세"); }
  if ((base.volatility20 ?? 0) >= 5) { riskScore += 10; riskReasons.push("변동성 급증"); }
  if ((base.daysSinceLow ?? 0) < 3) { riskScore += 15; riskReasons.push("최근 신저가 반복"); }
  if (!base.enoughData) { riskScore += 15; riskReasons.push("2년 데이터 부족"); }
  riskScore = Math.round(clamp(riskScore, 0, 100));

  const scoutCheap = (base.pricePositionPct ?? 100) <= 30 && (base.drawdownFromHighPct ?? 0) <= -20;
  const watchCheap = (base.pricePositionPct ?? 100) <= 40 && (base.drawdownFromHighPct ?? 0) <= -15;
  let status = "관찰 목록";
  let stage = 0;
  if (riskScore >= 65) { status = "추가매수 금지"; stage = 5; }
  else if (scoutCheap && stabilizeScore >= 65 && riskScore <= 35) { status = "1차 매수 검토"; stage = 3; }
  else if (scoutCheap && stabilizeScore >= 45 && riskScore <= 50) { status = "하락 정지 확인"; stage = 2; }
  else if (scoutCheap && riskScore <= 60) { status = "정찰병 1주"; stage = 1; }
  else if (watchCheap) { status = "관찰 목록"; stage = 0; }

  return { ...base, relative5, relative20, relativeDist120, cheapScore, stabilizeScore, riskScore, riskReasons, status, stage };
}

export function enrichLeaderScores(base, pct20, pct60, pct120) {
  if (base.dataDays < 120) return { ...base, score: null, grade: "계산불가", relativeStrengthScore: null };
  const rs = [pct20, pct60, pct120].every(Number.isFinite) ? (pct20 + pct60 + pct120) * 10 : null;
  const componentsValid = [base.trendScore, rs, base.highRetentionScore, base.persistenceScore].every(Number.isFinite);
  const score = componentsValid ? rnd(clamp(base.trendScore + rs + base.highRetentionScore + base.persistenceScore, 0, 100), 1) : null;
  return { ...base, relativeStrengthScore: rs, score, grade: leaderGrade(score) };
}

export function leaderGrade(score) {
  if (!Number.isFinite(score)) return "계산불가";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 50) return "C";
  return "D";
}

export function rankScout(rows) {
  const ranked = rows.filter((r) => r.scout).sort((a, b) =>
    scoutSortPriority(b.scout.status) - scoutSortPriority(a.scout.status)
    || b.scout.cheapScore - a.scout.cheapScore
    || b.scout.stabilizeScore - a.scout.stabilizeScore
    || a.scout.riskScore - b.scout.riskScore
  );
  ranked.forEach((r, i) => { r.scout.rank = i + 1; r.scout.total = ranked.length; });
}

export function rankCombined(rows) {
  const ranked = rows.filter((r) => r.combined?.rankable).sort((a, b) =>
    b.combined.tier - a.combined.tier
    || b.combined.score - a.combined.score
    || b.combined.mainScore - a.combined.mainScore
    || (a.scout?.rank ?? 9999) - (b.scout?.rank ?? 9999)
  );
  ranked.forEach((r, i) => { r.combined.rank = i + 1; r.combined.total = ranked.length; });
}

export function buildFlags(x) {
  const streak2 = Math.max(x.foreignStreak ?? 0, x.instStreak ?? 0) >= 2;
  const totalNetPositive = x.totalNetAmount > 0;
  const strongStreakBid = streak2 && x.liquidityScore >= 50;
  return {
    R: x.liquidityScore >= 60 && x.change3dPct >= -6 && x.change3dPct <= 3 && x.dayChangePct <= 5 && streak2 && totalNetPositive && x.vwapRecovered,
    F: x.liquidityScore >= 50 && x.change3dPct >= -8 && x.change3dPct <= 5 && totalNetPositive,
    F2: x.liquidityScore >= 50 && x.change3dPct >= -8 && x.change3dPct <= 5 && streak2 && totalNetPositive,
    B: x.liquidityScore >= 50 && streak2 && x.change3dPct <= 12 && x.dayChangePct <= 10 && totalNetPositive,
    C: x.liquidityScore >= 70,
    H2: x.dayChangePct >= -12 && x.dayChangePct <= -4 && x.reboundFromLowPct >= 1.5 && x.vwapRecovered && (x.tradingValueRatio20 >= 2 || x.bodyTurnoverPct >= 3) && totalNetPositive,
    H3: x.dayChangePct >= -12 && x.dayChangePct <= -5 && x.reboundFromLowPct >= 2 && x.vwapRecovered && strongStreakBid,
    I: x.dayChangePct < -12 || (x.dayChangePct <= -5 && (!x.vwapRecovered || x.reboundFromLowPct < 1.2))
  };
}

export function buildCombinedDecision(row, scout) {
  const f = row.flags || {};
  const completeData = row.price > 0 && row.tradingValue > 0 && row.marketCap > 0;
  const overheat = row.dayChangePct >= 10 || row.change3dPct >= 12;
  const scoutRisk = scout?.riskScore ?? 50;
  const blocked = !completeData || Boolean(f.I) || overheat || scoutRisk >= 65;
  const strategySignal = Boolean(f.R || f.F || f.F2 || f.B || f.C || f.H3);

  let strategyPoints = 0;
  if (f.R) strategyPoints = 25;
  else if (f.F2) strategyPoints = 22;
  else if (f.F) strategyPoints = 18;
  else if (f.B && row.liquidityScore >= 50) strategyPoints = 13;
  else if (f.H3) strategyPoints = 11;
  else if (f.C) strategyPoints = 8;

  const liquidityPoints = clamp(row.liquidityScore / 100, 0, 1) * 20;
  let supplyPoints = 0;
  if (row.totalNetAmount > 0) supplyPoints += 4;
  supplyPoints += clamp(row.foreignStreak / 3, 0, 1) * 4;
  supplyPoints += clamp(row.instStreak / 3, 0, 1) * 4;
  if (row.smartMoneyBodyPct >= 0.3 || row.smartMoneyTradingSharePct >= 10) supplyPoints += 3;

  let technicalPoints = 0;
  if (row.vwapRecovered) technicalPoints += 4;
  if (row.change3dPct >= -8 && row.change3dPct <= 5) technicalPoints += 3;
  if (row.bullishTurn) technicalPoints += 3;

  const mainScore = Math.round(clamp(strategyPoints + liquidityPoints + supplyPoints + technicalPoints, 0, 70));
  const scoutScore = scout ? Math.round(clamp(scout.stabilizeScore * 0.15 + (100 - scoutRisk) * 0.10 + scout.cheapScore * 0.05, 0, 30)) : 0;
  const score = Math.round(clamp(mainScore + scoutScore, 0, 100));
  const rankable = !blocked && (strategySignal || score >= 40);

  let label = "관망", tier = 1, reason = "종합 매수조건 부족";
  if (!completeData) { label = "계산불가"; tier = 0; reason = "시세·거래 데이터 부족"; }
  else if (f.I || scoutRisk >= 65) { label = "매수보류"; tier = 0; reason = f.I ? "급락 미회복" : "정찰병 위험 높음"; }
  else if (overheat) { label = "추격주의"; tier = 0; reason = "당일 또는 3일 급등"; }
  else if (f.R && score >= 60) { label = "종합 최우선"; tier = 5; reason = "엄격 눌림·수급·정찰 조건"; }
  else if ((f.F2 || f.F) && score >= 50) { label = "종합 분할후보"; tier = 4; reason = f.F2 ? "눌림과 연속수급 확인" : "눌림과 순매수 확인"; }
  else if (f.H3) { label = "단기 특수"; tier = 3; reason = "강수급 낙주, 단기만"; }
  else if (rankable) { label = "관심 관찰"; tier = 2; reason = "일부 조건만 충족"; }

  const gateReason = !completeData ? "DATA" : f.I ? "I" : overheat ? "OVERHEAT" : scoutRisk >= 65 ? "SCOUT_RISK" : "PASS";
  return {
    score, mainScore, scoutScore,
    strategyPoints: Math.round(strategyPoints),
    liquidityPoints: Math.round(liquidityPoints),
    supplyPoints: Math.round(supplyPoints),
    technicalPoints: Math.round(technicalPoints),
    label, tier, rankable, blocked, reason, gateReason, overheat
  };
}

function buildExternalSignals(row) {
  const L = row.leader || {};
  const cafe = L.grade === "A"
    && L.monthlyCloseAboveMa5
    && L.monthlyMa5Rising
    && (row.foreign5 > 0 || row.inst5 > 0)
    && Number.isFinite(L.drawdown52wPct) && L.drawdown52wPct <= -5 && L.drawdown52wPct >= -15
    && Number.isFinite(L.ret5 ?? row.scoutBase?.ret5) && (L.ret5 ?? row.scoutBase.ret5) >= -8 && (L.ret5 ?? row.scoutBase.ret5) <= 2
    && row.dayChangePct < 10 && row.change3dPct < 12;

  const mtt = Number.isFinite(L.ma200)
    && row.price > L.ma150 && row.price > L.ma200
    && L.ma150 > L.ma200
    && Number.isFinite(L.ma200Prev20) && L.ma200 > L.ma200Prev20
    && L.ma50 > L.ma150 && L.ma50 > L.ma200
    && row.price > L.ma50
    && Number.isFinite(L.low52w) && row.price >= L.low52w * 1.30
    && Number.isFinite(L.high52w) && row.price >= L.high52w * 0.75;

  return {
    CAFE_LEADER_PULLBACK_PROXY: cafe,
    MINERVINI_MTT: mtt
  };
}

function buildCombos(row) {
  const leaderA = row.leader?.grade === "A";
  const scoutActionable = ["정찰병 1주", "하락 정지 확인", "1차 매수 검토"].includes(row.scout?.status);
  return {
    LEADER_A_AND_TOP: leaderA && row.combined?.label === "종합 최우선",
    LEADER_A_AND_R: leaderA && Boolean(row.flags?.R),
    LEADER_A_AND_F2: leaderA && Boolean(row.flags?.F2),
    LEADER_A_AND_SCOUT: leaderA && scoutActionable,
    LIQ70_AND_TOP: row.liquidityScore >= 70 && row.combined?.label === "종합 최우선"
  };
}

export function buildOutcomes(series, signalIndex, options = {}) {
  const holds = options.holds ?? runtime.holdingDaysList;
  const costPct = Number.isFinite(options.costPct) ? options.costPct : runtime.roundTripCostPct;
  const out = {};
  // Entry is always the NEXT trading day's open: the signal is only known
  // after the signal day's close, so entering on that day would be look-ahead.
  const entry = series[signalIndex + 1];
  if (!entry?.open) return out;
  for (const h of holds) {
    const exit = series[signalIndex + 1 + h];
    if (!exit?.close) continue;
    const window = series.slice(signalIndex + 1, signalIndex + 2 + h);
    const maxHigh = Math.max(...window.map((x) => x.high).filter(Number.isFinite));
    const minLow = Math.min(...window.map((x) => x.low).filter(Number.isFinite));
    out[h] = {
      entryDate: entry.date,
      entryPrice: entry.open,
      exitDate: exit.date,
      exitPrice: exit.close,
      netReturnPct: (exit.close / entry.open - 1) * 100 - costPct,
      grossReturnPct: (exit.close / entry.open - 1) * 100,
      mfePct: Number.isFinite(maxHigh) ? (maxHigh / entry.open - 1) * 100 : null,
      maePct: Number.isFinite(minLow) ? (minLow / entry.open - 1) * 100 : null
    };
  }
  return out;
}


export function calcLiquidityScore({ tradingValue, bodyTurnoverPct, tradingValueRatio20, smartMoneyBodyPct, smartMoneyTradingSharePct }) {
  const absoluteValueScore = scaled((tradingValue ?? 0) / eok, 500, 3000, 10000);
  const bodyScore = scaled(bodyTurnoverPct, 1, 5, 20);
  const explosionScore = scaled(tradingValueRatio20, 1, 3, 10);
  const smartBodyScore = scaled(smartMoneyBodyPct, 0.1, 0.3, 1);
  const leadershipScore = scaled(smartMoneyTradingSharePct, 5, 10, 30);
  return Math.round(absoluteValueScore * 0.12 + bodyScore * 0.31 + explosionScore * 0.27 + smartBodyScore * 0.20 + leadershipScore * 0.10);
}
function scaled(value, weak, strong, extreme) {
  if (!Number.isFinite(value) || value <= weak) return 0;
  if (value >= extreme) return 100;
  if (value >= strong) return 70 + ((value - strong) / (extreme - strong)) * 30;
  return ((value - weak) / (strong - weak)) * 70;
}
export function percentileMap(rows, getter) {
  const valid = rows.map((r) => ({ code: r.code, value: getter(r) })).filter((x) => Number.isFinite(x.value)).sort((a, b) => a.value - b.value);
  const out = new Map();
  if (!valid.length) return out;
  const n = valid.length;
  for (let i = 0; i < n; i += 1) out.set(valid[i].code, n === 1 ? 0.5 : i / (n - 1));
  return out;
}
function scoutSortPriority(status) { return { "1차 매수 검토": 5, "하락 정지 확인": 4, "정찰병 1주": 3, "관찰 목록": 2, "추가매수 금지": 1 }[status] ?? 0; }
function volumeProfile(rows) {
  const recent = rows.slice(-20), up = [], down = [];
  for (let i = 1; i < recent.length; i += 1) {
    const p = recent[i - 1], r = recent[i];
    if (!Number.isFinite(r.volume) || !Number.isFinite(r.close) || !Number.isFinite(p.close)) continue;
    (r.close >= p.close ? up : down).push(r.volume);
  }
  return { upAvg: avg(up), downAvg: avg(down), improving: Number.isFinite(avg(up)) && Number.isFinite(avg(down)) ? avg(up) > avg(down) : false };
}
function calcVolatility(closes, days) {
  const rets = [];
  for (let i = Math.max(1, closes.length - days); i < closes.length; i += 1) if (closes[i - 1]) rets.push((closes[i] / closes[i - 1] - 1) * 100);
  if (!rets.length) return null;
  const m = avg(rets); return Math.sqrt(avg(rets.map((x) => (x - m) ** 2)));
}
function countDaysSinceLatestLow(rows) {
  let low = Infinity, idx = -1;
  rows.forEach((r, i) => { if (Number.isFinite(r.close) && r.close <= low) { low = r.close; idx = i; } });
  return idx >= 0 ? rows.length - 1 - idx : null;
}
function maAt(closes, period, endExclusive = closes.length) { return endExclusive >= period ? avg(closes.slice(endExclusive - period, endExclusive)) : null; }
function slopePct(closes, period, lag = 5) { const now = maAt(closes, period), prev = maAt(closes, period, closes.length - lag); return now && prev ? (now / prev - 1) * 100 : null; }
function returnPctFrom(closes, days) { if (closes.length <= days) return null; const b = closes.at(-1 - days), l = closes.at(-1); return b && l ? (l / b - 1) * 100 : null; }
function finite2(a, b, fn) { return Number.isFinite(a) && Number.isFinite(b) ? fn(a, b) : null; }
export function rankBin(rank) { if (!Number.isFinite(rank)) return "NA"; if (rank <= 5) return "1-5"; if (rank <= 10) return "6-10"; if (rank <= 20) return "11-20"; if (rank <= 50) return "21-50"; return "51+"; }
export function binLabel(value, bins) { if (!Number.isFinite(value)) return "NA"; for (const [a, b] of bins) if (value >= a && value <= b) return `${a}-${b}`; return "NA"; }
export function groupBy(rows, keyFn) { const m = new Map(); for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; }
export function avg(values) { const v = values.filter(Number.isFinite); return v.length ? sum(v) / v.length : null; }
export function sum(values) { return values.filter(Number.isFinite).reduce((s, x) => s + x, 0); }
export function median(values) { const v = values.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }
export function pct(n, d) { return d ? rnd(n / d * 100) : null; }
export function rnd(x, digits = 2) { return Number.isFinite(x) ? Number(x.toFixed(digits)) : null; }
function fmt(x) { return Number.isFinite(x) ? Number(x).toFixed(2) : ""; }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function num(value) { if (value === null || value === undefined || value === "") return 0; const n = Number(String(value).replace(/[,+%\s]/g, "")); return Number.isFinite(n) ? n : 0; }
function emptyInvestor(date) { return { date, foreignNetAmount: 0, instNetAmount: 0 }; }
export function yyyymmdd(date) { return date.toISOString().slice(0, 10).replace(/-/g, ""); }
export function parseYmd(v) { return new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00+09:00`); }
export function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function toCsv(rows) { if (!rows.length) return ""; const cols = Object.keys(rows[0]); return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n"); }
function csvCell(v) { if (v === null || v === undefined) return ""; const t = String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }
function parseCsvLine(line) { const out = []; let cur = "", q = false; for (let i = 0; i < line.length; i += 1) { const c = line[i]; if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i += 1; } else q = !q; } else if (c === "," && !q) { out.push(cur); cur = ""; } else cur += c; } out.push(cur); return out; }
