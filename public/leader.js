const state = {
  data: null,
  query: "",
  sortKey: "score",
  sortDirection: "desc"
};

const MARKETS = ["KOSPI", "KOSDAQ"];
const fmtNum = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

function pct(value) {
  if (!Number.isFinite(Number(value))) return "-";
  return `${Number(value) >= 0 ? "+" : ""}${fmtNum.format(value)}%`;
}

function price(value) {
  return Number.isFinite(Number(value)) ? `${fmtInt.format(Math.round(value))}원` : "-";
}

function naverStockUrl(code) {
  return `https://stock.naver.com/domestic/stock/${code}/price`;
}

function gradeClass(grade) {
  if (grade === "A") return "buy";
  if (grade === "B") return "hold";
  if (grade === "D" || grade === "계산불가") return "danger";
  return "muted";
}

function strategyBadges(row) {
  return (row.confirmation?.badges ?? []).map((label) => `<span class="strategy-badge ${label === "실험: 낙주" ? "hold" : "buy"}">${label}</span>`).join("");
}

function reboundLabel(row) {
  return row.confirmation?.reboundState?.label ?? row.scout?.status ?? "계산불가";
}

function marketRows(market) {
  const query = state.query.trim().toLowerCase();
  const rows = [...(state.data?.rows?.[market] ?? [])].filter((row) => !query || row.name.toLowerCase().includes(query) || row.code.includes(query));
  const direction = state.sortDirection === "asc" ? 1 : -1;
  return rows.sort((a, b) => {
    if (state.sortKey === "name") return String(a.name).localeCompare(String(b.name), "ko") * direction;
    const value = (row) => {
      if (state.sortKey === "rank") return row.leader?.rank ?? Number.POSITIVE_INFINITY;
      return Number(row.leader?.[state.sortKey]);
    };
    const av = value(a);
    const bv = value(b);
    const safeA = Number.isFinite(av) ? av : (direction === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    const safeB = Number.isFinite(bv) ? bv : (direction === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
    return (safeA - safeB) * direction || (b.leader?.score ?? -1) - (a.leader?.score ?? -1);
  });
}

function aggregateSummary() {
  const kospi = state.data?.summary?.kospi ?? {};
  const kosdaq = state.data?.summary?.kosdaq ?? {};
  const sum = (key) => Number(kospi[key] ?? 0) + Number(kosdaq[key] ?? 0);
  return {
    count: sum("count"),
    calculable: sum("calculable"),
    a: sum("a"),
    b: sum("b"),
    c: sum("c"),
    d: sum("d"),
    unavailable: sum("unavailable")
  };
}

function renderMetrics() {
  const data = aggregateSummary();
  const cards = [
    ["A 핵심 주도주", `${data.a}개`, "KOSPI+KOSDAQ · 85~100점", "positive"],
    ["B 준주도주", `${data.b}개`, "KOSPI+KOSDAQ · 70~84점", "watch-text"],
    ["C 중립", `${data.c}개`, "KOSPI+KOSDAQ · 50~69점", ""],
    ["D 약세", `${data.d}개`, `계산불가 ${data.unavailable}개`, "negative"]
  ];
  document.querySelector("#leaderMetrics").innerHTML = cards.map(([label, value, sub, cls]) => `
    <article class="metric"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></article>
  `).join("");
}

function renderSummary() {
  const data = aggregateSummary();
  const cards = [
    ["전체", data.count, "KOSPI+KOSDAQ"],
    ["계산 가능", data.calculable, "252거래일 이상"],
    ["A+B", data.a + data.b, "주도주 우선군"],
    ["계산불가", data.unavailable, "가격 이력 부족"]
  ];
  document.querySelector("#leaderSummary").innerHTML = cards.map(([label, value, sub]) => `
    <div class="mini-metric"><span>${label}</span><b>${value}개</b><small>${sub}</small></div>
  `).join("");
}

function renderSortState() {
  document.querySelectorAll("[data-leader-sort]").forEach((button) => button.classList.toggle("active", button.dataset.leaderSort === state.sortKey));
  document.querySelectorAll("[data-leader-sort-icon]").forEach((icon) => {
    icon.textContent = icon.dataset.leaderSortIcon === state.sortKey ? (state.sortDirection === "desc" ? "↓" : "↑") : "↕";
  });
}

function renderRow(row) {
  const leader = row.leader ?? {};
  const scout = row.scout ?? {};
  const combined = row.combined ?? {};
  const leaderText = Number.isFinite(leader.score) ? `${leader.score} ${leader.grade}` : "계산불가";
  return `
    <tr>
      <td><b class="rank-main">${leader.rank ?? "–"}</b><div class="cell-sub">${leader.total ? `${leader.total}개 중` : "순위 없음"}</div></td>
      <td><a class="stock-link stock-name" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a><div class="cell-sub">${row.code} · ${price(row.price)}</div></td>
      <td><span class="leader-badge ${gradeClass(leader.grade)}">${leaderText}</span></td>
      <td><b>${leader.trendScore ?? "-"}/30</b><div class="cell-sub">MA20·60·120</div></td>
      <td><b>${leader.relativeStrengthScore ?? "-"}/30</b><div class="cell-sub">20·60·120일 백분위</div></td>
      <td><b>${leader.highRetentionScore ?? "-"}/20</b><div class="cell-sub">고점 ${price(leader.high52w)}</div></td>
      <td><b>${leader.persistenceScore ?? "-"}/20</b><div class="cell-sub">월5선 ${leader.monthAboveMa5 ? "위" : "아래"} · ${leader.monthMa5Rising ? "상승" : "비상승"}</div></td>
      <td><b>${pct(leader.drawdown52wPct)}</b></td>
      <td><b>${pct(leader.ret60)}</b><div class="cell-sub">120일 ${pct(leader.ret120)}</div></td>
      <td><span class="badge ${combined.tone === "buy" ? "buy" : combined.tone === "danger" ? "danger" : "hold"}">${combined.label ?? "관망"}</span><div class="cell-sub">${combined.rank ? `종합 ${combined.rank}위 · ${combined.score}점` : "종합 순위권 밖"}</div></td>
      <td><span class="badge ${row.confirmation?.reboundState?.tone ?? "hold"}">${reboundLabel(row)}</span><div class="cell-sub">멈춤 ${scout.stabilizeScore ?? "-"} · 위험 ${scout.riskScore ?? "-"}</div></td>
      <td><div class="judgement-line">거래강도 ${row.supply?.liquidityScore ?? 0}</div><div class="strategy-badges">${strategyBadges(row)}</div><div class="cell-sub">${leader.decision ?? "가격 이력 확인 필요"}</div></td>
    </tr>
  `;
}

function marketDivider(market, count) {
  return `<tr class="market-table-divider ${market.toLowerCase()}"><td colspan="12"><b>${market}</b><span> · ${count}종목 · 각 시장 안에서 현재 정렬 기준 적용</span></td></tr>`;
}

function renderRows() {
  const sections = MARKETS.map((market) => ({ market, rows: marketRows(market) }));
  const allRows = sections.flatMap((section) => section.rows);
  document.querySelector("#leaderCards").innerHTML = "";
  document.querySelector("#leaderRows").innerHTML = allRows.length
    ? sections.map(({ market, rows }) => `${marketDivider(market, rows.length)}${rows.map(renderRow).join("")}`).join("")
    : `<tr><td colspan="12" class="loading">표시할 종목이 없습니다.</td></tr>`;
}

function render() {
  const asOf = state.data?.asOf ? new Date(state.data.asOf).toLocaleString("ko-KR") : "-";
  const errors = state.data?.errors?.length ? ` · 일부 실패 ${state.data.errors.length}건` : "";
  const kospiCount = state.data?.rows?.KOSPI?.length ?? 0;
  const kosdaqCount = state.data?.rows?.KOSDAQ?.length ?? 0;
  document.querySelector("#leaderStatus").textContent = `KOSPI ${kospiCount} · KOSDAQ ${kosdaqCount} 연속 표시 · ${asOf}${errors}`;
  renderMetrics();
  renderSummary();
  renderSortState();
  renderRows();
}

async function loadLeader(force = false) {
  document.querySelector("#leaderStatus").textContent = "KOSPI·KOSDAQ 주도주를 한 번에 불러오는 중입니다.";
  const response = await fetch(`/api/leader?market=ALL&limit=100${force ? `&t=${Date.now()}` : ""}`, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error((await response.json()).error ?? "leader failed");
  state.data = await response.json();
  render();
}

document.querySelectorAll("[data-leader-sort]").forEach((button) => button.addEventListener("click", () => {
  const key = button.dataset.leaderSort;
  if (state.sortKey === key) state.sortDirection = state.sortDirection === "desc" ? "asc" : "desc";
  else {
    state.sortKey = key;
    state.sortDirection = key === "name" || key === "rank" ? "asc" : "desc";
  }
  renderSortState();
  renderRows();
}));

document.querySelector("#leaderSearch").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderRows();
});

document.querySelector("#refreshBtn").addEventListener("click", () => loadLeader(true).catch((error) => document.querySelector("#leaderStatus").textContent = error.message));
document.querySelector("#refreshLeader").addEventListener("click", () => loadLeader(true).catch((error) => document.querySelector("#leaderStatus").textContent = error.message));

loadLeader(false).catch((error) => {
  document.querySelector("#leaderStatus").textContent = error.message;
  document.querySelector("#leaderRows").innerHTML = `<tr><td colspan="12" class="loading">${error.message}</td></tr>`;
});
