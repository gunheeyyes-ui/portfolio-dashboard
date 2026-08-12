import { themes } from "./portfolio.js";

const avg = (arr) => arr.length ? arr.reduce((sum, value) => sum + value, 0) / arr.length : null;
const eok = 100_000_000;

const scoreWeights = {
  ratio: 0.6,
  turnover: 0.1,
  strength: 0.2,
  rsi: 0.1
};

const adjustments = {
  bothForeignInstBuy: 0.09,
  oneSideBuy: 0.03,
  programPositive: 0.05,
  foreignInstProgramCombo: 0.12,
  foreignStreakPerDay: 0.012,
  instStreakPerDay: 0.012,
  streakCapDays: 4,
  bothStreakComboMinDays: 2,
  bothStreakComboBonus: 0.05,
  strongProgramBuy: 10 * eok,
  strongProgramBonus: 0.04,
  veryStrongProgramBuy: 30 * eok,
  veryStrongProgramBonus: 0.04,
  oneSideHeavySellPenalty: 0.03,
  pivotGapPenaltyBelow: 0.5,
  pivotGapPenalty: 0.03,
  programNegativePenalty: 0.18,
  pivotNegativePenalty: 0.08,
  lowStrengthBelow: 120,
  lowStrengthPenalty: 0.06
};

export function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const clean = String(value).replace(/[,+%\s]/g, "");
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildIndicators(history = []) {
  const closes = history.map((row) => row.close).filter(Number.isFinite);
  const volumes = history.map((row) => row.volume).filter(Number.isFinite);
  const tradingValues = history
    .filter((row) => Number.isFinite(row.close) && Number.isFinite(row.volume))
    .map((row) => row.close * row.volume);
  const latest = closes.at(-1) ?? null;
  const ma20 = closes.length >= 20 ? avg(closes.slice(-20)) : null;
  const ma60 = closes.length >= 60 ? avg(closes.slice(-60)) : null;
  const volume20 = volumes.length >= 20 ? avg(volumes.slice(-20)) : null;
  const tradingValue20 = tradingValues.length >= 21 ? avg(tradingValues.slice(-21, -1)) : (tradingValues.length >= 20 ? avg(tradingValues.slice(-20)) : null);
  const lastVolume = volumes.at(-1) ?? null;
  const volumeRatio = volume20 && lastVolume ? lastVolume / volume20 : null;
  const prevClose = closes.length >= 2 ? closes.at(-2) : null;
  const base3 = closes.length >= 4 ? closes.at(-4) : null;

  let rsi14 = null;
  if (closes.length >= 15) {
    let gains = 0;
    let losses = 0;
    for (let i = closes.length - 14; i < closes.length; i += 1) {
      const delta = closes[i] - closes[i - 1];
      if (delta >= 0) gains += delta;
      else losses -= delta;
    }
    const avgGain = gains / 14;
    const avgLoss = losses / 14;
    rsi14 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return {
    latest,
    ma20,
    ma60,
    ma5: closes.length >= 5 ? avg(closes.slice(-5)) : null,
    rsi14,
    volumeRatio,
    tradingValue20,
    dayChangePct: latest && prevClose ? (latest / prevClose - 1) * 100 : null,
    change3dPct: latest && base3 ? (latest / base3 - 1) * 100 : null,
    dist20: latest && ma20 ? (latest / ma20 - 1) * 100 : null,
    dist60: latest && ma60 ? (latest / ma60 - 1) * 100 : null,
    pivotGapPct: calcPivotGapPct(history, latest)
  };
}

function calcPivotGapPct(history, latest) {
  const rows = history.filter((row) => Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close));
  if (rows.length < 2 || !latest) return null;
  const prev = rows.at(-2);
  const pivot = (prev.high + prev.low + prev.close) / 3;
  const r2 = pivot + (prev.high - prev.low);
  return r2 ? ((r2 - latest) / latest) * 100 : null;
}

function trendState(ind) {
  if (ind.ma20 && ind.ma60 && ind.latest) {
    if (ind.latest > ind.ma20 && ind.ma20 > ind.ma60) return "상승";
    if (ind.latest < ind.ma20 && ind.ma20 < ind.ma60) return "하락";
  }
  return "중립";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function calcBaseScore({ supplyIntensityPct, turnoverPct, strength, rsi }) {
  const normRatio = clamp((supplyIntensityPct ?? 0) / 2, 0, 1);
  const normTurnover = clamp((turnoverPct ?? 0) / 15, 0, 1);
  const normStrength = clamp((strength ?? 0) / 250, 0, 1);
  const normRsi = rsi === null || rsi === undefined ? 0.35 : rsi <= 40 ? 0 : clamp((rsi - 40) / 40, 0, 1);
  return (
    normRatio * scoreWeights.ratio
    + normTurnover * scoreWeights.turnover
    + normStrength * scoreWeights.strength
    + normRsi * scoreWeights.rsi
  );
}

function compressScore(score) {
  const safe = Math.max(score, 0);
  if (safe <= 0.9) return clamp(safe, 0, 1);
  return clamp(0.9 + 0.095 * (1 - Math.exp(-(safe - 0.9) / 0.35)), 0, 0.994);
}

function calcSupplyScore({ foreignNetAmount, instNetAmount, programNetAmount, supplyIntensityPct, turnoverPct, strength, rsi, pivotGapPct, foreignStreak, instStreak }) {
  let score = calcBaseScore({ supplyIntensityPct, turnoverPct, strength, rsi });
  const totalNet = foreignNetAmount + instNetAmount;

  if (foreignNetAmount > 0 && instNetAmount > 0) score += adjustments.bothForeignInstBuy;
  else if (totalNet > 0 && (foreignNetAmount > 0 || instNetAmount > 0)) score += adjustments.oneSideBuy;

  if (programNetAmount > 0) score += adjustments.programPositive;
  if (foreignNetAmount > 0 && instNetAmount > 0 && programNetAmount > 0) score += adjustments.foreignInstProgramCombo;

  score += Math.min(Math.max(foreignStreak, 0), adjustments.streakCapDays) * adjustments.foreignStreakPerDay;
  score += Math.min(Math.max(instStreak, 0), adjustments.streakCapDays) * adjustments.instStreakPerDay;
  if (foreignStreak > 0 && instStreak > 0 && Math.min(foreignStreak, instStreak) >= adjustments.bothStreakComboMinDays) {
    score += adjustments.bothStreakComboBonus;
  }

  if (programNetAmount >= adjustments.strongProgramBuy) score += adjustments.strongProgramBonus;
  if (programNetAmount >= adjustments.veryStrongProgramBuy) score += adjustments.veryStrongProgramBonus;

  const positiveSide = Math.max(foreignNetAmount, instNetAmount, 0);
  const negativeSide = Math.abs(Math.min(foreignNetAmount, instNetAmount, 0));
  if (totalNet > 0 && positiveSide > 0 && negativeSide > positiveSide * 0.6) score -= adjustments.oneSideHeavySellPenalty;
  if (pivotGapPct !== null && pivotGapPct < adjustments.pivotGapPenaltyBelow) score -= adjustments.pivotGapPenalty;
  if (programNetAmount < 0) score -= adjustments.programNegativePenalty;
  if (pivotGapPct !== null && pivotGapPct < 0) score -= adjustments.pivotNegativePenalty;
  if (strength && strength < adjustments.lowStrengthBelow) score -= adjustments.lowStrengthPenalty;

  return compressScore(score);
}

function buildSupply(holding, ind) {
  const marketCap = holding.quote?.marketCap ?? null;
  const tradingValue = holding.quote?.tradingValue ?? null;
  const freeFloatRate = normalizeFreeFloatRate(holding.freeFloatRate);
  const floatMarketCap = marketCap && freeFloatRate ? marketCap * freeFloatRate : null;
  const bodyMarketCap = floatMarketCap ?? marketCap;
  const foreignNetAmount = holding.investor?.foreignNetAmount ?? 0;
  const instNetAmount = holding.investor?.instNetAmount ?? 0;
  const programNetAmount = holding.program?.programNetAmount ?? 0;
  const totalNetAmount = foreignNetAmount + instNetAmount;
  const supplyNetAmount = totalNetAmount + programNetAmount;
  const strength = holding.execution?.strength ?? holding.quote?.strength ?? null;
  const marketCapTurnoverPct = marketCap ? (tradingValue / marketCap) * 100 : 0;
  const turnoverPct = bodyMarketCap ? (tradingValue / bodyMarketCap) * 100 : marketCapTurnoverPct;
  const supplyIntensityPct = tradingValue ? (supplyNetAmount / tradingValue) * 100 : 0;
  const smartMoneyBodyPct = bodyMarketCap ? (totalNetAmount / bodyMarketCap) * 100 : 0;
  const smartMoneyTradingSharePct = tradingValue ? (totalNetAmount / tradingValue) * 100 : 0;
  const tradingValueRatio20 = ind.tradingValue20 ? tradingValue / ind.tradingValue20 : null;
  const friendlyCount = [foreignNetAmount, instNetAmount, programNetAmount].filter((value) => value > 0).length;
  const foreignStreak = holding.investor?.foreignStreak ?? holding.judal?.foreignStreak ?? 0;
  const instStreak = holding.investor?.instStreak ?? holding.judal?.fundStreak ?? 0;
  const pivotGapPct = ind.pivotGapPct ?? null;
  const score = calcSupplyScore({
    foreignNetAmount,
    instNetAmount,
    programNetAmount,
    supplyIntensityPct,
    turnoverPct,
    strength,
    rsi: ind.rsi14,
    pivotGapPct,
    foreignStreak,
    instStreak
  });

  return {
    foreignNetAmount,
    instNetAmount,
    programNetAmount,
    totalNetAmount,
    supplyNetAmount,
    supplyIntensityPct,
    turnoverPct,
    marketCapTurnoverPct,
    freeFloatRate,
    floatMarketCap,
    bodyMarketCap,
    bodyTurnoverPct: turnoverPct,
    tradingValueRatio20,
    smartMoneyBodyPct,
    smartMoneyTradingSharePct,
    liquidityScore: calcLiquidityScore({ tradingValue, bodyTurnoverPct: turnoverPct, tradingValueRatio20, smartMoneyBodyPct, smartMoneyTradingSharePct }),
    usesFreeFloat: Boolean(floatMarketCap),
    tradingValue,
    marketCap,
    strength,
    foreignStreak,
    instStreak,
    friendlyCount,
    pivotGapPct,
    score,
    score100: Math.round(score * 100),
    investorAvailable: Boolean(holding.investor?.available)
  };
}

function normalizeFreeFloatRate(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

function scaled(value, weak, strong, extreme) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  if (value <= weak) return 0;
  if (value >= extreme) return 100;
  if (value >= strong) return 70 + ((value - strong) / (extreme - strong)) * 30;
  return ((value - weak) / (strong - weak)) * 70;
}

function calcLiquidityScore({ tradingValue, bodyTurnoverPct, tradingValueRatio20, smartMoneyBodyPct, smartMoneyTradingSharePct }) {
  const absoluteValueScore = scaled((tradingValue ?? 0) / eok, 500, 3000, 10000);
  const bodyScore = scaled(bodyTurnoverPct, 1, 5, 20);
  const explosionScore = scaled(tradingValueRatio20, 1, 3, 10);
  const smartBodyScore = scaled(smartMoneyBodyPct, 0.1, 0.3, 1);
  const leadershipScore = scaled(smartMoneyTradingSharePct, 5, 10, 30);
  return Math.round(absoluteValueScore * 0.12 + bodyScore * 0.31 + explosionScore * 0.27 + smartBodyScore * 0.20 + leadershipScore * 0.10);
}

function buildNakjuPlan(holding, supply) {
  const price = holding.price ?? 0;
  const quote = holding.quote ?? {};
  const prevClose = quote.prevClose || (quote.changeRate !== null && quote.changeRate !== undefined ? price / (1 + quote.changeRate / 100) : null);
  const open = quote.open ?? null;
  const low = quote.low ?? null;
  const high = quote.high ?? null;
  const tradingValue = quote.tradingValue ?? null;
  const volume = quote.volume ?? null;
  const vwap = tradingValue && volume ? tradingValue / volume : null;
  const dropPct = prevClose ? (price / prevClose - 1) * 100 : null;
  const reboundFromLowPct = low ? (price / low - 1) * 100 : null;
  const intradayRangePct = low && high ? (high / low - 1) * 100 : null;
  const vwapRecovered = vwap ? price >= vwap : false;
  const bullishTurn = open ? price >= open : false;
  const lowDefense = reboundFromLowPct !== null && reboundFromLowPct >= 1.2;
  const dropInBand = dropPct !== null && dropPct <= -5 && dropPct >= -12;
  const tooDeep = dropPct !== null && dropPct < -12;
  const time = kstTimeParts();
  const inEntryWindow = time.minutes >= 9 * 60 + 30 && time.minutes <= 14 * 60 + 30 && time.weekday >= 1 && time.weekday <= 5;
  const forceExitWindow = time.minutes >= 15 * 60 + 10;
  const liquidityOk = (tradingValue ?? 0) >= 3_000_000_000;
  const supplyOk = supply.score >= 0.5 || supply.friendlyCount >= 2 || supply.programNetAmount > 0;
  const reasons = [];
  let label = "해당 없음";
  let tone = "hold";
  let score = 0;

  if (dropInBand) {
    score += 25;
    reasons.push("낙폭 -5~-12%");
  }
  if (lowDefense) {
    score += 20;
    reasons.push("저점 방어");
  }
  if (bullishTurn) {
    score += 15;
    reasons.push("양봉 전환");
  }
  if (vwapRecovered) {
    score += 20;
    reasons.push("VWAP 회복");
  }
  if (supplyOk) {
    score += 15;
    reasons.push("수급 확인");
  }
  if (liquidityOk) {
    score += 5;
    reasons.push("거래대금 충족");
  }
  if (tooDeep) {
    reasons.push("-12% 초과 급락");
    score -= 25;
  }
  if ((dropInBand || tooDeep) && !inEntryWindow && !forceExitWindow) reasons.push("진입 시간 아님");
  if ((dropInBand || tooDeep) && forceExitWindow) reasons.push("장마감 이후");

  if (forceExitWindow && (dropInBand || tooDeep)) {
    label = "장마감 복기";
    tone = "danger";
  } else if (inEntryWindow && dropInBand && lowDefense && bullishTurn && vwapRecovered && supplyOk) {
    label = "낙주 진입검토";
    tone = "buy";
  } else if (inEntryWindow && dropInBand && (lowDefense || vwapRecovered || bullishTurn)) {
    label = "반등 확인대기";
    tone = "watch";
  } else if (tooDeep || (dropPct !== null && dropPct <= -5 && !lowDefense && !vwapRecovered)) {
    label = "급락 매수보류";
    tone = "danger";
  }

  const entryBandLow = price ? price * 0.995 : null;
  const entryBandHigh = price ? price * 1.005 : null;
  return {
    label,
    tone,
    score: Math.round(clamp(score, 0, 100)),
    dropPct,
    reboundFromLowPct,
    intradayRangePct,
    vwap,
    vwapRecovered,
    bullishTurn,
    lowDefense,
    inEntryWindow,
    forceExitWindow,
    liquidityOk,
    supplyOk,
    entryBandLow,
    entryBandHigh,
    stopLoss: price ? price * 0.95 : null,
    takeProfit1: price ? price * 1.03 : null,
    takeProfit2: price ? price * 1.05 : null,
    takeProfit3: price ? price * 1.07 : null,
    budgetPlan: [
      { step: "1차", amount: 1_000_000 },
      { step: "2차", amount: 2_000_000 },
      { step: "3차", amount: 3_000_000 }
    ],
    reasons: reasons.slice(0, 6)
  };
}

function buildStrategyPlan(holding, supply, nakju, ind) {
  const quoteChangeRate = Number.isFinite(holding.quote?.changeRate)
    && (Number.isFinite(holding.quote?.prevClose) || holding.quote.changeRate !== 0)
    ? holding.quote.changeRate
    : null;
  const dayChangePct = quoteChangeRate ?? ind.dayChangePct ?? 0;
  const change3dPct = holding.changeRate3d ?? holding.quote?.changeRate3d ?? ind.change3dPct ?? 0;
  const bullishTurn = nakju.bullishTurn;
  const vwapRecovered = nakju.vwapRecovered;
  const reboundFromLowPct = nakju.reboundFromLowPct ?? 0;
  const totalNetPositive = supply.totalNetAmount > 0;
  const streak2 = Math.max(supply.foreignStreak ?? 0, supply.instStreak ?? 0) >= 2;
  const strongStreakBid = streak2 && supply.liquidityScore >= 50;
  const bothSell = supply.foreignNetAmount < 0 && supply.instNetAmount < 0;
  const overheat = change3dPct >= 12 || dayChangePct >= 10;
  const longBearish = dayChangePct < -4 && !bullishTurn;
  const upperTailRisk = calcUpperTailPct(holding) >= 35;

  const flags = {
    R: supply.liquidityScore >= 60 && change3dPct >= -6 && change3dPct <= 3 && dayChangePct <= 5 && streak2 && totalNetPositive && vwapRecovered,
    F: supply.liquidityScore >= 50 && change3dPct >= -8 && change3dPct <= 5 && totalNetPositive,
    F2: supply.liquidityScore >= 50 && change3dPct >= -8 && change3dPct <= 5 && streak2 && totalNetPositive,
    B: supply.liquidityScore >= 50 && streak2 && change3dPct <= 12 && dayChangePct <= 10 && totalNetPositive,
    C: supply.liquidityScore >= 70,
    H2: dayChangePct >= -12 && dayChangePct <= -4 && reboundFromLowPct >= 1.5 && vwapRecovered && ((supply.tradingValueRatio20 ?? 0) >= 2 || supply.bodyTurnoverPct >= 3) && totalNetPositive,
    H3: dayChangePct >= -12 && dayChangePct <= -5 && reboundFromLowPct >= 2 && vwapRecovered && strongStreakBid,
    I: dayChangePct < -12 || (dayChangePct <= -5 && (!vwapRecovered || reboundFromLowPct < 1.2))
  };

  let score = 0;
  if (flags.R) score += 35;
  if (flags.F) score += 30;
  if (flags.F2) score += 20;
  if (flags.B) score += 15;
  if (flags.C) score += 10;
  if (flags.H3) score += 24;
  else if (flags.H2) score += 8;
  if (vwapRecovered) score += 10;
  if (bullishTurn) score += 5;
  if (ind.ma5 && holding.price >= ind.ma5) score += 5;
  if (overheat) score -= 30;
  if (longBearish) score -= 25;
  if (upperTailRisk) score -= 15;
  if (bothSell) score -= 20;
  if (flags.I) score = Math.min(score, -50);

  let label = "관망";
  let grade = "관망";
  let tone = "hold";
  let horizon = "관찰";

  if (flags.I || bothSell) {
    label = "매수보류";
    grade = "제외";
    tone = "danger";
    horizon = "물타기 금지";
  } else if (flags.H3) {
    label = "강수급 낙주";
    grade = "단기";
    tone = "watch";
    horizon = "1~3일";
  } else if (flags.R && !overheat) {
    label = "우선 검토";
    grade = "우선";
    tone = "buy";
    horizon = "5~10일 분할";
  } else if (flags.F2 && vwapRecovered && !overheat) {
    label = "분할 후보";
    grade = "분할";
    tone = "buy";
    horizon = "5~10일 관점";
  } else if (flags.F && vwapRecovered && totalNetPositive) {
    label = "분할 후보";
    grade = "분할";
    tone = "buy";
    horizon = "10일 관점";
  } else if (flags.F2 || flags.F) {
    label = "눌림 관찰";
    grade = "관찰";
    tone = "buy";
    horizon = "분할 관찰";
  } else if (flags.H2) {
    label = "낙주 확인";
    grade = "단기";
    tone = "watch";
    horizon = "5일 이하";
  } else if (flags.B) {
    label = "수급 관찰";
    grade = "관찰";
    tone = "hold";
    horizon = "관심등록";
  } else if (flags.C) {
    label = "거래강도 관심";
    grade = "참고";
    tone = "hold";
    horizon = "단독매수 금지";
  }

  return {
    label,
    grade,
    tone,
    score,
    horizon,
    flags,
    dayChangePct,
    change3dPct,
    vwapRecovered,
    bullishTurn,
    reboundFromLowPct,
    overheat,
    bothSell,
    upperTailRisk
  };
}

function buildRiskPlan(holding, nakju, ind) {
  const price = holding.price ?? holding.quote?.price ?? 0;
  const prevLow = Number.isFinite(holding.quote?.low) ? holding.quote.low : null;
  const ma5 = Number.isFinite(ind.ma5) ? ind.ma5 : null;
  const vwap = Number.isFinite(nakju.vwap) ? nakju.vwap : null;
  const hardStop = price ? price * 0.95 : null;
  const supportCandidates = [prevLow, ma5, vwap, hardStop].filter((value) => Number.isFinite(value) && value > 0 && value < price);
  const stopLoss = supportCandidates.length ? Math.max(...supportCandidates) * 0.985 : hardStop;
  const riskPct = stopLoss && price ? ((stopLoss / price) - 1) * 100 : null;
  const takeProfit1 = price ? price * 1.035 : null;
  const takeProfit2 = price ? price * 1.07 : null;
  const trailBase = [ma5, vwap].filter((value) => Number.isFinite(value) && value > 0);
  const trailStop = trailBase.length ? Math.max(...trailBase) * 0.985 : stopLoss;

  return {
    stopLoss,
    riskPct,
    takeProfit1,
    takeProfit2,
    trailStop,
    basis: [
      prevLow ? "전일저점" : null,
      ma5 ? "5일선" : null,
      vwap ? "VWAP" : null
    ].filter(Boolean).join("+") || "기본 -5%"
  };
}

function buildJudgement(holding, strategy, supply, nakju, ind, pnlPct) {
  const bits = [];
  if (strategy.flags.I) return "급락 후 회복 부족이라 신규매수/물타기 보류";
  if (strategy.flags.H3) return `급락 후 VWAP 회복, 외/기관 연속수급 확인. 1~3일 단기만`;
  if (strategy.flags.R) bits.push("엄격 우선 기준 통과: 거래강도60, 눌림, 연속수급, VWAP 회복");
  else if (strategy.flags.F2) bits.push("눌림 구간에 거래강도와 외/기관 연속수급 동반");
  else if (strategy.flags.F) bits.push("눌림 구간과 외/기관 순매수는 확인");
  else if (strategy.flags.B) bits.push("연속수급은 있으나 가격 위치 추가 확인 필요");
  else if (strategy.flags.C) bits.push("거래강도는 강하지만 단독 추격 금지");
  else bits.push("매수 핵심 조건은 아직 부족");

  if (supply.foreignStreak >= 2 || supply.instStreak >= 2) bits.push(`연속 외${supply.foreignStreak}·기${supply.instStreak}`);
  if ((supply.smartMoneyTradingSharePct ?? 0) >= 10) bits.push("큰손 주도율 양호");
  if ((strategy.change3dPct ?? 0) >= 12 || strategy.overheat) bits.push("단기 과열 주의");
  if (pnlPct <= -10 && strategy.tone !== "buy") bits.push("손실 구간이라 물타기 근거 필요");
  if (nakju.vwapRecovered && ind.ma5 && holding.price >= ind.ma5) bits.push("VWAP/5일선 위");
  return bits.slice(0, 3).join(" · ");
}

function calcUpperTailPct(holding) {
  const quote = holding.quote ?? {};
  const high = quote.high ?? null;
  const low = quote.low ?? null;
  const close = holding.price ?? quote.price ?? null;
  if (!high || !low || !close || high <= low) return 0;
  return ((high - close) / (high - low)) * 100;
}

function kstTimeParts() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: weekdayMap[parts.weekday] ?? 0
  };
}

export function classifyHolding(holding, portfolioTotal, marketContext = { mode: "중립" }) {
  const invested = holding.accountInvested ?? holding.avgPrice * holding.qty;
  const value = holding.accountValue ?? holding.price * holding.qty;
  const pnl = holding.accountPnl ?? value - invested;
  const pnlPct = holding.accountPnlPct ?? (invested ? (pnl / invested) * 100 : 0);
  const weight = portfolioTotal ? (value / portfolioTotal) * 100 : 0;
  const ind = holding.indicators ?? {};
  const isSynthetic = Boolean(ind.synthetic);
  const trend = isSynthetic ? "기본" : trendState(ind);
  const rsi = ind.rsi14;
  const volumeRatio = ind.volumeRatio;
  const supply = buildSupply(holding, ind);
  const nakju = buildNakjuPlan(holding, supply);
  const strategy = buildStrategyPlan(holding, supply, nakju, ind);
  const riskPlan = buildRiskPlan(holding, nakju, ind);
  const judgement = buildJudgement(holding, strategy, supply, nakju, ind, pnlPct);
  const reasons = [];
  let action = strategy.label;
  let tone = strategy.tone;
  let priority = 50;
  const strongSupply = supply.score >= 0.75 && supply.friendlyCount >= 2 && supply.totalNetAmount >= 2 * eok;
  const watchSupply = supply.score >= 0.5 && supply.supplyIntensityPct >= 0.35 && supply.totalNetAmount > 0;
  const badSupply = supply.friendlyCount === 0 || (supply.totalNetAmount < 0 && supply.programNetAmount < 0);
  const overheat = (rsi !== null && rsi >= 75) || (holding.quote?.changeRate ?? 0) >= 8 || (supply.pivotGapPct !== null && supply.pivotGapPct < 0.5);
  const dayChange = holding.quote?.changeRate ?? 0;
  const defensiveMode = marketContext.mode === "방어" || marketContext.mode === "패닉";
  const panicMode = marketContext.mode === "패닉";
  const trueInstitutionalBid = supply.score >= 85
    && supply.friendlyCount >= 2
    && supply.totalNetAmount >= 2 * eok
    && (supply.foreignStreak >= 2 || supply.instStreak >= 2)
    && supply.programNetAmount >= 0;
  const confirmedRebound = nakju.label === "낙주 진입검토" && trueInstitutionalBid;

  if (weight >= 18) reasons.push("단일 종목 비중이 큼");
  if (defensiveMode) reasons.push(`${marketContext.mode} 모드`);
  if (strategy.flags.R) reasons.push("우선 검토");
  if (strategy.flags.F) reasons.push("눌림 구간");
  if (strategy.flags.F2) reasons.push("외/기 연속 눌림");
  if (strategy.flags.B) reasons.push("연속수급 관찰");
  if (strategy.flags.C) reasons.push("거래강도 70+");
  if (strategy.flags.H3) reasons.push("강수급 낙주");
  if (strategy.flags.H2) reasons.push("낙주 반등확인");
  if (strategy.flags.I) reasons.push("매수보류 조건");
  if (strategy.change3dPct !== null) reasons.push(`3일 ${Math.round(strategy.change3dPct * 10) / 10}%`);
  if (strategy.vwapRecovered) reasons.push("VWAP 위");
  if (nakju.label === "낙주 진입검토") reasons.push("낙주반등 확인");
  if (nakju.label === "반등 확인대기") reasons.push("낙주 대기");
  if (pnlPct >= 15) reasons.push("수익 구간");
  if (pnlPct <= -10) reasons.push("손실 확대 구간");
  if (supply.score100) reasons.push(`수급점수 ${supply.score100}점`);
  if (supply.liquidityScore >= 70) reasons.push(`거래강도 ${supply.liquidityScore}점`);
  if (supply.bodyTurnoverPct >= 10) reasons.push("몸집대비 거래 강함");
  if ((supply.tradingValueRatio20 ?? 0) >= 3) reasons.push("거래대금 폭증");
  if (supply.friendlyCount >= 2) reasons.push(`수급우호 ${supply.friendlyCount}/3`);
  if (supply.foreignStreak >= 2 || supply.instStreak >= 2) reasons.push(`연속 외${supply.foreignStreak}·기${supply.instStreak}`);
  if (!isSynthetic && trend !== "중립") reasons.push(`${trend} 추세`);
  if (!isSynthetic && rsi !== null && rsi >= 70) reasons.push("RSI 과열");
  if (!isSynthetic && rsi !== null && rsi <= 35) reasons.push("RSI 침체");
  if (!isSynthetic && supply.pivotGapPct !== null && supply.pivotGapPct < 0.5) reasons.push("R2 여유 부족");
  if (!isSynthetic && volumeRatio !== null && volumeRatio >= 1.8) reasons.push("거래량 급증");

  if (strategy.flags.I) {
    action = "매수보류";
    tone = "danger";
    priority = 99;
  } else if (strategy.flags.R) {
    action = "우선 검토";
    tone = "buy";
    priority = 96;
  } else if (strategy.grade === "분할" || (strategy.grade === "관찰" && (strategy.flags.F || strategy.flags.F2))) {
    action = "분할 후보";
    tone = "buy";
    priority = 91;
  } else if (strategy.flags.H3) {
    action = "강수급 낙주";
    tone = "hold";
    priority = 86;
  } else if (strategy.flags.H2) {
    action = "낙주 확인";
    tone = "hold";
    priority = 84;
  } else if (strategy.flags.B) {
    action = "수급 관찰";
    tone = "hold";
    priority = 78;
  } else if (strategy.flags.C) {
    action = "강한 관심";
    tone = "hold";
    priority = 76;
  } else if (isSynthetic) {
    if (pnlPct >= 20 && weight >= 8) {
      action = "익절/축소";
      tone = "sell";
      priority = 92;
    } else if (pnlPct >= 12 && weight >= 12) {
      action = "비중축소";
      tone = "sell";
      priority = 84;
    } else if (pnlPct <= -15) {
      action = "손절 검토";
      tone = "danger";
      priority = 90;
    } else if (pnlPct <= -9) {
      action = "물타기 금지";
      tone = "danger";
      priority = 82;
    } else if (pnlPct <= -3 && weight <= 8) {
      action = "분할매수 가능";
      tone = "buy";
      priority = 74;
    } else if (pnlPct >= 0 && pnlPct < 8 && weight <= 5) {
      action = "추가매수";
      tone = "buy";
      priority = 68;
    }
  } else if (panicMode && pnlPct <= -18 && (badSupply || dayChange <= -7)) {
    action = "손절 검토";
    tone = "danger";
    priority = 98;
  } else if (defensiveMode && pnlPct <= -25 && !trueInstitutionalBid) {
    action = "손절 검토";
    tone = "danger";
    priority = 96;
  } else if (pnlPct <= -25 && badSupply) {
    action = "손절 검토";
    tone = "danger";
    priority = 95;
  } else if (pnlPct <= -15 && badSupply && trend === "하락") {
    action = "손절 검토";
    tone = "danger";
    priority = 90;
  } else if (defensiveMode && weight >= 15 && (supply.score < 55 || dayChange <= -5)) {
    action = "비중축소";
    tone = "sell";
    priority = 94;
  } else if (pnlPct >= 20 && (weight >= 12 || overheat || badSupply || defensiveMode)) {
    action = "익절/축소";
    tone = "sell";
    priority = 92;
  } else if (pnlPct >= 12 && weight >= 12 && !strongSupply) {
    action = "비중축소";
    tone = "sell";
    priority = 86;
  } else if (defensiveMode && pnlPct <= -3 && !confirmedRebound) {
    action = pnlPct <= -8 ? "물타기 금지" : "방어 관망";
    tone = pnlPct <= -8 ? "danger" : "hold";
    priority = pnlPct <= -8 ? 88 : 70;
  } else if (pnlPct <= -3 && pnlPct > -25 && weight <= 8 && watchSupply && !overheat) {
    action = "분할매수 가능";
    tone = "buy";
    priority = 80;
  } else if (pnlPct <= -9 && !strongSupply) {
    action = "물타기 금지";
    tone = "danger";
    priority = 84;
  } else if (pnlPct > -5 && weight <= 12 && strongSupply && !overheat) {
    action = "추가매수";
    tone = "buy";
    priority = 82;
  } else if (pnlPct > 0 && badSupply && weight >= 8) {
    action = "비중축소";
    tone = "sell";
    priority = 78;
  }

  return {
    ...holding,
    invested,
    value,
    pnl,
    pnlPct,
    weight,
    trend,
    supply,
    nakju,
    strategy,
    riskPlan,
    judgement,
    action,
    tone,
    priority,
    reasons: reasons.slice(0, 6)
  };
}

export function buildPortfolioSummary(rows, marketContext = { mode: "중립" }, accountSummary = null) {
  const rowTotalValue = rows.reduce((sum, row) => sum + row.value, 0);
  const rowTotalInvested = rows.reduce((sum, row) => sum + row.invested, 0);
  const totalValue = accountSummary?.totalValue ?? rowTotalValue;
  const totalInvested = accountSummary?.totalInvested ?? rowTotalInvested;
  const totalPnl = accountSummary?.totalPnl ?? totalValue - totalInvested;
  const totalPnlPct = accountSummary?.totalPnlPct ?? (totalInvested ? (totalPnl / totalInvested) * 100 : 0);
  const byAction = rows.reduce((acc, row) => {
    acc[row.action] = (acc[row.action] ?? 0) + 1;
    return acc;
  }, {});
  const strategyCounts = rows.reduce((acc, row) => {
    const flags = row.strategy?.flags ?? {};
    for (const key of ["R", "F", "F2", "B", "C", "H3", "H2", "I"]) {
      if (flags[key]) acc[key] = (acc[key] ?? 0) + 1;
    }
    acc[row.strategy?.grade ?? "관망"] = (acc[row.strategy?.grade ?? "관망"] ?? 0) + 1;
    return acc;
  }, {});

  const themeExposure = Object.entries(themes).map(([theme, codes]) => {
    const value = rows.filter((row) => codes.includes(row.code)).reduce((sum, row) => sum + row.value, 0);
    return { theme, value, pct: totalValue ? (value / totalValue) * 100 : 0 };
  }).sort((a, b) => b.value - a.value);

  return {
    totalValue,
    totalInvested,
    totalPnl,
    totalPnlPct,
    marketContext,
    byAction,
    strategyCounts,
    avgSupplyScore: rows.length ? rows.reduce((sum, row) => sum + row.supply.score100, 0) / rows.length : 0,
    avgLiquidityScore: rows.length ? rows.reduce((sum, row) => sum + row.supply.liquidityScore, 0) / rows.length : 0,
    strongSupplyCount: rows.filter((row) => row.supply.score100 >= 75).length,
    strongLiquidityCount: rows.filter((row) => row.supply.liquidityScore >= 70).length,
    freeFloatAppliedCount: rows.filter((row) => row.supply.usesFreeFloat).length,
    foreignInstBuyCount: rows.filter((row) => row.supply.foreignNetAmount > 0 && row.supply.instNetAmount > 0).length,
    nakjuReady: rows.filter((row) => row.nakju.label === "낙주 진입검토").length,
    nakjuWatch: rows.filter((row) => row.nakju.label === "반등 확인대기").length,
    todayTrades: [...rows]
      .filter((row) => row.strategy?.flags?.R || row.strategy?.flags?.F || row.strategy?.flags?.F2 || row.strategy?.flags?.B || row.strategy?.flags?.C || row.strategy?.flags?.H3 || row.strategy?.flags?.H2 || row.strategy?.flags?.I)
      .sort((a, b) => (b.strategy?.score ?? 0) - (a.strategy?.score ?? 0) || b.supply.liquidityScore - a.supply.liquidityScore)
      .slice(0, 6),
    topWeights: [...rows].sort((a, b) => b.weight - a.weight).slice(0, 5),
    themeExposure
  };
}
