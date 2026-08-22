import { buildStrategyCandidates } from "./strategy-candidate-engine.js";
import {
  buildEntryReviewCandidates,
  mergeEntryCandidates
} from "./entry-review-candidates.js";

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

function label(row) {
  if (row.coreCandidate) return "🔥 핵심후보";
  if (row.strongCandidate) return "⭐ 강한후보";
  return "✅ 실제진입";
}

function badges(row) {
  return [
    row.coreCandidate ? '<span class="strategy-badge buy">🔥 핵심후보</span>' : "",
    row.strongCandidate ? '<span class="strategy-badge buy">⭐ 강한후보</span>' : "",
    row.actualEntry ? '<span class="strategy-badge buy">✅ 실제진입</span>' : "",
    row.cafePass ? '<span class="strategy-badge buy">CAFE</span>' : "",
    row.minerviniPass ? '<span class="strategy-badge buy">MTT</span>' : ""
  ].join("");
}

function renderCard(row) {
  const leader = finite(row.leaderScore)
    ? `${finite(row.leaderRank) ? `#${row.leaderRank} · ` : ""}${row.leaderGrade ?? "-"} ${fmtNum.format(Number(row.leaderScore))}`
    : "-";
  const consensus = finite(row.strategyCount) && finite(row.axisCount)
    ? `${row.strategyCount}전략 · ${row.axisCount}계열`
    : "-";
  const riskStab = `${finite(row.scoutRiskScore) ? fmtInt.format(row.scoutRiskScore) : "-"}/${finite(row.scoutStabilizeScore) ? fmtInt.format(row.scoutStabilizeScore) : "-"}`;
  const why = row.coreCandidate
    ? "Leader TOP10 + 5전략+ + 3계열+"
    : row.strongCandidate
      ? "Leader A + RS80+ + 3계열+"
      : row.category?.label ?? "기존 실제진입";

  return `
    <article class="sim-card buy">
      <div class="sim-card-head">
        <span class="badge buy">${label(row)}</span>
        <small>${escapeHtml(row.market || row.sourceLabel || "시장")}${row.actualEntry && row.category?.label ? ` · ${escapeHtml(row.category.label)}` : ""}</small>
      </div>
      <a class="stock-link sim-name" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.name)}</a>
      <div class="cell-sub">${escapeHtml(row.code)} · ${price(row.price)} · 당일 ${pct(row.changeRate)}</div>
      <div class="sim-mini">
        <span>Leader <b>${escapeHtml(leader)}</b></span>
        <span>RS20 <b>${finite(row.rs20) ? fmtInt.format(row.rs20) : "-"}</b></span>
        <span>합의 <b>${consensus}</b></span>
        <span>Risk/Stab <b>${riskStab}</b></span>
        <span>낙폭 <b>${pct(row.drawdownFromHighPct)}</b></span>
        <span>3일등락 <b>${pct(row.changeRate3d)}</b></span>
      </div>
      <div class="strategy-badges">${badges(row)}</div>
      <p>${escapeHtml(why)}</p>
    </article>`;
}

async function loadHomeEntryCandidates() {
  const target = document.querySelector("#homeEntryCandidates");
  const status = document.querySelector("#homeEntryStatus");
  if (!target || !status) return;

  status.textContent = "🔥 핵심 · ⭐ 강한 · ✅ 실제진입 후보 계산 중";
  target.innerHTML = '<article class="trade-empty"><strong>계산 중</strong><span>시장 200종목에서 백테스트 우선 후보를 찾고 있습니다.</span></article>';

  const response = await fetch("/api/market-screener?limit=100&market=ALL", { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "진입후보를 불러오지 못했습니다.");
  const payload = await response.json();
  const rows = buildHomeEntryCandidates(payload).slice(0, 16);
  const core = rows.filter((row) => row.coreCandidate).length;
  const strong = rows.filter((row) => row.strongCandidate).length;
  const actual = rows.filter((row) => row.actualEntry).length;

  status.textContent = `우선순위순 ${rows.length}종목 · 🔥 핵심 ${core} · ⭐ 강한 ${strong} · ✅ 실제진입 ${actual}`;
  target.innerHTML = rows.length
    ? rows.map(renderCard).join("")
    : '<article class="trade-empty"><strong>오늘 진입후보 없음</strong><span>핵심·강한후보와 기존 실제진입을 모두 확인했지만 조건 충족 종목이 없습니다.</span></article>';
}

loadHomeEntryCandidates().catch((error) => {
  const target = document.querySelector("#homeEntryCandidates");
  const status = document.querySelector("#homeEntryStatus");
  if (status) status.textContent = error.message;
  if (target) target.innerHTML = `<article class="trade-empty"><strong>진입후보 불러오기 실패</strong><span>${escapeHtml(error.message)}</span></article>`;
});
