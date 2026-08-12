import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { portfolio } from "./portfolio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(__dirname, "backtest-cache");
const outDir = path.join(__dirname, "backtest-results");
mkdirSync(cacheDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

loadDotEnv();

const args = parseArgs(process.argv.slice(2));
const today = new Date();
const endDate = args.end || yyyymmdd(today);
const startDate = args.start || yyyymmdd(addDays(today, -365 * Number(args.years || 2)));
const universeMode = args.universe || "holdings";
const marketLimit = Number(args.limit || 30);
const holdingDaysList = String(args.holds || "5,10").split(",").map((v) => Number(v.trim())).filter(Boolean);
const roundTripCostPct = Number(args.cost || 0.23);
const entryMode = args.entry || "next-open";
const maxTickers = args.max ? Number(args.max) : null;

const KIS_BASE_URL = process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443";
const USER_AGENT = "Mozilla/5.0 CriteriaBacktest/0.1";
const eok = 100_000_000;
let tokenPromise = null;
let lastKisCallAt = 0;

const strategies = [
  {
    name: "대시보드_우선검토",
    description: "현재 대시보드의 '우선 검토': 거래강도60+ / 3일 -6~+3% / 당일 +5% 이하 / 외국인 또는 기관 2일+ / VWAP 회복 / 과열·급락보류 제외",
    test: (r) => isDashboardBuyReady(r)
  },
  {
    name: "대시보드_분할후보",
    description: "현재 대시보드의 '분할 후보': 눌림목/연속수급 후보. 우선검토/과열/급락보류 제외",
    test: (r) => isDashboardBuyCandidate(r)
  },
  {
    name: "대시보드_단기특수",
    description: "현재 대시보드의 '단기 특수': 급락 후 저점반등/VWAP 회복 + 외국인/기관 2일+ + 거래강도50+",
    test: (r) => isDashboardSpecial(r)
  },
  {
    name: "대시보드_관심관찰",
    description: "현재 대시보드의 '관심 관찰': 매수권은 아니지만 연속수급/큰손주도/거래대금폭증/거래강도70 중 하나",
    test: (r) => isDashboardObserve(r)
  },
  {
    name: "대시보드_추격주의_역추적",
    description: "현재 대시보드의 '추격주의': 당일 +10% 이상 또는 3일 +12% 이상. 사면 안 되는 과열 구간 역추적",
    test: (r) => isDashboardOverheat(r)
  },
  {
    name: "대시보드_매수보류_역추적",
    description: "현재 대시보드의 '매수보류': -12% 초과 급락 또는 -5% 이하에서 VWAP/저점방어 실패. 위험 구간 역추적",
    test: (r) => isDashboardAvoid(r)
  },
  {
    name: "A_현재기준_엄격",
    description: "거래강도 70+ / 외국인 또는 기관 2일+ / 3일 등락 +12% 이하 / 당일 +10% 이하 / 외+기관 순매수",
    test: (r) => r.liquidityScore >= 70 && Math.max(r.foreignStreak, r.instStreak) >= 2 && r.change3dPct <= 12 && r.dayChangePct <= 10 && r.totalNetAmount > 0
  },
  {
    name: "B_현재기준_관찰50",
    description: "거래강도 50+ / 외국인 또는 기관 2일+ / 과열 제한 / 외+기관 순매수",
    test: (r) => r.liquidityScore >= 50 && Math.max(r.foreignStreak, r.instStreak) >= 2 && r.change3dPct <= 12 && r.dayChangePct <= 10 && r.totalNetAmount > 0
  },
  {
    name: "C_거래강도70_단독",
    description: "거래강도 70+만 사용",
    test: (r) => r.liquidityScore >= 70
  },
  {
    name: "D_60점_동시수급",
    description: "거래강도 60+ / 외국인+기관 둘 다 1일 이상 또는 외+기관 순매수 / 3일 +15% 이하",
    test: (r) => r.liquidityScore >= 60 && ((r.foreignStreak >= 1 && r.instStreak >= 1) || r.totalNetAmount > 0) && r.change3dPct <= 15
  },
  {
    name: "E_초입50_연속3일",
    description: "거래강도 50+ / 외국인 또는 기관 3일+ / 거래대금 20일 평균 2배+ / 몸집회전 3%+",
    test: (r) => r.liquidityScore >= 50 && Math.max(r.foreignStreak, r.instStreak) >= 3 && r.tradingValueRatio20 >= 2 && r.bodyTurnoverPct >= 3
  },
  {
    name: "F_눌림50",
    description: "거래강도 50+ / 3일 등락 -8%~+5% / 외+기관 순매수",
    test: (r) => r.liquidityScore >= 50 && r.change3dPct >= -8 && r.change3dPct <= 5 && r.totalNetAmount > 0
  },
  {
    name: "F2_눌림50_연속2",
    description: "거래강도 50+ / 3일 등락 -8%~+5% / 외국인 또는 기관 2일+ / 외+기관 순매수",
    test: (r) => r.liquidityScore >= 50 && r.change3dPct >= -8 && r.change3dPct <= 5 && Math.max(r.foreignStreak, r.instStreak) >= 2 && r.totalNetAmount > 0
  },
  {
    name: "F3_눌림40_저과열",
    description: "거래강도 40+ / 3일 등락 -10%~+3% / 외+기관 순매수 / 당일 +7% 이하",
    test: (r) => r.liquidityScore >= 40 && r.change3dPct >= -10 && r.change3dPct <= 3 && r.dayChangePct <= 7 && r.totalNetAmount > 0
  },
  {
    name: "G_완화40_큰손주도",
    description: "거래강도 40+ / 몸집회전 3%+ / 20일 평균 2배+ / 외+기관 거래대금 주도율 10%+ / 연속 2일+",
    test: (r) => r.liquidityScore >= 40 && r.bodyTurnoverPct >= 3 && r.tradingValueRatio20 >= 2 && r.smartMoneyTradingSharePct >= 10 && Math.max(r.foreignStreak, r.instStreak) >= 2
  },
  {
    name: "H_낙주반등_VWAP",
    description: "당일 -5~-12% / 종가 저점반등 2%+ / 종가 VWAP 위 / 양봉 또는 시가회복 / 거래강도40+ 또는 거래대금 2배+ / 수급 2요소 우호",
    test: (r) => r.dayChangePct >= -12 && r.dayChangePct <= -5 && r.reboundFromLowPct >= 2 && r.vwapRecovered && r.bullishTurn && (r.liquidityScore >= 40 || r.tradingValueRatio20 >= 2) && r.friendlySignalCount >= 2
  },
  {
    name: "H2_낙주반등_완화",
    description: "당일 -4~-12% / 저점반등 1.5%+ / VWAP 회복 / 거래대금 2배+ 또는 몸집회전 3%+ / 외+기관 순매수",
    test: (r) => r.dayChangePct >= -12 && r.dayChangePct <= -4 && r.reboundFromLowPct >= 1.5 && r.vwapRecovered && (r.tradingValueRatio20 >= 2 || r.bodyTurnoverPct >= 3) && r.totalNetAmount > 0
  },
  {
    name: "H3_낙주반등_강수급",
    description: "당일 -5~-12% / 저점반등 2%+ / VWAP 회복 / 외국인 또는 기관 2일+ / 거래강도50+",
    test: (r) => r.dayChangePct >= -12 && r.dayChangePct <= -5 && r.reboundFromLowPct >= 2 && r.vwapRecovered && Math.max(r.foreignStreak, r.instStreak) >= 2 && r.liquidityScore >= 50
  },
  {
    name: "I_급락보류_역추적",
    description: "당일 -12% 초과 또는 -5% 이하인데 VWAP 미회복/저점반등 부족. 매수하면 안 되는 구간의 역추적",
    test: (r) => r.dayChangePct < -12 || (r.dayChangePct <= -5 && (!r.vwapRecovered || r.reboundFromLowPct < 1.2))
  }
];

function isF(r) {
  return r.liquidityScore >= 50 && r.change3dPct >= -8 && r.change3dPct <= 5 && r.totalNetAmount > 0;
}

function isF2(r) {
  return isF(r) && Math.max(r.foreignStreak, r.instStreak) >= 2;
}

function isB(r) {
  return r.liquidityScore >= 50
    && Math.max(r.foreignStreak, r.instStreak) >= 2
    && r.change3dPct <= 12
    && r.dayChangePct <= 10
    && r.totalNetAmount > 0;
}

function isH3(r) {
  return r.dayChangePct >= -12
    && r.dayChangePct <= -5
    && r.reboundFromLowPct >= 2
    && r.vwapRecovered
    && Math.max(r.foreignStreak, r.instStreak) >= 2
    && r.liquidityScore >= 50;
}

function isDashboardAvoid(r) {
  return r.dayChangePct < -12 || (r.dayChangePct <= -5 && (!r.vwapRecovered || r.reboundFromLowPct < 1.2));
}

function isDashboardOverheat(r) {
  return !isDashboardAvoid(r) && (r.dayChangePct >= 10 || r.change3dPct >= 12);
}

function isDashboardBuyReady(r) {
  return r.liquidityScore >= 60
    && r.change3dPct >= -6
    && r.change3dPct <= 3
    && r.dayChangePct <= 5
    && Math.max(r.foreignStreak, r.instStreak) >= 2
    && r.totalNetAmount > 0
    && r.vwapRecovered
    && !isDashboardAvoid(r)
    && !isDashboardOverheat(r);
}

function isDashboardBuyCandidate(r) {
  if (isDashboardBuyReady(r) || isDashboardAvoid(r) || isDashboardOverheat(r)) return false;
  return isF(r) || isF2(r) || (isB(r) && r.liquidityScore >= 50);
}

function isDashboardSpecial(r) {
  return isH3(r) && !isDashboardAvoid(r);
}

function isDashboardObserve(r) {
  if (isDashboardAvoid(r) || isDashboardOverheat(r) || isF2(r) || isF(r) || isH3(r)) return false;
  const streak = Math.max(r.foreignStreak, r.instStreak) >= 2;
  const smartMoney = r.smartMoneyBodyPct >= 0.3 || r.smartMoneyTradingSharePct >= 10;
  const explosion = r.tradingValueRatio20 >= 3;
  const strongLiquidity = r.liquidityScore >= 70;
  return streak || smartMoney || explosion || strongLiquidity;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  console.log(`Backtest ${startDate}~${endDate}, universe=${universeMode}, limit=${marketLimit}`);
  const universe = (await loadUniverse()).slice(0, maxTickers || undefined);
  console.log(`Universe: ${universe.length} tickers`);
  const allRows = [];
  const allTrades = [];

  for (let i = 0; i < universe.length; i += 1) {
    const item = universe[i];
    process.stdout.write(`[${i + 1}/${universe.length}] ${item.code} ${item.name} ... `);
    try {
      const rows = await buildTickerRows(item);
      allRows.push(...rows.map((row) => ({ ...row, name: item.name, code: item.code })));
      const trades = buildTrades(item, rows);
      allTrades.push(...trades);
      console.log(`${rows.length} rows, ${trades.length} trades`);
    } catch (error) {
      console.log(`failed: ${error.message}`);
    }
  }

  const summary = summarize(allTrades);
  const stamp = `${startDate}_${endDate}_${universeMode}_${marketLimit}_${entryMode}`;
  const summaryPath = path.join(outDir, `backtest-summary-${stamp}.csv`);
  const tradesPath = path.join(outDir, `backtest-trades-${stamp}.csv`);
  const reportPath = path.join(outDir, `backtest-report-${stamp}.md`);

  writeFileSync(summaryPath, toCsv(summary), "utf8");
  writeFileSync(tradesPath, toCsv(allTrades), "utf8");
  writeFileSync(reportPath, buildMarkdownReport(summary, allTrades, universe), "utf8");

  console.log("");
  console.log(formatSummaryTable(summary));
  console.log("");
  console.log(`Saved:\n- ${summaryPath}\n- ${tradesPath}\n- ${reportPath}`);
}

async function loadUniverse() {
  if (universeMode === "market") {
    const [kospi, kosdaq] = await Promise.all([
      fetchMarketCapCandidates("KOSPI", marketLimit),
      fetchMarketCapCandidates("KOSDAQ", marketLimit)
    ]);
    return [...kospi, ...kosdaq];
  }
  if (universeMode === "account") {
    try {
      return await fetchAccountUniverse();
    } catch (error) {
      console.warn(`Account universe failed, fallback to portfolio.js: ${error.message}`);
    }
  }
  return dedupe(portfolio.map((item) => ({ code: item.code, name: item.name })));
}

async function buildTickerRows(item) {
  const prices = await fetchPriceHistory(item.code);
  const investors = await fetchInvestorHistory(item.code);
  const quote = await fetchQuote(item.code).catch(() => null);
  const listedShares = quote?.listedShares || inferListedShares(prices);
  const investorByDate = new Map(investors.map((row) => [row.date, row]));
  const merged = prices.map((row) => ({ ...row, ...(investorByDate.get(row.date) || emptyInvestor(row.date)) })).sort((a, b) => a.date.localeCompare(b.date));
  const result = [];

  let foreignStreak = 0;
  let instStreak = 0;
  for (let i = 0; i < merged.length; i += 1) {
    const r = merged[i];
    foreignStreak = r.foreignNetAmount > 0 ? foreignStreak + 1 : 0;
    instStreak = r.instNetAmount > 0 ? instStreak + 1 : 0;
    if (i < 25) continue;
    const prev = merged[i - 1];
    const base3 = merged[i - 3];
    const tradingValue20 = avg(merged.slice(i - 20, i).map((x) => x.tradingValue));
    const marketCap = listedShares && r.close ? listedShares * r.close : null;
    const bodyTurnoverPct = marketCap ? (r.tradingValue / marketCap) * 100 : 0;
    const tradingValueRatio20 = tradingValue20 ? r.tradingValue / tradingValue20 : 0;
    const totalNetAmount = r.foreignNetAmount + r.instNetAmount;
    const smartMoneyBodyPct = marketCap ? (totalNetAmount / marketCap) * 100 : 0;
    const smartMoneyTradingSharePct = r.tradingValue ? (totalNetAmount / r.tradingValue) * 100 : 0;
    const liquidityScore = calcLiquidityScore({ tradingValue: r.tradingValue, bodyTurnoverPct, tradingValueRatio20, smartMoneyBodyPct, smartMoneyTradingSharePct });
    const vwap = r.volume ? r.tradingValue / r.volume : null;
    const reboundFromLowPct = r.low ? (r.close / r.low - 1) * 100 : 0;
    const vwapRecovered = vwap ? r.close >= vwap : false;
    const bullishTurn = r.close >= r.open;
    const friendlySignalCount = [
      r.foreignNetAmount > 0,
      r.instNetAmount > 0,
      liquidityScore >= 40 || tradingValueRatio20 >= 2
    ].filter(Boolean).length;
    result.push({
      ...r,
      marketCap,
      bodyTurnoverPct,
      tradingValueRatio20,
      totalNetAmount,
      smartMoneyBodyPct,
      smartMoneyTradingSharePct,
      liquidityScore,
      foreignStreak,
      instStreak,
      dayChangePct: prev?.close ? (r.close / prev.close - 1) * 100 : 0,
      change3dPct: base3?.close ? (r.close / base3.close - 1) * 100 : 0,
      vwap,
      reboundFromLowPct,
      vwapRecovered,
      bullishTurn,
      friendlySignalCount
    });
  }
  return result;
}

function buildTrades(item, rows) {
  const trades = [];
  for (const holdingDays of holdingDaysList) {
    const cooldown = new Map();
    for (let i = 0; i < rows.length - holdingDays - 1; i += 1) {
      const signal = rows[i];
      for (const strategy of strategies) {
        const cooldownKey = `${strategy.name}:${holdingDays}:${item.code}`;
        if ((cooldown.get(cooldownKey) || "") >= signal.date) continue;
        if (!strategy.test(signal)) continue;
        const entryIndex = entryMode === "close" ? i : i + 1;
        const exitIndex = entryIndex + holdingDays;
        const entry = rows[entryIndex];
        const exit = rows[exitIndex];
        const entryPrice = entryMode === "close" ? entry?.close : entry?.open;
        if (!entryPrice || !exit?.close) continue;
        const grossReturnPct = (exit.close / entryPrice - 1) * 100;
        const netReturnPct = grossReturnPct - roundTripCostPct;
        trades.push({
          strategy: strategy.name,
          holdingDays,
          code: item.code,
          name: item.name,
          signalDate: signal.date,
          entryDate: entry.date,
          exitDate: exit.date,
          entryPrice,
          exitPrice: exit.close,
          netReturnPct,
          grossReturnPct,
          liquidityScore: signal.liquidityScore,
          bodyTurnoverPct: signal.bodyTurnoverPct,
          tradingValueRatio20: signal.tradingValueRatio20,
          smartMoneyTradingSharePct: signal.smartMoneyTradingSharePct,
          foreignStreak: signal.foreignStreak,
          instStreak: signal.instStreak,
          change3dPct: signal.change3dPct,
          dayChangePct: signal.dayChangePct,
          reboundFromLowPct: signal.reboundFromLowPct,
          vwapRecovered: signal.vwapRecovered,
          bullishTurn: signal.bullishTurn,
          friendlySignalCount: signal.friendlySignalCount
        });
        cooldown.set(cooldownKey, exit.date);
      }
    }
  }
  return trades;
}

function summarize(trades) {
  const groups = new Map();
  for (const trade of trades) {
    const key = `${trade.strategy}|${trade.holdingDays}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const [strategy, holdingDays] = key.split("|");
    const returns = rows.map((r) => r.netReturnPct);
    const wins = returns.filter((v) => v > 0);
    const losses = returns.filter((v) => v <= 0);
    const grossProfit = wins.reduce((s, v) => s + v, 0);
    const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
    return {
      strategy,
      holdingDays: Number(holdingDays),
      trades: rows.length,
      winRatePct: pctNum(wins.length / rows.length * 100),
      avgReturnPct: pctNum(avg(returns)),
      medianReturnPct: pctNum(median(returns)),
      bestPct: pctNum(Math.max(...returns)),
      worstPct: pctNum(Math.min(...returns)),
      profitFactor: grossLoss ? round(grossProfit / grossLoss, 2) : null,
      maxDrawdownPct: pctNum(calcMaxDrawdown(rows)),
      description: strategies.find((s) => s.name === strategy)?.description || ""
    };
  }).sort((a, b) => b.avgReturnPct - a.avgReturnPct);
}

function calcMaxDrawdown(rows) {
  const sorted = [...rows].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const row of sorted) {
    equity *= 1 + row.netReturnPct / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity / peak - 1);
  }
  return maxDd * 100;
}

async function fetchPriceHistory(code) {
  const cacheKey = `price-${code}-${startDate}-${endDate}.json`;
  const cached = readCache(cacheKey);
  if (cached) return cached;
  let cursorEnd = endDate;
  const rows = [];
  const seen = new Set();
  for (let page = 0; page < 12; page += 1) {
    const data = await kisGet("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: startDate,
      FID_INPUT_DATE_2: cursorEnd,
      FID_PERIOD_DIV_CODE: "D",
      FID_ORG_ADJ_PRC: "0"
    }, "FHKST03010100");
    const chunk = data.output2 || [];
    if (!chunk.length) break;
    for (const row of chunk) {
      const date = row.stck_bsop_date;
      if (!date || seen.has(date)) continue;
      seen.add(date);
      rows.push({
        date,
        open: num(row.stck_oprc),
        high: num(row.stck_hgpr),
        low: num(row.stck_lwpr),
        close: num(row.stck_clpr),
        volume: num(row.acml_vol),
        tradingValue: num(row.acml_tr_pbmn)
      });
    }
    const oldest = chunk.at(-1)?.stck_bsop_date;
    if (!oldest || oldest <= startDate) break;
    cursorEnd = yyyymmdd(addDays(parseYmd(oldest), -1));
  }
  const result = rows.filter((r) => r.date >= startDate && r.date <= endDate && r.close).sort((a, b) => a.date.localeCompare(b.date));
  writeCache(cacheKey, result);
  return result;
}

async function fetchInvestorHistory(code) {
  const cacheKey = `investor-${code}-${startDate}-${endDate}.json`;
  const cached = readCache(cacheKey);
  if (cached) return cached;
  let cursor = endDate;
  const rows = [];
  const seen = new Set();
  for (let page = 0; page < 28; page += 1) {
    const data = await kisGet("/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily", {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: cursor,
      FID_ORG_ADJ_PRC: "",
      FID_ETC_CLS_CODE: ""
    }, "FHPTJ04160001");
    const chunk = data.output2 || data.output || [];
    if (!chunk.length) break;
    for (const row of chunk) {
      const date = row.stck_bsop_date;
      if (!date || seen.has(date)) continue;
      seen.add(date);
      rows.push({
        date,
        foreignNetAmount: num(row.frgn_ntby_tr_pbmn) * 1_000_000,
        instNetAmount: num(row.orgn_ntby_tr_pbmn) * 1_000_000
      });
    }
    const oldest = chunk.at(-1)?.stck_bsop_date;
    if (!oldest || oldest <= startDate) break;
    cursor = yyyymmdd(addDays(parseYmd(oldest), -1));
  }
  const result = rows.filter((r) => r.date >= startDate && r.date <= endDate).sort((a, b) => a.date.localeCompare(b.date));
  writeCache(cacheKey, result);
  return result;
}

async function fetchQuote(code) {
  const cacheKey = `quote-${code}.json`;
  const cached = readCache(cacheKey, 1000 * 60 * 60 * 24 * 7);
  if (cached) return cached;
  const data = await kisGet("/uapi/domestic-stock/v1/quotations/inquire-price", {
    FID_COND_MRKT_DIV_CODE: "J",
    FID_INPUT_ISCD: code
  }, "FHKST01010100");
  const out = data.output || {};
  const result = { listedShares: num(out.lstn_stcn), name: out.hts_kor_isnm || code };
  writeCache(cacheKey, result);
  return result;
}

async function fetchAccountUniverse() {
  const account = kisAccountConfig();
  if (!account.cano) throw new Error("KIS account not configured");
  const data = await kisGet("/uapi/domestic-stock/v1/trading/inquire-balance", {
    CANO: account.cano,
    ACNT_PRDT_CD: account.product,
    AFHR_FLPR_YN: "N",
    OFL_YN: "",
    INQR_DVSN: "02",
    UNPR_DVSN: "01",
    FUND_STTL_ICLD_YN: "N",
    FNCG_AMT_AUTO_RDPT_YN: "N",
    PRCS_DVSN: "01",
    CTX_AREA_FK100: "",
    CTX_AREA_NK100: ""
  }, account.trId);
  return dedupe((data.output1 || []).filter((r) => num(r.hldg_qty) > 0).map((r) => ({
    code: String(r.pdno).padStart(6, "0"),
    name: String(r.prdt_name || r.prdt_name120 || r.pdno).trim()
  })));
}

async function fetchMarketCapCandidates(market, count) {
  const cacheKey = `universe-${market}-${count}.json`;
  const cached = readCache(cacheKey, 1000 * 60 * 60 * 12);
  if (cached) return cached;
  const candidates = [];
  const seen = new Set();
  const sosok = market === "KOSDAQ" ? "1" : "0";
  for (let page = 1; page <= 8 && candidates.length < count; page += 1) {
    const response = await fetch(`https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`, {
      headers: { "user-agent": USER_AGENT, referer: "https://finance.naver.com/sise/" }
    });
    const html = await readKoreanHtml(response);
    const matches = html.matchAll(/<a\s+href="\/item\/main\.naver\?code=(\d{6})"[^>]*class="tltle"[^>]*>([\s\S]*?)<\/a>/g);
    for (const match of matches) {
      const code = match[1];
      const name = stripHtml(match[2]);
      if (seen.has(code) || isExcludedMarketCandidate(name)) continue;
      seen.add(code);
      candidates.push({ code, name, market });
      if (candidates.length >= count) break;
    }
  }
  writeCache(cacheKey, candidates);
  return candidates;
}

async function kisGet(endpoint, params, trId) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const token = await getKisToken();
      await throttleKis();
      const url = new URL(endpoint, KIS_BASE_URL);
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization: `Bearer ${token}`,
          appkey: process.env.KIS_APP_KEY,
          appsecret: process.env.KIS_APP_SECRET,
          tr_id: trId,
          custtype: process.env.KIS_CUSTTYPE || "P",
          "user-agent": USER_AGENT
        }
      });
      const data = await response.json();
      if (!response.ok || (data.rt_cd && data.rt_cd !== "0")) {
        throw new Error(data.msg1 || `KIS failed ${endpoint}`);
      }
      return data;
    } catch (error) {
      lastError = error;
      const message = String(error.message || "");
      const retryable = message.includes("초당") || message.includes("잠시") || message.includes("EGW");
      if (!retryable || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function getKisToken() {
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    const cached = readCache("kis-token.json", 1000 * 60 * 50);
    if (cached?.access_token) return cached.access_token;
    const response = await fetch(`${KIS_BASE_URL}/oauth2/tokenP`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ grant_type: "client_credentials", appkey: process.env.KIS_APP_KEY, appsecret: process.env.KIS_APP_SECRET })
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error(data.msg1 || data.error_description || "KIS token failed");
    writeCache("kis-token.json", data);
    return data.access_token;
  })();
  return tokenPromise;
}

async function throttleKis() {
  const minGapMs = Number(process.env.KIS_REQUEST_GAP_MS || 140);
  const now = Date.now();
  const waitMs = Math.max(0, lastKisCallAt + minGapMs - now);
  lastKisCallAt = now + waitMs;
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

function calcLiquidityScore({ tradingValue, bodyTurnoverPct, tradingValueRatio20, smartMoneyBodyPct, smartMoneyTradingSharePct }) {
  const absoluteValueScore = scaled((tradingValue ?? 0) / eok, 500, 3000, 10000);
  const bodyScore = scaled(bodyTurnoverPct, 1, 5, 20);
  const explosionScore = scaled(tradingValueRatio20, 1, 3, 10);
  const smartBodyScore = scaled(smartMoneyBodyPct, 0.1, 0.3, 1);
  const leadershipScore = scaled(smartMoneyTradingSharePct, 5, 10, 30);
  return Math.round(absoluteValueScore * 0.12 + bodyScore * 0.31 + explosionScore * 0.27 + smartBodyScore * 0.20 + leadershipScore * 0.10);
}

function scaled(value, weak, strong, extreme) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  if (value <= weak) return 0;
  if (value >= extreme) return 100;
  if (value >= strong) return 70 + ((value - strong) / (extreme - strong)) * 30;
  return ((value - weak) / (strong - weak)) * 70;
}

function buildMarkdownReport(summary, trades, universe) {
  const lines = [];
  lines.push(`# 거래강도 기준 백테스트`);
  lines.push("");
  lines.push(`- 기간: ${startDate}~${endDate}`);
  lines.push(`- 우주: ${universeMode} (${universe.length}종목)`);
  lines.push(`- 진입: ${entryMode === "close" ? "신호 당일 종가" : "신호 다음 거래일 시가"}`);
  lines.push(`- 청산: 지정 보유일 뒤 종가`);
  lines.push(`- 비용: 왕복 ${roundTripCostPct}% 차감`);
  lines.push(`- 낙주반등 주의: 5분봉이 없어서 장중 VWAP가 아니라 일봉 근사 VWAP(거래대금/거래량)와 종가 기준 회복으로 계산했습니다.`);
  lines.push(`- 주의: 현재 구성종목 기준이라 과거 편입/상장폐지 종목이 빠지는 survivorship bias가 있습니다.`);
  lines.push("");
  lines.push(`## 요약`);
  lines.push("");
  lines.push(`|전략|보유일|거래수|승률|평균|중앙값|최고|최악|PF|MDD|`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const row of summary) {
    lines.push(`|${row.strategy}|${row.holdingDays}|${row.trades}|${row.winRatePct}%|${row.avgReturnPct}%|${row.medianReturnPct}%|${row.bestPct}%|${row.worstPct}%|${row.profitFactor ?? ""}|${row.maxDrawdownPct}%|`);
  }
  lines.push("");
  lines.push(`## 전략 정의`);
  for (const s of strategies) lines.push(`- ${s.name}: ${s.description}`);
  lines.push("");
  lines.push(`## 상위/하위 트레이드`);
  const sorted = [...trades].sort((a, b) => b.netReturnPct - a.netReturnPct);
  for (const t of sorted.slice(0, 10)) lines.push(`- 상위: ${t.strategy} ${t.name} ${t.signalDate} -> ${t.netReturnPct.toFixed(2)}%`);
  for (const t of sorted.slice(-10).reverse()) lines.push(`- 하위: ${t.strategy} ${t.name} ${t.signalDate} -> ${t.netReturnPct.toFixed(2)}%`);
  return `${lines.join("\n")}\n`;
}

function formatSummaryTable(summary) {
  return summary.map((r) => `${r.strategy.padEnd(14)} ${String(r.holdingDays).padStart(2)}d trades=${String(r.trades).padStart(4)} win=${String(r.winRatePct).padStart(6)}% avg=${String(r.avgReturnPct).padStart(7)}% mdd=${String(r.maxDrawdownPct).padStart(7)}%`).join("\n");
}

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map((row) => cols.map((col) => csvCell(row[col])).join(","))].join("\n");
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

function kisAccountConfig() {
  const combined = process.env.KIS_ACCOUNT_NO || process.env.KIS_ACCOUNT || "";
  const match = String(combined).trim().match(/^(\d{8})[-\s]?(\d{2})$/);
  return {
    cano: process.env.KIS_CANO || process.env.KIS_ACCOUNT_CANO || match?.[1] || "",
    product: process.env.KIS_ACNT_PRDT_CD || process.env.KIS_ACCOUNT_PRODUCT_CODE || match?.[2] || "01",
    trId: process.env.KIS_BALANCE_TR_ID || (process.env.KIS_VIRTUAL === "1" ? "VTTC8434R" : "TTTC8434R")
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = "1";
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function readCache(name, ttlMs = Infinity) {
  const file = path.join(cacheDir, name);
  if (!existsSync(file)) return null;
  const stat = readFileSync(file, "utf8");
  const parsed = JSON.parse(stat);
  if (parsed.__createdAt && Date.now() - parsed.__createdAt > ttlMs) return null;
  return parsed.value ?? parsed;
}

function writeCache(name, value) {
  writeFileSync(path.join(cacheDir, name), JSON.stringify({ __createdAt: Date.now(), value }, null, 2), "utf8");
}

function inferListedShares(prices) {
  return null;
}

function emptyInvestor(date) {
  return { date, foreignNetAmount: 0, instNetAmount: 0 };
}

function avg(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  return valid.length ? valid.reduce((s, v) => s + v, 0) / valid.length : 0;
}

function median(values) {
  const valid = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!valid.length) return 0;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function pctNum(value) {
  return round(value || 0, 2);
}

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function num(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replace(/[,+%\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function yyyymmdd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function parseYmd(value) {
  return new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00+09:00`);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (!/^\d{6}$/.test(row.code) || seen.has(row.code)) return false;
    seen.add(row.code);
    return true;
  });
}

function isExcludedMarketCandidate(name = "") {
  const normalized = String(name).toUpperCase().replace(/\s/g, "");
  const keywords = ["KODEX", "TIGER", "ACE", "SOL", "KBSTAR", "HANARO", "RISE", "PLUS", "TIMEFOLIO", "ETF", "ETN", "인버스", "레버리지", "선물", "스팩", "SPAC"];
  return keywords.some((keyword) => normalized.includes(keyword)) || /우(B|C)?$/.test(String(name).trim());
}

function stripHtml(value = "") {
  return String(value).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();
}

async function readKoreanHtml(response) {
  const buffer = await response.arrayBuffer();
  const euckr = new TextDecoder("euc-kr").decode(buffer);
  if (!euckr.includes("�")) return euckr;
  return new TextDecoder("utf-8").decode(buffer);
}
