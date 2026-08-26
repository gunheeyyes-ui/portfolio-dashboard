const COHORTS = [
  { id: "actual", label: "✅ 실제진입" },
  { id: "core", label: "🔥 핵심후보" },
  { id: "strong", label: "⭐ 강한후보" }
];
const HORIZONS = [0, 1, 3, 5, 10, 20];
const PORTFOLIO_HORIZONS = [5, 10, 20];
const PAGE_SIZE = 100;

const state = {
  model: null,
  rows: [],
  loading: false
};

const fmtNum = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const fmtWon = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function pct(value) {
  if (!finite(value)) return "-";
  const n = Number(value);
  return `${n >= 0 ? "+" : ""}${fmtNum.format(n)}%`;
}

function price(value) {
  return finite(value) ? `${fmtInt.format(Number(value))}원` : "-";
}

function won(value) {
  return finite(value) ? fmtWon.format(Number(value)) : "-";
}

function tone(value) {
  return finite(value) && Number(value) < 0 ? "negative" : "positive";
}

function naverStockUrl(code) {
  return `https://stock.naver.com/domestic/stock/${code}/price`;
}

function cohortBadges(row) {
  return COHORTS.filter((cohort) => row[cohort.id])
    .map((cohort) => `<span class="strategy-badge buy">${cohort.label}</span>`)
    .join("");
}

function horizonLabel(horizon) {
  return horizon === 0 ? "0D" : `${horizon}D`;
}

function ensureEnhancedPanels() {
  const metrics = document.querySelector("#simV2Metrics");
  if (!metrics || document.querySelector("#simV2Health")) return;
  metrics.insertAdjacentHTML("afterend", `
    <section class="notice" id="simV2Health"></section>
    <section class="sim-panel">
      <div class="section-title"><div><h2>실제운용 포트폴리오 시뮬레이션</h2><p>동일 종목 중복진입 금지 · 최대 10종목 · 1억원 기준. 실현손익 기준 MDD이며 기존 OOS 신호 자체는 변경하지 않습니다.</p></div></div>
      <div class="table-wrap"><table class="sim-table"><thead><tr><th>후보군</th><th>5D</th><th>10D</th><th>20D</th></tr></thead><tbody id="simV2Portfolio"></tbody></table></div>
    </section>
    <section class="sim-panel">
      <div class="section-title"><div><h2>체결·비용 강건성</h2><p>다음날 시가 갭과 기존 순수익에 추가 비용 +0.2%/+0.5%를 가정한 스트레스 결과입니다.</p></div></div>
      <div class="table-wrap"><table class="sim-table"><thead><tr><th>후보군</th><th>진입갭</th><th>5D 기본</th><th>+0.2%</th><th>+0.5%</th><th>지수대비</th><th>일별 바스켓</th></tr></thead><tbody id="simV2Robustness"></tbody></table></div>
    </section>
    <section class="sim-panel">
      <div class="section-title"><div><h2>시장국면별 성과</h2><p>KOSPI/KOSDAQ 지수의 신호일 이전 20거래일 흐름과 변동성으로 상승·중립·하락·고변동을 나눕니다.</p></div></div>
      <div class="table-wrap"><table class="sim-table"><thead><tr><th>후보군 / 국면</th><th>신호일</th><th>5D</th><th>10D</th><th>20D</th></tr></thead><tbody id="simV2Regimes"></tbody></table></div>
    </section>
  `);

  const cohortHead = document.querySelector("#simV2Cohorts")?.closest("table")?.querySelector("thead tr");
  if (cohortHead) cohortHead.innerHTML = `<th>후보군</th>${HORIZONS.map((horizon) => `<th>${horizonLabel(horizon)}</th>`).join("")}`;

  const rowHead = document.querySelector("#simV2Rows")?.closest("table")?.querySelector("thead tr");
  if (rowHead) rowHead.innerHTML = `
    <th>신호일</th><th>종목/후보군</th><th>신호→진입/갭</th><th>당시 전략·계열</th><th>시장국면</th>
    ${HORIZONS.map((horizon) => `<th>${horizonLabel(horizon)}</th>`).join("")}
    <th>진행</th><th>MFE/MAE</th><th>5D 지수대비</th>`;

  const recentPanel = document.querySelector("#simV2Rows")?.closest(".sim-panel");
  recentPanel?.insertAdjacentHTML("beforeend", `<div class="top-actions" style="justify-content:center;margin-top:12px"><button id="simV2More" class="ghost-btn" type="button">이전 기록 더 보기</button></div>`);
  document.querySelector("#simV2More")?.addEventListener("click", () => loadV2({ append: true }).catch(renderFailure));
}

async function fetchV2(offset = 0) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(PAGE_SIZE) });
  const response = await fetch(`/api/simulation-v2?${params}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error((await response.json()).error ?? "Simulation V2 load failed");
  return response.json();
}

async function loadV2({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const status = document.querySelector("#simV2Status");
  if (status) status.textContent = append ? "이전 OOS 기록을 더 불러오는 중입니다." : "전체 OOS 원자료에서 시뮬레이션 통계를 계산 중입니다.";
  try {
    const offset = append ? state.rows.length : 0;
    const model = await fetchV2(offset);
    state.model = model;
    state.rows = append ? [...state.rows, ...(model.rows ?? [])] : [...(model.rows ?? [])];
    renderV2(model);
  } finally {
    state.loading = false;
  }
}

function renderMetrics(model) {
  const health = model.health ?? {};
  const metrics = [
    ["V2 전체 누적 신호", `${model.meta?.totalCandidateRows ?? 0}건`, `전체 OOS 통계 · 화면 ${state.rows.length}건`, "watch-text"],
    ["🔥 핵심", `${model.cohorts?.core?.trades ?? 0}건`, `독립 신호일 ${model.cohorts?.core?.signalDays ?? 0} · 5D ${pct(model.cohorts?.core?.horizons?.["5"]?.trades?.avgReturnPct)}`, tone(model.cohorts?.core?.horizons?.["5"]?.trades?.avgReturnPct)],
    ["⭐ 강한", `${model.cohorts?.strong?.trades ?? 0}건`, `독립 신호일 ${model.cohorts?.strong?.signalDays ?? 0} · 5D ${pct(model.cohorts?.strong?.horizons?.["5"]?.trades?.avgReturnPct)}`, tone(model.cohorts?.strong?.horizons?.["5"]?.trades?.avgReturnPct)],
    ["데이터 건강", health.status === "good" ? "정상" : health.status === "warn" ? "확인필요" : "대기", `누락 ${health.missingSnapshotDates?.length ?? 0}일 · 동결 ${pct(health.frozenConsensusCoveragePct)}`, health.status === "good" ? "positive" : "watch-text"]
  ];
  document.querySelector("#simV2Metrics").innerHTML = metrics.map(([label, value, sub, cls = ""]) => `
    <article class="metric"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></article>
  `).join("");
}

function renderHealth(model) {
  const health = model.health ?? {};
  const missing = health.missingSnapshotDates ?? [];
  const indexDates = health.indexLastDate ?? {};
  const node = document.querySelector("#simV2Health");
  if (!node) return;
  const ok = health.status === "good";
  node.innerHTML = `
    <strong>${ok ? "🟢 자동수집 상태 정상" : health.status === "empty" ? "⚪ OOS 기록 대기" : "🟠 자동수집 상태 확인 필요"}</strong>
    <span>최근 신호 ${health.lastSignalDate ?? "-"} · 마지막 스냅샷 ${health.lastSnapshotAt ? new Date(health.lastSnapshotAt).toLocaleString("ko-KR") : "-"} · 마지막 성과평가 ${health.lastEvaluatedAt ? new Date(health.lastEvaluatedAt).toLocaleString("ko-KR") : "-"}</span>
    <span>스냅샷 누락 ${missing.length}일${missing.length ? ` (${missing.slice(-5).join(", ")})` : ""} · 오류라인 ${health.invalidLines ?? 0} · 전략/계열 동결 ${pct(health.frozenConsensusCoveragePct)} · 0D 보강 ${pct(health.entryDayCoveragePct)}</span>
    <span>실제지수 저장 KOSPI ${indexDates.KOSPI ?? "-"} · KOSDAQ ${indexDates.KOSDAQ ?? "-"} · 유니버스 ${Object.keys(model.meta?.universeVersions ?? {}).join(" / ") || "legacy"}</span>`;
}

function renderCohortSummary(model) {
  document.querySelector("#simV2Cohorts").innerHTML = COHORTS.map((cohort) => {
    const stat = model.cohorts?.[cohort.id] ?? {};
    const cells = HORIZONS.map((horizon) => {
      const block = stat.horizons?.[String(horizon)] ?? {};
      const trades = block.trades ?? {};
      const days = block.signalDays ?? {};
      return `<td><b class="${tone(trades.avgReturnPct)}">${pct(trades.avgReturnPct)}</b><div class="cell-sub">종목 승 ${pct(trades.winRatePct)} · n=${trades.n ?? 0}</div><div class="cell-sub">일별 ${pct(days.avgReturnPct)} · d=${days.n ?? 0}</div></td>`;
    }).join("");
    return `<tr><td><b>${cohort.label}</b><div class="cell-sub">누적 ${stat.trades ?? 0} · 신호일 ${stat.signalDays ?? 0} · 진행 ${stat.pending ?? 0}</div></td>${cells}</tr>`;
  }).join("");
}

function renderPortfolio(model) {
  const body = document.querySelector("#simV2Portfolio");
  if (!body) return;
  body.innerHTML = COHORTS.map((cohort) => {
    const cells = PORTFOLIO_HORIZONS.map((horizon) => {
      const p = model.portfolio?.[cohort.id]?.[String(horizon)] ?? {};
      return `<td><b class="${tone(p.totalReturnPct)}">${pct(p.totalReturnPct)}</b><div class="cell-sub">MDD ${pct(p.realizedMaxDrawdownPct)} · ${p.completedTrades ?? 0}건</div><div class="cell-sub">중복skip ${p.skippedDuplicate ?? 0} · 용량skip ${p.skippedCapacity ?? 0}</div></td>`;
    }).join("");
    return `<tr><td><b>${cohort.label}</b><div class="cell-sub">초기 1억원 · 최대 10종목</div></td>${cells}</tr>`;
  }).join("");
}

function renderRobustness(model) {
  const body = document.querySelector("#simV2Robustness");
  if (!body) return;
  body.innerHTML = COHORTS.map((cohort) => {
    const stat = model.cohorts?.[cohort.id] ?? {};
    const five = stat.horizons?.["5"] ?? {};
    const trade = five.trades ?? {};
    const days = five.signalDays ?? {};
    return `<tr>
      <td><b>${cohort.label}</b><div class="cell-sub">갭 표본 ${stat.gap?.n ?? 0}</div></td>
      <td><b>${pct(stat.gap?.avgPct)}</b><div class="cell-sub">+5%↑ ${pct(stat.gap?.gapUp5Pct)} · -5%↓ ${pct(stat.gap?.gapDown5Pct)}</div></td>
      <td><b class="${tone(trade.avgReturnPct)}">${pct(trade.avgReturnPct)}</b><div class="cell-sub">승 ${pct(trade.winRatePct)}</div></td>
      <td><b class="${tone(trade.stress?.["0.2"]?.avgReturnPct)}">${pct(trade.stress?.["0.2"]?.avgReturnPct)}</b><div class="cell-sub">승 ${pct(trade.stress?.["0.2"]?.winRatePct)}</div></td>
      <td><b class="${tone(trade.stress?.["0.5"]?.avgReturnPct)}">${pct(trade.stress?.["0.5"]?.avgReturnPct)}</b><div class="cell-sub">승 ${pct(trade.stress?.["0.5"]?.winRatePct)}</div></td>
      <td><b class="${tone(trade.avgIndexExcessReturnPct)}">${pct(trade.avgIndexExcessReturnPct)}</b><div class="cell-sub">KOSPI/KOSDAQ 실제지수</div></td>
      <td><b class="${tone(days.avgReturnPct)}">${pct(days.avgReturnPct)}</b><div class="cell-sub">독립 신호일 d=${days.n ?? 0}</div></td>
    </tr>`;
  }).join("");
}

function renderRegimes(model) {
  const body = document.querySelector("#simV2Regimes");
  if (!body) return;
  const rows = [];
  for (const cohort of COHORTS) {
    for (const regime of model.cohorts?.[cohort.id]?.regimes ?? []) {
      rows.push(`<tr>
        <td><b>${cohort.label}</b><div class="cell-sub">${regime.label}</div></td>
        <td>${regime.signalDays ?? 0}일<div class="cell-sub">${regime.trades ?? 0}건</div></td>
        ${[5, 10, 20].map((horizon) => {
          const block = regime.horizons?.[String(horizon)] ?? {};
          return `<td><b class="${tone(block.avgReturnPct)}">${pct(block.avgReturnPct)}</b><div class="cell-sub">승 ${pct(block.winRatePct)} · n=${block.n ?? 0}</div></td>`;
        }).join("")}
      </tr>`);
    }
  }
  body.innerHTML = rows.join("") || `<tr><td colspan="5" class="loading">지수 이력이 쌓이면 시장국면별 성과가 표시됩니다.</td></tr>`;
}

function horizonCell(row, horizon) {
  const outcome = row.outcomesV2?.[String(horizon)];
  if (!outcome) return "-";
  return `<b class="${tone(outcome.netReturnPct)}">${pct(outcome.netReturnPct)}</b>`;
}

function latestExcursion(row) {
  for (const horizon of [...HORIZONS].reverse()) {
    const outcome = row.outcomesV2?.[String(horizon)];
    if (outcome && (finite(outcome.mfePct) || finite(outcome.maePct))) return { horizon, mfePct: outcome.mfePct, maePct: outcome.maePct };
  }
  if (row.live) return { horizon: row.live.tradingDaysElapsed ?? null, mfePct: row.live.currentMFE, maePct: row.live.currentMAE };
  return { horizon: null, mfePct: null, maePct: null };
}

function renderRecentRows(model) {
  const rows = state.rows;
  const body = document.querySelector("#simV2Rows");
  if (!body) return;
  body.innerHTML = rows.length ? rows.map((row) => {
    const excursion = latestExcursion(row);
    const strategyText = row.strategyCount || row.axisCount ? `${row.strategyCount}전략 · ${row.axisCount}계열` : "전략 계산 없음";
    const axes = row.axisLabels?.length ? row.axisLabels.join(" · ") : "-";
    const matched = row.strategyNames?.length ? row.strategyNames.slice(0, 6).join(" · ") : "-";
    const live = row.status !== "COMPLETE" && row.live ? pct(row.live.currentReturnPct) : "완료";
    const fiveIndex = row.outcomesV2?.["5"]?.indexExcessReturnPct;
    return `<tr>
      <td>${row.signalDate}<div class="cell-sub">${row.market}</div></td>
      <td><a class="stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a><div class="cell-sub">${row.code}</div><div class="strategy-badges">${cohortBadges(row)}</div></td>
      <td>${price(row.signalPrice)}<div class="cell-sub">→ ${price(row.entryOpen)} · 갭 ${pct(row.entryGapPct)}</div></td>
      <td><b>${strategyText}</b><div class="cell-sub">${axes}</div><div class="cell-sub" title="${matched}">${matched}</div><div class="cell-sub">정의 ${row.frozenConsensus?.source === "frozen" ? "당시 동결" : "legacy 재구성"}</div></td>
      <td><b>${row.regime?.label ?? "-"}</b><div class="cell-sub">20D ${pct(row.regime?.ret20)} · 변동 ${pct(row.regime?.vol20)}</div></td>
      ${HORIZONS.map((horizon) => `<td>${horizonCell(row, horizon)}</td>`).join("")}
      <td><b class="${tone(row.live?.currentReturnPct)}">${live}</b><div class="cell-sub">${row.entryDate ?? "진입 대기"}</div></td>
      <td><b>${excursion.horizon === null ? "-" : horizonLabel(excursion.horizon)}</b><div class="cell-sub">MFE ${pct(excursion.mfePct)} · MAE ${pct(excursion.maePct)}</div></td>
      <td><b class="${tone(fiveIndex)}">${pct(fiveIndex)}</b><div class="cell-sub">유니버스대비 ${pct(row.outcomesV2?.["5"]?.excessReturnPct)}</div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="15" class="loading">아직 OOS 기반 Simulation V2 기록이 없습니다.</td></tr>`;

  const more = document.querySelector("#simV2More");
  if (more) {
    const total = model.meta?.filteredRows ?? model.meta?.totalCandidateRows ?? 0;
    more.hidden = state.rows.length >= total;
    more.textContent = `이전 기록 더 보기 (${state.rows.length}/${total})`;
  }
}

function renderV2(model) {
  ensureEnhancedPanels();
  renderMetrics(model);
  renderHealth(model);
  renderCohortSummary(model);
  renderPortfolio(model);
  renderRobustness(model);
  renderRegimes(model);
  renderRecentRows(model);
  const status = document.querySelector("#simV2Status");
  if (status) {
    status.textContent = model.meta?.latestSignalDate
      ? `전체 OOS ${model.meta.totalCandidateRows}건 · 최근 신호 ${model.meta.latestSignalDate} · 다음 거래일 시가 진입 · 0/1/3/5/10/20D · 실제지수·비용·포트폴리오 검증`
      : "아직 기록된 OOS 신호가 없습니다. 서버 EOD 스케줄이 자동으로 쌓습니다.";
  }
}

function renderFailure(error) {
  const status = document.querySelector("#simV2Status");
  if (status) status.textContent = `Simulation V2 불러오기 실패: ${error.message}`;
  const body = document.querySelector("#simV2Rows");
  if (body) body.innerHTML = `<tr><td colspan="15" class="loading">${error.message}</td></tr>`;
}

document.querySelector("#refreshBtn")?.addEventListener("click", () => loadV2().catch(renderFailure));
loadV2().catch(renderFailure);
