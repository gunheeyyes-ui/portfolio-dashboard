const state = {
  data: null,
  market: "ALL",
  scope: "featured",
  level: "cohorts",
  sortKey: "excess10",
  sortDir: "desc",
  detailId: null
};

const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });
const HORIZONS = ["1", "3", "5", "10", "20"];

function missing(value) {
  return value === null || value === undefined || value === "" || !Number.isFinite(Number(value));
}

// 수익률: 부호를 붙이되 반올림 후 0이면 부호를 붙이지 않는다(-0% 방지).
function pct(value, digits = 2) {
  if (missing(value)) return "-";
  const rounded = Number(Number(value).toFixed(digits));
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

// 승률처럼 부호가 의미 없는 비율
function rate(value, digits = 1) {
  return missing(value) ? "-" : `${Number(Number(value).toFixed(digits))}%`;
}

function plain(value, digits = 2) {
  return missing(value) ? "-" : number.format(Number(Number(value).toFixed(digits)));
}

function price(value) {
  return Number.isFinite(Number(value)) ? `${new Intl.NumberFormat("ko-KR").format(Math.round(value))}원` : "-";
}

// KIS 일봉 날짜는 YYYYMMDD로 저장된다. 화면에서는 기록일과 같은 형식으로 보인다.
function ymd(value) {
  const text = String(value ?? "");
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : (text || "-");
}

function tone(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "";
  return Number(value) >= 0 ? "good-score" : "bad-score";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function block(strategy, horizon) {
  return strategy?.horizons?.[horizon]?.[state.level] ?? null;
}

function confirmedReturn(strategy, horizon) {
  return block(strategy, horizon)?.avgReturnPct ?? null;
}

function sampleCount(strategy) {
  const source = strategy?.horizons?.["10"];
  return state.level === "cohorts" ? source?.cohorts?.n ?? 0 : source?.trades?.n ?? 0;
}

function gradeBadge(strategy) {
  const grade = strategy?.horizons?.["10"]?.sampleGrade;
  if (!grade) return "";
  return `<small class="sample-grade sample-${grade.key}">${grade.label}</small>`;
}

const SORTERS = {
  name: (strategy) => strategy.displayName,
  n: (strategy) => sampleCount(strategy),
  running: (strategy) => strategy.pending?.cohorts ?? 0,
  runningReturn: (strategy) => strategy.pending?.avgReturnPct,
  r3: (strategy) => confirmedReturn(strategy, "3"),
  r5: (strategy) => confirmedReturn(strategy, "5"),
  r10: (strategy) => confirmedReturn(strategy, "10"),
  r20: (strategy) => confirmedReturn(strategy, "20"),
  excess10: (strategy) => block(strategy, "10")?.avgExcessReturnPct,
  median10: (strategy) => block(strategy, "10")?.medianReturnPct,
  win10: (strategy) => block(strategy, "10")?.winRatePct,
  pf10: (strategy) => strategy?.horizons?.["10"]?.trades?.profitFactor,
  mae10: (strategy) => strategy?.horizons?.["10"]?.trades?.avgMaePct,
  latest: (strategy) => strategy.latest?.count ?? 0
};

function sortStrategies(rows) {
  const sorter = SORTERS[state.sortKey] ?? SORTERS.excess10;
  const direction = state.sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sorter(a);
    const right = sorter(b);
    if (typeof left === "string" || typeof right === "string") {
      return String(left).localeCompare(String(right)) * direction;
    }
    const leftValue = Number.isFinite(Number(left)) ? Number(left) : null;
    const rightValue = Number.isFinite(Number(right)) ? Number(right) : null;
    if (leftValue === null && rightValue === null) return a.displayName.localeCompare(b.displayName);
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return (leftValue - rightValue) * direction || a.displayName.localeCompare(b.displayName);
  });
}

const COLUMNS = [
  { key: "name", label: "전략", align: "left", core: true },
  { key: "n", label: "N", core: true },
  { key: "running", label: "진행중", extra: true },
  { key: "runningReturn", label: "진행중 수익", extra: true },
  { key: "r3", label: "3D", extra: true },
  { key: "r5", label: "5D", core: true },
  { key: "r10", label: "10D", core: true },
  { key: "r20", label: "20D", extra: true },
  { key: "excess10", label: "10D 초과", core: true },
  { key: "win10", label: "승률", extra: true },
  { key: "median10", label: "10D 중앙", extra: true },
  { key: "pf10", label: "PF", extra: true },
  { key: "mae10", label: "MAE", extra: true },
  { key: "latest", label: "최근 선정", extra: true }
];

function headerCells() {
  return COLUMNS.map((column) => {
    const active = state.sortKey === column.key ? ` aria-sort="${state.sortDir === "asc" ? "ascending" : "descending"}"` : "";
    const arrow = state.sortKey === column.key ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
    return `<th class="${column.extra ? "col-extra" : ""}"${active}><button class="th-sort" type="button" data-sort="${column.key}">${column.label}${arrow}</button></th>`;
  }).join("");
}

function strategyRow(strategy) {
  const pending = strategy.pending ?? {};
  const cells = [
    `<td class="strategy-name"><button class="link-btn" type="button" data-detail="${strategy.id}">${escapeHtml(strategy.displayName)}</button><small>${escapeHtml(strategy.description ?? "")}</small></td>`,
    `<td>${sampleCount(strategy)}${gradeBadge(strategy)}</td>`,
    `<td class="col-extra running-cell">${pending.cohorts ?? 0}</td>`,
    `<td class="col-extra running-cell ${tone(pending.avgReturnPct)}">${pct(pending.avgReturnPct)}</td>`,
    `<td class="col-extra ${tone(confirmedReturn(strategy, "3"))}">${pct(confirmedReturn(strategy, "3"))}</td>`,
    `<td class="${tone(confirmedReturn(strategy, "5"))}">${pct(confirmedReturn(strategy, "5"))}</td>`,
    `<td class="${tone(confirmedReturn(strategy, "10"))}">${pct(confirmedReturn(strategy, "10"))}</td>`,
    `<td class="col-extra ${tone(confirmedReturn(strategy, "20"))}">${pct(confirmedReturn(strategy, "20"))}</td>`,
    `<td class="${tone(block(strategy, "10")?.avgExcessReturnPct)}">${pct(block(strategy, "10")?.avgExcessReturnPct)}</td>`,
    `<td class="col-extra">${rate(block(strategy, "10")?.winRatePct)}</td>`,
    `<td class="col-extra ${tone(block(strategy, "10")?.medianReturnPct)}">${pct(block(strategy, "10")?.medianReturnPct)}</td>`,
    `<td class="col-extra">${plain(strategy?.horizons?.["10"]?.trades?.profitFactor)}</td>`,
    `<td class="col-extra ${tone(strategy?.horizons?.["10"]?.trades?.avgMaePct)}">${pct(strategy?.horizons?.["10"]?.trades?.avgMaePct)}</td>`,
    `<td class="col-extra">${strategy.latest ? `${strategy.latest.count}종목<small>${strategy.latest.signalDate}</small>` : "-"}</td>`
  ];
  return `<tr>${cells.join("")}</tr>`;
}

function strategyTable(rows) {
  const body = rows.length
    ? sortStrategies(rows).map(strategyRow).join("")
    : `<tr><td colspan="${COLUMNS.length}" class="loading">아직 기록이 없습니다. 다음 거래일 장마감 이후 자동으로 쌓입니다.</td></tr>`;
  return `<div class="validation-table-wrap"><table class="validation-table strategy-table"><thead><tr>${headerCells()}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderMetrics() {
  const data = state.data ?? {};
  const meta = data.meta ?? {};
  const strategies = data.strategies ?? [];
  const runningCohorts = strategies.reduce((sum, row) => sum + (row.pending?.cohorts ?? 0), 0);
  const lastEvaluated = strategies.map((row) => row.pending?.lastEvaluatedDate).filter(Boolean).sort().at(-1) ?? "-";
  document.querySelector("#strategyMetrics").innerHTML = [
    ["기록 시작일", meta.firstDate ?? "아직 없음", `${(meta.signalDates ?? []).length} 거래일 기록`],
    ["추적 전략", `${meta.strategyCount ?? 0}개`, `순위 ${meta.rankingStrategyCount ?? 0} · 조건 ${meta.conditionStrategyCount ?? 0}`],
    ["20D까지 확정", `${meta.completedRecordCount ?? 0}건`, `진행중 ${meta.pendingRecordCount ?? 0}건`],
    ["진행중 cohort", `${runningCohorts}개`, `오늘 기준 ${ymd(lastEvaluated)}`]
  ].map(([label, value, sub]) => `<article class="metric"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></article>`).join("");
}

function renderTables() {
  const data = state.data ?? {};
  const strategies = data.strategies ?? [];
  const target = document.querySelector("#strategyTables");
  document.querySelector("#strategyTableTitle").textContent = state.scope === "featured" ? "대표 전략 비교" : "전체 전략 비교";

  if (state.scope === "featured") {
    const featured = new Set(data.featured ?? []);
    target.innerHTML = strategyTable(strategies.filter((row) => featured.has(row.id)));
    return;
  }
  const groups = data.groups ?? [];
  target.innerHTML = groups.map((group) => {
    const rows = strategies.filter((row) => row.group === group.id);
    if (!rows.length) return "";
    return `<section class="strategy-group"><h3>${escapeHtml(group.label)}<small>${escapeHtml(group.description)}</small></h3>${strategyTable(rows)}</section>`;
  }).join("");
}

function factorSummary(factors) {
  if (!factors) return "-";
  const parts = [
    factors.leaderGrade ? `Leader ${factors.leaderGrade}${Number.isFinite(factors.leaderScore) ? ` ${factors.leaderScore}` : ""}` : null,
    Number.isFinite(factors.rs20) ? `RS ${factors.rs20}` : null,
    Number.isFinite(factors.combinedScore) ? `타이밍 ${factors.combinedScore}` : null,
    Number.isFinite(factors.rankingV2Tier) ? `T${factors.rankingV2Tier}` : null,
    Number.isFinite(factors.riskScore) ? `Risk ${factors.riskScore}` : null,
    Number.isFinite(factors.stabilizeScore) ? `Stab ${factors.stabilizeScore}` : null,
    Number.isFinite(factors.drawdownPct) ? `DD ${Math.round(factors.drawdownPct)}%` : null,
    factors.cafe ? "CAFE" : null,
    factors.mtt ? "MTT" : null,
    factors.actionable ? "진입후보" : null
  ].filter(Boolean);
  return escapeHtml(parts.join(" · "));
}

function detailRows(cohort) {
  return cohort.rows.map((row) => {
    const live = row.live;
    const confirmed = HORIZONS.map((horizon) => {
      const outcome = row.outcomes?.[horizon];
      return `<td class="${tone(outcome?.netReturnPct)}">${outcome ? pct(outcome.netReturnPct) : '<span class="pending-chip">진행중</span>'}</td>`;
    }).join("");
    return `<tr>
      <td>${row.strategyRank ?? "-"}</td>
      <td><a class="stock-link" href="https://stock.naver.com/domestic/stock/${row.code}/price" target="_blank" rel="noopener noreferrer">${escapeHtml(row.name)}</a><small>${row.code}</small></td>
      <td class="factor-cell">${factorSummary(row.factors)}</td>
      <td>${price(row.entryOpen)}<small>${row.entryDate ? ymd(row.entryDate) : "진입 대기"}</small></td>
      <td class="${tone(live?.currentReturnPct)}">${live ? `${pct(live.currentReturnPct)}<small>${live.tradingDaysElapsed}거래일 · ${ymd(live.lastEvaluatedDate)}</small>` : "-"}</td>
      ${confirmed}
      <td class="${tone(row.outcomes?.["10"]?.excessReturnPct)}">${row.outcomes?.["10"] ? pct(row.outcomes["10"].excessReturnPct) : "-"}</td>
    </tr>`;
  }).join("");
}

function renderDetail(detail, strategy) {
  const panel = document.querySelector("#strategyDetailPanel");
  panel.hidden = false;
  document.querySelector("#strategyDetailTitle").textContent = `${strategy?.displayName ?? detail.strategyId} 상세`;
  document.querySelector("#strategyDetailSub").textContent = `${strategy?.description ?? ""} · 과거 결과는 당시 snapshot 그대로이며 현재 값으로 재계산하지 않습니다.`;
  const body = detail.cohorts.length ? detail.cohorts.map((cohort) => `
    <section class="cohort-block">
      <h4>${cohort.signalDate} · ${cohort.market}
        <small>선정 ${cohort.validCount}/${cohort.targetCount}종목 · 10D 코호트 ${pct(cohort.cohortReturns?.["10"]?.returnPct)} · 진행중 ${pct(cohort.liveReturnPct)}</small>
      </h4>
      <div class="validation-table-wrap">
        <table class="validation-table detail-table">
          <thead><tr><th>순위</th><th>종목</th><th>당시 factor</th><th>진입가</th><th>현재(진행중)</th><th>1D</th><th>3D</th><th>5D</th><th>10D</th><th>20D</th><th>10D 초과</th></tr></thead>
          <tbody>${detailRows(cohort)}</tbody>
        </table>
      </div>
    </section>`).join("") : '<p class="loading">해당 전략의 기록이 아직 없습니다.</p>';
  document.querySelector("#strategyDetail").innerHTML = body;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function render() {
  renderMetrics();
  renderTables();
  const meta = state.data?.meta ?? {};
  const missing = (meta.missingSnapshotDates ?? []).length;
  document.querySelector("#strategyStatus").textContent = [
    `${(meta.signalDates ?? []).length}개 기록일`,
    `20D 확정 ${meta.completedRecordCount ?? 0}건 · 진행중 ${meta.pendingRecordCount ?? 0}건`,
    missing ? `기록 없는 평일 ${missing}일(휴장일 포함, 소급 생성하지 않음)` : "누락 없음",
    `집계 기준: ${state.level === "cohorts" ? "코호트 동일비중" : "개별 종목"} · 확정 성과와 진행중 수익은 분리 표시`
  ].join(" · ");
}

async function loadSummary() {
  document.querySelector("#strategyStatus").textContent = "전략 기록 집계 중";
  const response = await fetch(`/api/strategy-validation?market=${state.market}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error((await response.json()).error ?? "전략 기록을 불러오지 못했습니다.");
  state.data = await response.json();
  render();
}

async function loadDetail(strategyId) {
  state.detailId = strategyId;
  const response = await fetch(`/api/strategy-validation/detail?id=${encodeURIComponent(strategyId)}&market=${state.market}&limit=40`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error((await response.json()).error ?? "전략 상세를 불러오지 못했습니다.");
  const detail = await response.json();
  renderDetail(detail, (state.data?.strategies ?? []).find((row) => row.id === strategyId));
}

function showError(error) {
  document.querySelector("#strategyStatus").textContent = error.message;
}

function bindTabs(selector, key, onChange) {
  document.querySelector(selector).addEventListener("click", (event) => {
    const button = event.target.closest(`[data-${key}]`);
    if (!button) return;
    state[key] = button.dataset[key];
    document.querySelectorAll(`${selector} button`).forEach((item) => item.classList.toggle("active", item === button));
    onChange();
  });
}

bindTabs("#strategyMarkets", "market", () => {
  loadSummary().then(() => {
    if (state.detailId) loadDetail(state.detailId).catch(showError);
  }).catch(showError);
});
bindTabs("#strategyScope", "scope", render);
bindTabs("#strategyLevel", "level", render);

document.querySelector("#strategyTables").addEventListener("click", (event) => {
  const sortButton = event.target.closest("[data-sort]");
  if (sortButton) {
    const key = sortButton.dataset.sort;
    if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else {
      state.sortKey = key;
      state.sortDir = key === "name" ? "asc" : "desc";
    }
    render();
    return;
  }
  const detailButton = event.target.closest("[data-detail]");
  if (detailButton) loadDetail(detailButton.dataset.detail).catch(showError);
});

document.querySelector("#strategyDetailClose").addEventListener("click", () => {
  state.detailId = null;
  document.querySelector("#strategyDetailPanel").hidden = true;
});

document.querySelector("#strategyRefresh").addEventListener("click", () => loadSummary().catch(showError));

loadSummary().catch(showError);
