const state = {
  market: "KOSPI",
  data: null,
  query: "",
  sortKey: "score",
  sortDirection: "desc"
};

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

function marketRows() {
  const query = state.query.trim().toLowerCase();
  const rows = [...(state.data?.rows?.[state.market] ?? [])].filter((row) => !query || row.name.toLowerCase().includes(query) || row.code.includes(query));
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

function summary() {
  return state.data?.summary?.[state.market === "KOSPI" ? "kospi" : "kosdaq"] ?? {};
}

function renderMetrics() {
  const data = summary();
  const cards = [
    ["A 핵심 주도주", `${data.a ?? 0}개`, "85~100점", "positive"],
    ["B 준주도주", `${data.b ?? 0}개`, "70~84점", "watch-text"],
    ["C 중립", `${data.c ?? 0}개`, "50~69점", ""],
    ["D 약세", `${data.d ?? 0}개`, `계산불가 ${data.unavailable ?? 0}개`, "negative"]
  ];
  document.querySelector("#leaderMetrics").innerHTML = cards.map(([label, value, sub, cls]) => `
    <article class="metric"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></article>
  `).join("");
}

function renderSummary() {
  const data = summary();
  const cards = [
    ["전체", data.count ?? 0, "시총+거래 후보"],
    ["계산 가능", data.calculable ?? 0, "252거래일 이상"],
    ["A+B", (data.a ?? 0) + (data.b ?? 0), "주도주 우선군"],
    ["계산불가", data.unavailable ?? 0, "가격 이력 부족"]
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

function renderRows() {
  const rows = marketRows();
  document.querySelector("#leaderRows").innerHTML = rows.length ? rows.map((row) => {
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
        <td><span class="badge ${scout.status === "1차 매수 검토" ? "buy" : scout.status === "추가매수 금지" ? "danger" : "hold"}">${scout.status ?? "순위권 밖"}</span><div class="cell-sub">싸짐 ${scout.cheapScore ?? "-"} · 멈춤 ${scout.stabilizeScore ?? "-"} · 위험 ${scout.riskScore ?? "-"}</div></td>
        <td><div class="judgement-line">${leader.decision ?? "가격 이력 확인 필요"}</div></td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="12" class="loading">표시할 종목이 없습니다.</td></tr>`;
}

function render() {
  const asOf = state.data?.asOf ? new Date(state.data.asOf).toLocaleString("ko-KR") : "-";
  const errors = state.data?.errors?.length ? ` · 일부 실패 ${state.data.errors.length}건` : "";
  document.querySelector("#leaderStatus").textContent = `${state.market} 기존 시장 Universe · ${asOf}${errors}`;
  renderMetrics();
  renderSummary();
  renderSortState();
  renderRows();
}

async function loadLeader(force = false) {
  document.querySelector("#leaderStatus").textContent = `${state.market} 주도주 계산 중입니다. 첫 실행은 시간이 걸릴 수 있습니다.`;
  const response = await fetch(`/api/leader?market=${state.market}&limit=100${force ? `&t=${Date.now()}` : ""}`, { signal: AbortSignal.timeout(300000) });
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

document.querySelector("#marketTabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-market]");
  if (!button) return;
  state.market = button.dataset.market;
  document.querySelectorAll("#marketTabs button").forEach((item) => item.classList.toggle("active", item === button));
  loadLeader(false).catch((error) => document.querySelector("#leaderStatus").textContent = error.message);
});

document.querySelector("#refreshBtn").addEventListener("click", () => loadLeader(true).catch((error) => document.querySelector("#leaderStatus").textContent = error.message));
document.querySelector("#refreshLeader").addEventListener("click", () => loadLeader(true).catch((error) => document.querySelector("#leaderStatus").textContent = error.message));

loadLeader(false).catch((error) => {
  document.querySelector("#leaderStatus").textContent = error.message;
  document.querySelector("#leaderRows").innerHTML = `<tr><td colspan="12" class="loading">${error.message}</td></tr>`;
});
