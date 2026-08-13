import { rankMarketRowsV2, reboundRankingTier, compareReboundRankingV2 } from "./rebound-ranking-v2.js";

const state = {
  snapshot: null,
  screener: null,
  filter: "all",
  query: "",
  holdingSort: "priority-desc",
  screenerSort: null,
  screenerFetchCount: 0,
  explorerMode: "rebound",
  screenerQuery: "",
  screenerLoading: false,
  backgroundRefresh: null,
  live: true
};

const fmtWon = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const fmtNum = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

const themeNames = {
  semiconductor: "반도체/부품",
  robotAi: "로봇/AI",
  bioMedical: "바이오/의료",
  energyPower: "에너지/전력",
  autoBattery: "자동차/2차전지",
  constructionShip: "건설/조선/해운",
  platform: "플랫폼/IT서비스"
};

function won(value) {
  return fmtWon.format(Math.round(value));
}

function eok(value) {
  return `${fmtNum.format((value ?? 0) / 100000000)}억`;
}

function pct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return `${value >= 0 ? "+" : ""}${fmtNum.format(value)}%`;
}

function plainPct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return `${fmtNum.format(value)}%`;
}

function dayChangeValue(row) {
  const quote = row.quote ?? {};
  const hasQuoteChange = Number.isFinite(quote.changeRate)
    && (Number.isFinite(quote.prevClose) || quote.changeRate !== 0);
  return hasQuoteChange ? quote.changeRate : row.strategy?.dayChangePct;
}

function qty(value) {
  return `${fmtInt.format(value)}주`;
}

function price(value) {
  return value ? `${fmtInt.format(Math.round(value))}원` : "-";
}

function ymd(value) {
  const text = String(value ?? "");
  if (!/^\d{8}$/.test(text)) return "-";
  return `${text.slice(2, 4)}.${text.slice(4, 6)}.${text.slice(6, 8)}`;
}

function naverStockUrl(code) {
  return `https://stock.naver.com/domestic/stock/${code}/price`;
}

function valuationMarketLabel(market) {
  if (market === "NX") return "NXT 현재가 재평가";
  if (market === "UN") return "통합시세 재평가";
  if (market === "J") return "KRX 현재가 재평가";
  return `${market} 현재가 재평가`;
}

function quoteMarketLabel(market) {
  if (market === "NX") return "NXT";
  if (market === "UN") return "통합";
  if (market === "J") return "KRX";
  return market || "시세";
}

function toneClass(value) {
  return value >= 0 ? "positive" : "negative";
}

function leaderTone(grade) {
  if (grade === "A") return "buy";
  if (grade === "B") return "hold";
  if (grade === "D" || grade === "계산불가") return "danger";
  return "muted";
}

function actionTone(action) {
  if (action.includes("매수") || action.includes("눌림") || action.includes("우선") || action.includes("분할")) return "buy";
  if (action.includes("축소") || action.includes("익절")) return "sell";
  if (action.includes("금지") || action.includes("손절") || action.includes("보류")) return "danger";
  return "hold";
}

function isScreenerOverheat(row) {
  const dayChange = row.changeRate ?? row.strategy?.dayChangePct ?? 0;
  const change3d = row.changeRate3d ?? row.strategy?.change3dPct ?? 0;
  return Boolean(row.strategy?.overheat) || dayChange >= 10 || change3d >= 12;
}

function isStrictBuyReady(row) {
  const flags = row.strategy?.flags ?? {};
  const supply = row.supply ?? {};
  const dayChange = row.changeRate ?? row.strategy?.dayChangePct ?? 0;
  const change3d = row.changeRate3d ?? row.strategy?.change3dPct ?? 0;
  const streak = (supply.foreignStreak ?? 0) >= 2 || (supply.instStreak ?? 0) >= 2;
  const vwapRecovered = Boolean(row.strategy?.vwapRecovered ?? row.nakju?.vwapRecovered);
  const fallbackStrict = (supply.liquidityScore ?? 0) >= 60
    && change3d >= -6
    && change3d <= 3
    && dayChange <= 5
    && streak
    && (supply.totalNetAmount ?? 0) > 0
    && vwapRecovered;
  return !flags.I && !isScreenerOverheat(row) && (Boolean(flags.R) || fallbackStrict);
}

function scoreTone(score) {
  if (score >= 70) return "buy";
  if (score >= 50) return "watch";
  if (score >= 30) return "hold";
  return "muted";
}

const RS20_TOOLTIP = "RS(20D)\n최근 20거래일 수익률을 같은 시장(KOSPI/KOSDAQ) 종목끼리 비교한 상대강도.\n0~99이며 높을수록 최근 시장 대비 강함.\n매수신호 또는 Ranking 점수가 아님.";
const TIER_TOOLTIP = "Ranking V2 Tier (순위를 가르는 등급)\nT1 최우선 · T2 하락정지 · T3 저위험\nT4~T6 후순위 · T6 제외";

function rs20Tone(rs20) {
  if (!Number.isFinite(rs20)) return "muted";
  if (rs20 >= 90) return "rs-strong";
  if (rs20 >= 80) return "rs-good";
  if (rs20 >= 70) return "rs-mild";
  if (rs20 >= 40) return "rs-neutral";
  return "rs-weak";
}

function liquidityDisplay(row) {
  const supply = row.supply ?? {};
  const hasMarketData = Number.isFinite(Number(supply.tradingValue)) && Number(supply.tradingValue) > 0
    && Number.isFinite(Number(supply.marketCap)) && Number(supply.marketCap) > 0;
  if (!hasMarketData) {
    return { value: "데이터 없음", tone: "missing", missing: true };
  }
  const score = supply.liquidityScore ?? 0;
  return { value: score, tone: scoreTone(score), missing: false };
}

function metricTone(value, good, strong) {
  if ((value ?? 0) >= strong) return "positive";
  if ((value ?? 0) >= good) return "watch-text";
  return "";
}

function dataBadges(row) {
  const badges = [];
  if (row.live) badges.push({ tone: "good", text: quoteMarketLabel(row.quote?.market) });
  else badges.push({ tone: "caution", text: "시세확인" });
  if (row.investor?.investorAmountSource === "daily-confirmed") badges.push({ tone: "good", text: "확정수급" });
  else if (row.investor?.available) badges.push({ tone: "watch", text: "추정수급" });
  else badges.push({ tone: "caution", text: "수급없음" });
  if (String(row.quote?.source ?? "").includes("cached")) badges.push({ tone: "watch", text: "캐시" });
  if (!row.supply?.tradingValue || !row.supply?.marketCap) badges.push({ tone: "caution", text: "거래데이터 부족" });
  return badges;
}

function renderDataBadges(row) {
  return `<div class="data-badges">${dataBadges(row).map((badge) => `<span class="data-badge ${badge.tone}">${badge.text}</span>`).join("")}</div>`;
}

function shortJudgement(row) {
  return row.judgement || "조건 추가 확인 필요";
}

function streakClass(row) {
  const foreign = row.supply.foreignStreak ?? 0;
  const inst = row.supply.instStreak ?? 0;
  if (foreign >= 2 && inst >= 2) return "combo";
  if (foreign >= 3 || inst >= 3) return "strong";
  if (foreign >= 2 || inst >= 2) return "watch";
  return "plain";
}

async function loadSnapshot(force = false) {
  document.querySelector("#holdings").innerHTML = `<tr><td colspan="9" class="loading">실계좌 잔고, NXT 현재가, 거래강도, 외/기관 연속일수 계산 중...</td></tr>`;

  try {
    const forceParam = force ? `&t=${Date.now()}` : "";
    const response = await fetch(`/api/snapshot?live=${state.live ? "1" : "0"}${forceParam}`, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "대시보드 데이터를 불러오지 못했습니다.");
    }
    state.snapshot = await response.json();
  } catch (error) {
    if (state.snapshot) {
      state.snapshot.errors = [...(state.snapshot.errors ?? []), { type: "live-load", message: error.message }];
      render();
      return;
    }
    const fallback = await fetch("/api/snapshot?live=0&cached=1");
    if (!fallback.ok) {
      document.querySelector("#holdings").innerHTML = `<tr><td colspan="9" class="loading">저장된 첫 정상 데이터를 준비 중입니다. 잠시 후 다시 확인해 주세요.</td></tr>`;
      return;
    }
    state.snapshot = await fallback.json();
    state.snapshot.errors = [...(state.snapshot.errors ?? []), { type: "live-load", message: error.message }];
  }
  render();
}

async function requestBackgroundRefresh() {
  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    if (response.status !== 202) return false;
    const payload = await response.json();
    state.backgroundRefresh = payload;
    pollBackgroundRefresh(payload.refreshId);
    return true;
  } catch {
    return false;
  }
}

async function pollBackgroundRefresh(refreshId) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      const response = await fetch("/api/refresh-status");
      if (!response.ok) return;
      const status = await response.json();
      state.backgroundRefresh = status;
      renderUnifiedExplorer();
      if (status.status === "success" && (!refreshId || status.refreshId === refreshId)) {
        await loadMarketScreener(false);
        await loadSnapshot(false);
        return;
      }
      if (status.status === "error") return;
    } catch {
      return;
    }
  }
}

async function loadMarketScreener(force = false) {
  state.screenerFetchCount += 1;
  state.screenerLoading = true;
  renderScreenerLoading();
  try {
    const backgroundAccepted = force ? await requestBackgroundRefresh() : false;
    const response = await fetch(`/api/market-screener?limit=100&market=ALL${force && !backgroundAccepted ? `&t=${Date.now()}` : ""}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "시장 스크리너를 불러오지 못했습니다.");
    }
    const payload = await response.json();
    state.screener = {
      ...(state.screener ?? {}),
      ...payload,
      rows: {
        ...(state.screener?.rows ?? { KOSPI: [], KOSDAQ: [] }),
        ...payload.rows
      },
      summary: {
        ...(state.screener?.summary ?? {}),
        ...payload.summary
      }
    };
  } catch (error) {
    state.screener = {
      ...(state.screener ?? {}),
      rows: state.screener?.rows ?? { KOSPI: [], KOSDAQ: [] },
      summary: state.screener?.summary ?? {},
      errors: [{ message: error.message }]
    };
  } finally {
    state.screenerLoading = false;
    renderUnifiedExplorer();
  }
}

function renderMetrics(summary) {
  const market = summary.marketContext ?? { mode: "중립", avgChange: 0, downCount: 0, totalCount: 0 };
  const accountBasis = state.snapshot?.accountSummary?.source === "kis-balance" ? " · 한국투자 잔고 기준" : "";
  const metrics = [
    [`장세 모드`, market.mode, `평균 ${pct(market.avgChange)} · 하락 ${market.downCount}/${market.totalCount}`, market.mode === "패닉" || market.mode === "방어" ? "negative" : ""],
    ["평가금액", won(summary.totalValue), `${state.snapshot.rows.length}종목`],
    ["총 손익", won(summary.totalPnl), `${pct(summary.totalPnlPct)}${accountBasis}`, toneClass(summary.totalPnl)],
    ["거래강도", `${summary.strongLiquidityCount}개`, `평균 ${fmtNum.format(summary.avgLiquidityScore)}점 · 유통보정 ${summary.freeFloatAppliedCount}개`]
  ];
  document.querySelector("#metrics").innerHTML = metrics.map(([label, value, sub, cls = ""]) => `
    <article class="metric">
      <div class="label">${label}</div>
      <div class="value ${cls}">${value}</div>
      <div class="sub">${sub}</div>
    </article>
  `).join("");
}

function renderActions(summary) {
  const strategies = summary.strategyCounts ?? {};
  const strictReady = strategies.R ?? 0;
  const pullbackCandidate = Math.max((strategies.F ?? 0) - strictReady, 0);
  const cards = [
    ["우선 검토", strictReady, "거래강도60 + 좁은 눌림 + VWAP"],
    ["분할 후보", pullbackCandidate, "5~10일 관점, 소액 분할"],
    ["수급 관찰", strategies.B ?? 0, "연속 수급은 있으나 눌림 미확인"],
    ["강수급 낙주", strategies.H3 ?? 0, "급락 후 VWAP 회복 + 연속수급"],
    ["강한 관심", strategies.C ?? 0, "거래강도70, 추격매수 금지"],
    ["매수보류", strategies.I ?? 0, "급락 미회복/물타기 금지"]
  ];
  document.querySelector("#actionGrid").innerHTML = cards.map(([label, count, sub]) => `
    <article class="action-card">
      <strong>${label}</strong>
      <span>${count}</span>
      <small>${sub}</small>
    </article>
  `).join("");
}

function renderThemes(summary) {
  document.querySelector("#themeList").innerHTML = summary.themeExposure.map((item) => `
    <div class="theme-row">
      <div class="theme-head">
        <span>${themeNames[item.theme] ?? item.theme}</span>
        <b>${fmtNum.format(item.pct)}%</b>
      </div>
      <div class="bar"><div class="fill" style="width:${Math.min(100, item.pct)}%"></div></div>
    </div>
  `).join("");
}

function renderTodayTrades(summary) {
  const trades = summary.todayTrades ?? [];
  document.querySelector("#todayTrades").innerHTML = trades.length ? trades.map((row) => `
    <article class="trade-row ${row.strategy.tone}">
      <div class="trade-main">
        <span class="badge ${row.strategy.tone === "watch" ? "hold" : row.strategy.tone}">${row.strategy.label}</span>
        <a class="stock-link trade-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a>
        <small>${row.code}</small>
      </div>
      <div class="trade-stats">
        <span><b>${row.strategy.grade}</b> 등급</span>
        <span><b>${row.supply.liquidityScore}</b> 거래강도</span>
        <span><b>${pct(row.strategy.change3dPct)}</b> 3일</span>
        <span><b>${row.supply.foreignStreak}</b>외 · <b>${row.supply.instStreak}</b>기</span>
        <span>${row.strategy.vwapRecovered ? "VWAP 위" : "VWAP 아래"}</span>
      </div>
      <div class="trade-prices">
        <span>${row.strategy.horizon}</span>
        <span>우선 ${row.strategy.flags.R ? "충족" : "-"}</span>
        <span>분할 ${row.strategy.flags.F2 || row.strategy.flags.F ? "후보" : "-"}</span>
        <span>낙주 ${row.strategy.flags.H3 ? "충족" : "-"}</span>
        <span>${row.strategy.flags.I ? "매수보류" : "관찰가능"}</span>
      </div>
    </article>
  `).join("") : `
    <article class="trade-empty">
      <strong>오늘 눌림목 핵심 후보 없음</strong>
      <span>거래강도 50점 이상, 3일 -8~+5%, 외/기관 연속수급 조합을 우선 확인합니다.</span>
    </article>
  `;
}

function renderScreenerPicks(rows) {
  const rankMap = combinedRankMap();
  const picks = rows
    .filter((row) => row.combined?.rankable)
    .sort((a, b) => displayCombinedRank(a, rankMap) - displayCombinedRank(b, rankMap))
    .slice(0, 6);
  document.querySelector("#screenerPicks").innerHTML = picks.length ? `
    <div class="picks-title">
      <strong>종합 매수 상위</strong>
      <span>매수보류·과열·데이터 부족 제외 후 메인 70점 + 정찰병 30점</span>
    </div>
    <div class="pick-list">
      ${picks.map((row) => `
        <article class="pick-item ${row.strategy?.tone ?? "hold"}">
          <div>
            <a class="stock-link pick-name" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a>
            <div class="cell-sub">종합 ${displayCombinedRank(row, rankMap) ?? "-"}위 · ${row.combined?.label ?? "관망"}</div>
          </div>
          <div class="pick-metrics">
            <span>거래강도 <b>${row.supply?.liquidityScore ?? "-"}</b></span>
            <span>외/기 <b>${row.supply?.foreignStreak ?? 0}/${row.supply?.instStreak ?? 0}일</b></span>
            <span>반등 <b>${row.scout?.reboundRank ? `${row.scout.reboundRank}/${row.scout.reboundTotal}` : "순위권 밖"}</b></span>
          </div>
          <p>${row.combined?.reason ?? shortJudgement(row)}</p>
        </article>
      `).join("")}
    </div>
  ` : "";
}

function marketRows(market = state.screenerMarket) {
  const groups = state.screener?.rows ?? { KOSPI: [], KOSDAQ: [] };
  return market === "ALL" ? [...(groups.KOSPI ?? []), ...(groups.KOSDAQ ?? [])] : (groups[market] ?? []);
}

function combinedRankMap() {
  const source = state.screenerMarket === "ALL" ? marketRows("ALL") : marketRows(state.screenerMarket);
  const ranked = source
    .filter((row) => row.combined?.rankable)
    .sort((a, b) => (b.combined?.tier ?? 0) - (a.combined?.tier ?? 0)
      || (b.combined?.score ?? 0) - (a.combined?.score ?? 0)
      || (b.combined?.mainScore ?? 0) - (a.combined?.mainScore ?? 0)
      || (a.scout?.rank ?? 9999) - (b.scout?.rank ?? 9999)
      || (b.supply?.liquidityScore ?? 0) - (a.supply?.liquidityScore ?? 0));
  return new Map(ranked.map((row, index) => [row.code, index + 1]));
}

function displayCombinedRank(row, rankMap = combinedRankMap()) {
  return row.combined?.rank ?? null;
}

function screenerRows() {
  const rows = marketRows();
  const query = state.screenerQuery.trim().toLowerCase();
  const filteredByQuery = query ? rows.filter((row) => row.name.toLowerCase().includes(query) || row.code.includes(query)) : rows;
  const filtered = filteredByQuery.filter((row) => matchesScreenerFilter(row, state.screenerFilter));
  return sortScreenerRows(filtered);
}

function matchesScreenerFilter(row, filter) {
  const flags = row.strategy?.flags ?? {};
  const supply = row.supply ?? {};
  const dayChange = row.changeRate ?? row.strategy?.dayChangePct ?? 0;
  const change3d = row.changeRate3d ?? row.strategy?.change3dPct ?? 0;
  const overheat = Boolean(row.strategy?.overheat) || dayChange >= 10 || change3d >= 12;
  const smartMoney = (supply.smartMoneyBodyPct ?? 0) >= 0.3 || (supply.smartMoneyTradingSharePct ?? 0) >= 10;
  const streak = (supply.foreignStreak ?? 0) >= 2 || (supply.instStreak ?? 0) >= 2;
  const explosion = (supply.tradingValueRatio20 ?? 0) >= 3;
  if (filter === "all") return true;
  if (filter === "combined-buy") return Boolean(row.combined?.rankable) && (row.combined?.tier ?? 0) >= 4;
  if (filter === "buy-ready") return isStrictBuyReady(row);
  if (filter === "buy-candidate") return !isStrictBuyReady(row) && !flags.I && !overheat && (Boolean(flags.F) || Boolean(flags.F2) || (Boolean(flags.B) && (supply.liquidityScore ?? 0) >= 50));
  if (filter === "special") return Boolean(flags.H3) && !flags.I;
  if (filter === "observe") return !flags.I && !overheat && !flags.F2 && !flags.F && !flags.H3 && (streak || smartMoney || explosion || Boolean(flags.C));
  if (filter === "overheat") return overheat && !flags.I;
  if (filter === "avoid") return Boolean(flags.I);
  if (filter === "pullback-core") return isStrictBuyReady(row);
  if (filter === "pullback-candidate") return Boolean(flags.F) && !flags.F2;
  if (filter === "nakju") return Boolean(flags.H3);
  if (filter === "streak") return streak;
  if (filter === "explosion") return explosion;
  if (filter === "smart-money") return smartMoney;
  return false;
}

function sortScreenerRows(rows) {
  const [field, direction] = state.screenerSort.split("-");
  const multiplier = direction === "asc" ? 1 : -1;
  if (field === "rank") {
    const rankMap = combinedRankMap();
    return [...rows].sort((a, b) => {
      const aRank = displayCombinedRank(a, rankMap);
      const bRank = displayCombinedRank(b, rankMap);
      if (aRank && !bRank) return -1;
      if (!aRank && bRank) return 1;
      if (aRank && bRank && aRank !== bRank) return direction === "desc" ? aRank - bRank : bRank - aRank;
      return (b.combined?.score ?? 0) - (a.combined?.score ?? 0);
    });
  }
  const valueOf = (row) => {
    const supply = row.supply ?? {};
    if (field === "price") return row.price ?? 0;
    if (field === "liquidity") return supply.liquidityScore ?? 0;
    if (field === "turnover") return Math.max(supply.bodyTurnoverPct ?? 0, (supply.tradingValueRatio20 ?? 0) * 2);
    if (field === "smart") return Math.max(supply.smartMoneyBodyPct ?? 0, supply.smartMoneyTradingSharePct ?? 0) + Math.max(supply.foreignStreak ?? 0, supply.instStreak ?? 0);
    if (field === "leader") return Number.isFinite(row.leader?.score) ? row.leader.score : -1;
    if (field === "combined") return row.combined?.rankable ? 1000 - (row.combined?.rank ?? 999) : -(row.combined?.score ?? 0);
    if (field === "scout") return row.scout?.reboundRank ? 1000 - row.scout.reboundRank : -1;
    if (field === "strategy") return row.strategy?.score ?? 0;
    return row.rank ? -row.rank : 0;
  };
  return [...rows].sort((a, b) => {
    const diff = valueOf(a) - valueOf(b);
    if (diff !== 0) return diff * multiplier;
    return (b.supply?.liquidityScore ?? 0) - (a.supply?.liquidityScore ?? 0);
  });
}

function setScreenerSort(field) {
  const [currentField, currentDirection] = state.screenerSort.split("-");
  const nextDirection = currentField === field && currentDirection === "desc" ? "asc" : "desc";
  state.screenerSort = `${field}-${nextDirection}`;
  renderScreener();
}

function renderScreenerSortState() {
  const [field, direction] = state.screenerSort.split("-");
  document.querySelectorAll("[data-screener-sort-field]").forEach((button) => {
    const active = button.dataset.screenerSortField === field;
    button.classList.toggle("active", active);
    button.setAttribute("aria-sort", active ? (direction === "desc" ? "descending" : "ascending") : "none");
  });
  document.querySelectorAll("[data-screener-sort-icon]").forEach((icon) => {
    const active = icon.dataset.screenerSortIcon === field;
    icon.textContent = active ? (direction === "desc" ? "↓" : "↑") : "↕";
  });
}

function screenerTags(row) {
  const tags = [];
  const supply = row.supply ?? {};
  const score = supply.liquidityScore ?? 0;
  const totalNet = supply.totalNetAmount ?? 0;
  const bodyTurnover = supply.bodyTurnoverPct ?? 0;
  const valueRatio = supply.tradingValueRatio20 ?? 0;
  const bodyPct = supply.smartMoneyBodyPct ?? 0;
  const sharePct = supply.smartMoneyTradingSharePct ?? 0;
  const foreignStreak = supply.foreignStreak ?? 0;
  const instStreak = supply.instStreak ?? 0;
  const nakju = row.nakju ?? {};
  const strategy = row.strategy ?? {};
  const flags = strategy.flags ?? {};
  const confirmation = row.confirmation ?? {};

  const push = (tone, text) => tags.push({ tone, text });

  if (confirmation.leaderReboundPass) push("good", "전략: 좋은종목 반등");
  if (confirmation.cafePass) push("good", "전략: CAFE");
  if (confirmation.minerviniPass) push("good", "전략: MTT");
  if (confirmation.experimentalNakjuPass) push("watch", "실험: 낙주");

  if (flags.H3) push("good", "특수: 강수급 낙주");
  else if (isStrictBuyReady(row)) push("good", "우선검토: 엄격 기준 통과");
  else if (flags.F2) push("good", "분할: 눌림+연속수급");
  else if (flags.F) push("good", "분할: 눌림 후보");
  else if (flags.B) push("watch", "관찰: 연속수급");
  else if (flags.C) push("watch", "관찰: 거래강도70");
  if (flags.H2 && !flags.H3) push("watch", "단기: 낙주 확인");
  if (flags.I) push("caution", "제외: 매수보류");

  if (score >= 70) push("good", "좋음: 돈이 강하게 붙음");
  else if (score >= 50) push("watch", "관심: 후보권 거래강도");
  else push("muted", "약함: 아직 돈 유입 부족");

  if (foreignStreak >= 2 && instStreak >= 2) push("good", `강함: 외/기 동시연속 ${foreignStreak}/${instStreak}일`);
  else if (foreignStreak >= 3) push("good", `강함: 외인 ${foreignStreak}일 연속`);
  else if (instStreak >= 3) push("good", `강함: 기관 ${instStreak}일 연속`);
  else if (foreignStreak >= 2 || instStreak >= 2) push("watch", `관찰: 연속수급 외${foreignStreak}·기${instStreak}`);
  else push("muted", "약함: 연속 매수 없음");

  if (totalNet > 0 && (bodyPct >= 0.3 || sharePct >= 10)) push("good", "좋음: 외+기관이 거래 주도");
  else if (totalNet > 0) push("watch", "관찰: 외+기관 순매수");
  else push("caution", "주의: 외+기관 매도 우위");

  if (bodyTurnover >= 10) push("good", "좋음: 돈 회전 매우 큼");
  else if (bodyTurnover >= 5) push("good", "좋음: 돈 회전 큼");
  else if (bodyTurnover >= 1) push("watch", "관심: 거래 회전 발생");

  if (valueRatio >= 5) push("good", "좋음: 거래대금 급증");
  else if (valueRatio >= 3) push("good", "좋음: 평소보다 거래 3배+");
  else if (valueRatio >= 1.5) push("watch", "관심: 평소보다 거래 증가");

  if ((row.changeRate ?? 0) <= -5) {
    if (flags.H3) push("good", "특수: 급락 후 큰손 반등");
    else if (nakju.vwapRecovered && (nakju.reboundFromLowPct ?? 0) >= 1.2) push("good", "좋음: 낙주 반등 확인");
    else if ((nakju.reboundFromLowPct ?? 0) >= 1.2) push("watch", "관심: 저점 반등은 있음");
    else push("caution", "주의: 낙폭 큰데 저점 약함");
    if (!nakju.vwapRecovered) push("caution", "주의: VWAP 미회복");
  }

  return tags.slice(0, 8);
}

function renderTag(tag) {
  if (typeof tag === "string") return `<span class="reason">${tag}</span>`;
  return `<span class="reason ${tag.tone ?? ""}">${tag.text}</span>`;
}

function renderScreenerLoading() {
  document.querySelector("#screenerMarkets").innerHTML = `<div class="loading explorer-loading">KOSPI·KOSDAQ 종목 탐색 데이터 계산 중... 첫 실행은 시간이 걸릴 수 있습니다.</div>`;
  document.querySelector("#screenerStatus").textContent = "두 시장을 한 번에 불러오되 순위는 시장별로 따로 계산합니다.";
  document.querySelector("#screenerStatus").dataset.fetchCount = String(state.screenerFetchCount);
}

function renderMobileScreener(rows) {
  const signalFor = (row) => {
    const combined = row.combined ?? {};
    if (combined.blocked || combined.tone === "danger") return { tone: "red", label: "보류" };
    if ((combined.tier ?? 0) >= 4 || isStrictBuyReady(row)) return { tone: "green", label: "후보" };
    return { tone: "yellow", label: "관찰" };
  };
  const orderMarketRows = (marketRows) => {
    const [sortField, direction] = state.screenerSort.split("-");
    if (sortField !== "rank") return marketRows;
    const signalPriority = { green: 0, yellow: 1, red: 2 };
    return [...marketRows].sort((a, b) => {
      const toneDiff = signalPriority[signalFor(a).tone] - signalPriority[signalFor(b).tone];
      if (toneDiff !== 0) return toneDiff;
      const aRank = a.combined?.rank;
      const bRank = b.combined?.rank;
      if (aRank && !bRank) return -1;
      if (!aRank && bRank) return 1;
      if (aRank && bRank && aRank !== bRank) return direction === "desc" ? aRank - bRank : bRank - aRank;
      return (b.combined?.score ?? 0) - (a.combined?.score ?? 0);
    });
  };
  const renderRows = (marketRows) => marketRows.map((row) => {
    const combined = row.combined ?? {};
    const leader = row.leader ?? {};
    const scout = row.scout ?? {};
    const liquidity = liquidityDisplay(row);
    const signal = signalFor(row);
    return `
      <article class="mobile-stock-row ${row.market === "KOSDAQ" ? "kosdaq" : "kospi"}" title="${combined.label ?? "관망"} · 전일 ${pct(row.changeRate)} · 3일 ${pct(row.changeRate3d)}">
        <div class="mobile-stock-rank">
          <b>${combined.rank ?? "–"}</b>
        </div>
        <a class="mobile-stock-name stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">
          <b>${row.name}</b>
        </a>
        <div class="mobile-stock-price">
          <b>${price(row.price)}</b>
          <small><i class="${toneClass(row.changeRate ?? 0)}">1일 ${pct(row.changeRate)}</i><i class="${toneClass(row.changeRate3d ?? 0)}">3일 ${pct(row.changeRate3d)}</i></small>
        </div>
        <div class="mobile-inline-score"><span>거래</span><b class="${liquidity.tone}">${liquidity.missing ? "-" : liquidity.value}</b></div>
        <div class="mobile-inline-score"><span>주도</span><b class="${leaderTone(leader.grade)}">${leader.grade ?? "-"}</b></div>
        <div class="mobile-inline-score"><span>반등</span><b class="${scout.reboundRank ? "watch" : "muted"}">${scout.reboundRank ? `${scout.reboundRank}위` : "-"}</b></div>
        <div class="mobile-inline-score mobile-supply"><span>외기</span><b class="${streakClass(row)}">${row.supply?.foreignStreak ?? 0}/${row.supply?.instStreak ?? 0}</b></div>
        <div class="mobile-signal ${signal.tone}"><i></i><b>${signal.label}</b></div>
      </article>
    `;
  }).join("");

  const sections = (state.screenerMarket === "ALL" ? ["KOSPI", "KOSDAQ"] : [state.screenerMarket])
    .map((market) => {
      const marketRows = orderMarketRows(rows.filter((row) => row.market === market));
      if (!marketRows.length) return "";
      const marketClass = market === "KOSDAQ" ? "kosdaq" : "kospi";
      return `
        <section class="mobile-market-section ${marketClass}">
          <header class="mobile-market-heading">
            <strong>${market}</strong>
            <span>시장별 독립 순위 · ${marketRows.length}종목</span>
            <small><i class="green"></i>후보 <i class="yellow"></i>관찰 <i class="red"></i>보류</small>
          </header>
          ${renderRows(marketRows)}
        </section>
      `;
    }).join("");
  document.querySelector("#mobileScreenerRows").innerHTML = sections || `<div class="loading">조건에 맞는 시장 후보가 없습니다.</div>`;
}

function renderScreenerSummary() {
  const rows = marketRows();
  const summary = {
    count: rows.length,
    combinedBuy: rows.filter((row) => (row.combined?.tier ?? 0) >= 4).length
  };
  const count = (filter) => rows.filter((row) => matchesScreenerFilter(row, filter)).length;
  const cards = [
    ["all", "전체", `${summary.count}개`, "시총 상위+거래량 후보"],
    ["combined-buy", "종합 매수후보", `${summary.combinedBuy ?? 0}개`, "메인+반등 조건 함께 통과"],
    ["buy-ready", "우선 검토", `${count("buy-ready")}개`, "거래강도60·VWAP·좁은 눌림"],
    ["buy-candidate", "분할 후보", `${count("buy-candidate")}개`, "5~10일 관점, 소액 분할"],
    ["special", "단기 특수", `${count("special")}개`, "강수급 낙주, 짧게만"],
    ["observe", "관심 관찰", `${count("observe")}개`, "연속수급/큰손/거래폭증"],
    ["overheat", "추격주의", `${count("overheat")}개`, "급등·3일 과열"],
    ["avoid", "매수보류", `${count("avoid")}개`, "급락 미회복/위험"]
  ];
  document.querySelector("#screenerSummary").innerHTML = cards.map(([filter, label, value, sub]) => `
    <button class="mini-metric ${state.screenerFilter === filter ? "active" : ""}" data-screener-filter="${filter}" type="button">
      <span>${label}</span>
      <b>${value}</b>
      <small>${sub}</small>
    </button>
  `).join("");
}

function renderScreener() {
  if (state.screenerLoading) return;
  renderScreenerSummary();
  renderScreenerSortState();
  const rows = screenerRows();
  renderScreenerPicks(rows);
  renderMobileScreener(rows);
  const errorText = state.screener?.errors?.length ? ` · 일부 실패 ${state.screener.errors.length}건` : "";
  const asOf = state.screener?.asOf ? new Date(state.screener.asOf).toLocaleString("ko-KR") : "-";
  const marketLabel = state.screenerMarket === "ALL" ? "KOSPI·KOSDAQ 각각" : state.screenerMarket;
  if (!rows.length && state.screener?.errors?.length && !state.screener?.asOf) {
    document.querySelector("#screenerStatus").textContent = state.screener.errors[0].message;
  } else {
    document.querySelector("#screenerStatus").textContent = `${marketLabel} 시총 상위 100 + 거래대금 랭킹 후보 기준 · ${asOf}${errorText}`;
  }
  const rankMap = combinedRankMap();
  document.querySelector("#screenerRows").innerHTML = rows.map((row, index) => {
    const supply = row.supply ?? {};
    const tags = screenerTags(row);
    const liquidity = liquidityDisplay(row);
    const combined = row.combined ?? {};
    const scout = row.scout ?? {};
    const leader = row.leader ?? {};
    const rebound = row.confirmation?.reboundState ?? {};
    const scoutTone = rebound.tone ?? (scout.status === "추가매수 금지" ? "danger" : "hold");
    const strategyBadges = (row.confirmation?.badges ?? []).map((label) => `<span class="strategy-badge ${label === "실험: 낙주" ? "hold" : "buy"}">${label}</span>`).join("");
    return `
      <tr>
        <td>
          <div class="rank-main">${displayCombinedRank(row, rankMap) ?? "–"}</div>
          <div class="cell-sub">${displayCombinedRank(row, rankMap) ? `종합 ${combined.score}점` : (combined.label ?? "조건 미달")}</div>
          <div class="cell-sub">${row.rankType ?? "시총"} ${row.rank}위</div>
        </td>
        <td>
          <a class="stock-name stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a>
          <div class="code">${row.code} · ${row.market}</div>
          ${renderDataBadges(row)}
        </td>
        <td>
          <div class="money-main">${price(row.price)}</div>
          <div class="price-change ${toneClass(row.changeRate ?? 0)}">전일 ${pct(row.changeRate)}</div>
          <div class="price-change small ${toneClass(row.changeRate3d ?? 0)}">3일 ${pct(row.changeRate3d)}</div>
          <div class="cell-sub">거래대금 ${eok(row.tradingValue)}</div>
        </td>
        <td>
          <div class="score-pill ${liquidity.tone}">${liquidity.value}</div>
          <div class="cell-sub">${supply.usesFreeFloat ? "유통시총" : "시총"} 기준</div>
          <div class="cell-sub">종합 반영 ${combined.liquidityPoints ?? 0}/20점</div>
        </td>
        <td>
          <div class="money-main ${metricTone(supply.bodyTurnoverPct, 5, 10)}">${pct(supply.bodyTurnoverPct)}</div>
          <div class="cell-sub">20일 대비 ${supply.tradingValueRatio20 === null ? "-" : `${fmtNum.format(supply.tradingValueRatio20)}배`}</div>
          <div class="cell-sub">시총 ${eok(row.marketCap)}</div>
        </td>
        <td>
          <div class="money-main ${toneClass(supply.totalNetAmount ?? 0)}">${eok(supply.totalNetAmount)}</div>
          <div class="streak-badge screener-streak ${streakClass(row)}">연속 외 ${supply.foreignStreak ?? 0}일 · 기 ${supply.instStreak ?? 0}일</div>
          <div class="cell-sub">기준 ${ymd(row.investor?.latestInvestorDate)}</div>
          <div class="cell-sub ${metricTone(supply.smartMoneyBodyPct, 0.3, 1)}">몸집 ${pct(supply.smartMoneyBodyPct)}</div>
          <div class="cell-sub ${metricTone(supply.smartMoneyTradingSharePct, 10, 30)}">주도 ${pct(supply.smartMoneyTradingSharePct)}</div>
        </td>
        <td>
          <a class="leader-badge ${leaderTone(leader.grade)}" href="/leader.html" title="장기추세 ${leader.trendScore ?? "-"}/30 · 상대강도 ${leader.relativeStrengthScore ?? "-"}/30 · 고점유지 ${leader.highRetentionScore ?? "-"}/20 · 지속성 ${leader.persistenceScore ?? "-"}/20">${Number.isFinite(leader.score) ? `${leader.score} ${leader.grade}` : "계산불가"}</a>
        </td>
        <td>
          <div class="badge ${combined.tone === "buy" ? "buy" : combined.tone === "danger" ? "danger" : "hold"}">${combined.label ?? "관망"}</div>
          <div class="combined-score"><b>${combined.score ?? 0}점</b><span>메인 ${combined.mainScore ?? 0} + 반등 ${combined.scoutScore ?? 0}</span></div>
          <div class="cell-sub">눌림 ${combined.strategyPoints ?? 0} · 거래 ${combined.liquidityPoints ?? 0} · 수급 ${combined.supplyPoints ?? 0} · 기술 ${combined.technicalPoints ?? 0}</div>
          <div class="cell-sub">${combined.reason ?? "종합 조건 확인"}</div>
        </td>
        <td>
          <div class="badge ${scoutTone}">${rebound.label ?? scout.status ?? "순위권 밖"}</div>
          <div class="scout-rank">${scout.reboundRank ? `${scout.reboundRank}/${scout.reboundTotal}위` : "반등 순위 없음"}</div>
          <div class="cell-sub">싸짐 ${scout.cheapScore ?? "-"} · 멈춤 ${scout.stabilizeScore ?? "-"} · 위험 ${scout.riskScore ?? "-"}</div>
          <div class="cell-sub">2년 위치 ${scout.pricePositionPct === null || scout.pricePositionPct === undefined ? "-" : plainPct(scout.pricePositionPct)} · 고점대비 ${pct(scout.drawdownFromHighPct)}</div>
          <div class="strategy-badges">${strategyBadges}</div>
        </td>
        <td>
          <div class="judgement-line">${shortJudgement(row)}</div>
          <div class="reason-list">${tags.map(renderTag).join("")}</div>
        </td>
      </tr>
    `;
  }).join("") || `<tr><td colspan="10" class="loading">조건에 맞는 시장 후보가 없습니다.</td></tr>`;
}

// Unified explorer: one cached dataset, two independently ranked market sections.
function explorerMarketRows(market) {
  return state.screener?.rows?.[market] ?? [];
}

function signedEok(value) {
  if (!Number.isFinite(Number(value))) return "-";
  const amount = Number(value) / 100000000;
  return `${amount > 0 ? "+" : ""}${fmtNum.format(amount)}억`;
}

const SE_BADGE_TOOLTIP = {
  "SE-MOM": "SE-MOM\nStockEasy 모멘텀 Easy 현재 편입",
  "SE-PEAK": "SE-PEAK\nStockEasy 피크 Easy 현재 편입",
  "SE-VALUE": "SE-VALUE\nStockEasy 밸류 Easy 현재 편입"
};

function explorerBadges(row) {
  const confirmation = row.confirmation ?? {};
  const stockEasy = row.stockEasy ?? {};
  const labels = [
    confirmation.minerviniPass ? "MTT" : null,
    confirmation.cafePass ? "CAFE" : null,
    stockEasy.seMomentum ? "SE-MOM" : null,
    stockEasy.sePeak ? "SE-PEAK" : null,
    stockEasy.seValue ? "SE-VALUE" : null
  ].filter(Boolean);
  return labels
    .map((label) => {
      const tone = label.startsWith("SE-") ? "se" : "buy";
      const title = SE_BADGE_TOOLTIP[label] ? ` title="${SE_BADGE_TOOLTIP[label]}"` : "";
      return `<span class="strategy-badge ${tone}"${title}>${label}</span>`;
    })
    .join("");
}

function explorerModeRows(market) {
  const query = state.screenerQuery.trim().toLowerCase();
  let rows = explorerMarketRows(market).filter((row) => !query || row.name.toLowerCase().includes(query) || row.code.includes(query));
  if (state.explorerMode === "cafe") rows = rows.filter((row) => row.confirmation?.cafePass);
  if (state.explorerMode === "mtt") rows = rows.filter((row) => row.confirmation?.minerviniPass);
  return rows;
}

function explorerDefaultSort(rows) {
  if (state.explorerMode === "rebound") return rankMarketRowsV2(rows);
  if (state.explorerMode === "leader") return [...rows].sort((a, b) => Number(b.leader?.score ?? -1) - Number(a.leader?.score ?? -1)
    || Number(b.combined?.score ?? 0) - Number(a.combined?.score ?? 0));
  return [...rows].sort((a, b) => Number(b.combined?.tier ?? 0) - Number(a.combined?.tier ?? 0)
    || Number(b.combined?.score ?? 0) - Number(a.combined?.score ?? 0)
    || Number(b.combined?.mainScore ?? 0) - Number(a.combined?.mainScore ?? 0));
}

function explorerSortValue(row, field) {
  if (field === "rs20") return Number.isFinite(row.scout?.rs20) ? Number(row.scout.rs20) : -1;
  if (field === "leader") return Number(row.leader?.score ?? -1);
  if (field === "drawdown") return Number(row.scout?.drawdownFromHighPct ?? 0);
  if (field === "risk") return Number(row.scout?.riskScore ?? 100);
  if (field === "stabilize") return Number(row.scout?.stabilizeScore ?? 0);
  if (field === "liquidity") return Number(row.supply?.liquidityScore ?? 0);
  if (field === "timing") return Number(row.combined?.score ?? 0);
  return 0;
}

function explorerRows(market) {
  const rows = explorerModeRows(market);
  if (!state.screenerSort) return explorerDefaultSort(rows);
  const [field, direction] = state.screenerSort.split("-");
  const multiplier = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => (explorerSortValue(a, field) - explorerSortValue(b, field)) * multiplier || compareReboundRankingV2(a, b));
}

function setExplorerSort(field) {
  if (field === "rank") {
    state.screenerSort = null;
    renderUnifiedExplorer();
    return;
  }
  const firstDirection = field === "risk" || field === "drawdown" ? "asc" : "desc";
  if (!state.screenerSort || !state.screenerSort.startsWith(`${field}-`)) state.screenerSort = `${field}-${firstDirection}`;
  else state.screenerSort = `${field}-${state.screenerSort.endsWith("-asc") ? "desc" : "asc"}`;
  renderUnifiedExplorer();
}

function renderExplorerSortState() {
  const [rawField = "", direction = ""] = (state.screenerSort ?? "").split("-");
  const field = rawField || "rank";
  document.querySelectorAll("[data-screener-sort-field]").forEach((button) => button.classList.toggle("active", button.dataset.screenerSortField === field));
  document.querySelectorAll("[data-screener-sort-icon]").forEach((icon) => {
    if (icon.dataset.screenerSortIcon === "rank") { icon.textContent = field === "rank" ? "●" : "↕"; return; }
    icon.textContent = icon.dataset.screenerSortIcon === field ? (direction === "desc" ? "↓" : "↑") : "↕";
  });
}

function scoutStatusLabel(status) {
  return {
    "정찰병 1주": "정찰병",
    "하락 정지 확인": "하락 정지",
    "1차 매수 검토": "반등 확인",
    "추가매수 금지": "고위험",
    "관찰 목록": "관찰"
  }[status] ?? "계산불가";
}

// Mobile shows a 2-character version of the same judgement so the badge
// never gets clipped at the right screen edge. Same source status, no
// change to the judgement itself.
function scoutStatusShort(status) {
  return {
    "정찰병 1주": "정찰",
    "하락 정지 확인": "정지",
    "1차 매수 검토": "반등",
    "추가매수 금지": "위험",
    "관찰 목록": "관찰"
  }[status] ?? "–";
}

function scoutStatusTone(row) {
  if (row.scout?.status === "추가매수 금지" || reboundRankingTier(row) === 6) return "danger";
  if (["1차 매수 검토", "하락 정지 확인"].includes(row.scout?.status)) return "buy";
  return "hold";
}

function renderExplorerMobile(rows, market) {
  return rows.map((row, index) => {
    const scout = row.scout ?? {};
    const leader = row.leader ?? {};
    const supply = row.supply ?? {};
    const combined = row.combined ?? {};
    return `<article class="explorer-mobile-card ${market.toLowerCase()}">
      <div class="explorer-card-head"><b>${index + 1}</b><div class="stock-title-line"><a class="stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a><span class="strategy-badges">${explorerBadges(row)}</span></div><span class="badge ${scoutStatusTone(row)}">${scoutStatusLabel(scout.status)}</span></div>
      <div class="explorer-card-price"><b>${price(row.price)}</b><span class="${toneClass(row.changeRate ?? 0)}">전일 ${pct(row.changeRate)}</span><span class="${toneClass(row.changeRate3d ?? 0)}">3일 ${pct(row.changeRate3d)}</span></div>
      <div class="explorer-card-grid"><span>RS <b class="${rs20Tone(scout.rs20)}" title="${RS20_TOOLTIP}">${Number.isFinite(scout.rs20) ? scout.rs20 : "-"}</b></span><span>Leader <b>${leader.grade ?? "-"}${Number.isFinite(leader.score) ? ` ${leader.score}` : ""}</b></span><span>낙폭 <b>${pct(scout.drawdownFromHighPct)}</b></span><span>Risk <b>${scout.riskScore ?? "-"}</b></span><span>Stab <b>${scout.stabilizeScore ?? "-"}</b></span><span>거래강도 <b>${supply.liquidityScore ?? 0}</b><small>외 ${signedEok(supply.foreignNetAmount)} · 기 ${signedEok(supply.instNetAmount)}</small></span><span>타이밍 <b>${combined.score ?? 0}</b><small>${combined.label ?? "관망"}</small></span></div>
    </article>`;
  }).join("") || `<div class="loading">${state.explorerMode.toUpperCase()} 조건에 맞는 종목이 없습니다.</div>`;
}

function renderExplorerRows(rows) {
  return rows.map((row, index) => {
    const scout = row.scout ?? {};
    const leader = row.leader ?? {};
    const supply = row.supply ?? {};
    const combined = row.combined ?? {};
    return `<tr>
      <td><div class="rank-main">${index + 1}</div><div class="cell-sub rank-tier" title="${TIER_TOOLTIP}">${state.explorerMode === "rebound" ? `T${reboundRankingTier(row)}` : state.explorerMode.toUpperCase()}</div></td>
      <td><div class="stock-title-line"><a class="stock-name stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a><span class="strategy-badges">${explorerBadges(row)}</span></div><div class="explorer-price-line"><b>${price(row.price)}</b><span class="${toneClass(row.changeRate ?? 0)}">전일 ${pct(row.changeRate)}</span><span class="${toneClass(row.changeRate3d ?? 0)}">3일 ${pct(row.changeRate3d)}</span></div></td>
      <td><b class="rs20-value ${rs20Tone(scout.rs20)}" title="${RS20_TOOLTIP}">${Number.isFinite(scout.rs20) ? scout.rs20 : "-"}</b></td>
      <td><span class="leader-badge ${leaderTone(leader.grade)}">${Number.isFinite(leader.score) ? `${leader.grade} ${leader.score}` : "계산불가"}</span></td>
      <td><b>${pct(scout.drawdownFromHighPct)}</b></td>
      <td><b class="${Number(scout.riskScore ?? 100) <= 35 ? "good-score" : Number(scout.riskScore ?? 100) >= 65 ? "bad-score" : ""}">${scout.riskScore ?? "-"}</b></td>
      <td><b class="${Number(scout.stabilizeScore ?? 0) >= 65 ? "good-score" : ""}">${scout.stabilizeScore ?? "-"}</b></td>
      <td><div class="score-pill ${scoreTone(supply.liquidityScore ?? 0)}">${supply.liquidityScore ?? 0}</div><div class="cell-sub supply-compact">외 ${signedEok(supply.foreignNetAmount)} · 기 ${signedEok(supply.instNetAmount)}</div></td>
      <td><b>${combined.score ?? 0}</b><div class="cell-sub">${combined.label ?? "관망"}</div></td>
      <td><span class="badge judge-badge ${scoutStatusTone(row)}" title="${scoutStatusLabel(scout.status)}"><i class="judge-full">${scoutStatusLabel(scout.status)}</i><i class="judge-short">${scoutStatusShort(scout.status)}</i></span><div class="cell-sub">현재 타이밍 ${combined.label ?? "관망"}</div></td>
    </tr>`;
  }).join("") || `<tr><td colspan="10" class="loading">조건에 맞는 종목이 없습니다.</td></tr>`;
}

function explorerTableHeader() {
  return `<thead><tr>
    <th><button class="sort-btn" data-screener-sort-field="rank" type="button" title="${TIER_TOOLTIP}">순위 <span data-screener-sort-icon="rank">↕</span></button></th><th>종목</th>
    <th><button class="sort-btn" data-screener-sort-field="rs20" type="button" title="${RS20_TOOLTIP}">RS <span data-screener-sort-icon="rs20">↕</span></button></th>
    <th><button class="sort-btn" data-screener-sort-field="leader" type="button">주도 <span data-screener-sort-icon="leader">↕</span></button></th>
    <th><button class="sort-btn" data-screener-sort-field="drawdown" type="button">낙폭 <span data-screener-sort-icon="drawdown">↕</span></button></th>
    <th><button class="sort-btn" data-screener-sort-field="risk" type="button">Risk <span data-screener-sort-icon="risk">↕</span></button></th>
    <th><button class="sort-btn" data-screener-sort-field="stabilize" type="button">Stab <span data-screener-sort-icon="stabilize">↕</span></button></th>
    <th><button class="sort-btn" data-screener-sort-field="liquidity" type="button">거래강도 <span data-screener-sort-icon="liquidity">↕</span></button></th>
    <th><button class="sort-btn" data-screener-sort-field="timing" type="button">타이밍 <span data-screener-sort-icon="timing">↕</span></button></th>
    <th>판정</th>
  </tr></thead>`;
}

function renderMarketSection(market) {
  const rows = explorerRows(market);
  return `<section class="market-ranking-section ${market.toLowerCase()}" data-market="${market}">
    <header class="market-ranking-header"><h3>${market}</h3><span>시장 내 독립 순위 · ${rows.length}종목</span></header>
    <div class="mobile-screener" aria-label="${market} 모바일 종목 순위"><div class="explorer-mobile-list">${renderExplorerMobile(rows, market)}</div></div>
    <div class="table-wrap screener-wrap"><table class="screener-table explorer-table">${explorerTableHeader()}<tbody>${renderExplorerRows(rows)}</tbody></table></div>
  </section>`;
}

function renderUnifiedExplorer() {
  if (state.screenerLoading) return;
  const counts = Object.fromEntries(["KOSPI", "KOSDAQ"].map((market) => [market, explorerRows(market).length]));
  document.querySelector("#screenerMarkets").innerHTML = ["KOSPI", "KOSDAQ"].map(renderMarketSection).join("");
  renderExplorerSortState();
  const asOf = state.screener?.asOf ? new Date(state.screener.asOf).toLocaleString("ko-KR") : "-";
  const allCount = (state.screener?.rows?.KOSPI?.length ?? 0) + (state.screener?.rows?.KOSDAQ?.length ?? 0);
  const errorText = state.screener?.errors?.length ? ` · 일부 실패 ${state.screener.errors.length}건` : "";
  const cloud = state.screener?.cloud;
  const modeText = cloud?.dataMode === "INTRADAY_PARTIAL" ? " · 장중 시세/확정랭킹 혼합" : (cloud?.dataMode === "EOD_FULL" ? " · 장마감 확정" : "");
  const refreshText = state.backgroundRefresh?.status === "running" || cloud?.refreshStatus === "running" ? " · 백그라운드 갱신 중" : "";
  const staleText = cloud?.lastError && cloud?.refreshStatus === "error" ? " · 최근 갱신 실패, 기존 정상 데이터 표시 중" : "";
  document.querySelector("#screenerStatus").textContent = `KOSPI ${counts.KOSPI} · KOSDAQ ${counts.KOSDAQ} 표시 · 두 시장 ${allCount}종목 준비됨 · ${asOf}${modeText}${refreshText}${staleText}${errorText}`;
  document.querySelector("#screenerStatus").dataset.fetchCount = String(state.screenerFetchCount);
}

function filteredRows() {
  const query = state.query.trim().toLowerCase();
  const rows = state.snapshot.rows.filter((row) => {
    const matchesFilter = state.filter === "all" || row.tone === state.filter || (state.filter === "h3" && row.strategy?.flags?.H3);
    const matchesQuery = !query || row.name.toLowerCase().includes(query) || row.code.includes(query);
    return matchesFilter && matchesQuery;
  });
  return sortHoldingRows(rows);
}

function setHoldingFilter(filter) {
  state.filter = filter;
  document.querySelectorAll("#tabs button").forEach((item) => item.classList.toggle("active", item.dataset.filter === filter));
  renderTable();
}

function setScreenerFilter(filter) {
  state.screenerFilter = state.screenerFilter === filter && filter !== "all" ? "all" : filter;
  renderScreener();
}

function sortHoldingRows(rows) {
  const [field, direction] = state.holdingSort.split("-");
  const multiplier = direction === "asc" ? 1 : -1;
  const valueOf = (row) => {
    if (field === "value") return row.value ?? 0;
    if (field === "price") return row.price ?? 0;
    if (field === "liquidity") return row.supply?.liquidityScore ?? 0;
    if (field === "pnl") return row.pnlPct ?? 0;
    return row.priority ?? 0;
  };
  return [...rows].sort((a, b) => {
    const diff = valueOf(a) - valueOf(b);
    if (diff !== 0) return diff * multiplier;
    return (b.value ?? 0) - (a.value ?? 0);
  });
}

function setHoldingSort(field) {
  const [currentField, currentDirection] = state.holdingSort.split("-");
  const nextDirection = currentField === field && currentDirection === "desc" ? "asc" : "desc";
  state.holdingSort = `${field}-${nextDirection}`;
  renderTable();
}

function renderHoldingSortState() {
  const [field, direction] = state.holdingSort.split("-");
  document.querySelectorAll("[data-sort-field]").forEach((button) => {
    const active = button.dataset.sortField === field;
    button.classList.toggle("active", active);
    button.setAttribute("aria-sort", active ? (direction === "desc" ? "descending" : "ascending") : "none");
  });
  document.querySelectorAll("[data-sort-icon]").forEach((icon) => {
    const active = icon.dataset.sortIcon === field;
    icon.textContent = active ? (direction === "desc" ? "↓" : "↑") : "↕";
  });
}

function renderTable() {
  const rows = filteredRows();
  renderHoldingSortState();
  document.querySelector("#holdings").innerHTML = rows.map((row) => {
    const tone = actionTone(row.action);
    const reasons = row.reasons.length ? row.reasons : ["조건 미충족"];
    const liquidity = liquidityDisplay(row);
    return `
      <tr>
        <td><span class="badge ${tone}">${row.action}</span></td>
        <td>
          <a class="stock-name stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a>
          <div class="code">${row.code} · ${row.strategy.grade} · ${row.strategy.horizon}</div>
          ${renderDataBadges(row)}
        </td>
        <td>
          <div class="money-main">${won(row.value)}</div>
          <div class="cell-sub">${qty(row.qty)} · 평균 ${won(row.avgPrice)}</div>
        </td>
        <td>
          <div class="money-main">${price(row.price)}</div>
          <div class="price-change ${toneClass(dayChangeValue(row) ?? 0)}">전일 ${pct(dayChangeValue(row))}</div>
          <div class="price-change small ${toneClass(row.strategy.change3dPct ?? 0)}">3일 ${pct(row.strategy.change3dPct)}</div>
        </td>
        <td class="${toneClass(row.pnl)}">
          <div class="money-main">${pct(row.pnlPct)}</div>
          <div class="cell-sub ${toneClass(row.pnl)}">${won(row.pnl)}</div>
        </td>
        <td>
          <div class="score-pill ${liquidity.tone}">${liquidity.value}</div>
          <div class="cell-sub">${row.supply.usesFreeFloat ? "유통" : "시총"}회전 ${pct(row.supply.bodyTurnoverPct)}</div>
          <div class="cell-sub">폭증 ${row.supply.tradingValueRatio20 === null ? "-" : `${fmtNum.format(row.supply.tradingValueRatio20)}배`}</div>
          <div class="cell-sub">3일 ${pct(row.strategy.change3dPct)}</div>
        </td>
        <td>
          <div class="supply-lines">
            <span>외 ${eok(row.supply.foreignNetAmount)}</span>
            <span>기 ${eok(row.supply.instNetAmount)}</span>
            <span>프 ${eok(row.supply.programNetAmount)}</span>
          </div>
          <div class="streak-badge ${streakClass(row)}">연속 외 ${row.supply.foreignStreak}일 · 기 ${row.supply.instStreak}일</div>
          <div class="cell-sub">외/기관 기준 ${ymd(row.investor?.latestInvestorDate)}</div>
          <div class="cell-sub">5일 외 ${eok(row.investor?.foreignNetAmount5d ?? 0)} · 기 ${eok(row.investor?.instNetAmount5d ?? 0)}</div>
          <div class="cell-sub">큰손 ${pct(row.supply.smartMoneyBodyPct)} · 주도 ${pct(row.supply.smartMoneyTradingSharePct)}</div>
        </td>
        <td>
          <div class="money-main">${row.trend} · RSI ${row.indicators.synthetic || row.indicators.rsi14 === null ? "-" : fmtNum.format(row.indicators.rsi14)}</div>
          <div class="cell-sub">체결 ${row.supply.strength ? fmtNum.format(row.supply.strength) : "-"} · R2 ${row.supply.pivotGapPct === null ? "-" : pct(row.supply.pivotGapPct)}</div>
          <div class="cell-sub">${row.strategy.vwapRecovered ? "VWAP 위" : "VWAP 아래"} · ${row.strategy.bullishTurn ? "양봉" : "음봉"}</div>
          <div class="cell-sub">손절 ${price(row.riskPlan?.stopLoss)} · 익절 ${price(row.riskPlan?.takeProfit1)}</div>
        </td>
        <td>
          <div class="judgement-line">${shortJudgement(row)}</div>
          <div class="reason-list">${reasons.map((reason) => `<span class="reason">${reason}</span>`).join("")}</div>
        </td>
      </tr>
    `;
  }).join("") || `<tr><td colspan="9" class="loading">조건에 맞는 종목이 없습니다.</td></tr>`;
}

function render() {
  const { summary, source, asOf, errors } = state.snapshot;
  renderMetrics(summary);
  renderActions(summary);
  renderTodayTrades(summary);
  renderThemes(summary);
  renderTable();
  const valuationMarket = state.snapshot.accountSummary?.valuationMarket;
  const repriceText = valuationMarket ? ` · ${valuationMarketLabel(valuationMarket)}` : "";
  const sourceText = source === "kis-balance" ? `한국투자 실계좌 잔고${repriceText}` : (source === "kis" ? "한국투자 Open API · 스크린샷 보유 기준" : "스크린샷 기준 기본 데이터");
  const errText = errors?.length ? ` · 일부 실패 ${errors.length}건` : "";
  const judalText = state.snapshot.judal?.source === "judal" ? " · 주달 연속순매수 참고" : "";
  const cloud = state.snapshot.cloud;
  const modeText = cloud?.dataMode === "INTRADAY_PARTIAL" ? " · 장중 부분갱신" : (cloud?.dataMode === "EOD_FULL" ? " · 장마감 확정" : "");
  const refreshText = cloud?.refreshStatus === "running" ? " · 백그라운드 갱신 중" : "";
  const staleText = cloud?.lastError && cloud?.refreshStatus === "error" ? " · 최근 갱신 실패, 기존 정상 데이터 표시 중" : "";
  document.querySelector("#sourceLabel").textContent = `${sourceText}${judalText} · 데이터 기준 ${new Date(asOf).toLocaleString("ko-KR")}${modeText}${refreshText}${staleText}${errText}`;
}

document.querySelector("#refreshBtn").addEventListener("click", async () => {
  await loadMarketScreener(true);
  await loadSnapshot(true);
});
document.querySelector("#fallbackBtn").addEventListener("click", () => {
  state.live = !state.live;
  document.querySelector("#fallbackBtn").textContent = state.live ? "스크린샷 기준" : "실시간 시도";
  loadSnapshot();
});
document.querySelector("#search").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderTable();
});
document.querySelectorAll("[data-sort-field]").forEach((button) => {
  button.addEventListener("click", () => setHoldingSort(button.dataset.sortField));
});
document.querySelector("#screenerMarkets").addEventListener("click", (event) => {
  const button = event.target.closest("[data-screener-sort-field]");
  if (button) setExplorerSort(button.dataset.screenerSortField);
});
document.querySelector("#tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  setHoldingFilter(button.dataset.filter);
});
document.querySelector("#explorerModes").addEventListener("click", (event) => {
  const button = event.target.closest("[data-explorer-mode]");
  if (!button) return;
  state.explorerMode = button.dataset.explorerMode;
  state.screenerSort = null;
  document.querySelectorAll("#explorerModes button").forEach((item) => item.classList.toggle("active", item === button));
  renderUnifiedExplorer();
});
document.querySelector("#screenerSearch").addEventListener("input", (event) => {
  state.screenerQuery = event.target.value;
  renderUnifiedExplorer();
});
document.querySelector("#screenerRefresh").addEventListener("click", () => loadMarketScreener(true));

loadMarketScreener().finally(() => loadSnapshot());
