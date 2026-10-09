import { evaluateResearchQualityGate } from "./strategy-quality-gate.js";
const $=(id)=>document.getElementById(id);
const esc=(v)=>String(v??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]));
const num=(v)=>Number(v||0).toLocaleString("ko-KR");
const badge=(s)=>s==="PASS"?"통과":s==="WARN"?"주의":s==="UNKNOWN"?"미확인":"검증 차단";
function show(data,live) {
 const gate=evaluateResearchQualityGate(data,live?.meta?.signalDates);
 $("auditGate").innerHTML=`<strong>실전 자동매매 데이터 게이트: ${gate.status==="BLOCKED"?"차단":"수동 검토 필요"}</strong>
 <span>오류 의심 수익·누락 OOS가 있는 상태에서는 과거 전략의 높은 수익률이 실전 주문 근거가 될 수 없습니다.
 원본 가격·수익은 수정하지 않았습니다. 데이터 감사 파일 생성일 ${esc(data.generatedAt?.slice(0,10))}.</span>`;
 const rows=[
   ["고정 종목 우주",`${num(data.input.matrixUniverse)}종목`],
   ["과거 관측치",`${num(data.input.matrixRows)}건`],
   ["원시 OHLC 일봉",`${num(data.rawPrices.totals.quoteBarCount)}개`],
   ["극단 수익률 라벨",`${num(data.futureReturnExtremes.count)}건`],
   ["미기록 OOS 거래일",`${num(gate.missingDates.length)}일`],
   ["실전 자동주문", "차단"]
 ];
 $("auditMetrics").innerHTML=rows.map(([name,value])=>`<article class="metric-card"><span>${esc(name)}</span><strong>${esc(value)}</strong></article>`).join("");
 $("auditChecks").innerHTML=data.checks.map(c=>`<article class="candidate-group"><h3>${esc(c.label)}</h3>
  <p><b>${esc(badge(c.status))}</b></p>
  <p class="candidate-group-intro">${esc(c.message)}</p></article>`).join("");
 $("auditDatesStatus").textContent=`기록기간 ${gate.lastSignalDate?"최신 신호 "+gate.lastSignalDate:"확인 중"} · 휴장일 제외 · 정상 거래일 ${gate.missingDates.length}일 기록 부재`;
 $("auditMissingDates").innerHTML=gate.missingDates.length?
  `<p>${gate.missingDates.map(x=>`<code>${esc(x)}</code>`).join(" · ")}</p>`:
  "<p>현재 검사한 거래일 구간에서 새 누락 없음. 과거 200종목 편향과 가격검사는 별도 해결이 필요합니다.</p>";
 $("auditTopCodes").innerHTML=data.futureReturnExtremes.topCodes.map(x=>`<tr><td><b>${esc(x.code)}</b></td><td>${num(x.n)}건</td></tr>`).join("");
}
Promise.all([
 fetch("/strategy-data-quality.json",{cache:"no-store"}).then(r=>{if(!r.ok)throw Error("audit HTTP "+r.status);return r.json();}),
 fetch("/api/strategy-validation",{cache:"no-store"}).then(r=>{if(!r.ok)throw Error("OOS HTTP "+r.status);return r.json();})
]).then(([data,live])=>show(data,live)).catch(e=>{
 $("auditGate").innerHTML=`<strong>실전 자동매매 데이터 게이트: 차단</strong><span>${esc(e.message)} · 검사결과 조회 불가, 실패 우선 적용</span>`;
 $("auditDatesStatus").textContent="누락 기간 미확인 — 차단";
});
