const state = {
  data: null,
  query: "",
  filter: "all",
  sortKey: "rank",
  sortDirection: "asc"
};

const MARKETS = ["KOSPI", "KOSDAQ"];
const fmtNum = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

function pct(value) {
  if (!Number.isFinite(Number(value))) return "-";
  return `${Number(value) >= 0 ? "+" : ""}${fmtNum.format(value)}%`;
}

function plainPct(value) {
  return Number.isFinite(Number(value)) ? `${fmtNum.format(value)}%` : "-";
}

function price(value) {
  return Number(value) > 0 ? `${fmtInt.format(Math.round(value))}원` : "-";
}

function dropFromHigh(value) {
  if (!Number.isFinite(Number(value))) return "-";
  return `${fmtNum.format(Math.abs(Math.min(Number(value), 0)))}% 하락`;
}

function naverStockUrl(code) {
  return `https://stock.naver.com/domestic/stock/${code}/price`;
}

function status(row) {
  return row.confirmation?.reboundState ?? { label: "계산불가", tone: "danger", key: "risk" };
}

function scoreClass(value, reverse = false) {
  const score = Number(value ?? 0);
  if (reverse) return score >= 65 ? "danger" : score > 39 ? "hold" : "buy";
  return score >= 70 ? "buy" : score >= 45 ? "hold" : "muted";
}

function leaderClass(grade) {
  if (grade === "A") return "buy";
  if (grade === "B") return "hold";
  if (grade === "D" || grade === "계산불가") return "danger";
  return "muted";
}

function strategyBadges(row) {
  return (row.confirmation?.badges ?? []).map((label) => {
    const tone = label === "실험: 낙주" ? "hold" : label === "깊은낙폭 회복" ? "watch" : "buy";
    return `<span class="strategy-badge ${tone}">${label}</span>`;
  }).join("");
}

async function loadScout(force = false) {
  document.querySelector("#scoutStatus").textContent = "KOSPI·KOSDAQ 반등 조건을 한 번에 불러오는 중입니다.";
  const url = `/api/scout?market=ALL&limit=100${force ? `&t=${Date.now()}` : ""}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error((await response.json()).error ?? "rebound failed");
  state.data = await response.json();
  render();
}

function rawMarketRows(market) {
  return (state.data?.rows?.[market] ?? []).map((row, index) => ({ ...row, reboundRank: index + 1 }));
}

function allRawRows() {
  return MARKETS.flatMap((market) => rawMarketRows(market));
}

function matchesFilter(row) {
  const confirmation = row.confirmation ?? {};
  if (state.filter === "leader-rebound") return confirmation.leaderReboundPass;
  if (state.filter === "stopped") return ["ready", "stopped"].includes(confirmation.reboundState?.key);
  if (state.filter === "deep") return confirmation.deepRecoveryPass;
  if (state.filter === "safe") return Number(row.riskScore ?? 100) < 65;
  return true;
}

function sortValue(row, key) {
  if (key === "rank") return Number(row.reboundRank);
  if (key === "leaderScore") return Number(row.leader?.score);
  if (key === "drawdownFromHighPct") return Math.abs(Number(row.drawdownFromHighPct));
  return Number(row[key]);
}

function marketRows(market) {
  const query = state.query.trim().toLowerCase();
  const direction = state.sortDirection === "asc" ? 1 : -1;
  const rows = rawMarketRows(market).filter((row) => matchesFilter(row)
    && (!query || row.name.toLowerCase().includes(query) || row.code.includes(query)));
  return [...rows].sort((a, b) => {
    if (state.sortKey === "name") return String(a.name).localeCompare(String(b.name), "ko") * direction;
    const aValue = sortValue(a, state.sortKey);
    const bValue = sortValue(b, state.sortKey);
    const safeA = Number.isFinite(aValue) ? aValue : (direction === 1 ? Infinity : -Infinity);
    const safeB = Number.isFinite(bValue) ? bValue : (direction === 1 ? Infinity : -Infinity);
    return (safeA - safeB) * direction || Number(a.reboundRank ?? 9999) - Number(b.reboundRank ?? 9999);
  });
}

function average(rows, key) {
  const values = rows.map((row) => Number(row[key])).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function renderMetrics() {
  const rows = allRawRows();
  const count = (test) => rows.filter(test).length;
  const metrics = [
    ["좋은종목 반등", `${count((row) => row.confirmation?.leaderReboundPass)}개`, "KOSPI+KOSDAQ · Leader A + 하락정지 + Risk 39 이하", "positive"],
    ["반등 1차 후보", `${count((row) => row.confirmation?.reboundState?.key === "ready")}개`, "조정·정지·저위험 동시 충족", "positive"],
    ["하락 정지", `${count((row) => row.confirmation?.reboundState?.key === "stopped")}개`, "하락 둔화 확인 단계", "watch-text"],
    ["고위험 제외", `${count((row) => row.confirmation?.reboundState?.key === "risk")}개`, "Risk 65 이상", "negative"]
  ];
  document.querySelector("#scoutMetrics").innerHTML = metrics.map(([label, value, sub, cls]) => `
    <article class="metric"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></article>
  `).join("");
}

function renderSummary() {
  const rows = allRawRows();
  const cards = [
    ["후보 Universe", `${rows.length}개`, "KOSPI+KOSDAQ"],
    ["고위험 제외", `${rows.filter((row) => row.riskScore < 65).length}개`, "Risk 65 미만"],
    ["평균 하락정지", `${fmtNum.format(average(rows, "stabilizeScore"))}점`, "높을수록 회복 단서"],
    ["평균 위험", `${fmtNum.format(average(rows, "riskScore"))}점`, "낮을수록 좋음"]
  ];
  document.querySelector("#scoutSummary").innerHTML = cards.map(([label, value, sub]) => `
    <div class="mini-metric"><span>${label}</span><b>${value}</b><small>${sub}</small></div>
  `).join("");
}

function trendText(row) {
  return `5일 ${Number(row.slope5 ?? -1) > 0 ? "회복" : "약세"} · 20일 ${Number(row.slope20 ?? -1) > 0 ? "회복" : "약세"}`;
}

function renderRow(row) {
  const current = status(row);
  return `
    <tr>
      <td><b class="rank-main">${row.reboundRank ?? "-"}</b><div class="cell-sub">${current.label}</div></td>
      <td><a class="stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a><div class="cell-sub">${row.code} · ${price(row.price)} · 전일 ${pct(row.changeRate)}</div></td>
      <td><span class="leader-badge ${leaderClass(row.leader?.grade)}">${Number.isFinite(row.leader?.score) ? `${row.leader.score} ${row.leader.grade}` : "계산불가"}</span></td>
      <td><b class="${scoreClass(row.liquidityScore)}">${row.liquidityScore ?? 0}</b><div class="cell-sub">현재 돈 유입/회전</div></td>
      <td><b class="${scoreClass(row.stabilizeScore)}">${row.stabilizeScore ?? "-"}</b></td>
      <td><b class="${scoreClass(row.riskScore, true)}">${row.riskScore ?? "-"}</b></td>
      <td><b>${plainPct(row.pricePositionPct)}</b><div class="cell-sub">데이터 ${row.dataDays ?? 0}일</div></td>
      <td><b class="high-drop">${dropFromHigh(row.drawdownFromHighPct)}</b><div class="cell-sub">고점 ${price(row.high2y)}</div></td>
      <td><b>${row.daysSinceLow ?? "-"}일</b><div class="cell-sub">${row.noNewLow5 ? "5일 저점 유지" : "저점 확인 필요"}</div></td>
      <td><b>${trendText(row)}</b><div class="cell-sub">시장대비 20일 ${pct(row.relative20)}p</div></td>
      <td><span class="badge ${current.tone}">${current.label}</span><div class="strategy-badges">${strategyBadges(row)}</div><div class="cell-sub">${(row.riskReasons ?? []).join(" · ")}</div></td>
    </tr>
  `;
}

function marketDivider(market, count) {
  return `<tr class="market-table-divider ${market.toLowerCase()}"><td colspan="11"><b>${market}</b><span> · ${count}종목 · 각 시장 안에서 현재 정렬 기준 적용</span></td></tr>`;
}

function renderRows() {
  const sections = MARKETS.map((market) => ({ market, rows: marketRows(market) }));
  const allRows = sections.flatMap((section) => section.rows);
  document.querySelector("#reboundCards").innerHTML = "";
  document.querySelector("#scoutRows").innerHTML = allRows.length
    ? sections.map(({ market, rows }) => `${marketDivider(market, rows.length)}${rows.map(renderRow).join("")}`).join("")
    : `<tr><td colspan="11" class="loading">조건에 맞는 반등후보가 없습니다.</td></tr>`;
}

function renderSortState() {
  document.querySelectorAll("[data-scout-sort]").forEach((button) => button.classList.toggle("active", button.dataset.scoutSort === state.sortKey));
  document.querySelectorAll("[data-scout-sort-icon]").forEach((icon) => {
    icon.textContent = icon.dataset.scoutSortIcon === state.sortKey ? (state.sortDirection === "desc" ? "↓" : "↑") : "↕";
  });
}

function setSort(key) {
  if (state.sortKey === key) state.sortDirection = state.sortDirection === "desc" ? "asc" : "desc";
  else {
    state.sortKey = key;
    state.sortDirection = ["name", "rank", "riskScore", "pricePositionPct"].includes(key) ? "asc" : "desc";
  }
  renderSortState();
  renderRows();
}

function render() {
  const asOf = state.data?.asOf ? new Date(state.data.asOf).toLocaleString("ko-KR") : "-";
  const errors = state.data?.errors?.length ? ` · 일부 실패 ${state.data.errors.length}건` : "";
  const kospiCount = rawMarketRows("KOSPI").length;
  const kosdaqCount = rawMarketRows("KOSDAQ").length;
  document.querySelector("#scoutStatus").textContent = `KOSPI ${kospiCount} · KOSDAQ ${kosdaqCount} 연속 표시 · ${asOf}${errors}`;
  renderMetrics();
  renderSummary();
  renderSortState();
  renderRows();
}

document.querySelectorAll("[data-scout-sort]").forEach((button) => button.addEventListener("click", () => setSort(button.dataset.scoutSort)));
document.querySelector("#refreshBtn").addEventListener("click", () => loadScout(true).catch((error) => document.querySelector("#scoutStatus").textContent = error.message));
document.querySelector("#reboundFilters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-rebound-filter]");
  if (!button) return;
  state.filter = button.dataset.reboundFilter;
  document.querySelectorAll("#reboundFilters button").forEach((item) => item.classList.toggle("active", item === button));
  renderRows();
});
document.querySelector("#reboundSearch").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderRows();
});

loadScout(false).catch((error) => {
  document.querySelector("#scoutStatus").textContent = error.message;
  document.querySelector("#scoutRows").innerHTML = `<tr><td colspan="11" class="loading">${error.message}</td></tr>`;
});
