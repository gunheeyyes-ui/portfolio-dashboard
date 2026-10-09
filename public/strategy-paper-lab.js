const id = (key) => document.getElementById(key);
const pct = (n) => Number.isFinite(Number(n)) && n !== null ? `${Number(n) > 0 ? "+" : ""}${Number(n).toFixed(2)}%` : "—";
const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (s) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[s]));
const num = (n) => Number(n ?? 0).toLocaleString("ko-KR");

function accountCell(account, hold) {
  const s = account.holds?.[String(hold)];
  if (!s) return "<td>—</td>";
  const n = Number(s.closedTrades || 0);
  const opens = Number(s.openPositions || 0);
  const queued = Number(s.queuedOrders || 0);
  if (n === 0) return `<td><span class="cell-sub">${opens ? `보유 ${opens}` : queued ? `시가 대기 ${queued}` : "거래 전"}</span></td>`;
  const net = s.comparableReturnPct;
  const cls = Number(net) >= 0 ? "positive" : "negative";
  return `<td class="${cls}"><b>${pct(net)}</b><div class="cell-sub">완료 ${n} · MDD ${pct(s.maxDrawdownPct)}${s.quarantinedClosedTrades ? ` · 격리 ${s.quarantinedClosedTrades}` : ""}</div></td>`;
}

function buildRow(a, isShortlist = false) {
  const oos = a.oos ?? {};
  const badge = isShortlist ? "" : a.shortlisted ? "우선 검증" : a.qualified ? "잠정 통과" : "관찰";
  const extra = isShortlist ? "" : `<td>${escapeHtml(badge)}</td>`;
  const retClass = oos.netPct > 0 ? "positive" : oos.netPct < 0 ? "negative" : "";
  const exClass = oos.excessPct > 0 ? "positive" : oos.excessPct < 0 ? "negative" : "";
  return `<tr>
    <td><b>${escapeHtml(a.name)}</b><div class="cell-sub">${escapeHtml(a.id)}</div></td>
    <td>${num(oos.n)}${oos.quarantinedTrades ? `<small> 제외 ${num(oos.quarantinedTrades)}건</small>` : ""}</td>
    <td class="${retClass}">${pct(oos.netPct)}</td>
    <td class="${exClass}">${pct(oos.excessPct)}</td>
    ${extra}
    ${[3, 5, 10, 20].map((h) => accountCell(a, h)).join("")}
  </tr>`;
}

function render(model) {
  const d = model.diagnostics ?? {};
  const total = model.leaderboard?.length ?? 0;
  const missed = d.oosMissingSnapshotDates?.length ?? 0;
  id("labMetrics").innerHTML = [
    ["OOS 전략", `${num(total)}개`],
    ["독립 가상계좌", `${num(d.independentAccountCount)}개`],
    ["잠정 선별 통과", `${num(d.provisionalQualified)}개`],
    ["우선 비교 후보", `${num(d.shortlistCount)}개`],
    ["검증 시작 신호일", escapeHtml(model.startSignalDate)],
    ["OOS 누락 평일", `${num(missed)}일 (휴장 포함)`]
  ].map(([label, value]) => `<article class="metric-card"><span>${label}</span><strong>${value}</strong></article>`).join("");
  const recorded = d.oosLastSignalDate || "없음";
  id("labStatus").textContent = `OOS 최종 신호일: ${recorded} · 앞으로 발생하는 신호부터 자금·청산조건을 똑같이 비교합니다. 과거 수익 소급 없음.`;
  id("labShortlist").innerHTML = model.shortlist?.length
    ? model.shortlist.map((a) => buildRow(a, true)).join("")
    : '<tr><td colspan="8">현재 기준을 만족하는 잠정 후보가 없습니다. 107개 가상계좌 추적은 유지합니다.</td></tr>';
  id("labAll").innerHTML = model.leaderboard?.length
    ? model.leaderboard.map((a) => buildRow(a, false)).join("")
    : '<tr><td colspan="9">전략 정보가 없습니다.</td></tr>';
}

let expanded = false;
id("labToggle").addEventListener("click", () => {
  expanded = !expanded;
  id("labFullWrap").hidden = !expanded;
  id("labToggle").textContent = expanded ? "전체 목록 접기" : "전체 107개 보기";
});

async function refresh() {
  id("labRefresh").disabled = true;
  try {
    const response = await fetch("/api/strategy-paper-lab", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    id("labStatus").textContent = `검증 데이터 조회 실패: ${error.message}`;
    id("labShortlist").innerHTML = '<tr><td colspan="8">서버 데이터 또는 접근 권한을 확인하세요.</td></tr>';
  } finally {
    id("labRefresh").disabled = false;
  }
}
id("labRefresh").addEventListener("click", refresh);
refresh();
