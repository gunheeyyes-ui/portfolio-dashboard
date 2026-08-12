const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const avg = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const round1 = (value) => Math.round(value * 10) / 10;

function maAt(closes, period, endExclusive = closes.length) {
  if (endExclusive < period) return null;
  return avg(closes.slice(endExclusive - period, endExclusive));
}

function slopePct(closes, period, lag = 5) {
  const current = maAt(closes, period);
  const previous = maAt(closes, period, closes.length - lag);
  return current && previous ? ((current / previous) - 1) * 100 : null;
}

function returnPct(closes, days, latest) {
  if (closes.length <= days) return null;
  const base = closes.at(-1 - days);
  return base && latest ? ((latest / base) - 1) * 100 : null;
}

function buildMonthlyCloses(rows, latest) {
  const byMonth = new Map();
  for (const row of rows) {
    if (!row.date || !Number.isFinite(row.close)) continue;
    byMonth.set(String(row.date).slice(0, 6), row.close);
  }
  const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (months.length && Number.isFinite(latest)) months[months.length - 1][1] = latest;
  return months.map(([, close]) => close);
}

function percentile(value, population) {
  if (!Number.isFinite(value)) return null;
  const sorted = population.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return 0.5;
  let lower = 0;
  let equal = 0;
  for (const candidate of sorted) {
    if (candidate < value) lower += 1;
    else if (candidate === value) equal += 1;
  }
  return clamp((lower + Math.max(equal - 1, 0) / 2) / (sorted.length - 1), 0, 1);
}

export function leaderGrade(score) {
  if (!Number.isFinite(score)) return "계산불가";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 50) return "C";
  return "D";
}

export function calcLeaderBase(candidate, history = [], quote = {}) {
  const rows = history
    .filter((row) => row?.date && Number.isFinite(Number(row.close)))
    .map((row) => ({ ...row, close: Number(row.close) }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const closes = rows.map((row) => row.close);
  const quotedPrice = Number(quote?.price);
  const latest = quotedPrice > 0 ? quotedPrice : (closes.at(-1) ?? null);
  const ma20 = maAt(closes, 20);
  const ma60 = maAt(closes, 60);
  const ma120 = maAt(closes, 120);
  const slope60 = slopePct(closes, 60);
  const slope120 = slopePct(closes, 120);
  const ret20 = returnPct(closes, 20, latest);
  const ret60 = returnPct(closes, 60, latest);
  const ret120 = returnPct(closes, 120, latest);
  const recent52w = rows.slice(-252);
  const high52w = recent52w.length
    ? Math.max(...recent52w.map((row) => Number.isFinite(Number(row.high)) ? Number(row.high) : row.close))
    : null;
  const drawdown52wPct = high52w && latest ? ((latest / high52w) - 1) * 100 : null;
  const drawdownMagnitude = Math.abs(Math.min(drawdown52wPct ?? -100, 0));
  const highRetentionScore = drawdownMagnitude <= 5
    ? 20
    : drawdownMagnitude >= 30
      ? 0
      : 20 - ((drawdownMagnitude - 5) / 25) * 20;

  const monthlyCloses = buildMonthlyCloses(rows, latest);
  const monthMa5 = monthlyCloses.length >= 5 ? avg(monthlyCloses.slice(-5)) : null;
  const previousMonthMa5 = monthlyCloses.length >= 6 ? avg(monthlyCloses.slice(-6, -1)) : null;
  const monthAboveMa5 = Number.isFinite(latest) && Number.isFinite(monthMa5) && latest > monthMa5;
  const monthMa5Rising = Number.isFinite(monthMa5) && Number.isFinite(previousMonthMa5) && monthMa5 > previousMonthMa5;

  const required = [latest, ma20, ma60, ma120, slope60, slope120, ret20, ret60, ret120, high52w, monthMa5, previousMonthMa5];
  const enoughData = rows.length >= 252 && required.every(Number.isFinite) && monthlyCloses.length >= 6;
  const trendScore = enoughData
    ? (latest > ma20 ? 5 : 0)
      + (ma20 > ma60 ? 5 : 0)
      + (ma60 > ma120 ? 5 : 0)
      + (slope60 > 0 ? 7.5 : 0)
      + (slope120 > 0 ? 7.5 : 0)
    : null;
  const persistenceScore = enoughData
    ? (ret60 > 0 ? 5 : 0)
      + (ret120 > 0 ? 5 : 0)
      + (monthAboveMa5 ? 5 : 0)
      + (monthMa5Rising ? 5 : 0)
    : null;

  return {
    market: candidate.market,
    rank: candidate.rank,
    rankType: candidate.rankType,
    code: candidate.code,
    name: candidate.name,
    dataDays: rows.length,
    enoughData,
    latest,
    ma20,
    ma60,
    ma120,
    slope60,
    slope120,
    ret20,
    ret60,
    ret120,
    high52w,
    drawdown52wPct,
    monthMa5,
    previousMonthMa5,
    monthAboveMa5,
    monthMa5Rising,
    trendScore: Number.isFinite(trendScore) ? round1(trendScore) : null,
    highRetentionScore: enoughData ? round1(highRetentionScore) : null,
    persistenceScore: Number.isFinite(persistenceScore) ? round1(persistenceScore) : null
  };
}

export function enrichLeaderScores(bases = []) {
  const populations = Object.fromEntries(["KOSPI", "KOSDAQ"].map((market) => {
    const marketRows = bases.filter((row) => row.market === market && row.enoughData);
    const topMarketCapRows = marketRows.filter((row) => row.rankType === "시총" && (row.rank ?? 101) <= 100);
    const rows = topMarketCapRows.length ? topMarketCapRows : marketRows;
    return [market, {
      ret20: rows.map((row) => row.ret20),
      ret60: rows.map((row) => row.ret60),
      ret120: rows.map((row) => row.ret120)
    }];
  }));

  return bases.map((base) => {
    if (!base.enoughData) {
      return { ...base, percentile20: null, percentile60: null, percentile120: null, relativeStrengthScore: null, score: null, grade: "계산불가" };
    }
    const population = populations[base.market] ?? { ret20: [], ret60: [], ret120: [] };
    const percentile20 = percentile(base.ret20, population.ret20);
    const percentile60 = percentile(base.ret60, population.ret60);
    const percentile120 = percentile(base.ret120, population.ret120);
    const relativeStrengthScore = round1((percentile20 + percentile60 + percentile120) * 10);
    const rawScore = base.trendScore + relativeStrengthScore + base.highRetentionScore + base.persistenceScore;
    const score = Math.round(clamp(rawScore, 0, 100));
    return {
      ...base,
      percentile20,
      percentile60,
      percentile120,
      relativeStrengthScore,
      score,
      grade: leaderGrade(score)
    };
  });
}

export function buildLeaderDecision(leader, combined = {}, scout = {}) {
  if (!leader || !Number.isFinite(leader.score)) return "계산에 필요한 가격 이력 부족";
  if (leader.grade === "A") {
    if (combined.label === "종합 최우선") return "강한 주도주 + 매수조건 충족";
    if (combined.label === "종합 분할후보") return "강한 주도주 눌림 · 분할 검토";
    if (combined.label === "추격주의") return "핵심 주도주지만 현재 과열";
    if (combined.label === "매수보류") return "주도주이나 현재 위험조건 발생";
    return "핵심 주도주 · 눌림 타이밍 우선 관찰";
  }
  if (leader.grade === "B") return "준주도주 · 추세 유지 확인";
  const scoutHigh = scout.status === "1차 매수 검토" || ((scout.cheapScore ?? 0) >= 70 && (scout.stabilizeScore ?? 0) >= 65);
  if (scoutHigh) return "주도주보다는 낙폭과대 반등 후보";
  if (leader.grade === "C") return "중립 · 주도주 전략 우선순위 낮음";
  return "약세 · 주도주 전략 제외";
}
