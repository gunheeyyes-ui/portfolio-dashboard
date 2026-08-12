const state = { data: null, filter: "all", market: "ALL", query: "" };
const fmtNum = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

const pct = (value) => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? "+" : ""}${fmtNum.format(value)}%` : "-";
const price = (value) => Number(value) > 0 ? `${fmtInt.format(Math.round(value))}원` : "-";
const naverStockUrl = (code) => `https://stock.naver.com/domestic/stock/${code}/price`;

function gradeClass(grade) {
  if (grade === "A") return "buy";
  if (grade === "B") return "hold";
  if (grade === "D" || grade === "계산불가") return "danger";
  return "muted";
}

function strategyBadges(row) {
  return (row.confirmation?.badges ?? []).map((label) => `<span class="strategy-badge ${label === "실험: 낙주" ? "hold" : "buy"}">${label}</span>`).join("");
}

function matches(row) {
  const signal = row.confirmation ?? {};
  const query = state.query.trim().toLowerCase();
  if (state.market !== "ALL" && row.market !== state.market) return false;
  if (query && !row.name.toLowerCase().includes(query) && !row.code.includes(query)) return false;
  if (state.filter === "cafe") return signal.cafePass;
  if (state.filter === "mtt") return signal.minerviniPass;
  if (state.filter === "leader-rebound") return signal.leaderReboundPass;
  if (state.filter === "cafe-mtt") return signal.cafeAndMtt;
  if (state.filter === "nakju") return signal.experimentalNakjuPass;
  return signal.badges?.length > 0;
}

function rows() {
  const all = [...(state.data?.rows?.KOSPI ?? []), ...(state.data?.rows?.KOSDAQ ?? [])];
  return all.filter(matches).sort((a, b) => Number(b.confirmation?.leaderReboundPass) - Number(a.confirmation?.leaderReboundPass)
    || Number(b.confirmation?.cafeAndMtt) - Number(a.confirmation?.cafeAndMtt)
    || Number(a.scout?.riskScore ?? 100) - Number(b.scout?.riskScore ?? 100)
    || Number(b.scout?.stabilizeScore ?? 0) - Number(a.scout?.stabilizeScore ?? 0)
    || Number(b.combined?.score ?? 0) - Number(a.combined?.score ?? 0));
}

function renderMetrics() {
  const summary = state.data?.strategySummary?.all ?? {};
  const cards = [
    ["카페 눌림", summary.cafe ?? 0, "기술+수급 프록시"],
    ["MTT", summary.mtt ?? 0, "장기 추세 템플릿"],
    ["Leader반등", summary.leaderRebound ?? 0, "A + 하락정지 + 저위험"],
    ["CAFE+MTT", summary.cafeMtt ?? 0, "두 전략 동시 통과"]
  ];
  document.querySelector("#strategyMetrics").innerHTML = cards.map(([label, value, sub]) => `<article class="metric"><div class="label">${label}</div><div class="value">${value}개</div><div class="sub">${sub}</div></article>`).join("");
}

function render() {
  const visible = rows();
  const total = (state.data?.strategySummary?.all?.count ?? 0);
  const asOf = state.data?.asOf ? new Date(state.data.asOf).toLocaleString("ko-KR") : "-";
  document.querySelector("#strategyStatus").textContent = `실시간 Universe ${total}개 중 전략 통과 ${visible.length}개 · ${asOf}`;
  renderMetrics();
  document.querySelector("#strategyCards").innerHTML = visible.map((row) => `
    <article class="strategy-card">
      <div><span class="market-chip ${row.market.toLowerCase()}">${row.market}</span><a class="stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a></div>
      <div class="strategy-card-values"><span>${price(row.price)} <b>${pct(row.changeRate)}</b></span><span>종합 <b>${row.combined?.score ?? "-"}</b></span><span>Leader <b>${row.leader?.grade ?? "-"}</b></span><span>정지 <b>${row.scout?.stabilizeScore ?? "-"}</b></span><span>Risk <b>${row.scout?.riskScore ?? "-"}</b></span><span>거래 <b>${row.supply?.liquidityScore ?? 0}</b></span></div>
      <div class="strategy-badges">${strategyBadges(row)}</div>
    </article>
  `).join("") || `<div class="loading">선택한 조건을 통과한 종목이 없습니다.</div>`;
  document.querySelector("#strategyRows").innerHTML = visible.map((row) => {
    const rebound = row.confirmation?.reboundState ?? {};
    return `<tr>
      <td><a class="stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a><div class="cell-sub">${row.code}</div></td>
      <td><span class="market-chip ${row.market.toLowerCase()}">${row.market}</span></td>
      <td><b>${price(row.price)}</b><div class="cell-sub">전일 ${pct(row.changeRate)} · 3일 ${pct(row.changeRate3d)}</div></td>
      <td><b>${row.combined?.score ?? "-"}</b><div class="cell-sub">${row.combined?.label ?? "관망"}</div></td>
      <td><span class="leader-badge ${gradeClass(row.leader?.grade)}">${row.leader?.grade ?? "-"}</span></td>
      <td><b>${pct(row.scout?.drawdownFromHighPct)}</b></td>
      <td><b>${row.scout?.stabilizeScore ?? "-"}</b></td>
      <td><b>${row.scout?.riskScore ?? "-"}</b></td>
      <td><b>${row.supply?.liquidityScore ?? 0}</b></td>
      <td><div class="strategy-badges">${strategyBadges(row)}</div></td>
      <td><span class="badge ${rebound.tone ?? "hold"}">${rebound.label ?? "관찰"}</span></td>
    </tr>`;
  }).join("") || `<tr><td colspan="11" class="loading">선택한 조건을 통과한 종목이 없습니다.</td></tr>`;
}

async function load(force = false) {
  document.querySelector("#strategyStatus").textContent = "KOSPI·KOSDAQ 전략 조건 계산 중입니다.";
  const response = await fetch(`/api/strategies?market=ALL&limit=100${force ? `&t=${Date.now()}` : ""}`, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error((await response.json()).error ?? "strategies failed");
  state.data = await response.json();
  render();
}

document.querySelector("#strategyFilters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-strategy-filter]");
  if (!button) return;
  state.filter = button.dataset.strategyFilter;
  document.querySelectorAll("#strategyFilters button").forEach((item) => item.classList.toggle("active", item === button));
  render();
});
document.querySelector("#strategyMarkets").addEventListener("click", (event) => {
  const button = event.target.closest("[data-strategy-market]");
  if (!button) return;
  state.market = button.dataset.strategyMarket;
  document.querySelectorAll("#strategyMarkets button").forEach((item) => item.classList.toggle("active", item === button));
  render();
});
document.querySelector("#strategySearch").addEventListener("input", (event) => { state.query = event.target.value; render(); });
document.querySelector("#refreshBtn").addEventListener("click", () => load(true).catch((error) => document.querySelector("#strategyStatus").textContent = error.message));

load().catch((error) => {
  document.querySelector("#strategyStatus").textContent = error.message;
  document.querySelector("#strategyRows").innerHTML = `<tr><td colspan="11" class="loading">${error.message}</td></tr>`;
});
