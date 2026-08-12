const state = {
  market: "KOSPI",
  data: null,
  sortKey: "stage",
  sortDirection: "desc"
};

const fmtNum = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const fmtWon = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });

function pct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return `${value >= 0 ? "+" : ""}${fmtNum.format(value)}%`;
}

function plainPct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return `${fmtNum.format(value)}%`;
}

function price(value) {
  return value ? `${fmtInt.format(Math.round(value))}원` : "-";
}

function won(value) {
  return fmtWon.format(Math.round(value ?? 0));
}

function dropFromHigh(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  const amount = Math.abs(Math.min(Number(value), 0));
  return `${fmtNum.format(amount)}% 하락`;
}

function naverStockUrl(code) {
  return `https://stock.naver.com/domestic/stock/${code}/price`;
}

function statusClass(status) {
  if (status === "1차 매수 검토" || status === "정찰병 1주") return "buy";
  if (status === "하락 정지 확인") return "hold";
  if (status === "추가매수 금지") return "danger";
  return "hold";
}

function scoreClass(value, reverse = false) {
  const score = Number(value ?? 0);
  if (reverse) {
    if (score >= 65) return "danger";
    if (score >= 45) return "hold";
    return "buy";
  }
  if (score >= 70) return "buy";
  if (score >= 45) return "hold";
  return "muted";
}

async function loadScout(force = false) {
  document.querySelector("#scoutStatus").textContent = `${state.market} 2년 가격 위치 계산 중입니다. 첫 실행은 오래 걸릴 수 있습니다.`;
  const url = `/api/scout?market=${state.market}&limit=100${force ? `&t=${Date.now()}` : ""}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error((await response.json()).error ?? "scout failed");
  state.data = await response.json();
  render();
}

function rawMarketRows() {
  return state.data?.rows?.[state.market] ?? [];
}

function sortValue(row, key) {
  if (key === "stage") {
    return {
      "1차 매수 검토": 5,
      "하락 정지 확인": 4,
      "정찰병 1주": 3,
      "관찰 목록": 2,
      "추가매수 금지": 1
    }[row.status] ?? 0;
  }
  if (key === "leaderScore") return Number(row.leader?.score);
  if (key === "drawdownFromHighPct") return Math.abs(Number(row.drawdownFromHighPct));
  return Number(row[key]);
}

function marketRows() {
  const rows = [...rawMarketRows()];
  const direction = state.sortDirection === "asc" ? 1 : -1;
  const key = state.sortKey;
  return rows.sort((a, b) => {
    if (key === "name") {
      return String(a.name ?? "").localeCompare(String(b.name ?? ""), "ko") * direction;
    }
    const aValue = sortValue(a, key);
    const bValue = sortValue(b, key);
    const safeA = Number.isFinite(aValue) ? aValue : (direction === 1 ? Infinity : -Infinity);
    const safeB = Number.isFinite(bValue) ? bValue : (direction === 1 ? Infinity : -Infinity);
    const diff = (safeA - safeB) * direction;
    if (diff !== 0) return diff;
    return (b.cheapScore ?? 0) - (a.cheapScore ?? 0);
  });
}

function marketSummary() {
  return state.data?.summary?.[state.market === "KOSPI" ? "kospi" : "kosdaq"] ?? {};
}

function renderMetrics() {
  const summary = marketSummary();
  const metrics = [
    ["정찰병", `${summary.scout ?? 0}개`, "많이 싸졌고 위험이 과도하지 않음", "watch-text"],
    ["1차 매수 검토", `${summary.add ?? 0}개`, "싸진 정도와 하락 멈춤 신호 모두 높음", "positive"],
    ["하락 정지 확인", `${summary.stabilize ?? 0}개`, "살아나는지 확인 구간", ""],
    ["추가매수 금지", `${summary.avoid ?? 0}개`, "위험점수 높음", "negative"]
  ];
  document.querySelector("#scoutMetrics").innerHTML = metrics.map(([label, value, sub, cls = ""]) => `
    <article class="metric">
      <div class="label">${label}</div>
      <div class="value ${cls}">${value}</div>
      <div class="sub">${sub}</div>
    </article>
  `).join("");
}

function renderSummary() {
  const rows = marketRows();
  const count = (status) => rows.filter((row) => row.status === status).length;
  const cards = [
    ["전체", `${rows.length}개`, "시총 상위 100"],
    ["정찰병 1주", `${count("정찰병 1주")}개`, "싸졌지만 본매수 아님"],
    ["하락 정지 확인", `${count("하락 정지 확인")}개`, "추가매수 후보 전 단계"],
    ["1차 매수 검토", `${count("1차 매수 검토")}개`, "싸짐+하락 멈춤"],
    ["추가매수 금지", `${count("추가매수 금지")}개`, "위험 우선 확인"],
    ["평균 싸진 정도", `${fmtNum.format(marketSummary().avgCheap ?? 0)}점`, "많이 빠졌을수록 높음"],
    ["평균 위험", `${fmtNum.format(marketSummary().avgRisk ?? 0)}점`, "낮을수록 좋음"]
  ];
  document.querySelector("#scoutSummary").innerHTML = cards.map(([label, value, sub]) => `
    <div class="mini-metric">
      <span>${label}</span>
      <b>${value}</b>
      <small>${sub}</small>
    </div>
  `).join("");
}

function renderRows() {
  const rows = marketRows();
  document.querySelector("#scoutRows").innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td><span class="badge ${statusClass(row.status)}">${row.status}</span></td>
      <td>
        <a class="stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a>
        <div class="cell-sub">${row.code} · ${row.rankType}${row.rank ? ` ${row.rank}` : ""} · ${price(row.price)}</div>
      </td>
      <td>
        <a class="leader-badge ${row.leader?.grade === "A" ? "buy" : row.leader?.grade === "D" || row.leader?.grade === "계산불가" ? "danger" : "hold"}" href="/leader.html">${Number.isFinite(row.leader?.score) ? `${row.leader.score} ${row.leader.grade}` : "계산불가"}</a>
        <div class="cell-sub">${row.leader?.decision ?? "가격 이력 확인 필요"}</div>
      </td>
      <td><b class="${scoreClass(row.cheapScore)}">${row.cheapScore}</b></td>
      <td><b class="${scoreClass(row.stabilizeScore)}">${row.stabilizeScore}</b></td>
      <td><b class="${scoreClass(row.riskScore, true)}">${row.riskScore}</b></td>
      <td>
        <b>${plainPct(row.pricePositionPct)}</b>
        <div class="cell-sub">데이터 ${row.dataDays}일</div>
      </td>
      <td>
        <b class="high-drop">${dropFromHigh(row.drawdownFromHighPct)}</b>
        <div class="cell-sub">2년 고점 ${price(row.high2y)}</div>
        <div class="cell-sub">2년 저점서 ${pct(row.reboundFromLowPct)}</div>
      </td>
      <td>
        <b>${pct(row.dist120)}</b>
        <div class="cell-sub">${row.ma120Stage}</div>
      </td>
      <td>
        <b>${pct(row.relative20)}p</b>
        <div class="cell-sub">5일 ${pct(row.relative5)}p</div>
      </td>
      <td>
        <div>${row.reason?.join(" · ") ?? "-"}</div>
        <div class="cell-sub">위험: ${(row.riskReasons ?? []).join(" · ")}</div>
        <div class="cell-sub">정찰 1주 금액 ${won(row.scoutAmount)}</div>
      </td>
    </tr>
  `).join("") : `<tr><td colspan="11" class="loading">표시할 후보가 없습니다.</td></tr>`;
}

function renderSortState() {
  document.querySelectorAll("[data-scout-sort]").forEach((button) => {
    const active = button.dataset.scoutSort === state.sortKey;
    button.classList.toggle("active", active);
    button.setAttribute("aria-sort", active ? (state.sortDirection === "desc" ? "descending" : "ascending") : "none");
  });
  document.querySelectorAll("[data-scout-sort-icon]").forEach((icon) => {
    const active = icon.dataset.scoutSortIcon === state.sortKey;
    icon.textContent = active ? (state.sortDirection === "desc" ? "↓" : "↑") : "↕";
  });
}

function setSort(key) {
  if (state.sortKey === key) {
    state.sortDirection = state.sortDirection === "desc" ? "asc" : "desc";
  } else {
    state.sortKey = key;
    state.sortDirection = key === "name" || key === "riskScore" || key === "pricePositionPct" ? "asc" : "desc";
  }
  renderSortState();
  renderRows();
}

function render() {
  const asOf = state.data?.asOf ? new Date(state.data.asOf).toLocaleString("ko-KR") : "-";
  const errors = state.data?.errors?.length ? ` · 일부 실패 ${state.data.errors.length}건` : "";
  document.querySelector("#scoutStatus").textContent = `${state.market} 시총 상위 100 기준 · ${asOf}${errors}`;
  renderMetrics();
  renderSummary();
  renderSortState();
  renderRows();
}

document.querySelectorAll("[data-scout-sort]").forEach((button) => {
  button.addEventListener("click", () => setSort(button.dataset.scoutSort));
});

document.querySelector("#refreshBtn").addEventListener("click", () => {
  loadScout(true).catch((error) => {
    document.querySelector("#scoutStatus").textContent = error.message;
  });
});

document.querySelector("#marketTabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-market]");
  if (!button) return;
  state.market = button.dataset.market;
  document.querySelectorAll("#marketTabs button").forEach((item) => item.classList.toggle("active", item === button));
  loadScout(false).catch((error) => {
    document.querySelector("#scoutStatus").textContent = error.message;
  });
});

loadScout(false).catch((error) => {
  document.querySelector("#scoutStatus").textContent = error.message;
  document.querySelector("#scoutRows").innerHTML = `<tr><td colspan="11" class="loading">${error.message}</td></tr>`;
});
