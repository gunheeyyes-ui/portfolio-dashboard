import { buildStrategyCandidates } from "./strategy-candidate-engine.js";
import {
  buildEntryReviewCandidates,
  mergeEntryCandidates
} from "./entry-review-candidates.js";

if (!document.querySelector('link[href="/home-entry-compact.css"]')) {
  const compactStyles = document.createElement("link");
  compactStyles.rel = "stylesheet";
  compactStyles.href = "/home-entry-compact.css";
  document.head.appendChild(compactStyles);
}

const fmtNum = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function numberOrNull(value) {
  return finite(value) ? Number(value) : null;
}

function pct(value) {
  const n = numberOrNull(value);
  return n === null ? "-" : `${n >= 0 ? "+" : ""}${fmtNum.format(n)}%`;
}

function price(value) {
  const n = numberOrNull(value);
  return n === null ? "-" : `${fmtInt.format(Math.round(n))}원`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function naverStockUrl(code) {
  return `https://stock.naver.com/domestic/stock/${code}/price`;
}

function actualRow(item) {
  const feature = item.feature ?? {};
  const row = item.row ?? {};
  if (feature.actionable !== true) return null;
  return {
    code: String(feature.code ?? ""),
    name: feature.name ?? "",
    market: feature.market ?? "",
    source: "market",
    sourceLabel: feature.market ?? "시장",
    price: numberOrNull(feature.signalPrice),
    changeRate: numberOrNull(row.changeRate ?? row.quote?.changeRate ?? row.strategy?.dayChangePct),
    changeRate3d: numberOrNull(row.changeRate3d ?? row.strategy?.change3dPct),
    drawdownFromHighPct: numberOrNull(feature.drawdownPct),
    liquidityScore: numberOrNull(feature.liquidityScore),
    foreignStreak: numberOrNull(feature.foreignStreak),
    instStreak: numberOrNull(feature.institutionStreak),
    leaderScore: numberOrNull(feature.leaderScore),
    leaderGrade: feature.leaderGrade ?? null,
    leaderRank: numberOrNull(feature.leaderRank),
    rs20: numberOrNull(feature.rs20),
    scoutRiskScore: numberOrNull(feature.riskScore),
    scoutStabilizeScore: numberOrNull(feature.stabilizeScore),
    strategyCount: item.matches?.length ?? 0,
    axisCount: item.axesAll?.length ?? 0,
    axisLabels: (item.axesAll ?? []).map((axis) => axis.label),
    cafePass: feature.cafe === true,
    minerviniPass: feature.mtt === true,
    leaderReboundPass: feature.leaderRebound === true,
    judgement: row.judgement ?? "",
    reasons: Array.isArray(row.reasons) ? row.reasons.slice(0, 6) : [],
    category: {
      key: feature.simCategory ?? "actual",
      label: feature.simCategoryLabel ?? "실제진입",
      actionable: true
    }
  };
}

export function buildHomeEntryCandidates(payload) {
  const items = buildStrategyCandidates(payload);
  const actual = items.map(actualRow).filter(Boolean);
  const review = buildEntryReviewCandidates(items);
  return mergeEntryCandidates(actual, review);
}

function candidateLabel(row) {
  if (row.coreCandidate) return '<span class="strategy-badge buy home-entry-badge">🔥핵심</span>';
  if (row.strongCandidate) return '<span class="strategy-badge buy home-entry-badge">⭐강한</span>';
  return '<span class="strategy-badge buy home-entry-badge">✅실제</span>';
}

function renderRow(row) {
  const leader = finite(row.leaderScore)
    ? `${finite(row.leaderRank) ? `#${row.leaderRank} ` : ""}${row.leaderGrade ?? "-"} ${fmtNum.format(Number(row.leaderScore))}`
    : "-";
  const consensus = finite(row.strategyCount) && finite(row.axisCount)
    ? `${row.strategyCount}전략·${row.axisCount}계열`
    : "-";
  const riskStab = `${finite(row.scoutRiskScore) ? fmtInt.format(row.scoutRiskScore) : "-"}/${finite(row.scoutStabilizeScore) ? fmtInt.format(row.scoutStabilizeScore) : "-"}`;
  const actual = row.actualEntry
    ? `<span class="home-entry-actual" title="${escapeHtml(row.category?.label ?? "기존 실제진입")}">✅</span>`
    : '<span class="muted">-</span>';

  return `
    <tr>
      <td>${candidateLabel(row)}</td>
      <td class="home-entry-stock">
        <a class="stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.name)}</a>
        <small>${price(row.price)}</small>
      </td>
      <td><b>${escapeHtml(leader)}</b></td>
      <td><b>${finite(row.rs20) ? fmtInt.format(row.rs20) : "-"}</b></td>
      <td><b>${escapeHtml(consensus)}</b></td>
      <td><b>${escapeHtml(riskStab)}</b></td>
      <td><b>${pct(row.drawdownFromHighPct)}</b></td>
      <td><b>${pct(row.changeRate3d)}</b></td>
      <td>${actual}</td>
    </tr>`;
}

async function loadHomeEntryCandidates() {
  const target = document.querySelector("#homeEntryCandidates");
  const status = document.querySelector("#homeEntryStatus");
  if (!target || !status) return;

  status.textContent = "🔥 핵심 · ⭐ 강한 · ✅ 실제진입 후보 계산 중";
  target.innerHTML = '<tr><td colspan="9" class="loading">시장 200종목에서 백테스트 우선 후보를 찾고 있습니다.</td></tr>';

  const response = await fetch("/api/market-screener?limit=100&market=ALL", { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "진입후보를 불러오지 못했습니다.");
  const payload = await response.json();
  const rows = buildHomeEntryCandidates(payload).slice(0, 16);
  const core = rows.filter((row) => row.coreCandidate).length;
  const strong = rows.filter((row) => row.strongCandidate).length;
  const actual = rows.filter((row) => row.actualEntry).length;

  status.textContent = `우선순위순 ${rows.length}종목 · 🔥 핵심 ${core} · ⭐ 강한 ${strong} · ✅ 실제진입 ${actual}`;
  target.innerHTML = rows.length
    ? rows.map(renderRow).join("")
    : '<tr><td colspan="9" class="loading">오늘 핵심·강한후보와 기존 실제진입 조건을 충족한 종목이 없습니다.</td></tr>';
}

loadHomeEntryCandidates().catch((error) => {
  const target = document.querySelector("#homeEntryCandidates");
  const status = document.querySelector("#homeEntryStatus");
  if (status) status.textContent = error.message;
  if (target) target.innerHTML = `<tr><td colspan="9" class="loading">${escapeHtml(error.message)}</td></tr>`;
});
