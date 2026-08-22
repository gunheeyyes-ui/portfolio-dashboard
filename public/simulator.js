import {
  buildEntryReviewCandidates,
  mergeEntryCandidates
} from "./entry-review-candidates.js";

const state = {
  data: null,
  loading: false,
  reviewCandidates: [],
  reviewLoaded: false
};

const fmtWon = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const fmtNum = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function won(value) {
  return fmtWon.format(Math.round(value ?? 0));
}

function price(value) {
  return value ? `${fmtInt.format(Math.round(value))}원` : "-";
}

function pct(value) {
  if (!finite(value)) return "-";
  const n = Number(value);
  return `${n >= 0 ? "+" : ""}${fmtNum.format(n)}%`;
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
  document.querySelector("#simStatus").textContent = "기존 실제진입과 백테스트 합의 후보를 계산 중입니다.";
  document.querySelector("#todayCandidates").innerHTML = `<article class="trade-empty"><strong>계산 중</strong><span>시장 후보 200개를 확인해 핵심·강한·실제진입 후보를 합칩니다.</span></article>`;
}

function combinedCandidates() {
  return mergeEntryCandidates(state.data?.actionableToday ?? [], state.reviewCandidates);
}

function renderMetrics() {
  const summary = state.data?.summary ?? {};
  const rows = combinedCandidates();
  const actualCount = (state.data?.actionableToday ?? []).length;
  const coreCount = rows.filter((row) => row.coreCandidate).length;
  const strongCount = rows.filter((row) => row.strongCandidate).length;
  const metrics = [
    ["진행 중", `${summary.openCount ?? 0}개`, `평가손익 ${won(summary.openPnlAmount ?? 0)} · ${pct(summary.openPnlPct ?? 0)}`, tone(summary.openPnlAmount)],
    ["종료 결과", `${summary.closedCount ?? 0}건`, `실현 ${won(summary.realizedPnlAmount ?? 0)} · ${pct(summary.realizedPnlPct ?? 0)}`, tone(summary.realizedPnlAmount)],
    ["승률", pct(summary.winRate ?? 0), "종료된 시뮬 기준", (summary.winRate ?? 0) >= 50 ? "positive" : ""],
    ["오늘 진입후보", `${rows.length || actualCount}개`, `🔥 핵심 ${coreCount} · ⭐ 강한 ${strongCount} · ✅ 실제진입 ${actualCount}`, "watch-text"]
  ];
  document.querySelector("#simMetrics").innerHTML = metrics.map(([label, value, sub, cls = ""]) => `
    <article class="metric">
      <div class="label">${label}</div>
      <div class="value ${cls}">${value}</div>
      <div class="sub">${sub}</div>
    </article>
  `).join("");
}

function entryLabel(row) {
  if (row.coreCandidate) return "🔥 핵심후보";
  if (row.strongCandidate) return "⭐ 강한후보";
  return row.category?.label ?? "✅ 실제진입";
}

function entryBadges(row) {
  return [
    row.coreCandidate ? '<span class="strategy-badge buy">🔥 핵심후보</span>' : "",
    row.strongCandidate ? '<span class="strategy-badge buy">⭐ 강한후보</span>' : "",
    row.actualEntry ? '<span class="strategy-badge buy">✅ 실제진입</span>' : "",
    row.leaderReboundPass ? '<span class="strategy-badge buy">Leader반등</span>' : "",
    row.cafePass ? '<span class="strategy-badge buy">CAFE</span>' : "",
    row.minerviniPass ? '<span class="strategy-badge buy">MTT</span>' : ""
  ].join("");
}

function renderTodayCandidates() {
  const actionable = state.data?.actionableToday ?? [];
  const rows = combinedCandidates().slice(0, 16);
  const coreCount = rows.filter((row) => row.coreCandidate).length;
  const strongCount = rows.filter((row) => row.strongCandidate).length;
  const stamp = new Date(state.data.asOf).toLocaleString("ko-KR");
  const context = state.data?.alreadyRanToday
    ? "오늘 기존 실제진입 기록 완료"
    : state.data?.skippedReason
      ? state.data.skippedReason
      : "오늘 신규 기록 전";
  const reviewSuffix = state.reviewLoaded
    ? `진입후보 ${rows.length}개 · 핵심 ${coreCount} · 강한 ${strongCount} · 실제진입 ${actionable.length}개`
    : `실제진입 ${actionable.length}개 · 합의 후보 계산 중`;
  document.querySelector("#simStatus").textContent = `${context} · ${reviewSuffix} · ${stamp}`;

  document.querySelector("#todayCandidates").innerHTML = rows.length ? rows.map((row) => {
    const leaderText = finite(row.leaderScore)
      ? `${finite(row.leaderRank) ? `#${row.leaderRank} · ` : ""}${row.leaderGrade ?? "-"} ${fmtNum.format(Number(row.leaderScore))}`
      : "계산불가";
    const consensusText = finite(row.strategyCount) && finite(row.axisCount)
      ? `${row.strategyCount}전략 · ${row.axisCount}계열`
      : "-";
    const riskStab = `${finite(row.scoutRiskScore) ? fmtInt.format(row.scoutRiskScore) : "-"}/${finite(row.scoutStabilizeScore) ? fmtInt.format(row.scoutStabilizeScore) : "-"}`;
    const explanation = row.coreCandidate
      ? "백테스트 핵심: Leader TOP10 + 5전략+ + 3계열+"
      : row.strongCandidate
        ? "백테스트 강한후보: Leader A + RS80+ + 3계열+"
        : row.judgement || row.reasons?.slice(0, 3).join(" · ") || "기존 실제진입 기준 통과";
    return `
    <article class="sim-card buy">
      <div class="sim-card-head">
        <span class="badge buy">${entryLabel(row)}</span>
        <small>${row.market || row.sourceLabel || "시장"}${row.actualEntry && row.category?.label ? ` · 기존 ${row.category.label}` : ""}</small>
      </div>
      <a class="stock-link sim-name" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a>
      <div class="cell-sub">${row.code} · ${price(row.price)} · 전일 ${pct(row.changeRate)}</div>
      <div class="sim-mini">
        <span>Leader <b>${leaderText}</b></span>
        <span>RS20 <b>${finite(row.rs20) ? fmtInt.format(row.rs20) : "-"}</b></span>
        <span>합의 <b>${consensusText}</b></span>
        <span>Risk/Stab <b>${riskStab}</b></span>
        <span>낙폭 <b>${pct(row.drawdownFromHighPct)}</b></span>
        <span>3일등락 <b>${pct(row.changeRate3d)}</b></span>
      </div>
      <div class="strategy-badges">${entryBadges(row)}</div>
      <p>${explanation}</p>
    </article>`;
  }).join("") : `
    <article class="trade-empty">
      <strong>${state.reviewLoaded ? "오늘 진입 검토후보 없음" : "합의 후보 계산 중"}</strong>
      <span>${state.reviewLoaded ? "핵심·강한후보와 기존 실제진입을 모두 확인했지만 조건 충족 종목이 없습니다." : "기존 실제진입 외에 Leader·RS·독립계열 합의 후보를 추가로 계산하고 있습니다."}</span>
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

window.addEventListener("strategy-review-candidates", (event) => {
  state.reviewCandidates = buildEntryReviewCandidates(event.detail ?? []);
  state.reviewLoaded = true;
  if (state.data) {
    renderMetrics();
    renderTodayCandidates();
  }
});

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
