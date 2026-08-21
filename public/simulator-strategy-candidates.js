import {
  buildStrategyCandidates,
  strategyCatalogInfo
} from "./strategy-candidate-engine.js";

const state = {
  market: "ALL",
  mode: "featured",
  filter: "all",
  payload: null,
  rows: [],
  catalog: strategyCatalogInfo()
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

function viewFor(item) {
  const strategies = state.mode === "all" ? item.matches : item.featuredMatches;
  const axes = state.mode === "all" ? item.axesAll : item.axesFeatured;
  return { strategies, axes };
}

function hasLeaderRs(axes) {
  const ids = new Set(axes.map((axis) => axis.id));
  return ids.has("leader") && ids.has("rs");
}

function hasCafeMtt(item) {
  return item.matches.some((strategy) => /CAFE|MTT/.test(strategy.id));
}

function passesFilter(item, view) {
  if (state.filter === "five") return view.strategies.length >= 5;
  if (state.filter === "three-axes") return view.axes.length >= 3;
  if (state.filter === "five-three") return view.strategies.length >= 5 && view.axes.length >= 3;
  if (state.filter === "four-actionable") return view.axes.length >= 4 && item.feature.actionable === true;
  if (state.filter === "leader-rs-three") return view.axes.length >= 3 && hasLeaderRs(view.axes);
  if (state.filter === "actionable") return item.feature.actionable === true;
  if (state.filter === "leader-rs") return hasLeaderRs(view.axes);
  if (state.filter === "confirm") return hasCafeMtt(item);
  return true;
}

function renderStrategyBadges(strategies) {
  const first = strategies.slice(0, state.mode === "all" ? 10 : strategies.length);
  const rest = strategies.slice(first.length);
  const badge = (strategy) => `<span class="strategy-badge buy" title="${escapeHtml(strategy.id)} · ${escapeHtml(strategy.description)}">${escapeHtml(strategy.displayName)}</span>`;
  const firstHtml = first.map(badge).join("");
  if (!rest.length) return firstHtml;
  return `${firstHtml}<details class="strategy-more"><summary>+${rest.length}개 전략 더보기</summary><div class="strategy-badges">${rest.map(badge).join("")}</div></details>`;
}

function renderCard(item) {
  const row = item.row;
  const feature = item.feature;
  const view = viewFor(item);
  const matchIds = new Set(view.strategies.map((strategy) => strategy.id));
  const signalBadges = item.signals
    .filter((key) => !matchIds.has(`FLAG_${key}`))
    .map((key) => `<span class="strategy-badge">${key}</span>`).join("");
  const caution = feature.flags?.I ? '<span class="strategy-badge danger">I 매수보류</span>' : "";
  const category = feature.simCategoryLabel ?? "관망";
  const leader = finite(feature.leaderScore) ? `${feature.leaderGrade ?? "-"} ${number.format(feature.leaderScore)}` : "-";
  const axisText = view.axes.length ? view.axes.map((axis) => axis.label).join(" · ") : "대표 계열 없음";
  const countText = view.strategies.length
    ? `${view.strategies.length}전략 · ${view.axes.length}계열`
    : "주요신호";

  return `
    <article class="sim-card ${feature.actionable ? "buy" : "hold"}">
      <div class="sim-card-head">
        <span class="badge ${feature.actionable ? "buy" : "hold"}">${countText}</span>
        <small>${feature.market} · ${escapeHtml(category)}</small>
      </div>
      <a class="stock-link sim-name" href="${naverStockUrl(feature.code)}" target="_blank" rel="noopener noreferrer">${escapeHtml(feature.name)}</a>
      <div class="cell-sub">${escapeHtml(feature.code)} · ${price(feature.signalPrice)} · 당일 ${pct(row.changeRate ?? row.quote?.changeRate)}</div>
      <div class="sim-mini">
        <span>Leader <b>${escapeHtml(leader)}</b></span>
        <span>RS20 <b>${finite(feature.rs20) ? integer.format(feature.rs20) : "-"}</b></span>
        <span>타이밍 <b>${finite(feature.combinedScore) ? integer.format(feature.combinedScore) : "-"}</b></span>
        <span>Risk/Stab <b>${finite(feature.riskScore) ? integer.format(feature.riskScore) : "-"}/${finite(feature.stabilizeScore) ? integer.format(feature.stabilizeScore) : "-"}</b></span>
      </div>
      <div class="cell-sub"><b>독립 합의</b> ${escapeHtml(axisText)}</div>
      <div class="strategy-badges">${renderStrategyBadges(view.strategies)}${signalBadges}${caution}</div>
    </article>`;
}

function filteredRows() {
  return state.rows
    .map((item) => ({ item, view: viewFor(item) }))
    .filter(({ item, view }) => {
      if (state.market !== "ALL" && item.feature.market !== state.market) return false;
      const hasVisibleSignal = item.signals.length > 0;
      if (!view.strategies.length && state.mode === "featured" && !hasVisibleSignal) return false;
      return passesFilter(item, view);
    })
    .sort((a, b) => b.view.strategies.length - a.view.strategies.length
      || b.view.axes.length - a.view.axes.length
      || Number(b.item.feature.actionable) - Number(a.item.feature.actionable)
      || (a.item.feature.leaderRank ?? 9999) - (b.item.feature.leaderRank ?? 9999)
      || String(a.item.feature.name ?? "").localeCompare(String(b.item.feature.name ?? "")));
}

function updateControlLabels() {
  const featured = document.querySelector('[data-strategy-mode="featured"]');
  const all = document.querySelector('[data-strategy-mode="all"]');
  if (featured) featured.textContent = `대표 ${state.catalog.featuredCount}`;
  if (all) all.textContent = `전체 ${state.catalog.allCount}`;
}

function render() {
  const rows = filteredRows();
  const target = document.querySelector("#strategyCandidateList");
  const status = document.querySelector("#strategyCandidateStatus");
  if (!target || !status) return;

  const totalMatches = rows.reduce((sum, { view }) => sum + view.strategies.length, 0);
  const threeAxisCount = rows.filter(({ view }) => view.axes.length >= 3).length;
  const modeLabel = state.mode === "all" ? `전체 ${state.catalog.allCount}` : `대표 ${state.catalog.featuredCount}`;
  status.textContent = `${modeLabel} 기준 · ${rows.length}종목 · 전략 매칭 ${totalMatches}건 · 3계열+ ${threeAxisCount}종목 · 가상매수는 기존 실제 진입후보만`;
  target.innerHTML = rows.length
    ? rows.map(({ item }) => renderCard(item)).join("")
    : '<article class="trade-empty"><strong>조건에 맞는 후보 없음</strong><span>시장·전략 보기·필터를 바꿔 확인해 보세요.</span></article>';
}

async function load() {
  const status = document.querySelector("#strategyCandidateStatus");
  const target = document.querySelector("#strategyCandidateList");
  if (!status || !target) return;
  status.textContent = "중앙 전략 Registry 기준으로 오늘 후보를 계산 중입니다.";
  target.innerHTML = '<article class="trade-empty"><strong>계산 중</strong><span>기존 시장 스크리너 데이터를 재사용하며 추가 KIS 호출은 하지 않습니다.</span></article>';
  const response = await fetch("/api/market-screener?limit=100&market=ALL", { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "전략 후보군을 불러오지 못했습니다.");
  state.payload = await response.json();
  state.rows = buildStrategyCandidates(state.payload);
  updateControlLabels();
  render();
}

function activateButtons(selector, activeButton) {
  document.querySelectorAll(selector).forEach((button) => button.classList.toggle("active", button === activeButton));
}

document.querySelector("#strategyCandidateMarkets")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-strategy-market]");
  if (!button) return;
  state.market = button.dataset.strategyMarket;
  activateButtons("#strategyCandidateMarkets button", button);
  render();
});

document.querySelector("#strategyCandidateModes")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-strategy-mode]");
  if (!button) return;
  state.mode = button.dataset.strategyMode;
  activateButtons("#strategyCandidateModes button", button);
  render();
});

document.querySelector("#strategyCandidateFilters")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-strategy-filter]");
  if (!button) return;
  state.filter = button.dataset.strategyFilter;
  activateButtons("#strategyCandidateFilters button", button);
  render();
});

document.querySelector("#strategyCandidateRefresh")?.addEventListener("click", () => load().catch((error) => {
  document.querySelector("#strategyCandidateStatus").textContent = error.message;
}));

updateControlLabels();
load().catch((error) => {
  document.querySelector("#strategyCandidateStatus").textContent = error.message;
  document.querySelector("#strategyCandidateList").innerHTML = `<article class="trade-empty"><strong>불러오기 실패</strong><span>${escapeHtml(error.message)}</span></article>`;
});
