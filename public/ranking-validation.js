const state = { data: null, market: "ALL", date: "", horizon: 5 };
const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });

function pct(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "-";
  return `${Number(value) >= 0 ? "+" : ""}${number.format(Number(value))}%`;
}

function price(value) {
  return Number.isFinite(Number(value)) ? `${new Intl.NumberFormat("ko-KR").format(Math.round(value))}원` : "-";
}

function tone(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "";
  return Number(value) >= 0 ? "good-score" : "bad-score";
}

function scoutLabel(status) {
  return {
    "정찰병 1주": "정찰병",
    "하락 정지 확인": "하락 정지",
    "1차 매수 검토": "반등 확인",
    "관찰 목록": "관찰",
    "추가매수 금지": "고위험"
  }[status] ?? status;
}

async function loadValidation() {
  document.querySelector("#validationStatus").textContent = "실전 기록 집계 중";
  const params = new URLSearchParams({ market: state.market });
  if (state.date) params.set("date", state.date);
  const response = await fetch(`/api/ranking-validation?${params}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error((await response.json()).error ?? "실전 기록을 불러오지 못했습니다.");
  state.data = await response.json();
  render();
}

function renderDates() {
  const select = document.querySelector("#validationDate");
  const options = [`<option value="">전체 기간</option>`, ...(state.data?.dates ?? []).map((date) => `<option value="${date}" ${date === state.date ? "selected" : ""}>${date}</option>`)].join("");
  select.innerHTML = options;
}

function metric(label, value, sub) {
  return `<article class="metric"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></article>`;
}

function renderMetrics() {
  const data = state.data ?? {};
  document.querySelector("#validationMetrics").innerHTML = [
    metric("기록 시작일", data.startDate ?? "아직 없음", `${data.observationTradingDays ?? 0} 거래일`),
    metric("누적 관측", `${data.observationCount ?? 0}건`, `${state.market === "ALL" ? "전체 시장" : state.market} snapshot`),
    metric("10일 완료", `${data.completedObservationCount ?? 0}건`, `일부 완료 ${data.completedAnyCount ?? 0}건`),
    metric("현재 보기", `${state.horizon}거래일`, state.date || "전체 기록일")
  ].join("");
}

function metricTable(groups, labelMap = {}) {
  const rows = Object.entries(groups ?? {}).map(([label, horizons]) => {
    const item = horizons?.[state.horizon] ?? {};
    return `<tr><td><b>${labelMap[label] ?? label}</b></td><td>${item.n ?? 0}</td><td class="${tone(item.averageReturnPct)}">${pct(item.averageReturnPct)}</td><td class="${tone(item.medianReturnPct)}">${pct(item.medianReturnPct)}</td><td>${pct(item.winRatePct)}</td><td class="${tone(item.averageExcessReturnPct)}">${pct(item.averageExcessReturnPct)}</td><td>${pct(item.averageMfePct)}</td><td>${pct(item.averageMaePct)}</td></tr>`;
  }).join("");
  return `<div class="validation-table-wrap"><table class="validation-table"><thead><tr><th>구분</th><th>N</th><th>평균</th><th>중앙값</th><th>승률</th><th>시장내 초과</th><th>MFE</th><th>MAE</th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="loading">완료된 결과가 없습니다.</td></tr>'}</tbody></table></div>`;
}

function renderRecent(target, rows) {
  const horizon5 = "outcome5";
  const horizon10 = "outcome10";
  document.querySelector(target).innerHTML = `<div class="validation-table-wrap"><table class="validation-table recent-validation"><thead><tr><th>순위</th><th>종목</th><th>Tier/상태</th><th>Leader</th><th>DD</th><th>Risk/Stab</th><th>전략/거래</th><th>5일</th><th>10일</th></tr></thead><tbody>${rows.length ? rows.map((row) => `<tr><td><b>${row.reviewRank}</b><small>${row.signalDate}</small></td><td><a class="stock-link" href="https://stock.naver.com/domestic/stock/${row.ticker}/price" target="_blank" rel="noopener noreferrer">${row.name}</a><small>${price(row.currentPrice)}</small></td><td>T${row.rankingTier}<small>${scoutLabel(row.scoutStatus)}</small></td><td>${row.leaderGrade} ${row.leaderScore ?? "-"}</td><td>${pct(row.drawdownFromHighPct)}</td><td>${row.riskScore ?? "-"} / ${row.stabilizeScore ?? "-"}</td><td>${row.cafePass ? "CAFE " : ""}${row.minerviniPass ? "MTT " : ""}<small>거래 ${row.liquidityScore ?? "-"}</small></td><td class="${tone(row[horizon5]?.netReturnPct)}">${row[horizon5] ? pct(row[horizon5].netReturnPct) : "대기"}</td><td class="${tone(row[horizon10]?.netReturnPct)}">${row[horizon10] ? pct(row[horizon10].netReturnPct) : "대기"}</td></tr>`).join("") : '<tr><td colspan="9" class="loading">선택 조건의 기록이 없습니다.</td></tr>'}</tbody></table></div>`;
}

function render() {
  renderDates();
  renderMetrics();
  document.querySelector("#rankBucketTable").innerHTML = metricTable(state.data?.rankBuckets);
  document.querySelector("#cumulativeTable").innerHTML = metricTable(state.data?.cumulativeRanks);
  document.querySelector("#tierTable").innerHTML = metricTable(state.data?.tiers);
  document.querySelector("#scoutTable").innerHTML = metricTable(state.data?.scoutStatuses, Object.fromEntries(["정찰병 1주", "하락 정지 확인", "1차 매수 검토", "관찰 목록", "추가매수 금지"].map((item) => [item, scoutLabel(item)])));
  document.querySelector("#strategyTable").innerHTML = metricTable(state.data?.strategies);
  document.querySelector("#regimeTable").innerHTML = metricTable(state.data?.marketRegimes);
  renderRecent("#recentKospi", state.data?.recent?.KOSPI ?? []);
  renderRecent("#recentKosdaq", state.data?.recent?.KOSDAQ ?? []);
  document.querySelector("#validationStatus").textContent = `${state.data?.observationTradingDays ?? 0}개 기록일 · 깨진 줄 ${state.data?.invalidLines ?? 0}건`;
}

document.querySelector("#validationMarkets").addEventListener("click", (event) => {
  const button = event.target.closest("[data-market]");
  if (!button) return;
  state.market = button.dataset.market;
  document.querySelectorAll("#validationMarkets button").forEach((item) => item.classList.toggle("active", item === button));
  loadValidation().catch(showError);
});

document.querySelector("#validationHorizons").addEventListener("click", (event) => {
  const button = event.target.closest("[data-horizon]");
  if (!button) return;
  state.horizon = Number(button.dataset.horizon);
  document.querySelectorAll("#validationHorizons button").forEach((item) => item.classList.toggle("active", item === button));
  render();
});

document.querySelector("#validationDate").addEventListener("change", (event) => {
  state.date = event.target.value;
  loadValidation().catch(showError);
});

document.querySelector("#validationRefresh").addEventListener("click", () => loadValidation().catch(showError));

function showError(error) {
  document.querySelector("#validationStatus").textContent = error.message;
}

loadValidation().catch(showError);
