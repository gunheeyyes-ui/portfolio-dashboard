const el = (id) => document.getElementById(id);
const clean = (v) => String(v ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const nums = (v) => Number(v || 0).toLocaleString("ko-KR");
const pct = (v) => Number.isFinite(Number(v)) && v !== null ? `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(2)}%` : "—";
let model = null;
let period = "test";
let hold = "10";
let filtering = "sample";

function render() {
  if (!model) return;
  const data = model.accounts || [];
  const rows = data.map((a) => ({ ...a, summary: a.holds?.[hold]?.[period] })).filter((a) => {
    const n = Number(a.summary?.trades ?? 0);
    if (filtering === "all") return true;
    if (filtering === "positive") return n >= 20 && Number(a.summary?.pct || 0) > 0;
    return n >= 20;
  }).sort((a, b) => Number(b.summary?.pct ?? -Infinity) - Number(a.summary?.pct ?? -Infinity) || a.id.localeCompare(b.id));
  el("histStatus").textContent = `${period.toUpperCase()} · ${hold}거래일 보유 · 조건 충족 ${rows.length}개 전략. 순위는 편향된 역사적 수익률 기준이며 매수 추천 순위가 아닙니다.`;
  el("histRows").innerHTML = rows.length ? rows.map((a) => {
    const s = a.summary || {};
    const p = Number(s.pct || 0);
    const style = Number(s.trades) > 0 ? (p > 0 ? "positive" : p < 0 ? "negative" : "") : "";
    const result = Number(s.trades) === 0 ? "거래없음" : pct(s.pct);
    return `<tr>
      <td><b>${clean(a.name)}</b><div class="cell-sub">${clean(a.id)}</div></td>
      <td>${nums(s.trades)}</td>
      <td class="${style}"><b>${result}</b></td>
      <td>${Number(s.trades) ? pct(s.compare) : "—"}${s.bad ? `<div class="cell-sub">의심거래 ${nums(s.bad)}건 별도</div>` : ""}</td>
      <td>${Number(s.trades) ? pct(s.win) : "—"}</td>
      <td>${s.pf !== null && Number.isFinite(Number(s.pf)) ? Number(s.pf).toFixed(2) : "—"}</td>
      <td class="negative">${Number(s.trades) ? pct(s.mdd) : "—"}</td>
      <td>${nums(s.signals)}</td>
    </tr>`;
  }).join("") : '<tr><td colspan="8">조건에 맞는 과거 재현 결과가 없습니다.</td></tr>';
}

function showMeta(model) {
  const s = model;
  el("histMetrics").innerHTML = [
    ["전략", `${nums(s.accounts?.length)}개`],
    ["전략×청산", `${nums((s.accounts?.length || 0) * 4)}개`],
    ["과거 데이터 종목", `${nums(s.universe)}개 (고정)`],
    ["관측 종목-날짜", `${nums(s.rawObservations)}개`],
    ["20D까지 완료", `${nums(s.completeObservations)}개`],
    ["평가구간 첫 신호일", `${s.testStart.slice(0,4)}-${s.testStart.slice(4,6)}-${s.testStart.slice(6)}`]
  ].map(([label,value]) => `<article class="metric-card"><span>${clean(label)}</span><strong>${clean(value)}</strong></article>`).join("");
}

for (const btn of el("historicalPeriods").querySelectorAll("button")) {
  btn.addEventListener("click", () => {
    period = btn.dataset.period;
    for (const other of el("historicalPeriods").querySelectorAll("button")) other.classList.toggle("active", other === btn);
    render();
  });
}
for (const btn of el("historicalHolds").querySelectorAll("button")) {
  btn.addEventListener("click", () => {
    hold = btn.dataset.hold;
    for (const other of el("historicalHolds").querySelectorAll("button")) other.classList.toggle("active", other === btn);
    render();
  });
}
el("historicalFilter").addEventListener("change", (event) => {
  filtering = event.target.value;
  render();
});

fetch("/historical-backtest-107.json", {cache: "no-store"}).then((r) => {
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  return r.json();
}).then((json) => {
  model = json;
  if (!model.accounts?.length) throw Error("백테스트 결과가 비어 있습니다.");
  showMeta(model);
  render();
}).catch((error) => {
  el("histStatus").textContent = "과거 백테스트 결과 조회 실패: " + error.message;
  el("histRows").innerHTML = '<tr><td colspan="8">백테스트 결과 파일이 없거나 읽을 수 없습니다.</td></tr>';
});
