import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { portfolio } from "./portfolio.js";
import { buildIndicators, buildPortfolioSummary, classifyHolding, toNumber } from "./signals.js";
import { buildLeaderDecision, calcLeaderBase, enrichLeaderScores } from "./leader.js";
import { buildStrategyConfirmation } from "./strategy-confirmation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map();

loadDotEnv();

const PORT = Number(process.env.PORT || 5177);
const KIS_BASE_URL = process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443";
const KIS_QUOTE_MARKET = process.env.KIS_QUOTE_MARKET || process.env.KIS_MARKET_DIV_CODE || "UN";
const USER_AGENT = "Mozilla/5.0 PortfolioSignalDashboard/0.2";
const FREE_FLOAT_RATES = loadFreeFloatRates();
const SIMULATION_FILE = path.join(__dirname, "simulation-ledger.json");
const SIM_TRADE_AMOUNT = Number(process.env.SIM_TRADE_AMOUNT || 1_000_000);
const KIS_TOKEN_FILE = path.join(__dirname, "backtest-cache", "kis-token-server.json");
const BACKTEST_CACHE_DIR = path.join(__dirname, "backtest-cache");
let lastKisCallAt = 0;
let kisTokenPromise = null;
let backtestPriceFileIndex = null;

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadFreeFloatRates() {
  const filePath = path.join(__dirname, "free-float.json");
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function kisAccountConfig() {
  const combined = process.env.KIS_ACCOUNT_NO || process.env.KIS_ACCOUNT || "";
  const match = String(combined).trim().match(/^(\d{8})[-\s]?(\d{2})$/);
  const cano = process.env.KIS_CANO || process.env.KIS_ACCOUNT_CANO || match?.[1] || "";
  const product = process.env.KIS_ACNT_PRDT_CD || process.env.KIS_ACCOUNT_PRODUCT_CODE || match?.[2] || "01";
  return {
    cano: String(cano).trim(),
    product: String(product).trim(),
    trId: process.env.KIS_BALANCE_TR_ID || (process.env.KIS_VIRTUAL === "1" ? "VTTC8434R" : "TTTC8434R")
  };
}

function hasKisAccountConfig() {
  const account = kisAccountConfig();
  return /^\d{8}$/.test(account.cano) && /^\d{2}$/.test(account.product);
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function isAuthorized(req) {
  const password = process.env.DASHBOARD_PASSWORD || "";
  if (!password) return true;
  const authorization = String(req.headers.authorization || "");
  if (!authorization.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    const username = decoded.slice(0, separator);
    const suppliedPassword = decoded.slice(separator + 1);
    return username === (process.env.DASHBOARD_USERNAME || "gunhee") && suppliedPassword === password;
  } catch {
    return false;
  }
}

function requestLogin(res) {
  res.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "www-authenticate": 'Basic realm="Private Stock Dashboard", charset="UTF-8"'
  });
  res.end("로그인이 필요합니다.");
}

function cacheGet(key, ttlMs) {
  const item = cache.get(key);
  if (!item || Date.now() - item.createdAt > ttlMs) return null;
  return item.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, createdAt: Date.now() });
  return value;
}

function clearLiveSnapshotCache() {
  for (const key of cache.keys()) {
    if (
      key === "account-holdings"
      || key === "snapshot-live"
      || key.startsWith("quote:")
      || key.startsWith("investor:")
      || key.startsWith("investor-streak:")
      || key.startsWith("program:")
      || key.startsWith("history:")
      || key.startsWith("execution:")
    ) {
      cache.delete(key);
    }
  }
}

function kisSignal(ms = Number(process.env.KIS_TIMEOUT_MS || 8000)) {
  return AbortSignal.timeout(ms);
}

async function getKisToken() {
  const cached = cacheGet("kis-token", 1000 * 60 * 50);
  if (cached) return cached;
  const fileCached = readKisTokenFile();
  if (fileCached) return cacheSet("kis-token", fileCached);
  if (kisTokenPromise) return kisTokenPromise;
  const appkey = process.env.KIS_APP_KEY;
  const appsecret = process.env.KIS_APP_SECRET;
  if (!appkey || !appsecret) throw new Error("KIS_APP_KEY and KIS_APP_SECRET are required");

  kisTokenPromise = (async () => {
    const response = await fetch(`${KIS_BASE_URL}/oauth2/tokenP`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      signal: kisSignal(10000),
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey,
        appsecret
      })
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) {
      throw new Error(data.msg1 || data.error_description || "KIS token request failed");
    }
    writeKisTokenFile(data);
    return cacheSet("kis-token", data.access_token);
  })();

  try {
    return await kisTokenPromise;
  } finally {
    kisTokenPromise = null;
  }
}

function readKisTokenFile() {
  if (!existsSync(KIS_TOKEN_FILE)) return null;
  try {
    const statAgeMs = Date.now() - new Date(readFileSync(KIS_TOKEN_FILE, "utf8").match(/"cachedAt"\s*:\s*"([^"]+)"/)?.[1] ?? 0).getTime();
    if (!Number.isFinite(statAgeMs) || statAgeMs > 1000 * 60 * 50) return null;
    const data = JSON.parse(readFileSync(KIS_TOKEN_FILE, "utf8"));
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

function writeKisTokenFile(data) {
  try {
    writeFileSync(KIS_TOKEN_FILE, JSON.stringify({ ...data, cachedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch {
    // Token file cache is a convenience only; in-memory cache still works.
  }
}

async function kisGet(endpoint, params, trId) {
  const token = await getKisToken();
  await throttleKis();
  const url = new URL(endpoint, KIS_BASE_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, {
    signal: kisSignal(),
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
    throw new Error(data.msg1 || `KIS request failed: ${endpoint}`);
  }
  return data;
}

async function throttleKis() {
  const minGapMs = Number(process.env.KIS_REQUEST_GAP_MS || 250);
  const now = Date.now();
  const waitMs = Math.max(0, lastKisCallAt + minGapMs - now);
  lastKisCallAt = now + waitMs;
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function fetchQuote(code, market = KIS_QUOTE_MARKET, force = false) {
  const marketCode = String(market || "J").toUpperCase();
  const cached = cacheGet(`quote:${marketCode}:${code}`, 1000 * 20);
  if (cached && !force) return cached;
  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-price",
    { FID_COND_MRKT_DIV_CODE: marketCode, FID_INPUT_ISCD: code },
    "FHKST01010100"
  );
  const out = data.output ?? {};
  return cacheSet(`quote:${marketCode}:${code}`, {
    code,
    price: toNumber(out.stck_prpr),
    prevClose: toNumber(out.stck_prdy_clpr),
    open: toNumber(out.stck_oprc),
    high: toNumber(out.stck_hgpr),
    low: toNumber(out.stck_lwpr),
    changeRate: toNumber(out.prdy_ctrt),
    volume: toNumber(out.acml_vol),
    tradingValue: toNumber(out.acml_tr_pbmn),
    listedShares: toNumber(out.lstn_stcn),
    marketCap: toNumber(out.stck_prpr) && toNumber(out.lstn_stcn) ? toNumber(out.stck_prpr) * toNumber(out.lstn_stcn) : null,
    strength: toNumber(out.prdy_vrss_vol_rate),
    foreignNetQty: toNumber(out.frgn_ntby_qty),
    programNetQty: toNumber(out.pgtr_ntby_qty),
    source: "kis",
    market: marketCode
  });
}

function hasPositiveQuoteValue(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function hasQuoteCoreData(quote) {
  return hasPositiveQuoteValue(quote?.price)
    && hasPositiveQuoteValue(quote?.tradingValue)
    && hasPositiveQuoteValue(quote?.marketCap);
}

function positiveQuoteValue(primary, fallback) {
  return hasPositiveQuoteValue(primary) ? primary : fallback;
}

function mergeQuoteSupplement(primary, fallback, preferredMarket) {
  const primaryHasPrice = hasPositiveQuoteValue(primary?.price);
  const price = positiveQuoteValue(primary?.price, fallback?.price);
  const listedShares = positiveQuoteValue(primary?.listedShares, fallback?.listedShares);
  const marketCap = positiveQuoteValue(primary?.marketCap, price && listedShares ? price * listedShares : fallback?.marketCap);
  return {
    ...fallback,
    ...primary,
    price,
    prevClose: positiveQuoteValue(primary?.prevClose, fallback?.prevClose),
    open: positiveQuoteValue(primary?.open, fallback?.open),
    high: positiveQuoteValue(primary?.high, fallback?.high),
    low: positiveQuoteValue(primary?.low, fallback?.low),
    changeRate: primaryHasPrice && Number.isFinite(primary?.changeRate) ? primary.changeRate : fallback?.changeRate,
    volume: positiveQuoteValue(primary?.volume, fallback?.volume),
    tradingValue: positiveQuoteValue(primary?.tradingValue, fallback?.tradingValue),
    listedShares,
    marketCap,
    strength: primaryHasPrice && Number.isFinite(primary?.strength) ? primary.strength : fallback?.strength,
    foreignNetQty: primaryHasPrice && Number.isFinite(primary?.foreignNetQty) ? primary.foreignNetQty : fallback?.foreignNetQty,
    programNetQty: primaryHasPrice && Number.isFinite(primary?.programNetQty) ? primary.programNetQty : fallback?.programNetQty,
    source: primaryHasPrice ? `kis-${preferredMarket.toLowerCase()}+j-supplement` : "kis-j-fallback",
    market: primaryHasPrice ? preferredMarket : "J",
    supplementedFrom: "J"
  };
}

async function fetchQuoteWithKrxFallback(code, force = false) {
  const preferredMarket = String(KIS_QUOTE_MARKET || "J").toUpperCase();
  let preferredQuote = null;
  let preferredError = null;
  try {
    preferredQuote = await fetchQuote(code, preferredMarket, force);
  } catch (error) {
    preferredError = error;
  }

  if (preferredMarket === "J") {
    if (hasPositiveQuoteValue(preferredQuote?.price)) return preferredQuote;
    throw preferredError ?? new Error(`${code} KRX 시세 응답이 비어 있습니다.`);
  }
  if (hasQuoteCoreData(preferredQuote)) return preferredQuote;

  let krxQuote = null;
  let krxError = null;
  try {
    krxQuote = await fetchQuote(code, "J", force);
  } catch (error) {
    krxError = error;
  }
  if (hasPositiveQuoteValue(krxQuote?.price)) {
    return mergeQuoteSupplement(preferredQuote, krxQuote, preferredMarket);
  }
  if (hasPositiveQuoteValue(preferredQuote?.price)) return preferredQuote;

  const detail = [preferredError?.message, krxError?.message].filter(Boolean).join(" / ");
  throw new Error(detail || `${code} NXT와 KRX 시세 응답이 모두 비어 있습니다.`);
}

async function fetchAccountHoldings(force = false) {
  const cached = cacheGet("account-holdings", 1000 * 20);
  if (cached && !force) return cached;
  const account = kisAccountConfig();
  if (!hasKisAccountConfig()) throw new Error("KIS account number is not configured");

  const holdingsByCode = new Map();
  const seenPageKeys = new Set();
  let accountSummary = null;
  let fk = "";
  let nk = "";
  let trCont = "";

  for (let page = 0; page < 8; page += 1) {
    const { data, headers } = await kisGetWithHeaders(
      "/uapi/domestic-stock/v1/trading/inquire-balance",
      {
        CANO: account.cano,
        ACNT_PRDT_CD: account.product,
        AFHR_FLPR_YN: "N",
        OFL_YN: "",
        INQR_DVSN: "02",
        UNPR_DVSN: "01",
        FUND_STTL_ICLD_YN: "N",
        FNCG_AMT_AUTO_RDPT_YN: "N",
        PRCS_DVSN: "01",
        CTX_AREA_FK100: fk,
        CTX_AREA_NK100: nk
      },
      account.trId,
      trCont
    );
    const rows = Array.isArray(data.output1) ? data.output1 : [];
    const output2 = Array.isArray(data.output2) ? (data.output2[0] ?? {}) : (data.output2 ?? {});
    if (!accountSummary && Object.keys(output2).length) accountSummary = parseAccountSummary(output2);
    const pageKey = rows.map((row) => `${row.pdno}:${row.hldg_qty}:${row.pchs_amt}:${row.evlu_amt}`).join("|");
    if (seenPageKeys.has(pageKey)) break;
    seenPageKeys.add(pageKey);
    for (const row of rows) {
      const code = String(row.pdno ?? "").trim().padStart(6, "0");
      const qty = toNumber(row.hldg_qty);
      if (!/^\d{6}$/.test(code) || !qty || qty <= 0) continue;
      const accountInvested = toNumber(row.pchs_amt) ?? null;
      const avgPrice = toNumber(row.pchs_avg_pric) ?? toNumber(row.pchs_avg_pric_amt) ?? (accountInvested ? accountInvested / qty : 0);
      const currentPrice = toNumber(row.prpr) ?? toNumber(row.now_pric) ?? avgPrice;
      const accountValue = toNumber(row.evlu_amt) ?? (currentPrice ? currentPrice * qty : null);
      const accountPnl = toNumber(row.evlu_pfls_amt) ?? (accountValue !== null && accountInvested !== null ? accountValue - accountInvested : null);
      const accountPnlPct = toNumber(row.evlu_pfls_rt);
      const changeRate = toNumber(row.fltt_rt);
      const previous = holdingsByCode.get(code);
      if (previous) {
        const mergedQty = previous.qty + qty;
        const mergedInvested = (previous.accountInvested ?? previous.avgPrice * previous.qty) + (accountInvested ?? avgPrice * qty);
        const mergedValue = (previous.accountValue ?? previous.fallbackPrice * previous.qty) + (accountValue ?? currentPrice * qty);
        const mergedPnl = (previous.accountPnl ?? previous.accountValue - previous.accountInvested) + (accountPnl ?? mergedValue - mergedInvested);
        holdingsByCode.set(code, {
          ...previous,
          qty: mergedQty,
          avgPrice: mergedQty ? mergedInvested / mergedQty : previous.avgPrice,
          accountInvested: mergedInvested,
          accountValue: mergedValue,
          accountPnl: mergedPnl,
          accountPnlPct: mergedInvested ? (mergedPnl / mergedInvested) * 100 : previous.accountPnlPct
        });
        continue;
      }

      holdingsByCode.set(code, {
        name: String(row.prdt_name ?? row.prdt_name120 ?? code).trim() || code,
        code,
        qty,
        avgPrice,
        fallbackPrice: currentPrice || avgPrice,
        accountInvested,
        accountValue,
        accountPnl,
        accountPnlPct,
        quote: {
          code,
          price: currentPrice,
          changeRate,
          source: "kis-balance"
        }
      });
    }
    const nextFk = data.ctx_area_fk100 ?? output2.ctx_area_fk100 ?? "";
    const nextNk = data.ctx_area_nk100 ?? output2.ctx_area_nk100 ?? "";
    const next = String(headers.get("tr_cont") ?? "").toUpperCase();
    if (next !== "M" || ((!nextFk && !nextNk) || (nextFk === fk && nextNk === nk))) break;
    fk = nextFk;
    nk = nextNk;
    trCont = "N";
  }

  const holdings = [...holdingsByCode.values()];
  if (!holdings.length) throw new Error("KIS account balance returned no holdings");
  return cacheSet("account-holdings", { holdings, accountSummary });
}

async function applyQuoteValuation(holdings, errors, force = false) {
  if (process.env.KIS_REPRICE_ACCOUNT === "0") return { holdings, accountSummary: null };
  const market = KIS_QUOTE_MARKET;
  const repriced = await mapLimit(holdings, 2, async (item) => {
    try {
      const quote = await withRetry(() => fetchQuote(item.code, market, force), 2);
      if (!quote?.price) return item;
      const accountInvested = item.accountInvested ?? item.avgPrice * item.qty;
      const accountValue = Math.round(quote.price * item.qty);
      const accountPnl = accountInvested !== null ? accountValue - accountInvested : item.accountPnl;
      const accountPnlPct = accountInvested ? (accountPnl / accountInvested) * 100 : item.accountPnlPct;
      return {
        ...item,
        fallbackPrice: quote.price,
        accountValue,
        accountPnl,
        accountPnlPct,
        quote: {
          ...item.quote,
          ...quote,
          source: `kis-${market.toLowerCase()}-reprice`
        }
      };
    } catch (error) {
      errors.push({ code: item.code, name: item.name, type: "reprice", market, message: error.message });
      return item;
    }
  });
  return { holdings: repriced, accountSummary: buildAccountSummaryFromHoldings(repriced) };
}

function buildAccountSummaryFromHoldings(holdings) {
  const totalValue = holdings.reduce((sum, item) => sum + (item.accountValue ?? item.fallbackPrice * item.qty), 0);
  const totalInvested = holdings.reduce((sum, item) => sum + (item.accountInvested ?? item.avgPrice * item.qty), 0);
  const totalPnl = totalValue - totalInvested;
  return {
    totalValue,
    totalInvested,
    totalPnl,
    totalPnlPct: totalInvested ? (totalPnl / totalInvested) * 100 : null,
    valuationMarket: KIS_QUOTE_MARKET,
    source: "quote-repriced"
  };
}

async function applyHoldingAnalyticsQuotes(holdings, errors, force = false) {
  const analyticsMarket = process.env.KIS_ANALYTICS_MARKET || "J";
  return mapLimit(holdings, 3, async (item) => {
    try {
      const analyticsQuote = await withRetry(() => fetchQuote(item.code, analyticsMarket, force), 2);
      const currentQuote = item.quote ?? {};
      const hasCurrentChangeRate = Number.isFinite(currentQuote.changeRate)
        && (Number.isFinite(currentQuote.prevClose) || currentQuote.changeRate !== 0);
      return {
        ...item,
        quote: {
          ...analyticsQuote,
          ...currentQuote,
          price: currentQuote.price ?? analyticsQuote.price,
          prevClose: currentQuote.prevClose ?? analyticsQuote.prevClose,
          open: currentQuote.open ?? analyticsQuote.open,
          high: currentQuote.high ?? analyticsQuote.high,
          low: currentQuote.low ?? analyticsQuote.low,
          changeRate: hasCurrentChangeRate ? currentQuote.changeRate : analyticsQuote.changeRate,
          volume: currentQuote.volume ?? analyticsQuote.volume,
          tradingValue: currentQuote.tradingValue ?? analyticsQuote.tradingValue,
          listedShares: currentQuote.listedShares ?? analyticsQuote.listedShares,
          marketCap: currentQuote.marketCap ?? analyticsQuote.marketCap,
          strength: currentQuote.strength ?? analyticsQuote.strength,
          foreignNetQty: currentQuote.foreignNetQty ?? analyticsQuote.foreignNetQty,
          programNetQty: currentQuote.programNetQty ?? analyticsQuote.programNetQty,
          source: currentQuote.source && analyticsQuote.source ? `${currentQuote.source}+${analyticsQuote.market ?? analyticsMarket}-analytics` : (currentQuote.source ?? analyticsQuote.source),
          market: currentQuote.market ?? analyticsQuote.market
        }
      };
    } catch (error) {
      errors.push({ code: item.code, name: item.name, type: "holding-analytics-quote", market: analyticsMarket, message: error.message });
      return item;
    }
  });
}

function parseAccountSummary(row = {}) {
  const totalValue = toNumber(row.evlu_amt_smtl_amt) ?? toNumber(row.scts_evlu_amt) ?? toNumber(row.tot_evlu_amt) ?? null;
  const totalInvested = toNumber(row.pchs_amt_smtl_amt) ?? null;
  const totalPnl = toNumber(row.evlu_pfls_smtl_amt) ?? null;
  const totalPnlPct = toNumber(row.evlu_pfls_rt) ?? (totalInvested && totalPnl !== null ? (totalPnl / totalInvested) * 100 : null);
  return {
    totalValue,
    totalInvested,
    totalPnl,
    totalPnlPct
  };
}

function firstOutput(data) {
  const output = data.output2 ?? data.output ?? [];
  return Array.isArray(output) ? (output[0] ?? {}) : output;
}

async function kisGetWithHeaders(endpoint, params, trId, trCont = "") {
  const token = await getKisToken();
  await throttleKis();
  const url = new URL(endpoint, KIS_BASE_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, {
    signal: kisSignal(),
    headers: {
      authorization: `Bearer ${token}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: trId,
      tr_cont: trCont,
      custtype: process.env.KIS_CUSTTYPE || "P",
      "user-agent": USER_AGENT
    }
  });
  const data = await response.json();
  if (!response.ok || (data.rt_cd && data.rt_cd !== "0")) {
    throw new Error(data.msg1 || `KIS request failed: ${endpoint}`);
  }
  return { data, headers: response.headers };
}

function volumeRankInputCode(market) {
  return market === "KOSDAQ" ? "1001" : "0001";
}

function isExcludedMarketCandidate(name = "") {
  const normalized = String(name).toUpperCase().replace(/\s/g, "");
  const keywords = ["KODEX", "TIGER", "ACE", "SOL", "KBSTAR", "HANARO", "RISE", "PLUS", "TIMEFOLIO", "ETF", "ETN", "인버스", "레버리지", "선물", "스팩", "SPAC"];
  return keywords.some((keyword) => normalized.includes(keyword)) || /우(B|C)?$/.test(String(name).trim());
}

function stripHtml(value = "") {
  return String(value)
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

async function readKoreanHtml(response) {
  const buffer = await response.arrayBuffer();
  const euckr = new TextDecoder("euc-kr").decode(buffer);
  if (!euckr.includes("�")) return euckr;
  return new TextDecoder("utf-8").decode(buffer);
}

async function fetchMarketCapCandidates(market, count) {
  const cached = cacheGet(`naver-marketcap:${market}:${count}`, 1000 * 60 * 30);
  if (cached) return cached;
  const candidates = [];
  const seen = new Set();
  const sosok = market === "KOSDAQ" ? "1" : "0";

  for (let page = 1; page <= 8 && candidates.length < count; page += 1) {
    const response = await fetch(`https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`, {
      headers: {
        "user-agent": USER_AGENT,
        referer: "https://finance.naver.com/sise/"
      }
    });
    if (!response.ok) break;
    const html = await readKoreanHtml(response);
    const matches = html.matchAll(/<a\s+href="\/item\/main\.naver\?code=(\d{6})"[^>]*class="tltle"[^>]*>([\s\S]*?)<\/a>/g);
    let found = 0;
    for (const match of matches) {
      found += 1;
      const code = match[1];
      const name = stripHtml(match[2]);
      if (!/^\d{6}$/.test(code) || seen.has(code) || isExcludedMarketCandidate(name)) continue;
      seen.add(code);
      candidates.push({ market, code, name, rank: candidates.length + 1, rankType: "시총" });
      if (candidates.length >= count) break;
    }
    if (!found) break;
  }

  return cacheSet(`naver-marketcap:${market}:${count}`, candidates);
}

function mergeCandidates(primary, supplement, count) {
  const seen = new Set(primary.map((row) => row.code));
  const merged = [...primary];
  for (const row of supplement) {
    if (merged.length >= count) break;
    if (seen.has(row.code)) continue;
    seen.add(row.code);
    merged.push({ ...row, rankType: row.rankType ?? "거래" });
  }
  return merged.slice(0, count);
}

async function fetchVolumeRankCandidates(market, count) {
  const cached = cacheGet(`volume-rank:${market}:${count}`, 1000 * 60 * 5);
  if (cached) return cached;
  const candidates = [];
  const seen = new Set();
  let trCont = "";
  const params = {
    FID_COND_MRKT_DIV_CODE: "J",
    FID_COND_SCR_DIV_CODE: "20171",
    FID_INPUT_ISCD: volumeRankInputCode(market),
    FID_DIV_CLS_CODE: "0",
    FID_BLNG_CLS_CODE: "3",
    FID_TRGT_CLS_CODE: "111111111",
    FID_TRGT_EXLS_CLS_CODE: "0000000000",
    FID_INPUT_PRICE_1: "",
    FID_INPUT_PRICE_2: "",
    FID_VOL_CNT: "",
    FID_INPUT_DATE_1: ""
  };

  for (let page = 0; page < 8 && candidates.length < count; page += 1) {
    const { data, headers } = await kisGetWithHeaders("/uapi/domestic-stock/v1/quotations/volume-rank", params, "FHPST01710000", trCont);
    const output = data.output ?? [];
    for (const row of Array.isArray(output) ? output : []) {
      const code = String(row.mksc_shrn_iscd ?? "").trim().padStart(6, "0");
      const name = String(row.hts_kor_isnm ?? code).trim();
      if (!/^\d{6}$/.test(code) || seen.has(code) || isExcludedMarketCandidate(name)) continue;
      seen.add(code);
      candidates.push({ market, code, name, rank: candidates.length + 1, rankType: "거래" });
      if (candidates.length >= count) break;
    }
    const next = String(headers.get("tr_cont") ?? "").toUpperCase();
    if (next !== "M") break;
    trCont = "N";
  }
  return cacheSet(`volume-rank:${market}:${count}`, candidates);
}

async function fetchExecution(code) {
  const cached = cacheGet(`execution:${code}`, 1000 * 20);
  if (cached) return cached;
  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-ccnl",
    { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code },
    "FHKST01010300"
  );
  const out = firstOutput(data);
  return cacheSet(`execution:${code}`, {
    strength: toNumber(out.tday_rltv),
    time: out.stck_cntg_hour ?? null
  });
}

async function fetchInvestorTrend(code, price, quote = {}) {
  const cached = cacheGet(`investor:${code}`, 1000 * 60 * 5);
  if (cached) return cached;
  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/investor-trend-estimate",
    { MKSC_SHRN_ISCD: code },
    "HHPTJ04160200"
  );
  const out = firstOutput(data);
  const foreignQty = toNumber(out.frgn_fake_ntby_qty) ?? quote.foreignNetQty ?? 0;
  const instQty = toNumber(out.orgn_fake_ntby_qty) ?? 0;
  return cacheSet(`investor:${code}`, {
    foreignNetQty: foreignQty,
    instNetQty: instQty,
    foreignNetAmount: Math.round(foreignQty * price),
    instNetAmount: Math.round(instQty * price),
    available: Boolean(Object.keys(out).length)
  });
}

async function fetchInvestorDailyStreak(code, price, currentInvestor = {}) {
  const cached = cacheGet(`investor-streak:${code}`, 1000 * 60 * 30);
  if (cached) return cached;
  const start = new Date();
  start.setDate(start.getDate() - 45);
  const startDate = yyyymmdd(start);
  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: yyyymmdd(new Date()),
      FID_ORG_ADJ_PRC: "",
      FID_ETC_CLS_CODE: ""
    },
    "FHPTJ04160001"
  );
  const rawRows = data.output2 ?? data.output ?? [];
  const rows = (Array.isArray(rawRows) ? rawRows : []).map((row) => ({
    date: row.stck_bsop_date,
    foreignNetQty: toNumber(row.frgn_ntby_qty) ?? 0,
    instNetQty: toNumber(row.orgn_ntby_qty) ?? 0,
    foreignNetAmount: Math.round((toNumber(row.frgn_ntby_tr_pbmn) ?? 0) * 1_000_000),
    instNetAmount: Math.round((toNumber(row.orgn_ntby_tr_pbmn) ?? 0) * 1_000_000)
  })).filter((row) => row.date && row.date >= startDate).sort((a, b) => a.date.localeCompare(b.date));
  const deduped = rows.filter((row) => row.date !== rows.at(-1)?.date);
  const foreignHist = countPositiveStreak(deduped, "foreignNetQty");
  const instHist = countPositiveStreak(deduped, "instNetQty");
  const latest = rows.at(-1) ?? {};
  const hasCurrentInvestor = currentInvestor.available && (currentInvestor.foreignNetAmount !== undefined || currentInvestor.instNetAmount !== undefined);
  const result = {
    foreignStreak: currentInvestor.foreignNetAmount > 0 ? foreignHist + 1 : countPositiveStreak(rows, "foreignNetQty"),
    instStreak: currentInvestor.instNetAmount > 0 ? instHist + 1 : countPositiveStreak(rows, "instNetQty"),
    foreignNetAmount: Math.round((hasCurrentInvestor ? currentInvestor.foreignNetAmount : latest.foreignNetAmount) ?? 0),
    instNetAmount: Math.round((hasCurrentInvestor ? currentInvestor.instNetAmount : latest.instNetAmount) ?? 0),
    foreignNetQty: currentInvestor.foreignNetQty ?? latest.foreignNetQty ?? 0,
    instNetQty: currentInvestor.instNetQty ?? latest.instNetQty ?? 0,
    latestInvestorDate: latest.date ?? null,
    investorAmountSource: hasCurrentInvestor ? "estimate" : "daily-confirmed",
    foreignNetAmount5d: rows.slice(-5).reduce((sum, row) => sum + row.foreignNetAmount, 0),
    instNetAmount5d: rows.slice(-5).reduce((sum, row) => sum + row.instNetAmount, 0),
    available: rows.length > 0 || Boolean(currentInvestor.available)
  };
  return cacheSet(`investor-streak:${code}`, result);
}

async function fetchHoldingStreaks(holdings, errors) {
  if (process.env.KIS_HOLDING_STREAKS === "0") return new Map();
  const streakMap = new Map();
  await mapLimit(holdings, 2, async (item) => {
    try {
      const price = item.quote?.price ?? item.fallbackPrice ?? item.avgPrice ?? 0;
      const streak = await withRetry(() => fetchInvestorDailyStreak(item.code, price, {}), 2);
      streakMap.set(item.code, streak);
    } catch (error) {
      errors.push({ code: item.code, name: item.name, type: "holding-streak", message: error.message });
    }
  });
  return streakMap;
}

async function fetchHoldingHistories(holdings, errors) {
  if (process.env.KIS_HOLDING_HISTORY === "0") return new Map();
  const historyMap = new Map();
  await mapLimit(holdings, 3, async (item) => {
    try {
      historyMap.set(item.code, await withRetry(() => fetchHistory(item.code), 2));
    } catch (error) {
      errors.push({ code: item.code, name: item.name, type: "holding-history", message: error.message });
    }
  });
  return historyMap;
}

function countPositiveStreak(rows, field) {
  let count = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if ((rows[i][field] ?? 0) > 0) count += 1;
    else break;
  }
  return count;
}

function calcThreeDayChangePct(history = [], currentPrice = null) {
  const closes = history.map((row) => row.close).filter(Number.isFinite);
  if (closes.length < 4) return null;
  const base = closes.at(-4);
  const latest = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : closes.at(-1);
  return base ? ((latest / base) - 1) * 100 : null;
}

async function fetchProgramTrade(code) {
  const cached = cacheGet(`program:${code}`, 1000 * 60);
  if (cached) return cached;
  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/program-trade-by-stock",
    { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code },
    "FHPPG04650101"
  );
  const out = firstOutput(data);
  return cacheSet(`program:${code}`, {
    programNetAmount: toNumber(out.whol_smtn_ntby_tr_pbmn) ?? 0
  });
}

function yyyymmdd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function parseYmd(value) {
  const text = String(value ?? "");
  if (!/^\d{8}$/.test(text)) return null;
  return new Date(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T00:00:00+09:00`);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

async function fetchHistory(code, force = false) {
  const cached = force ? null : cacheGet(`history:${code}`, 1000 * 60 * 30);
  if (cached) return cached;
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 160);
  const data = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: yyyymmdd(start),
      FID_INPUT_DATE_2: yyyymmdd(end),
      FID_PERIOD_DIV_CODE: "D",
      FID_ORG_ADJ_PRC: "0"
    },
    "FHKST03010100"
  );
  const rows = (data.output2 ?? []).map((row) => ({
    date: row.stck_bsop_date,
    close: toNumber(row.stck_clpr),
    open: toNumber(row.stck_oprc),
    high: toNumber(row.stck_hgpr),
    low: toNumber(row.stck_lwpr),
    volume: toNumber(row.acml_vol)
  })).filter((row) => row.date && Number.isFinite(row.close)).reverse();
  return cacheSet(`history:${code}`, rows);
}

function buildBacktestPriceFileIndex() {
  if (backtestPriceFileIndex) return backtestPriceFileIndex;
  const index = new Map();
  if (!existsSync(BACKTEST_CACHE_DIR)) {
    backtestPriceFileIndex = index;
    return index;
  }
  for (const name of readdirSync(BACKTEST_CACHE_DIR)) {
    const match = name.match(/^price-(\d{6})-(\d{8})-(\d{8})\.json$/);
    if (!match) continue;
    const [, code, , endDate] = match;
    const previous = index.get(code);
    if (!previous || endDate > previous.endDate) {
      index.set(code, { endDate, filePath: path.join(BACKTEST_CACHE_DIR, name) });
    }
  }
  backtestPriceFileIndex = index;
  return index;
}

function loadBacktestPriceSeed(code) {
  const entry = buildBacktestPriceFileIndex().get(code);
  if (!entry) return [];
  try {
    const parsed = JSON.parse(readFileSync(entry.filePath, "utf8"));
    const rows = Array.isArray(parsed) ? parsed : parsed.value;
    return (Array.isArray(rows) ? rows : []).filter((row) => row?.date && Number.isFinite(Number(row.close))).map((row) => ({
      date: String(row.date),
      close: Number(row.close),
      open: toNumber(row.open),
      high: toNumber(row.high),
      low: toNumber(row.low),
      volume: toNumber(row.volume),
      tradingValue: toNumber(row.tradingValue)
    }));
  } catch {
    return [];
  }
}

function mergeHistoryRows(...groups) {
  const byDate = new Map();
  for (const rows of groups) {
    for (const row of rows ?? []) {
      if (!row?.date || !Number.isFinite(Number(row.close))) continue;
      byDate.set(String(row.date), { ...row, date: String(row.date), close: Number(row.close) });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchTwoYearHistory(code, force = false, recentRows = null) {
  const cacheKey = `history-2y:${code}`;
  const cached = force ? null : cacheGet(cacheKey, 1000 * 60 * 60 * 6);
  if (cached) return cached;
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 365 * 2 - 10);
  const startDate = yyyymmdd(start);
  const seed = loadBacktestPriceSeed(code);
  if (seed.length) {
    const recent = recentRows ?? await fetchHistory(code, force);
    const seeded = mergeHistoryRows(seed, recent).filter((row) => row.date >= startDate);
    if (seeded.length >= 360) return cacheSet(cacheKey, seeded);
  }
  let cursorEnd = yyyymmdd(end);
  const rows = [];
  const seen = new Set();

  for (let page = 0; page < 12; page += 1) {
    const data = await kisGet(
      "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
      {
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: code,
        FID_INPUT_DATE_1: startDate,
        FID_INPUT_DATE_2: cursorEnd,
        FID_PERIOD_DIV_CODE: "D",
        FID_ORG_ADJ_PRC: "0"
      },
      "FHKST03010100"
    );
    const chunk = data.output2 ?? [];
    if (!chunk.length) break;
    for (const row of chunk) {
      const date = row.stck_bsop_date;
      if (!date || seen.has(date)) continue;
      seen.add(date);
      rows.push({
        date,
        close: toNumber(row.stck_clpr),
        open: toNumber(row.stck_oprc),
        high: toNumber(row.stck_hgpr),
        low: toNumber(row.stck_lwpr),
        volume: toNumber(row.acml_vol),
        tradingValue: toNumber(row.acml_tr_pbmn)
      });
    }
    const oldest = chunk.at(-1)?.stck_bsop_date;
    if (!oldest || oldest <= startDate) break;
    const parsedOldest = parseYmd(oldest);
    if (!parsedOldest) break;
    cursorEnd = yyyymmdd(addDays(parsedOldest, -1));
  }

  const result = rows
    .filter((row) => row.date >= startDate && Number.isFinite(row.close))
    .sort((a, b) => a.date.localeCompare(b.date));
  return cacheSet(cacheKey, result);
}

function screenerOverheat(row) {
  const dayChange = row.changeRate ?? row.strategy?.dayChangePct ?? 0;
  const change3d = row.changeRate3d ?? row.strategy?.change3dPct ?? 0;
  return Boolean(row.strategy?.overheat) || dayChange >= 10 || change3d >= 12;
}

function scoutSortPriority(status) {
  return {
    "1차 매수 검토": 5,
    "하락 정지 확인": 4,
    "정찰병 1주": 3,
    "관찰 목록": 2,
    "추가매수 금지": 1
  }[status] ?? 0;
}

function reboundRiskBand(riskScore) {
  const risk = Number(riskScore ?? 100);
  if (risk <= 35) return 0;
  if (risk <= 50) return 1;
  if (risk < 65) return 2;
  return 3;
}

function compareReboundCandidate(a, b) {
  const aScout = a.scout ?? a;
  const bScout = b.scout ?? b;
  const leaderPower = { A: 4, B: 3, C: 2, D: 1, "계산불가": 0 };
  const boundedDrawdown = (value) => Math.min(Math.max(Math.abs(Math.min(Number(value ?? 0), 0)), 0), 40);
  return reboundRiskBand(aScout.riskScore) - reboundRiskBand(bScout.riskScore)
    || Number(bScout.stabilizeScore ?? 0) - Number(aScout.stabilizeScore ?? 0)
    || (leaderPower[b.leader?.grade] ?? 0) - (leaderPower[a.leader?.grade] ?? 0)
    || boundedDrawdown(bScout.drawdownFromHighPct) - boundedDrawdown(aScout.drawdownFromHighPct)
    || Number(b.supply?.liquidityScore ?? 0) - Number(a.supply?.liquidityScore ?? 0)
    || Number(aScout.riskScore ?? 100) - Number(bScout.riskScore ?? 100);
}

function buildCombinedDecision(row, scout) {
  const flags = row.strategy?.flags ?? {};
  const supply = row.supply ?? {};
  const completeData = hasPositiveQuoteValue(row.price)
    && hasPositiveQuoteValue(supply.tradingValue)
    && hasPositiveQuoteValue(supply.marketCap);
  const overheat = screenerOverheat(row);
  const scoutRisk = scout?.riskScore ?? 50;
  const blocked = !completeData || Boolean(flags.I) || overheat || scoutRisk >= 65;
  const strategySignal = Boolean(flags.R || flags.F || flags.F2 || flags.B || flags.C || flags.H3);

  let strategyPoints = 0;
  if (flags.R) strategyPoints = 25;
  else if (flags.F2) strategyPoints = 22;
  else if (flags.F) strategyPoints = 18;
  else if (flags.B && (supply.liquidityScore ?? 0) >= 50) strategyPoints = 13;
  else if (flags.H3) strategyPoints = 11;
  else if (flags.C) strategyPoints = 8;

  const liquidityPoints = clamp((supply.liquidityScore ?? 0) / 100, 0, 1) * 20;
  let supplyPoints = 0;
  if ((supply.totalNetAmount ?? 0) > 0) supplyPoints += 4;
  supplyPoints += clamp((supply.foreignStreak ?? 0) / 3, 0, 1) * 4;
  supplyPoints += clamp((supply.instStreak ?? 0) / 3, 0, 1) * 4;
  if ((supply.smartMoneyBodyPct ?? 0) >= 0.3 || (supply.smartMoneyTradingSharePct ?? 0) >= 10) supplyPoints += 3;

  let technicalPoints = 0;
  if (row.strategy?.vwapRecovered ?? row.nakju?.vwapRecovered) technicalPoints += 4;
  const change3d = row.changeRate3d ?? row.strategy?.change3dPct ?? 0;
  if (change3d >= -8 && change3d <= 5) technicalPoints += 3;
  if (row.nakju?.bullishTurn) technicalPoints += 3;

  const mainScore = Math.round(clamp(strategyPoints + liquidityPoints + supplyPoints + technicalPoints, 0, 70));
  const scoutScore = scout
    ? Math.round(clamp((scout.stabilizeScore ?? 0) * 0.15 + (100 - scoutRisk) * 0.10 + (scout.cheapScore ?? 0) * 0.05, 0, 30))
    : 0;
  const score = Math.round(clamp(mainScore + scoutScore, 0, 100));
  const rankable = !blocked && (strategySignal || score >= 40);

  let label = "관망";
  let tone = "hold";
  let tier = 1;
  let reason = "종합 매수조건 부족";
  if (!completeData) {
    label = "계산불가";
    tone = "danger";
    tier = 0;
    reason = "시세·거래 데이터 부족";
  } else if (flags.I || scoutRisk >= 65) {
    label = "매수보류";
    tone = "danger";
    tier = 0;
    reason = flags.I ? "급락 미회복" : "정찰병 위험 높음";
  } else if (overheat) {
    label = "추격주의";
    tone = "danger";
    tier = 0;
    reason = "당일 또는 3일 급등";
  } else if (flags.R && score >= 60) {
    label = "종합 최우선";
    tone = "buy";
    tier = 5;
    reason = "엄격 눌림·수급·정찰 조건";
  } else if ((flags.F2 || flags.F) && score >= 50) {
    label = "종합 분할후보";
    tone = "buy";
    tier = 4;
    reason = flags.F2 ? "눌림과 연속수급 확인" : "눌림과 순매수 확인";
  } else if (flags.H3) {
    label = "단기 특수";
    tone = "hold";
    tier = 3;
    reason = "강수급 낙주, 단기만";
  } else if (rankable) {
    label = "관심 관찰";
    tone = "hold";
    tier = 2;
    reason = "일부 조건만 충족";
  }

  return {
    score,
    mainScore,
    scoutScore,
    strategyPoints: Math.round(strategyPoints),
    liquidityPoints: Math.round(liquidityPoints),
    supplyPoints: Math.round(supplyPoints),
    technicalPoints: Math.round(technicalPoints),
    label,
    tone,
    tier,
    rankable,
    blocked,
    reason
  };
}

async function attachScoutAndCombined(rows, limit, force, errors, historyByCode) {
  const analysisBases = await mapLimit(rows, 2, async (row) => {
    try {
      const history = await fetchTwoYearHistory(row.code, force, historyByCode.get(row.code));
      return {
        scout: calcScoutBase(row, history, row.quote),
        leader: calcLeaderBase(row, history, row.quote)
      };
    } catch (error) {
      errors.push({ code: row.code, name: row.name, type: "scout", message: error.message });
      return null;
    }
  });
  const validBases = analysisBases.filter(Boolean).map((item) => item.scout);
  const leaderByCode = new Map(enrichLeaderScores(analysisBases.filter(Boolean).map((item) => item.leader)).map((leader) => [leader.code, leader]));
  const marketStats = Object.fromEntries(["KOSPI", "KOSDAQ"].map((market) => {
    const bases = validBases.filter((row) => row.market === market && row.rankType === "시총" && (row.rank ?? limit + 1) <= limit);
    return [market, {
      avgRet5: avgNumber(bases.map((row) => row.ret5)),
      avgRet20: avgNumber(bases.map((row) => row.ret20)),
      avgDist120: avgNumber(bases.map((row) => row.dist120))
    }];
  }));
  const scoutByCode = new Map(validBases.map((base) => {
    const scout = enrichScoutScores(base, marketStats[base.market] ?? {});
    return [base.code, scout];
  }));

  for (const market of ["KOSPI", "KOSDAQ"]) {
    const ranked = rows
      .filter((row) => row.market === market && row.rankType === "시총" && (row.rank ?? limit + 1) <= limit)
      .map((row) => scoutByCode.get(row.code))
      .filter(Boolean)
      .sort((a, b) => scoutSortPriority(b.status) - scoutSortPriority(a.status)
        || b.cheapScore - a.cheapScore
        || b.stabilizeScore - a.stabilizeScore
        || a.riskScore - b.riskScore);
    ranked.forEach((scout, index) => {
      scout.scoutRank = index + 1;
      scout.scoutTotal = ranked.length;
    });
  }

  const combined = rows.map((row) => {
    const scout = scoutByCode.get(row.code) ?? null;
    const leaderBase = leaderByCode.get(row.code) ?? null;
    const combinedDecision = buildCombinedDecision(row, scout);
    const enrichedRow = {
      ...row,
      scout: scout ? {
        rank: scout.scoutRank ?? null,
        total: scout.scoutTotal ?? null,
        status: scout.status,
        stage: scout.stage,
        tone: scout.tone,
        cheapScore: scout.cheapScore,
        stabilizeScore: scout.stabilizeScore,
        riskScore: scout.riskScore,
        riskReasons: scout.riskReasons,
        pricePositionPct: scout.pricePositionPct,
        drawdownFromHighPct: scout.drawdownFromHighPct,
        reboundFromLowPct: scout.reboundFromLowPct,
        high2y: scout.high2y,
        low2y: scout.low2y,
        dataDays: scout.dataDays,
        enoughData: scout.enoughData,
        daysSinceLow: scout.daysSinceLow,
        noNewLow5: scout.noNewLow5,
        slope5: scout.slope5,
        slope20: scout.slope20,
        ret5: scout.ret5,
        ret20: scout.ret20,
        relative5: scout.relative5,
        relative20: scout.relative20,
        dist120: scout.dist120,
        ma120Stage: scout.ma120Stage,
        volumeImproving: scout.volumeImproving,
        reason: scout.reason
      } : null,
      combined: combinedDecision,
      leader: leaderBase ? {
        ...leaderBase,
        decision: buildLeaderDecision(leaderBase, combinedDecision, scout ?? {})
      } : null
    };
    return {
      ...enrichedRow,
      confirmation: buildStrategyConfirmation(enrichedRow)
    };
  });

  for (const market of ["KOSPI", "KOSDAQ"]) {
    const reboundRanked = combined
      .filter((row) => row.market === market && row.scout)
      .sort(compareReboundCandidate);
    reboundRanked.forEach((row, index) => {
      row.scout.reboundRank = index + 1;
      row.scout.reboundTotal = reboundRanked.length;
    });
    const ranked = combined
      .filter((row) => row.market === market && row.combined.rankable)
      .sort((a, b) => b.combined.tier - a.combined.tier
        || b.combined.score - a.combined.score
        || b.combined.mainScore - a.combined.mainScore
        || (a.scout?.rank ?? 9999) - (b.scout?.rank ?? 9999));
    ranked.forEach((row, index) => {
      row.combined.rank = index + 1;
      row.combined.total = ranked.length;
    });
    const leaderRanked = combined
      .filter((row) => row.market === market && Number.isFinite(row.leader?.score))
      .sort((a, b) => b.leader.score - a.leader.score
        || b.leader.relativeStrengthScore - a.leader.relativeStrengthScore
        || b.leader.trendScore - a.leader.trendScore);
    leaderRanked.forEach((row, index) => {
      row.leader.rank = index + 1;
      row.leader.total = leaderRanked.length;
    });
  }
  return combined;
}

function summarizeLeaderRows(rows) {
  return {
    count: rows.length,
    calculable: rows.filter((row) => Number.isFinite(row.leader?.score)).length,
    a: rows.filter((row) => row.leader?.grade === "A").length,
    b: rows.filter((row) => row.leader?.grade === "B").length,
    c: rows.filter((row) => row.leader?.grade === "C").length,
    d: rows.filter((row) => row.leader?.grade === "D").length,
    unavailable: rows.filter((row) => row.leader?.grade === "계산불가" || !row.leader).length
  };
}

async function buildLeaderDashboard(limit = 100, force = false, marketFilter = "ALL") {
  const screener = await buildMarketScreener(limit, force, marketFilter);
  return {
    ...screener,
    summary: {
      kospi: summarizeLeaderRows(screener.rows?.KOSPI ?? []),
      kosdaq: summarizeLeaderRows(screener.rows?.KOSDAQ ?? [])
    }
  };
}

function summarizeStrategyRows(rows) {
  return {
    count: rows.length,
    cafe: rows.filter((row) => row.confirmation?.cafePass).length,
    mtt: rows.filter((row) => row.confirmation?.minerviniPass).length,
    leaderRebound: rows.filter((row) => row.confirmation?.leaderReboundPass).length,
    cafeMtt: rows.filter((row) => row.confirmation?.cafeAndMtt).length,
    experimentalNakju: rows.filter((row) => row.confirmation?.experimentalNakjuPass).length
  };
}

async function buildStrategyDashboard(limit = 100, force = false, marketFilter = "ALL") {
  const screener = await buildMarketScreener(limit, force, marketFilter);
  const kospi = screener.rows?.KOSPI ?? [];
  const kosdaq = screener.rows?.KOSDAQ ?? [];
  return {
    ...screener,
    strategySummary: {
      all: summarizeStrategyRows([...kospi, ...kosdaq]),
      kospi: summarizeStrategyRows(kospi),
      kosdaq: summarizeStrategyRows(kosdaq)
    }
  };
}

async function buildMarketScreener(limit = 100, force = false, marketFilter = "ALL") {
  const normalizedMarket = ["KOSPI", "KOSDAQ"].includes(marketFilter) ? marketFilter : "ALL";
  const cacheKey = `market-screener:${normalizedMarket}:${limit}`;
  const cached = force ? null : cacheGet(cacheKey, 1000 * 60 * 30);
  if (cached) return cached;
  if (!force && normalizedMarket !== "ALL") {
    const allCached = cacheGet(`market-screener:ALL:${limit}`, 1000 * 60 * 30);
    if (allCached) {
      const marketRows = allCached.rows?.[normalizedMarket] ?? [];
      return cacheSet(cacheKey, {
        ...allCached,
        market: normalizedMarket,
        rows: {
          KOSPI: normalizedMarket === "KOSPI" ? marketRows : [],
          KOSDAQ: normalizedMarket === "KOSDAQ" ? marketRows : []
        },
        summary: {
          kospi: summarizeMarketRows(normalizedMarket === "KOSPI" ? marketRows : []),
          kosdaq: summarizeMarketRows(normalizedMarket === "KOSDAQ" ? marketRows : [])
        }
      });
    }
  }
  const errors = [];
  const judal = await fetchJudalStreaks();
  const markets = normalizedMarket === "ALL" ? ["KOSPI", "KOSDAQ"] : [normalizedMarket];
  const candidateGroups = await Promise.all(markets.map(async (market) => {
    const volumeExtra = Math.min(30, limit);
    const [marketCap, volume] = await Promise.all([
      fetchMarketCapCandidates(market, limit),
      fetchVolumeRankCandidates(market, limit)
    ]);
    return mergeCandidates(marketCap, volume, limit + volumeExtra);
  }));
  const candidates = candidateGroups.flat();
  const historyByCode = new Map();

  const screenerConcurrency = Math.min(5, Math.max(1, Number(process.env.SCREENER_CONCURRENCY || 2)));
  const rows = await mapLimit(candidates, screenerConcurrency, async (candidate) => {
    let quote = null;
    let history = null;
    let investor = null;
    try {
      quote = await withRetry(() => fetchQuoteWithKrxFallback(candidate.code, force));
    } catch (error) {
      errors.push({ code: candidate.code, name: candidate.name, type: "quote", message: error.message });
    }
    if (quote?.price) {
      try {
        history = await withRetry(() => fetchHistory(candidate.code, force));
        historyByCode.set(candidate.code, history);
      } catch (error) {
        errors.push({ code: candidate.code, name: candidate.name, type: "history", message: error.message });
      }
      try {
        investor = await withRetry(() => fetchInvestorTrend(candidate.code, quote.price, quote));
      } catch (error) {
        errors.push({ code: candidate.code, name: candidate.name, type: "investor", message: error.message });
      }
      try {
        const streak = await withRetry(() => fetchInvestorDailyStreak(candidate.code, quote.price, investor ?? {}));
        investor = {
          ...(investor ?? {}),
          ...streak,
          foreignStreak: Math.max(streak.foreignStreak ?? 0, judal.foreign?.[candidate.code] ?? 0),
          instStreak: Math.max(streak.instStreak ?? 0, judal.fund?.[candidate.code] ?? 0)
        };
      } catch (error) {
        const expectedTimeLimit = /TIME LIMIT/i.test(error.message);
        investor = {
          ...(investor ?? {}),
          foreignStreak: judal.foreign?.[candidate.code] ?? 0,
          instStreak: judal.fund?.[candidate.code] ?? 0,
          investorAmountSource: investor?.available ? "estimate" : "judal-fallback",
          available: Boolean(investor?.available || judal.foreign?.[candidate.code] || judal.fund?.[candidate.code])
        };
        if (!expectedTimeLimit) {
          errors.push({ code: candidate.code, name: candidate.name, type: "investor-streak", message: error.message });
        }
      }
    }

    const price = quote?.price ?? 0;
    const indicators = { ...buildIndicators(history ?? []), synthetic: !history };
    const changeRate3d = calcThreeDayChangePct(history ?? [], price);
    const analyzed = classifyHolding({
      name: candidate.name,
      code: candidate.code,
      qty: 0,
      avgPrice: price,
      fallbackPrice: price,
      freeFloatRate: FREE_FLOAT_RATES[candidate.code] ?? null,
      price,
      changeRate3d,
      quote,
      investor,
      program: null,
      execution: null,
      judal: null,
      indicators,
      live: Boolean(quote?.price)
    }, 1, { mode: "중립" });
    return {
      market: candidate.market,
      rank: candidate.rank,
      rankType: candidate.rankType,
      code: candidate.code,
      name: candidate.name,
      price,
      quote,
      live: Boolean(quote?.price),
      changeRate: quote?.changeRate ?? null,
      changeRate3d,
      tradingValue: quote?.tradingValue ?? null,
      marketCap: quote?.marketCap ?? null,
      indicators,
      supply: analyzed.supply,
      investor,
      nakju: analyzed.nakju,
      strategy: analyzed.strategy,
      riskPlan: analyzed.riskPlan,
      judgement: analyzed.judgement,
      action: analyzed.action,
      tone: analyzed.tone,
      reasons: analyzed.reasons
    };
  });

  const combinedRows = await attachScoutAndCombined(rows, limit, force, errors, historyByCode);
  const byMarket = {
    KOSPI: combinedRows.filter((row) => row.market === "KOSPI").sort(sortMarketCandidate),
    KOSDAQ: combinedRows.filter((row) => row.market === "KOSDAQ").sort(sortMarketCandidate)
  };
  const payload = {
    asOf: new Date().toISOString(),
    limit,
    market: normalizedMarket,
    errors,
    rows: byMarket,
    summary: {
      kospi: summarizeMarketRows(byMarket.KOSPI),
      kosdaq: summarizeMarketRows(byMarket.KOSDAQ)
    }
  };
  return cacheSet(cacheKey, payload);
}

function sortMarketCandidate(a, b) {
  return Number(Boolean(b.combined?.rankable)) - Number(Boolean(a.combined?.rankable))
    || (b.combined?.tier ?? 0) - (a.combined?.tier ?? 0)
    || (b.combined?.score ?? 0) - (a.combined?.score ?? 0)
    || (b.strategy?.score ?? 0) - (a.strategy?.score ?? 0)
    || b.supply.liquidityScore - a.supply.liquidityScore
    || streakPower(b) - streakPower(a)
    || (b.supply.tradingValueRatio20 ?? 0) - (a.supply.tradingValueRatio20 ?? 0)
    || (b.tradingValue ?? 0) - (a.tradingValue ?? 0);
}

function streakPower(row) {
  const foreign = Math.min(row.supply.foreignStreak ?? 0, 5);
  const inst = Math.min(row.supply.instStreak ?? 0, 5);
  const combo = foreign > 0 && inst > 0 ? 3 : 0;
  return foreign + inst + combo;
}

function summarizeMarketRows(rows) {
  return {
    count: rows.length,
    combinedRanked: rows.filter((row) => row.combined?.rankable).length,
    combinedBuy: rows.filter((row) => (row.combined?.tier ?? 0) >= 4).length,
    f2: rows.filter((row) => row.strategy?.flags?.F2).length,
    f: rows.filter((row) => row.strategy?.flags?.F).length,
    h3: rows.filter((row) => row.strategy?.flags?.H3).length,
    h2: rows.filter((row) => row.strategy?.flags?.H2).length,
    strongLiquidity: rows.filter((row) => row.supply.liquidityScore >= 70).length,
    highTurnover: rows.filter((row) => row.supply.bodyTurnoverPct >= 5).length,
    explosion: rows.filter((row) => (row.supply.tradingValueRatio20 ?? 0) >= 3).length,
    smartMoney: rows.filter((row) => row.supply.smartMoneyBodyPct >= 0.3 || row.supply.smartMoneyTradingSharePct >= 10).length,
    streak: rows.filter((row) => (row.supply.foreignStreak ?? 0) >= 2 || (row.supply.instStreak ?? 0) >= 2).length,
    comboStreak: rows.filter((row) => (row.supply.foreignStreak ?? 0) >= 2 && (row.supply.instStreak ?? 0) >= 2).length
  };
}

function avgNumber(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function medianNumber(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function maAt(closes, period, endExclusive = closes.length) {
  if (endExclusive < period) return null;
  return avgNumber(closes.slice(endExclusive - period, endExclusive));
}

function slopePct(closes, period, lag = 5) {
  const now = maAt(closes, period);
  const prev = maAt(closes, period, closes.length - lag);
  return now && prev ? ((now / prev) - 1) * 100 : null;
}

function returnPctFrom(closes, days) {
  if (closes.length <= days) return null;
  const base = closes.at(-1 - days);
  const latest = closes.at(-1);
  return base && latest ? ((latest / base) - 1) * 100 : null;
}

function countDaysSinceLatestLow(rows) {
  if (!rows.length) return null;
  let low = Infinity;
  let lowIndex = -1;
  rows.forEach((row, index) => {
    if (Number.isFinite(row.close) && row.close <= low) {
      low = row.close;
      lowIndex = index;
    }
  });
  return lowIndex >= 0 ? rows.length - 1 - lowIndex : null;
}

function volumeProfile(rows) {
  const recent = rows.slice(-20);
  const up = [];
  const down = [];
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1];
    const row = recent[i];
    if (!Number.isFinite(row.volume) || !Number.isFinite(row.close) || !Number.isFinite(prev.close)) continue;
    if (row.close >= prev.close) up.push(row.volume);
    else down.push(row.volume);
  }
  return {
    upAvg: avgNumber(up),
    downAvg: avgNumber(down),
    improving: avgNumber(up) !== null && avgNumber(down) !== null ? avgNumber(up) > avgNumber(down) : false
  };
}

function maStage(dist120) {
  if (!Number.isFinite(dist120)) return "데이터 부족";
  if (dist120 <= -25) return "장기선 크게 아래";
  if (dist120 <= -15) return "장기선 아래";
  if (dist120 <= -5) return "하락 둔화 구간";
  if (dist120 <= 5) return "장기선 회복 근처";
  return "장기선 위";
}

function calcScoutBase(candidate, history, quote) {
  const rows = history.filter((row) => Number.isFinite(row.close));
  const closes = rows.map((row) => row.close);
  const quotedPrice = Number(quote?.price);
  const latest = quotedPrice > 0 ? quotedPrice : (closes.at(-1) ?? 0);
  const high2y = Math.max(...closes);
  const low2y = Math.min(...closes);
  const median2y = medianNumber(closes);
  const rawPricePositionPct = high2y > low2y ? ((latest - low2y) / (high2y - low2y)) * 100 : null;
  const pricePositionPct = Number.isFinite(rawPricePositionPct) ? clamp(rawPricePositionPct, 0, 100) : null;
  const drawdownFromHighPct = high2y ? ((latest / high2y) - 1) * 100 : null;
  const reboundFromLowPct = low2y ? ((latest / low2y) - 1) * 100 : null;
  const medianGapPct = median2y ? ((latest / median2y) - 1) * 100 : null;
  const ma5 = maAt(closes, 5);
  const ma20 = maAt(closes, 20);
  const ma60 = maAt(closes, 60);
  const ma120 = maAt(closes, 120);
  const dist5 = ma5 ? ((latest / ma5) - 1) * 100 : null;
  const dist20 = ma20 ? ((latest / ma20) - 1) * 100 : null;
  const dist60 = ma60 ? ((latest / ma60) - 1) * 100 : null;
  const dist120 = ma120 ? ((latest / ma120) - 1) * 100 : null;
  const slope5 = slopePct(closes, 5);
  const slope20 = slopePct(closes, 20);
  const slope60 = slopePct(closes, 60);
  const slope120 = slopePct(closes, 120);
  const daysSinceLow = countDaysSinceLatestLow(rows);
  const vol = volumeProfile(rows);
  const ret5 = returnPctFrom(closes, 5);
  const ret20 = returnPctFrom(closes, 20);
  const volatility20 = (() => {
    const rets = [];
    for (let i = Math.max(1, closes.length - 20); i < closes.length; i += 1) {
      if (closes[i - 1]) rets.push(((closes[i] / closes[i - 1]) - 1) * 100);
    }
    const mean = avgNumber(rets) ?? 0;
    return rets.length ? Math.sqrt(avgNumber(rets.map((value) => (value - mean) ** 2)) ?? 0) : null;
  })();

  return {
    market: candidate.market,
    rank: candidate.rank,
    rankType: candidate.rankType,
    code: candidate.code,
    name: candidate.name,
    price: latest,
    changeRate: quote?.changeRate ?? null,
    marketCap: quote?.marketCap ?? null,
    dataDays: rows.length,
    enoughData: rows.length >= 360,
    high2y,
    low2y,
    median2y,
    pricePositionPct,
    drawdownFromHighPct,
    reboundFromLowPct,
    medianGapPct,
    ma5,
    ma20,
    ma60,
    ma120,
    dist5,
    dist20,
    dist60,
    dist120,
    slope5,
    slope20,
    slope60,
    slope120,
    daysSinceLow,
    noNewLow5: Number.isFinite(daysSinceLow) ? daysSinceLow >= 5 : false,
    ret5,
    ret20,
    volumeUpDownRatio: vol.upAvg && vol.downAvg ? vol.upAvg / vol.downAvg : null,
    volumeImproving: vol.improving,
    volatility20
  };
}

function enrichScoutScores(row, marketStats) {
  const relative5 = Number.isFinite(row.ret5) && Number.isFinite(marketStats.avgRet5) ? row.ret5 - marketStats.avgRet5 : null;
  const relative20 = Number.isFinite(row.ret20) && Number.isFinite(marketStats.avgRet20) ? row.ret20 - marketStats.avgRet20 : null;
  const relativeDist120 = Number.isFinite(row.dist120) && Number.isFinite(marketStats.avgDist120) ? row.dist120 - marketStats.avgDist120 : null;
  const lowPriceScore = clamp((30 - (row.pricePositionPct ?? 100)) / 30, 0, 1) * 40;
  const drawdownScore = clamp((Math.abs(row.drawdownFromHighPct ?? 0) - 15) / 35, 0, 1) * 30;
  const medianGapScore = clamp(Math.abs(Math.min(row.medianGapPct ?? 0, 0)) / 35, 0, 1) * 15;
  const dataScore = row.enoughData ? 15 : 5;
  const cheapScore = Math.round(lowPriceScore + drawdownScore + medianGapScore + dataScore);

  const noLowScore = clamp((row.daysSinceLow ?? 0) / 20, 0, 1) * 25;
  const slope5Score = (row.slope5 ?? -1) > 0 ? 20 : clamp((row.slope5 ?? -5) + 5, 0, 5) / 5 * 8;
  const slope20Score = (row.slope20 ?? -1) > 0 ? 20 : clamp((row.slope20 ?? -5) + 5, 0, 5) / 5 * 8;
  const relativeScore = clamp(((relative20 ?? -10) + 8) / 16, 0, 1) * 20;
  const volumeScore = row.volumeImproving ? 15 : clamp(((row.volumeUpDownRatio ?? 0) - 0.8) / 0.7, 0, 1) * 8;
  const stabilizeScore = Math.round(noLowScore + slope5Score + slope20Score + relativeScore + volumeScore);

  let riskScore = 15;
  const riskReasons = ["하락 원인 미확인"];
  if (Number.isFinite(relativeDist120) && relativeDist120 <= -12) {
    riskScore += 15;
    riskReasons.push("시장 대비 120일선 괴리 과도");
  }
  if (Number.isFinite(relative20) && relative20 <= -8) {
    riskScore += 15;
    riskReasons.push("20일 시장 대비 약세");
  }
  if ((row.volatility20 ?? 0) >= 5) {
    riskScore += 10;
    riskReasons.push("변동성 급증");
  }
  if ((row.daysSinceLow ?? 0) < 3) {
    riskScore += 15;
    riskReasons.push("최근 신저가 반복");
  }
  if (!row.enoughData) {
    riskScore += 15;
    riskReasons.push("2년 데이터 부족");
  }
  riskScore = Math.round(clamp(riskScore, 0, 100));

  let status = "관찰 목록";
  let stage = 0;
  let tone = "hold";
  const scoutCheap = (row.pricePositionPct ?? 100) <= 30 && (row.drawdownFromHighPct ?? 0) <= -20;
  const watchCheap = (row.pricePositionPct ?? 100) <= 40 && (row.drawdownFromHighPct ?? 0) <= -15;

  if (riskScore >= 65) {
    status = "추가매수 금지";
    stage = 5;
    tone = "danger";
  } else if (scoutCheap && stabilizeScore >= 65 && riskScore <= 35) {
    status = "1차 매수 검토";
    stage = 3;
    tone = "buy";
  } else if (scoutCheap && stabilizeScore >= 45 && riskScore <= 50) {
    status = "하락 정지 확인";
    stage = 2;
    tone = "watch";
  } else if (scoutCheap && riskScore <= 60) {
    status = "정찰병 1주";
    stage = 1;
    tone = "buy";
  } else if (watchCheap) {
    status = "관찰 목록";
    stage = 0;
    tone = "hold";
  }

  const reason = [
    `2년 위치 하위 ${Math.round(row.pricePositionPct ?? 0)}%`,
    `고점 대비 ${Math.round((row.drawdownFromHighPct ?? 0) * 10) / 10}%`,
    row.noNewLow5 ? "5일 신저가 미갱신" : "저점 확인 필요",
    Number.isFinite(relative20) ? `시장대비 20일 ${Math.round(relative20 * 10) / 10}%p` : null
  ].filter(Boolean);

  return {
    ...row,
    relative5,
    relative20,
    relativeDist120,
    cheapScore,
    stabilizeScore,
    riskScore,
    riskReasons,
    status,
    stage,
    tone,
    ma120Stage: maStage(row.dist120),
    scoutQty: row.price > 0 ? 1 : 0,
    scoutAmount: row.price,
    reason
  };
}

function summarizeScoutRows(rows) {
  return {
    count: rows.length,
    scout: rows.filter((row) => row.status === "정찰병 1주").length,
    add: rows.filter((row) => row.status === "1차 매수 검토").length,
    stabilize: rows.filter((row) => row.status === "하락 정지 확인").length,
    avoid: rows.filter((row) => row.status === "추가매수 금지").length,
    avgCheap: avgNumber(rows.map((row) => row.cheapScore)) ?? 0,
    avgStabilize: avgNumber(rows.map((row) => row.stabilizeScore)) ?? 0,
    avgRisk: avgNumber(rows.map((row) => row.riskScore)) ?? 0
  };
}

async function buildScoutDashboard(limit = 100, force = false, marketFilter = "ALL") {
  const normalizedMarket = ["KOSPI", "KOSDAQ"].includes(marketFilter) ? marketFilter : "ALL";
  const cacheKey = `scout-dashboard:${normalizedMarket}:${limit}`;
  const cached = force ? null : cacheGet(cacheKey, 1000 * 60 * 30);
  if (cached) return cached;
  const screener = await buildMarketScreener(limit, force, normalizedMarket);
  const toReboundRow = (row) => ({
    ...row,
    ...(row.scout ?? {}),
    rank: row.scout?.reboundRank ?? row.scout?.rank ?? null,
    total: row.scout?.reboundTotal ?? row.scout?.total ?? null,
    scout: row.scout,
    liquidityScore: row.supply?.liquidityScore ?? 0
  });
  const byMarket = {
    KOSPI: (screener.rows?.KOSPI ?? []).map(toReboundRow).sort(compareReboundCandidate),
    KOSDAQ: (screener.rows?.KOSDAQ ?? []).map(toReboundRow).sort(compareReboundCandidate)
  };
  const payload = {
    asOf: screener.asOf,
    market: normalizedMarket,
    limit,
    errors: screener.errors,
    rows: byMarket,
    summary: {
      kospi: summarizeScoutRows(byMarket.KOSPI),
      kosdaq: summarizeScoutRows(byMarket.KOSDAQ)
    }
  };
  return cacheSet(cacheKey, payload);
}

function kstDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function readSimulationLedger() {
  if (!existsSync(SIMULATION_FILE)) {
    return { version: 1, createdAt: new Date().toISOString(), updatedAt: null, runs: [], positions: [], closed: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(SIMULATION_FILE, "utf8"));
    return {
      version: parsed.version ?? 1,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? null,
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      positions: Array.isArray(parsed.positions) ? parsed.positions : [],
      closed: Array.isArray(parsed.closed) ? parsed.closed : []
    };
  } catch {
    return { version: 1, createdAt: new Date().toISOString(), updatedAt: null, runs: [], positions: [], closed: [] };
  }
}

function writeSimulationLedger(ledger) {
  const next = { ...ledger, updatedAt: new Date().toISOString() };
  writeFileSync(SIMULATION_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function dateDiffDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00+09:00`);
  const end = new Date(`${endDate}T00:00:00+09:00`);
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

function simulationRank(row) {
  const supply = row.supply ?? {};
  return (row.strategy?.score ?? 0) * 10
    + (supply.liquidityScore ?? 0) * 4
    + Math.min(supply.foreignStreak ?? 0, 5) * 8
    + Math.min(supply.instStreak ?? 0, 5) * 8
    + Math.min(supply.tradingValueRatio20 ?? 0, 8) * 7
    + Math.max(supply.smartMoneyBodyPct ?? 0, 0) * 20;
}

function simulationCategory(row) {
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

function normalizeSimulationCandidate(row, source, leaderOverride = null) {
  const category = simulationCategory(row);
  const supply = row.supply ?? {};
  const leader = leaderOverride ?? row.leader ?? null;
  const scout = row.scout ?? null;
  const confirmation = row.confirmation ?? null;
  const price = row.price ?? row.quote?.price ?? 0;
  return {
    code: row.code,
    name: row.name,
    market: row.market ?? (source === "holding" ? "보유" : ""),
    source,
    sourceLabel: source === "holding" ? "내 보유" : row.market ?? "시장",
    price,
    changeRate: row.changeRate ?? row.quote?.changeRate ?? row.strategy?.dayChangePct ?? null,
    changeRate3d: row.changeRate3d ?? row.strategy?.change3dPct ?? null,
    action: row.action,
    category,
    score: row.strategy?.score ?? 0,
    rankScore: simulationRank(row),
    reasons: (row.reasons ?? []).slice(0, 6),
    judgement: row.judgement ?? "",
    liquidityScore: supply.liquidityScore ?? 0,
    bodyTurnoverPct: supply.bodyTurnoverPct ?? 0,
    tradingValueRatio20: supply.tradingValueRatio20 ?? 0,
    smartMoneyTradingSharePct: supply.smartMoneyTradingSharePct ?? 0,
    smartMoneyBodyPct: supply.smartMoneyBodyPct ?? 0,
    foreignStreak: supply.foreignStreak ?? 0,
    instStreak: supply.instStreak ?? 0,
    totalNetAmount: supply.totalNetAmount ?? 0,
    flags: row.strategy?.flags ?? {},
    riskPlan: row.riskPlan ?? null,
    leaderScore: Number.isFinite(leader?.score) ? leader.score : null,
    leaderGrade: leader?.grade ?? "계산불가",
    trendScore: Number.isFinite(leader?.trendScore) ? leader.trendScore : null,
    relativeStrengthScore: Number.isFinite(leader?.relativeStrengthScore) ? leader.relativeStrengthScore : null,
    highRetentionScore: Number.isFinite(leader?.highRetentionScore) ? leader.highRetentionScore : null,
    persistenceScore: Number.isFinite(leader?.persistenceScore) ? leader.persistenceScore : null,
    combinedScore: Number.isFinite(row.combined?.score) ? row.combined.score : null,
    scoutStatus: scout?.status ?? null,
    scoutStabilizeScore: Number.isFinite(scout?.stabilizeScore) ? scout.stabilizeScore : null,
    scoutRiskScore: Number.isFinite(scout?.riskScore) ? scout.riskScore : null,
    drawdownFromHighPct: Number.isFinite(scout?.drawdownFromHighPct) ? scout.drawdownFromHighPct : null,
    cafePass: Boolean(confirmation?.cafePass),
    minerviniPass: Boolean(confirmation?.minerviniPass),
    leaderReboundPass: Boolean(confirmation?.leaderReboundPass)
  };
}

function dedupeSimulationCandidates(candidates) {
  const byCode = new Map();
  for (const candidate of candidates) {
    if (!candidate.code || !candidate.price) continue;
    const previous = byCode.get(candidate.code);
    if (!previous || candidate.source === "holding" || candidate.rankScore > previous.rankScore) {
      byCode.set(candidate.code, candidate);
    }
  }
  return [...byCode.values()].sort((a, b) => b.rankScore - a.rankScore);
}

async function collectSimulationCandidates({ force = false, limit = 100 } = {}) {
  const live = Boolean(process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET);
  const [snapshot, screener] = await Promise.all([
    buildSnapshot(live, force),
    live ? buildMarketScreener(limit, force, "ALL") : Promise.resolve({ rows: { KOSPI: [], KOSDAQ: [] }, errors: [] })
  ]);
  const marketRows = [
    ...(screener.rows?.KOSPI ?? []),
    ...(screener.rows?.KOSDAQ ?? [])
  ];
  const leaderByCode = new Map(marketRows.filter((row) => row.leader).map((row) => [row.code, row.leader]));
  const holdings = (snapshot.rows ?? []).map((row) => normalizeSimulationCandidate(row, "holding", leaderByCode.get(row.code) ?? null));
  const market = marketRows.map((row) => normalizeSimulationCandidate(row, "market"));
  return {
    asOf: new Date().toISOString(),
    snapshot,
    screener,
    candidates: dedupeSimulationCandidates([...holdings, ...market])
  };
}

function makeSimulationPosition(candidate, runDate) {
  const targetDays = candidate.category.targetDays || 5;
  const capital = SIM_TRADE_AMOUNT;
  const qty = candidate.price ? capital / candidate.price : 0;
  return {
    id: `${runDate}:${candidate.code}:${candidate.category.key}`,
    code: candidate.code,
    name: candidate.name,
    source: candidate.source,
    sourceLabel: candidate.sourceLabel,
    market: candidate.market,
    category: candidate.category.label,
    categoryKey: candidate.category.key,
    tone: candidate.category.tone,
    entryDate: runDate,
    entryPrice: candidate.price,
    lastDate: runDate,
    lastPrice: candidate.price,
    qty,
    capital,
    targetDays,
    heldDays: 0,
    status: "open",
    pnlPct: 0,
    pnlAmount: 0,
    maxPnlPct: 0,
    minPnlPct: 0,
    liquidityScore: candidate.liquidityScore,
    tradingValueRatio20: candidate.tradingValueRatio20,
    smartMoneyTradingSharePct: candidate.smartMoneyTradingSharePct,
    foreignStreak: candidate.foreignStreak,
    instStreak: candidate.instStreak,
    changeRate: candidate.changeRate,
    changeRate3d: candidate.changeRate3d,
    reasons: candidate.reasons,
    judgement: candidate.judgement,
    riskPlan: candidate.riskPlan,
    leaderScore: candidate.leaderScore,
    leaderGrade: candidate.leaderGrade,
    trendScore: candidate.trendScore,
    relativeStrengthScore: candidate.relativeStrengthScore,
    highRetentionScore: candidate.highRetentionScore,
    persistenceScore: candidate.persistenceScore,
    combinedScore: candidate.combinedScore,
    scoutStatus: candidate.scoutStatus,
    scoutStabilizeScore: candidate.scoutStabilizeScore,
    scoutRiskScore: candidate.scoutRiskScore,
    drawdownFromHighPct: candidate.drawdownFromHighPct,
    cafePass: candidate.cafePass,
    minerviniPass: candidate.minerviniPass,
    leaderReboundPass: candidate.leaderReboundPass
  };
}

async function quoteSimulationOpenPositions(positions, candidateByCode, runDate) {
  return mapLimit(positions, 4, async (position) => {
    const candidate = candidateByCode.get(position.code);
    let price = candidate?.price ?? position.lastPrice;
    let changeRate = candidate?.changeRate ?? null;
    try {
      if (!candidate?.price) {
        const quote = await withRetry(() => fetchQuoteWithKrxFallback(position.code), 2);
        price = quote.price ?? price;
        changeRate = quote.changeRate ?? changeRate;
      }
    } catch {
      // Keep the last known price if the quote fails.
    }
    const pnlPct = position.entryPrice ? ((price / position.entryPrice) - 1) * 100 : 0;
    const pnlAmount = (price - position.entryPrice) * (position.qty ?? 0);
    const heldDays = dateDiffDays(position.entryDate, runDate);
    return {
      ...position,
      lastDate: runDate,
      lastPrice: price,
      changeRate,
      heldDays,
      pnlPct,
      pnlAmount,
      maxPnlPct: Math.max(position.maxPnlPct ?? pnlPct, pnlPct),
      minPnlPct: Math.min(position.minPnlPct ?? pnlPct, pnlPct)
    };
  });
}

function summarizeSimulation(ledger, todayCandidates) {
  const open = ledger.positions.filter((position) => position.status === "open");
  const closed = ledger.closed ?? [];
  const openPnlAmount = open.reduce((sum, item) => sum + (item.pnlAmount ?? 0), 0);
  const openCapital = open.reduce((sum, item) => sum + (item.capital ?? 0), 0);
  const realizedPnlAmount = closed.reduce((sum, item) => sum + (item.pnlAmount ?? 0), 0);
  const realizedCapital = closed.reduce((sum, item) => sum + (item.capital ?? 0), 0);
  const actionable = todayCandidates.filter((candidate) => candidate.category.actionable);
  return {
    openCount: open.length,
    closedCount: closed.length,
    runCount: ledger.runs.length,
    todayActionableCount: actionable.length,
    todayHoldingSignals: todayCandidates.filter((candidate) => candidate.source === "holding" && candidate.category.actionable).length,
    openPnlAmount,
    openPnlPct: openCapital ? (openPnlAmount / openCapital) * 100 : 0,
    realizedPnlAmount,
    realizedPnlPct: realizedCapital ? (realizedPnlAmount / realizedCapital) * 100 : 0,
    winRate: closed.length ? (closed.filter((item) => (item.pnlPct ?? 0) > 0).length / closed.length) * 100 : 0
  };
}

async function buildSimulation({ record = false, force = false, limit = 100 } = {}) {
  const runDate = kstDateKey();
  let ledger = readSimulationLedger();
  const collected = await collectSimulationCandidates({ force, limit });
  const candidateByCode = new Map(collected.candidates.map((candidate) => [candidate.code, candidate]));
  const openBefore = ledger.positions.filter((position) => position.status === "open");
  const updatedOpen = await quoteSimulationOpenPositions(openBefore, candidateByCode, runDate);
  const stillOpen = [];
  const newlyClosed = [];
  for (const position of updatedOpen) {
    if (position.heldDays >= position.targetDays) {
      newlyClosed.push({
        ...position,
        status: "closed",
        exitDate: runDate,
        exitPrice: position.lastPrice,
        exitReason: `${position.targetDays}일 관찰 종료`
      });
    } else {
      stillOpen.push(position);
    }
  }
  ledger.positions = stillOpen;
  ledger.closed = [...(ledger.closed ?? []), ...newlyClosed];

  const todayCandidates = collected.candidates.slice(0, 80);
  const actionableToday = collected.candidates
    .filter((candidate) => candidate.category.actionable)
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 14);

  let opened = [];
  const alreadyRanToday = ledger.runs.some((run) => run.date === runDate);
  if (record && !alreadyRanToday) {
    const openIds = new Set(ledger.positions.map((position) => `${position.code}:${position.categoryKey}`));
    opened = actionableToday
      .filter((candidate) => !openIds.has(`${candidate.code}:${candidate.category.key}`))
      .slice(0, 10)
      .map((candidate) => makeSimulationPosition(candidate, runDate));
    ledger.positions = [...ledger.positions, ...opened];
    ledger.runs = [
      ...ledger.runs,
      {
        date: runDate,
        asOf: collected.asOf,
        opened: opened.length,
        candidates: actionableToday.length,
        holdingSignals: actionableToday.filter((candidate) => candidate.source === "holding").length
      }
    ];
  }
  ledger = writeSimulationLedger(ledger);
  const alreadyRanTodayAfter = ledger.runs.some((run) => run.date === runDate);
  const open = ledger.positions.filter((position) => position.status === "open").sort((a, b) => (b.pnlPct ?? 0) - (a.pnlPct ?? 0));
  const closed = [...(ledger.closed ?? [])].sort((a, b) => String(b.exitDate ?? "").localeCompare(String(a.exitDate ?? "")) || (b.pnlPct ?? 0) - (a.pnlPct ?? 0));

  return {
    asOf: collected.asOf,
    date: runDate,
    recordedToday: record && !alreadyRanToday,
    alreadyRanToday: alreadyRanTodayAfter,
    opened,
    summary: summarizeSimulation(ledger, todayCandidates),
    todayCandidates,
    actionableToday,
    open,
    closed: closed.slice(0, 80),
    runs: [...ledger.runs].slice(-30).reverse(),
    errors: [
      ...(collected.snapshot.errors ?? []),
      ...(collected.screener.errors ?? [])
    ].slice(0, 20)
  };
}

function fallbackHistory(item) {
  const rows = [];
  for (let i = 90; i >= 0; i -= 1) {
    const progress = 1 - i / 90;
    const wave = Math.sin((90 - i + item.code.charCodeAt(0)) / 7) * item.fallbackPrice * 0.018;
    const close = Math.max(1, Math.round(item.avgPrice + (item.fallbackPrice - item.avgPrice) * progress + wave));
    rows.push({ date: "", close, volume: 100000 + (90 - i) * 900 });
  }
  return rows;
}

async function mapLimit(items, limit, worker) {
  const result = [];
  let index = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      result[current] = await worker(items[current], current);
    }
  });
  await Promise.all(workers);
  return result;
}

async function withRetry(task, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 700 * (i + 1)));
    }
  }
  throw lastError;
}

async function fetchJudalStreaks() {
  const cached = cacheGet("judal-streaks", 1000 * 60 * 30);
  if (cached) return cached;

  async function fetchPages(typeKey) {
    const result = {};
    for (let page = 1; page <= 4; page += 1) {
      const url = `https://www.judal.co.kr/?view=stockList&type=${typeKey}&market=&themeIdx=&page=${page}`;
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
      if (!response.ok) break;
      const html = await response.text();
      const rows = html.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
      let rowsFound = 0;
      for (const row of rows) {
        const code = row.match(/code=(\d{6})/)?.[1];
        const streak = row.match(/(\d+)일연속/)?.[1];
        if (!code) continue;
        rowsFound += 1;
        if (streak) result[code] = Number(streak);
      }
      if (!rowsFound) break;
    }
    return result;
  }

  try {
    const [foreign, fund] = await Promise.all([fetchPages("foreignerBuy"), fetchPages("fundBuy")]);
    return cacheSet("judal-streaks", { foreign, fund, fetchedAt: new Date().toISOString(), source: "judal" });
  } catch (error) {
    return cacheSet("judal-streaks", { foreign: {}, fund: {}, fetchedAt: new Date().toISOString(), source: "fallback", error: error.message });
  }
}

async function buildSnapshot(useLive, force = false) {
  const quoteMap = new Map();
  const historyMap = new Map();
  const executionMap = new Map();
  const investorMap = new Map();
  const programMap = new Map();
  const errors = [];
  let holdings = portfolio;
  let holdingsSource = "screenshot";
  let accountSummary = null;
  if (force) clearLiveSnapshotCache();
  if (useLive && hasKisAccountConfig()) {
    try {
      const accountData = await fetchAccountHoldings(force);
      holdings = accountData.holdings;
      accountSummary = accountData.accountSummary;
      holdingsSource = "kis-balance";
      const repriced = await applyQuoteValuation(holdings, errors, force);
      holdings = repriced.holdings;
      const brokerSummary = accountData.accountSummary;
      accountSummary = brokerSummary
        ? {
            ...brokerSummary,
            source: "kis-balance",
            nxtRepriced: repriced.accountSummary ?? null
          }
        : repriced.accountSummary;
    } catch (error) {
      errors.push({ type: "balance", message: error.message });
    }
  }
  const fastAccountMode = useLive && holdingsSource === "kis-balance" && process.env.KIS_ENRICH_ACCOUNT !== "1";
  const judal = useLive ? await fetchJudalStreaks() : { foreign: {}, fund: {}, source: "off" };
  if (useLive && fastAccountMode) {
    holdings = await applyHoldingAnalyticsQuotes(holdings, errors, force);
    const holdingHistories = await fetchHoldingHistories(holdings, errors);
    for (const [code, history] of holdingHistories.entries()) {
      historyMap.set(code, history);
    }
    const streakMap = await fetchHoldingStreaks(holdings, errors);
    for (const item of holdings) {
      const streak = streakMap.get(item.code) ?? {};
      investorMap.set(item.code, {
        foreignNetAmount: streak.foreignNetAmount ?? 0,
        instNetAmount: streak.instNetAmount ?? 0,
        foreignNetQty: streak.foreignNetQty ?? 0,
        instNetQty: streak.instNetQty ?? 0,
        foreignNetAmount5d: streak.foreignNetAmount5d ?? 0,
        instNetAmount5d: streak.instNetAmount5d ?? 0,
        latestInvestorDate: streak.latestInvestorDate ?? null,
        investorAmountSource: streak.investorAmountSource ?? null,
        foreignStreak: Math.max(streak.foreignStreak ?? 0, judal.foreign?.[item.code] ?? 0),
        instStreak: Math.max(streak.instStreak ?? 0, judal.fund?.[item.code] ?? 0),
        available: Boolean(streakMap.has(item.code) || judal.foreign?.[item.code] || judal.fund?.[item.code])
      });
    }
  }
  if (useLive && !fastAccountMode) {
    await mapLimit(holdings, 2, async (item) => {
      let quote = null;
      try {
        quote = await withRetry(() => fetchQuoteWithKrxFallback(item.code, force));
        quoteMap.set(item.code, quote);
      } catch (error) {
        errors.push({ code: item.code, name: item.name, type: "quote", message: error.message });
      }
      try {
        const history = await withRetry(() => fetchHistory(item.code));
        historyMap.set(item.code, history);
      } catch (error) {
        errors.push({ code: item.code, name: item.name, type: "history", message: error.message });
      }
      if (quote?.price) {
        try {
          executionMap.set(item.code, await withRetry(() => fetchExecution(item.code)));
        } catch (error) {
          errors.push({ code: item.code, name: item.name, type: "execution", message: error.message });
        }
        try {
          const investor = await withRetry(() => fetchInvestorTrend(item.code, quote.price, quote));
          const streak = await withRetry(() => fetchInvestorDailyStreak(item.code, quote.price, investor));
          investorMap.set(item.code, {
            ...investor,
            ...streak,
            foreignStreak: Math.max(streak.foreignStreak ?? 0, judal.foreign?.[item.code] ?? 0),
            instStreak: Math.max(streak.instStreak ?? 0, judal.fund?.[item.code] ?? 0)
          });
        } catch (error) {
          errors.push({ code: item.code, name: item.name, type: "investor", message: error.message });
        }
        try {
          programMap.set(item.code, await withRetry(() => fetchProgramTrade(item.code)));
        } catch (error) {
          errors.push({ code: item.code, name: item.name, type: "program", message: error.message });
        }
      }
    });
  }

  const prepared = holdings.map((item) => {
    const quote = quoteMap.get(item.code) ?? item.quote;
    const price = quote?.price ?? item.fallbackPrice;
    const history = historyMap.get(item.code) ?? fallbackHistory(item);
    const indicators = { ...buildIndicators(history), synthetic: !quote };
    return {
      ...item,
      freeFloatRate: FREE_FLOAT_RATES[item.code] ?? null,
      price,
      quote,
      execution: executionMap.get(item.code) ?? null,
      investor: investorMap.get(item.code) ?? null,
      program: programMap.get(item.code) ?? null,
      judal: {
        foreignStreak: judal.foreign?.[item.code] ?? 0,
        fundStreak: judal.fund?.[item.code] ?? 0
      },
      indicators,
      live: Boolean(quote?.price)
    };
  });
  const total = prepared.reduce((sum, item) => sum + (item.accountValue ?? item.price * item.qty), 0);
  const marketContext = buildMarketContext(prepared);
  const rows = prepared.map((holding) => classifyHolding(holding, total, marketContext)).sort((a, b) => b.priority - a.priority || b.value - a.value);
  const payload = {
    asOf: new Date().toISOString(),
    source: useLive && holdingsSource === "kis-balance" ? "kis-balance" : (useLive && errors.length < holdings.length ? "kis" : "fallback"),
    holdingsSource,
    accountSummary,
    judal: { source: judal.source, fetchedAt: judal.fetchedAt },
    errors,
    rows,
    summary: buildPortfolioSummary(rows, marketContext, accountSummary)
  };
  if (useLive && rows.some((row) => row.live && row.supply?.tradingValue)) {
    cacheSet("snapshot-live", payload);
  }
  return payload;
}

function buildMarketContext(items) {
  const changes = items.map((item) => item.quote?.changeRate).filter(Number.isFinite);
  const avgChange = changes.length ? changes.reduce((sum, value) => sum + value, 0) / changes.length : 0;
  const downCount = changes.filter((value) => value < 0).length;
  const deepDownCount = changes.filter((value) => value <= -5).length;
  const downRatio = changes.length ? downCount / changes.length : 0;
  const deepDownRatio = changes.length ? deepDownCount / changes.length : 0;
  const dayPnl = items.reduce((sum, item) => {
    const prev = item.quote?.prevClose;
    return Number.isFinite(prev) ? sum + (item.price - prev) * item.qty : sum;
  }, 0);

  let mode = "중립";
  if (avgChange <= -5 || downRatio >= 0.8 || deepDownRatio >= 0.45) mode = "패닉";
  else if (avgChange <= -3 || downRatio >= 0.65 || deepDownRatio >= 0.3) mode = "방어";
  else if (avgChange >= 2 && downRatio <= 0.35) mode = "공격";

  return {
    mode,
    avgChange,
    downCount,
    deepDownCount,
    totalCount: changes.length,
    downRatio,
    deepDownRatio,
    dayPnl
  };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(__dirname, "public", pathname));
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/health") {
      json(res, 200, { ok: true });
      return;
    }
    if (!isAuthorized(req)) {
      requestLogin(res);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/api/config") {
      json(res, 200, {
        hasKisKeys: Boolean(process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET),
        hasKisAccount: hasKisAccountConfig(),
        quoteMarket: KIS_QUOTE_MARKET,
        itemCount: portfolio.length
      });
      return;
    }
    if (url.pathname === "/api/snapshot") {
      const live = url.searchParams.get("live") !== "0" && Boolean(process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET);
      const force = url.searchParams.has("t") || url.searchParams.get("force") === "1";
      if (!live && url.searchParams.get("cached") === "1") {
        const cachedLive = cacheGet("snapshot-live", 1000 * 60 * 60 * 12);
        if (cachedLive) {
          json(res, 200, { ...cachedLive, source: `${cachedLive.source}-cached` });
          return;
        }
      }
      json(res, 200, await buildSnapshot(live, force));
      return;
    }
    if (url.pathname === "/api/market-screener") {
      if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
        json(res, 400, { error: "KIS keys are required" });
        return;
      }
      const limit = Math.min(100, Math.max(10, Number(url.searchParams.get("limit") || 100)));
      const force = url.searchParams.has("t") || url.searchParams.get("force") === "1";
      const market = String(url.searchParams.get("market") || "ALL").toUpperCase();
      json(res, 200, await buildMarketScreener(limit, force, market));
      return;
    }
    if (url.pathname === "/api/leader") {
      if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
        json(res, 400, { error: "KIS keys are required" });
        return;
      }
      const limit = Math.min(100, Math.max(20, Number(url.searchParams.get("limit") || 100)));
      const force = url.searchParams.has("t") || url.searchParams.get("force") === "1";
      const market = String(url.searchParams.get("market") || "ALL").toUpperCase();
      json(res, 200, await buildLeaderDashboard(limit, force, market));
      return;
    }
    if (url.pathname === "/api/scout") {
      if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
        json(res, 400, { error: "KIS keys are required" });
        return;
      }
      const limit = Math.min(100, Math.max(20, Number(url.searchParams.get("limit") || 100)));
      const force = url.searchParams.has("t") || url.searchParams.get("force") === "1";
      const market = String(url.searchParams.get("market") || "ALL").toUpperCase();
      json(res, 200, await buildScoutDashboard(limit, force, market));
      return;
    }
    if (url.pathname === "/api/strategies") {
      if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
        json(res, 400, { error: "KIS keys are required" });
        return;
      }
      const limit = Math.min(100, Math.max(20, Number(url.searchParams.get("limit") || 100)));
      const force = url.searchParams.has("t") || url.searchParams.get("force") === "1";
      const market = String(url.searchParams.get("market") || "ALL").toUpperCase();
      json(res, 200, await buildStrategyDashboard(limit, force, market));
      return;
    }
    if (url.pathname === "/api/simulation") {
      if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
        json(res, 400, { error: "KIS keys are required" });
        return;
      }
      const limit = Math.min(100, Math.max(20, Number(url.searchParams.get("limit") || 100)));
      const force = url.searchParams.has("t") || url.searchParams.get("force") === "1";
      const record = url.searchParams.get("record") === "1";
      json(res, 200, await buildSimulation({ record, force, limit }));
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Portfolio signal dashboard: http://localhost:${PORT}`);
});
