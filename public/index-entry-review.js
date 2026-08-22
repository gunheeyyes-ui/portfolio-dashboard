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

function pctTone(value) {
  const n = numberOrNull(value);
  if (n === null || n === 0) return "muted";
  return n > 0 ? "positive" : "negative";
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
    timingScore: numberOrNull(feature.combinedScore),
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

function enrichHomeCandidate(row, item) {
  const sourceRow = item?.row ?? {};
  const feature = item?.feature ?? {};
  const stockEasy = sourceRow.stockEasy ?? {};
  return {
    ...row,
    rankingV2Tier: numberOrNull(feature.rankingV2Tier),
    rankingV2Rank: numberOrNull(feature.rankingV2Rank),
    scoutRank: numberOrNull(feature.scoutRank),
    reboundLabel: sourceRow.confirmation?.reboundState?.label ?? feature.scoutStatus ?? null,
    seMomentum: stockEasy.seMomentum === true,
    sePeak: stockEasy.sePeak === true,
    seValue: stockEasy.seValue === true
  };
}

export function buildHomeEntryCandidates(payload) {
  const items = buildStrategyCandidates(payload);
  const actual = items.map(actualRow).filter(Boolean);
  const review = buildEntryReviewCandidates(items);
  const itemByCode = new Map(items.map((item) => [String(item.feature?.code ?? ""), item]));
  return mergeEntryCandidates(actual, review)
    .map((row) => enrichHomeCandidate(row, itemByCode.get(String(row.code))));
}

function syncHomeEntryHeader() {
  const head = document.querySelector(".home-entry-table thead");
  if (head) head.innerHTML = `
    <tr>
      <th>후보</th>
      <th title="종목명 옆에 현재가·전일·3일·2년 고점 대비 낙폭과 확인 배지를 함께 표시">종목 · 가격/등락</th>
      <th title="Leader 등급·점수. 순위는 KOSPI/KOSDAQ 시장별이라 홈에서는 중복 혼동을 피하려고 숨김">Leader</th>
      <th title="종합타이밍 = Main 70 + Scout 30">타이밍</th>
      <th>RS</th>
      <th>전략·계열</th>
      <th title="T=Ranking V2 Tier · 우=반등우선 시장 내 순위 · 후=반등후보 시장 내 순위">반등</th>
      <th>Risk/Stab</th>
      <th title="기존의 빡빡한 actionable 진입조건 통과 여부. 실제 주문 체결을 뜻하지 않음">기존진입</th>
    </tr>`;

  const guide = document.querySelector(".home-entry-panel .score-guide small");
  if (guide) guide.textContent = "Leader는 등급·점수(A91)만 표시합니다. 순위는 시장별이라 홈에서는 숨깁니다. 반등의 우/후 순위는 각각 반등우선·반등후보의 시장 내 순위입니다.";
}

function candidateLabel(row) {
  if (row.coreCandidate) return '<span class="strategy-badge buy home-entry-badge">🔥핵심</span>';
  if (row.strongCandidate) return '<span class="strategy-badge buy home-entry-badge">⭐강한</span>';
  return '<span class="strategy-badge buy home-entry-badge">✅기존</span>';
}

function stockBadges(row) {
  const badges = [
    row.minerviniPass ? { label: "MTT", tone: "buy", title: "MTT(미네르비니) 통과" } : null,
    row.cafePass ? { label: "CAFE", tone: "buy", title: "CAFE 전략 통과" } : null,
    row.seMomentum ? { label: "SE-MOM", tone: "se", title: "StockEasy 모멘텀 Easy 편입" } : null,
    row.sePeak ? { label: "SE-PEAK", tone: "se secondary", title: "StockEasy 피크 Easy 편입" } : null,
    row.seValue ? { label: "SE-VALUE", tone: "se secondary", title: "StockEasy 밸류 Easy 편입" } : null
  ].filter(Boolean);

  return badges.map((badge) => `<span class="strategy-badge home-stock-badge ${badge.tone}" title="${escapeHtml(badge.title)}">${badge.label}</span>`).join("");
}

function reboundSummary(row) {
  const tier = finite(row.rankingV2Tier) ? Math.trunc(Number(row.rankingV2Tier)) : null;
  const ranking = finite(row.rankingV2Rank) ? Math.trunc(Number(row.rankingV2Rank)) : null;
  const scout = finite(row.scoutRank) ? Math.trunc(Number(row.scoutRank)) : null;
  const state = row.reboundLabel ? ` · ${row.reboundLabel}` : "";
  const tierHtml = tier
    ? `<span class="home-rebound-tier t${Math.min(6, Math.max(1, tier))}" title="Ranking V2 Tier${escapeHtml(state)}">T${tier}</span>`
    : '<span class="home-rebound-rank muted">T-</span>';
  const rankingHtml = ranking
    ? `<span class="home-rebound-rank ${ranking <= 10 ? "top" : ""}" title="반등우선(Ranking V2) 시장 내 ${ranking}위">우${ranking}</span>`
    : '<span class="home-rebound-rank muted">우-</span>';
  const scoutHtml = scout
    ? `<span class="home-rebound-rank ${scout <= 10 ? "top" : ""}" title="반등후보(Scout) 시장 내 ${scout}위">후${scout}</span>`
    : '<span class="home-rebound-rank muted">후-</span>';
  return `${tierHtml}${rankingHtml}${scoutHtml}`;
}

function renderRow(row) {
  const leader = finite(row.leaderScore)
    ? `${row.leaderGrade ?? "-"}${fmtInt.format(row.leaderScore)}`
    : "-";
  const leaderTitle = finite(row.leaderRank)
    ? `기존 검증 기준의 ${row.market || "시장"} Leader ${fmtInt.format(row.leaderRank)}위 · 화면에는 등급/점수만 표시`
    : "Leader 등급·점수";
  const timing = finite(row.timingScore) ? `${fmtInt.format(row.timingScore)}점` : "-";
  const consensus = finite(row.strategyCount) && finite(row.axisCount)
    ? `${row.strategyCount}전략·${row.axisCount}계열`
    : "-";
  const riskStab = `${finite(row.scoutRiskScore) ? fmtInt.format(row.scoutRiskScore) : "-"}/${finite(row.scoutStabilizeScore) ? fmtInt.format(row.scoutStabilizeScore) : "-"}`;
  const actual = row.actualEntry
    ? `<span class="home-entry-actual" title="${escapeHtml(row.category?.label ?? "기존 실제진입 조건 통과")}">✅</span>`
    : '<span class="muted">-</span>';

  return `
    <tr>
      <td>${candidateLabel(row)}</td>
      <td class="home-entry-stock">
        <div class="home-stock-top">
          <a class="stock-link" href="${naverStockUrl(row.code)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.name)}</a>
          <span class="home-stock-badges">${stockBadges(row)}</span>
        </div>
        <div class="home-stock-meta">
          <b>${price(row.price)}</b>
          <span class="${pctTone(row.changeRate)}">전 ${pct(row.changeRate)}</span>
          <span class="${pctTone(row.changeRate3d)}">3일 ${pct(row.changeRate3d)}</span>
          <span class="${pctTone(row.drawdownFromHighPct)}">낙 ${pct(row.drawdownFromHighPct)}</span>
        </div>
      </td>
      <td class="home-entry-leader" title="${escapeHtml(leaderTitle)}"><b>${escapeHtml(leader)}</b></td>
      <td class="home-entry-timing"><b>${escapeHtml(timing)}</b></td>
      <td><b>${finite(row.rs20) ? fmtInt.format(row.rs20) : "-"}</b></td>
      <td><b>${escapeHtml(consensus)}</b></td>
      <td class="home-entry-rebound">${reboundSummary(row)}</td>
      <td><b>${escapeHtml(riskStab)}</b></td>
      <td>${actual}</td>
    </tr>`;
}

async function loadHomeEntryCandidates() {
  const target = document.querySelector("#homeEntryCandidates");
  const status = document.querySelector("#homeEntryStatus");
  if (!target || !status) return;

  syncHomeEntryHeader();
  status.textContent = "🔥 핵심 · ⭐ 강한 · ✅ 기존진입 후보 계산 중";
  target.innerHTML = '<tr><td colspan="9" class="loading">시장 200종목에서 백테스트 우선 후보를 찾고 있습니다.</td></tr>';

  const response = await fetch("/api/market-screener?limit=100&market=ALL", { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "진입후보를 불러오지 못했습니다.");
  const payload = await response.json();
  const rows = buildHomeEntryCandidates(payload).slice(0, 16);
  const core = rows.filter((row) => row.coreCandidate).length;
  const strong = rows.filter((row) => row.strongCandidate).length;
  const actual = rows.filter((row) => row.actualEntry).length;

  status.textContent = `우선순위순 ${rows.length}종목 · 🔥 핵심 ${core} · ⭐ 강한 ${strong} · ✅ 기존진입 ${actual}`;
  target.innerHTML = rows.length
    ? rows.map(renderRow).join("")
    : '<tr><td colspan="9" class="loading">오늘 핵심·강한후보와 기존 진입조건을 충족한 종목이 없습니다.</td></tr>';
}

loadHomeEntryCandidates().catch((error) => {
  const target = document.querySelector("#homeEntryCandidates");
  const status = document.querySelector("#homeEntryStatus");
  if (status) status.textContent = error.message;
  if (target) target.innerHTML = `<tr><td colspan="9" class="loading">${escapeHtml(error.message)}</td></tr>`;
});
