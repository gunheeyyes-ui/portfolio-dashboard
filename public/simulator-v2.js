import {
  SIMULATION_V2_COHORTS,
  SIMULATION_V2_HORIZONS,
  buildSimulationV2,
  latestExcursion
} from "./simulation-v2.js";

const fmtNum = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

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

function tone(value) {
  return finite(value) && Number(value) < 0 ? "negative" : "positive";
}

function naverStockUrl(code) {
  return `https://stock.naver.com/domestic/stock/${code}/price`;
}

function cohortBadges(row) {
  return SIMULATION_V2_COHORTS.filter((cohort) => row[cohort.id])
    .map((cohort) => `<span class="strategy-badge buy">${cohort.label}</span>`)
    .join("");
}

async function fetchDetail(id) {
  const params = new URLSearchParams({ id, market: "ALL", limit: "120" });
  const response = await fetch(`/api/strategy-validation/detail?${params}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error((await response.json()).error ?? `${id} load failed`);
  return response.json();
}

async function loadV2() {
  const status = document.querySelector("#simV2Status");
  if (status) status.textContent = "OOS 기록에서 실제진입·핵심·강한후보를 재구성 중입니다.";

  const [actual, leaderTop10, consensus5s3a, leaderARs80, axis3plus] = await Promise.all([
    fetchDetail("ACTIONABLE_ALL"),
    fetchDetail("LEADER_TOP10"),
    fetchDetail("CONSENSUS_5S_3A"),
    fetchDetail("LEADER_A_AND_RS80"),
    fetchDetail("CONSENSUS_AXIS_3_PLUS")
  ]);
  const model = buildSimulationV2({ actual, leaderTop10, consensus5s3a, leaderARs80, axis3plus });
  renderV2(model);
}

function renderMetrics(model) {
  const rows = model.rows ?? [];
  const pending = rows.filter((row) => row.status !== "COMPLETE").length;
  const metrics = [
    ["V2 누적 신호", `${rows.length}건`, `최근 OOS 최대 120코호트 기준`, "watch-text"],
    ["🔥 핵심", `${model.cohorts.core.trades}건`, `진행 ${model.cohorts.core.pending} · 5D ${pct(model.cohorts.core.horizons["5"].avgReturnPct)}`, tone(model.cohorts.core.horizons["5"].avgReturnPct)],
    ["⭐ 강한", `${model.cohorts.strong.trades}건`, `진행 ${model.cohorts.strong.pending} · 5D ${pct(model.cohorts.strong.horizons["5"].avgReturnPct)}`, tone(model.cohorts.strong.horizons["5"].avgReturnPct)],
    ["✅ 실제진입", `${model.cohorts.actual.trades}건`, `진행 ${model.cohorts.actual.pending} · 전체 진행 ${pending}`, tone(model.cohorts.actual.horizons["5"].avgReturnPct)]
  ];
  document.querySelector("#simV2Metrics").innerHTML = metrics.map(([label, value, sub, cls = ""]) => `
    <article class="metric">
      <div class="label">${label}</div>
      <div class="value ${cls}">${value}</div>
      <div class="sub">${sub}</div>
    </article>
  `).join("");
}

function renderCohortSummary(model) {
  document.querySelector("#simV2Cohorts").innerHTML = SIMULATION_V2_COHORTS.map((cohort) => {
    const stat = model.cohorts[cohort.id];
    const cells = SIMULATION_V2_HORIZONS.map((horizon) => {
      const block = stat.horizons[String(horizon)];
      return `<td><b class="${tone(block.avgReturnPct)}">${pct(block.avgReturnPct)}</b><div class="cell-sub">승 ${pct(block.winRatePct)} · n=${block.n}</div></td>`;
    }).join("");
    return `<tr>
      <td><b>${cohort.label}</b><div class="cell-sub">누적 ${stat.trades} · 진행 ${stat.pending}</div></td>
      ${cells}
    </tr>`;
  }).join("");
}

function horizonCell(row, horizon) {
  const outcome = row.outcomes?.[String(horizon)];
  if (!outcome) return "-";
  return `<b class="${tone(outcome.netReturnPct)}">${pct(outcome.netReturnPct)}</b>`;
}

function renderRecentRows(model) {
  const rows = (model.rows ?? []).slice(0, 50);
  document.querySelector("#simV2Rows").innerHTML = rows.length ? rows.map((row) => {
    const excursion = latestExcursion(row);
    const strategyText = row.strategyCount || row.axisCount
      ? `${row.strategyCount}전략 · ${row.axisCount}계열`
      : "전략 계산 없음";
    const axes = row.axisLabels?.length ? row.axisLabels.join(" · ") : "-";
    const matched = row.strategyNames?.length ? row.strategyNames.slice(0, 6).join(" · ") : "-";
    const live = row.status !== "COMPLETE" && row.live ? pct(row.live.currentReturnPct) : "완료";
    return `<tr>
      <td>${row.signalDate}<div class="cell-sub">${row.market}</div></td>
      <td>
        <a class="stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${row.name}</a>
        <div class="cell-sub">${row.code}</div>
        <div class="strategy-badges">${cohortBadges(row)}</div>
      </td>
      <td>${price(row.signalPrice)}<div class="cell-sub">→ 다음날 시가 ${price(row.entryOpen)}</div></td>
      <td><b>${strategyText}</b><div class="cell-sub">${axes}</div><div class="cell-sub" title="${matched}">${matched}</div></td>
      <td>${horizonCell(row, 1)}</td>
      <td>${horizonCell(row, 3)}</td>
      <td>${horizonCell(row, 5)}</td>
      <td>${horizonCell(row, 10)}</td>
      <td>${horizonCell(row, 20)}</td>
      <td><b class="${tone(row.live?.currentReturnPct)}">${live}</b><div class="cell-sub">${row.entryDate ?? "진입 대기"}</div></td>
      <td><b>${excursion.horizon === null ? "-" : `${excursion.horizon}D`}</b><div class="cell-sub">MFE ${pct(excursion.mfePct)} · MAE ${pct(excursion.maePct)}</div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="11" class="loading">아직 OOS 기반 Simulation V2 기록이 없습니다.</td></tr>`;
}

function renderV2(model) {
  renderMetrics(model);
  renderCohortSummary(model);
  renderRecentRows(model);
  const status = document.querySelector("#simV2Status");
  if (status) {
    status.textContent = model.latestSignalDate
      ? `자동 OOS 기록 기반 · 최근 신호 ${model.latestSignalDate} · 다음 거래일 시가 진입 · 1/3/5/10/20 거래일 순수익 및 MFE/MAE`
      : "아직 기록된 OOS 신호가 없습니다. 서버 EOD 스케줄이 자동으로 쌓습니다.";
  }
}

function renderFailure(error) {
  const status = document.querySelector("#simV2Status");
  if (status) status.textContent = `Simulation V2 불러오기 실패: ${error.message}`;
  document.querySelector("#simV2Rows").innerHTML = `<tr><td colspan="11" class="loading">${error.message}</td></tr>`;
}

document.querySelector("#refreshBtn")?.addEventListener("click", () => loadV2().catch(renderFailure));
loadV2().catch(renderFailure);
