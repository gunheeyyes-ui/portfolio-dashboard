import { rankMarketRowsV2 } from "./rebound-ranking-v2.js";

const state = {
  market: "ALL",
  payload: null,
  rows: []
};

const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function pct(value) {
  if (!finite(value)) return "-";
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${number.format(n)}%`;
}

function price(value) {
  return finite(value) ? `${integer.format(Math.round(Number(value)))}원` : "-";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function naverStockUrl(code) {
  return `https://stock.naver.com/domestic/stock/${code}/price`;
}

function rs20(row) {
  return finite(row?.scout?.rs20) ? Number(row.scout.rs20) : null;
}

function leaderRank(row) {
  return finite(row?.leader?.score) && finite(row?.leader?.rank) ? Number(row.leader.rank) : null;
}

function timingRank(row) {
  return finite(row?.combined?.rank) ? Number(row.combined.rank) : null;
}

function scoutRank(row) {
  return finite(row?.scout?.reboundRank) ? Number(row.scout.reboundRank) : null;
}

function buildContexts(payload) {
  const contexts = [];
  for (const market of ["KOSPI", "KOSDAQ"]) {
    const rows = payload?.rows?.[market] ?? [];
    const rankingV2 = new Map(rankMarketRowsV2(rows).map((row, index) => [String(row.code), index + 1]));
    const rsOrder = rows
      .filter((row) => finite(rs20(row)))
      .slice()
      .sort((a, b) => Number(rs20(b)) - Number(rs20(a)) || String(a.code).localeCompare(String(b.code)));
    const rsRanks = new Map(rsOrder.map((row, index) => [String(row.code), index + 1]));

    for (const row of rows) {
      contexts.push({
        row,
        market,
        leaderRank: leaderRank(row),
        rsRank: rsRanks.get(String(row.code)) ?? null,
        rankingV2Rank: rankingV2.get(String(row.code)) ?? null,
        timingRank: timingRank(row),
        scoutRank: scoutRank(row),
        actionable: row?.simCategory?.actionable === true
      });
    }
  }
  return contexts;
}

const FEATURED = [
  { id: "LEADER_TOP3", label: "Leader TOP3", test: (c) => finite(c.leaderRank) && c.leaderRank <= 3 },
  { id: "LEADER_TOP10", label: "Leader TOP10", test: (c) => finite(c.leaderRank) && c.leaderRank <= 10 },
  { id: "RS_TOP10", label: "RS TOP10", test: (c) => finite(c.rsRank) && c.rsRank <= 10 },
  { id: "LEADER_A_AND_RS80", label: "Leader A+RS80", test: (c) => c.row?.leader?.grade === "A" && finite(rs20(c.row)) && rs20(c.row) >= 80 },
  { id: "LEADER_A_AND_RS80_AND_ACTIONABLE", label: "A+RS80+진입", test: (c) => c.row?.leader?.grade === "A" && finite(rs20(c.row)) && rs20(c.row) >= 80 && c.actionable },
  { id: "ACTIONABLE_ALL", label: "진입후보", test: (c) => c.actionable },
  { id: "FLAG_F2", label: "F2", test: (c) => c.row?.strategy?.flags?.F2 === true },
  { id: "TIMING_TOP10", label: "타이밍 TOP10", test: (c) => finite(c.timingRank) && c.timingRank <= 10 },
  { id: "RANKING_V2_TOP10", label: "반등우선 TOP10", test: (c) => finite(c.rankingV2Rank) && c.rankingV2Rank <= 10 },
  { id: "SCOUT_TOP10", label: "반등후보 TOP10", test: (c) => finite(c.scoutRank) && c.scoutRank <= 10 },
  { id: "CAFE", label: "CAFE", test: (c) => c.row?.confirmation?.cafePass === true },
  { id: "MTT", label: "MTT", test: (c) => c.row?.confirmation?.minerviniPass === true },
  { id: "CAFE_AND_ACTIONABLE", label: "CAFE+진입", test: (c) => c.row?.confirmation?.cafePass === true && c.actionable },
  { id: "MTT_AND_ACTIONABLE", label: "MTT+진입", test: (c) => c.row?.confirmation?.minerviniPass === true && c.actionable }
];

const SIGNAL_KEYS = ["R", "F", "F2", "B", "H2", "H3"];

function decorate(context) {
  const featured = FEATURED.filter((strategy) => strategy.test(context));
  const flags = context.row?.strategy?.flags ?? {};
  const signals = SIGNAL_KEYS.filter((key) => flags[key] === true);
  return { ...context, featured, signals };
}

function renderCard(item) {
  const row = item.row;
  const strategyBadges = item.featured.map((strategy) => `<span class="strategy-badge buy" title="${escapeHtml(strategy.id)}">${escapeHtml(strategy.label)}</span>`).join("");
  const signalBadges = item.signals
    .filter((key) => key !== "F2" || !item.featured.some((strategy) => strategy.id === "FLAG_F2"))
    .map((key) => `<span class="strategy-badge">${key}</span>`).join("");
  const caution = row?.strategy?.flags?.I ? '<span class="strategy-badge danger">I 매수보류</span>' : "";
  const category = row?.simCategory?.label ?? "관망";
  const leader = finite(row?.leader?.score) ? `${row.leader.grade ?? "-"} ${number.format(row.leader.score)}` : "-";
  const rs = rs20(row);
  return `
    <article class="sim-card ${item.actionable ? "buy" : "hold"}">
      <div class="sim-card-head">
        <span class="badge ${item.actionable ? "buy" : "hold"}">${item.featured.length}전략</span>
        <small>${item.market} · ${escapeHtml(category)}</small>
      </div>
      <a class="stock-link sim-name" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.name)}</a>
      <div class="cell-sub">${escapeHtml(row.code)} · ${price(row.price ?? row.quote?.price)} · 당일 ${pct(row.changeRate ?? row.quote?.changeRate)}</div>
      <div class="sim-mini">
        <span>Leader <b>${escapeHtml(leader)}</b></span>
        <span>RS20 <b>${finite(rs) ? integer.format(rs) : "-"}</b></span>
        <span>타이밍 <b>${finite(row?.combined?.score) ? integer.format(row.combined.score) : "-"}</b></span>
        <span>Risk/Stab <b>${finite(row?.scout?.riskScore) ? integer.format(row.scout.riskScore) : "-"}/${finite(row?.scout?.stabilizeScore) ? integer.format(row.scout.stabilizeScore) : "-"}</b></span>
      </div>
      <div class="strategy-badges">${strategyBadges}${signalBadges}${caution}</div>
    </article>`;
}

function filteredRows() {
  return state.rows
    .filter((item) => state.market === "ALL" || item.market === state.market)
    .sort((a, b) => b.featured.length - a.featured.length
      || Number(b.actionable) - Number(a.actionable)
      || (a.leaderRank ?? 9999) - (b.leaderRank ?? 9999)
      || String(a.row.name ?? "").localeCompare(String(b.row.name ?? "")));
}

function render() {
  const rows = filteredRows();
  const target = document.querySelector("#strategyCandidateList");
  const status = document.querySelector("#strategyCandidateStatus");
  if (!target || !status) return;

  const featuredHits = rows.reduce((sum, item) => sum + item.featured.length, 0);
  status.textContent = `대표 14전략 또는 R/F/B/H2/H3 신호에 걸린 ${rows.length}종목 · 전략 매칭 ${featuredHits}건 · 가상매수는 기존 진입후보만`;
  target.innerHTML = rows.length
    ? rows.map(renderCard).join("")
    : '<article class="trade-empty"><strong>현재 전략 후보 없음</strong><span>대표 전략 또는 주요 신호에 해당하는 종목이 없습니다.</span></article>';
}

async function load() {
  const status = document.querySelector("#strategyCandidateStatus");
  const target = document.querySelector("#strategyCandidateList");
  if (!status || !target) return;
  status.textContent = "오늘 스크리너에서 전략 후보를 계산 중입니다.";
  target.innerHTML = '<article class="trade-empty"><strong>계산 중</strong><span>기존 시장 스크리너 데이터를 재사용합니다.</span></article>';
  const response = await fetch("/api/market-screener?limit=100&market=ALL", { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "전략 후보군을 불러오지 못했습니다.");
  state.payload = await response.json();
  state.rows = buildContexts(state.payload)
    .map(decorate)
    .filter((item) => item.featured.length > 0 || item.signals.length > 0);
  render();
}

document.querySelector("#strategyCandidateMarkets")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-strategy-market]");
  if (!button) return;
  state.market = button.dataset.strategyMarket;
  document.querySelectorAll("#strategyCandidateMarkets button").forEach((item) => item.classList.toggle("active", item === button));
  render();
});

document.querySelector("#strategyCandidateRefresh")?.addEventListener("click", () => load().catch((error) => {
  document.querySelector("#strategyCandidateStatus").textContent = error.message;
}));

load().catch((error) => {
  document.querySelector("#strategyCandidateStatus").textContent = error.message;
  document.querySelector("#strategyCandidateList").innerHTML = `<article class="trade-empty"><strong>불러오기 실패</strong><span>${escapeHtml(error.message)}</span></article>`;
});
