const state = {
  data: null,
  loading: false
};

const fmtWon = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const fmtNum = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

function won(value) {
  return fmtWon.format(Math.round(value ?? 0));
}

function price(value) {
  return value ? `${fmtInt.format(Math.round(value))}원` : "-";
}

function pct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  return `${value >= 0 ? "+" : ""}${fmtNum.format(value)}%`;
}

function tone(value) {
  return (value ?? 0) >= 0 ? "positive" : "negative";
}

function naverStockUrl(code) {
  return `https://stock.naver.com/domestic/stock/${code}/price`;
}

function badgeClass(category) {
  if (category === "분할 후보" || category === "우선 검토") return "buy";
  if (category === "단기 특수") return "hold";
  if (category === "매수보류" || category === "추격주의") return "danger";
  return "hold";
}

async function loadSimulation({ record = false, force = false } = {}) {
  state.loading = true;
  renderLoading();
  const params = new URLSearchParams();
  if (record) params.set("record", "1");
  if (force) params.set("force", "1");
  if (force) params.set("t", Date.now());
  const response = await fetch(`/api/simulation${params.toString() ? `?${params}` : ""}`, {
    signal: AbortSignal.timeout(240000)
  });
  if (!response.ok) throw new Error((await response.json()).error ?? "simulation failed");
  state.data = await response.json();
  state.loading = false;
  render();
}

function renderLoading() {
  document.querySelector("#simStatus").textContent = "보유종목과 시장 후보를 계산 중입니다.";
  document.querySelector("#todayCandidates").innerHTML = `<article class="trade-empty"><strong>계산 중</strong><span>첫 실행은 시장 후보 200개를 훑어서 시간이 걸릴 수 있습니다.</span></article>`;
}

function renderMetrics() {
  const summary = state.data?.summary ?? {};
  const metrics = [
    ["진행 중", `${summary.openCount ?? 0}개`, `평가손익 ${won(summary.openPnlAmount ?? 0)} · ${pct(summary.openPnlPct ?? 0)}`, tone(summary.openPnlAmount)],
    ["종료 결과", `${summary.closedCount ?? 0}건`, `실현 ${won(summary.realizedPnlAmount ?? 0)} · ${pct(summary.realizedPnlPct ?? 0)}`, tone(summary.realizedPnlAmount)],
    ["승률", pct(summary.winRate ?? 0), "종료된 시뮬 기준", (summary.winRate ?? 0) >= 50 ? "positive" : ""],
    ["오늘 후보", `${summary.todayActionableCount ?? 0}개`, `내 보유 후보 ${summary.todayHoldingSignals ?? 0}개`, "watch-text"]
  ];
  document.querySelector("#simMetrics").innerHTML = metrics.map(([label, value, sub, cls = ""]) => `
    <article class="metric">
      <div class="label">${label}</div>
      <div class="value ${cls}">${value}</div>
      <div class="sub">${sub}</div>
    </article>
  `).join("");
}

function renderTodayCandidates() {
  const actionable = state.data?.actionableToday ?? [];
  const fallback = (state.data?.todayCandidates ?? []).filter((row) => row.category?.key !== "none").slice(0, 12);
  const rows = actionable.length ? actionable : fallback;
  document.querySelector("#simStatus").textContent = state.data?.alreadyRanToday
    ? `오늘은 이미 기록됨 · ${new Date(state.data.asOf).toLocaleString("ko-KR")}`
    : `아직 오늘 신규 기록 전 · 진입 후보 ${actionable.length}개 · ${new Date(state.data.asOf).toLocaleString("ko-KR")}`;

  document.querySelector("#todayCandidates").innerHTML = rows.length ? rows.slice(0, 12).map((row) => `
    <article class="sim-card ${badgeClass(row.category.label)}">
      <div class="sim-card-head">
        <span class="badge ${badgeClass(row.category.label)}">${row.category.label}</span>
        <small>${row.sourceLabel}</small>
      </div>
      <a class="stock-link sim-name" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a>
      <div class="cell-sub">${row.code} · ${price(row.price)} · 전일 ${pct(row.changeRate)}</div>
      <div class="sim-mini">
        <span>거래강도 <b>${row.liquidityScore}</b></span>
        <span>3일 <b>${pct(row.changeRate3d)}</b></span>
        <span>외/기 <b>${row.foreignStreak}/${row.instStreak}일</b></span>
        <span>주도주 <b>${Number.isFinite(row.leaderScore) ? `${row.leaderScore} ${row.leaderGrade}` : "계산불가"}</b></span>
      </div>
      <div class="strategy-badges">
        ${row.leaderReboundPass ? '<span class="strategy-badge buy">Leader반등</span>' : ""}
        ${row.cafePass ? '<span class="strategy-badge buy">CAFE</span>' : ""}
        ${row.minerviniPass ? '<span class="strategy-badge buy">MTT</span>' : ""}
      </div>
      <p>${row.judgement || row.reasons?.slice(0, 3).join(" · ") || "기준 통과 후보"}</p>
    </article>
  `).join("") : `
    <article class="trade-empty">
      <strong>오늘 신규 진입 후보 없음</strong>
      <span>분할 후보, 우선 검토, 단기 특수 기준을 통과한 종목이 없습니다. 관망일로 기록하면 됩니다.</span>
    </article>
  `;
}

function renderOpenPositions() {
  const rows = state.data?.open ?? [];
  document.querySelector("#openPositions").innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td>
        <a class="stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a>
        <div class="cell-sub">${row.code} · ${row.sourceLabel}</div>
      </td>
      <td><span class="badge ${badgeClass(row.category)}">${row.category}</span></td>
      <td>${price(row.entryPrice)}</td>
      <td>${price(row.lastPrice)}</td>
      <td>
        <b class="${tone(row.pnlPct)}">${pct(row.pnlPct)}</b>
        <div class="cell-sub">${won(row.pnlAmount)}</div>
      </td>
      <td>${row.heldDays}/${row.targetDays}일</td>
      <td>
        <div>거래강도 ${row.liquidityScore} · 외/기 ${row.foreignStreak}/${row.instStreak}일</div>
        <div class="cell-sub">주도주 ${Number.isFinite(row.leaderScore) ? `${row.leaderScore} ${row.leaderGrade}` : "기록 없음"}</div>
        <div class="cell-sub">반등 ${row.scoutStatus ?? "기록 없음"} · 정지 ${row.scoutStabilizeScore ?? "-"} · Risk ${row.scoutRiskScore ?? "-"}</div>
        <div class="strategy-badges">${row.cafePass ? '<span class="strategy-badge buy">CAFE</span>' : ""}${row.minerviniPass ? '<span class="strategy-badge buy">MTT</span>' : ""}${row.leaderReboundPass ? '<span class="strategy-badge buy">Leader반등</span>' : ""}</div>
        <div class="cell-sub">${row.judgement || row.reasons?.slice(0, 3).join(" · ") || "-"}</div>
      </td>
    </tr>
  `).join("") : `<tr><td colspan="7" class="loading">진행 중인 가상 포지션이 없습니다. 오늘 시뮬 기록을 누르면 시작됩니다.</td></tr>`;
}

function renderClosedPositions() {
  const rows = state.data?.closed ?? [];
  document.querySelector("#closedPositions").innerHTML = rows.length ? rows.slice(0, 50).map((row) => `
    <tr>
      <td>
        <a class="stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a>
        <div class="cell-sub">${row.code} · ${row.sourceLabel}</div>
      </td>
      <td><span class="badge ${badgeClass(row.category)}">${row.category}</span></td>
      <td>${row.entryDate} → ${row.exitDate}</td>
      <td>${price(row.entryPrice)}</td>
      <td>${price(row.exitPrice)}</td>
      <td>
        <b class="${tone(row.pnlPct)}">${pct(row.pnlPct)}</b>
        <div class="cell-sub">${won(row.pnlAmount)}</div>
      </td>
      <td>${row.exitReason ?? "관찰 종료"}</td>
    </tr>
  `).join("") : `<tr><td colspan="7" class="loading">아직 종료된 시뮬 결과가 없습니다.</td></tr>`;
}

function render() {
  renderMetrics();
  renderTodayCandidates();
  renderOpenPositions();
  renderClosedPositions();
}

document.querySelector("#refreshBtn").addEventListener("click", () => {
  loadSimulation({ force: true }).catch((error) => {
    document.querySelector("#simStatus").textContent = error.message;
  });
});

document.querySelector("#recordBtn").addEventListener("click", () => {
  loadSimulation({ record: true, force: true }).catch((error) => {
    document.querySelector("#simStatus").textContent = error.message;
  });
});

loadSimulation().catch((error) => {
  state.loading = false;
  document.querySelector("#simStatus").textContent = error.message;
  document.querySelector("#todayCandidates").innerHTML = `<article class="trade-empty"><strong>불러오기 실패</strong><span>${error.message}</span></article>`;
});
