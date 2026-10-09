import { evaluateResearchQualityGate } from "./strategy-quality-gate.js";
import { classifyOosGaps } from "./strategy-oos-gap-reasons.js";
const $=(id)=>document.getElementById(id);
const esc=(v)=>String(v??"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]));
const num=(v)=>Number(v||0).toLocaleString("ko-KR");
const badge=(s)=>s==="PASS"?"통과":s==="WARN"?"주의":s==="UNKNOWN"?"미확인":"검증 차단";
function show(data,live,evidence,pit) {
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
 $("auditPitStatus").innerHTML=pit?`<p><b>${num(pit.validatedDailyFiles)} / ${num(pit.expectedDailyFiles)}개 시장·일자별 원천 파일 검증 완료</b></p>
 <p>과거 ${num(pit.requiredDays)} 거래일 × KOSPI/KOSDAQ 2개 시장 · 미수집 ${num(pit.missingFileCount)}개 · 검증 미통과 ${num(pit.invalidFileCount)}개</p>
 <p>${pit.readyForPitRebuild?"일별 전종목 스냅샷 완비 — 다음 주가조정 검증 필요":"전종목 과거 백테스트 데이터 미확보 · 기존 200종목 과거 수익률 신뢰 불가"}</p>
 <p class="candidate-guide-disclaimer">자동 수집기 환경의 인증키 설정: ${pit.credentialConfigured?"설정 확인":"미설정"}. 키 값은 대시보드나 저장소에 기록되지 않습니다.</p>`
  :'<p>KRX 원천 데이터 준비상태를 조회하지 못했습니다. 실전 사용 불가.</p>';
 $("auditChecks").innerHTML=data.checks.map(c=>`<article class="candidate-group"><h3>${esc(c.label)}</h3>
  <p><b>${esc(badge(c.status))}</b></p>
  <p class="candidate-group-intro">${esc(c.message)}</p></article>`).join("");
 $("auditDatesStatus").textContent=`기록기간 ${gate.lastSignalDate?"최신 신호 "+gate.lastSignalDate:"확인 중"} · 휴장일 제외 · 정상 거래일 ${gate.missingDates.length}일 기록 부재`;
 $("auditMissingDates").innerHTML=gate.missingDates.length?
  `<p>${gate.missingDates.map(x=>`<code>${esc(x)}</code>`).join(" · ")}</p>`:
  "<p>현재 검사한 거래일 구간에서 새 누락 없음. 과거 200종목 편향과 가격검사는 별도 해결이 필요합니다.</p>";
 const diagnoses=classifyOosGaps(gate.missingDates,live?.meta?.skipped||[]);
 const known=diagnoses.rows.filter(x=>x.status==="CONFIRMED_QUARANTINED");
 $("auditGapCauses").innerHTML=`<article class="candidate-group"><h3>원인 확인: ${num(diagnoses.confirmedQuarantine)}일</h3>
  ${known.map(x=>`<p class="candidate-group-intro"><b>${esc(x.date)}</b> · 시장 데이터 부족으로 격리.
  당시 KOSPI ${num(x.marketCounts?.KOSPI)} / KOSDAQ ${num(x.marketCounts?.KOSDAQ)}종목,
  전략기록 ${num(x.removed?.strategyRecords)}건 · 선택 ${num(x.removed?.strategySelections)}건은 백업 후 제외됨</p>`).join("")||'<p class="candidate-group-intro">노출된 기록에 원인 확인 없음</p>'}
 </article><article class="candidate-group"><h3>추가 원인 확인 필요: ${num(diagnoses.unresolved)}일</h3>
 <p class="candidate-group-intro">당일 실행 기록 또는 EOD 수집 서버 로그와 대조하지 않은 날짜입니다. 다른 날과 동일한 장애였다고 추정하지 않습니다.</p></article>`;
 $("auditTopCodes").innerHTML=(evidence?.priorityStocks||data.futureReturnExtremes.topCodes.map(x=>({...x,suspiciousLabels:x.n})))
   .map(x=>`<tr><td><b>${esc(x.name?x.name+" · ":"")}${esc(x.code)}</b></td>
   <td>${num(x.suspiciousLabels)}건</td>
   <td>${evidence?num(x.internallyConsistent)+"/"+num(x.suspiciousLabels)+"건 산술 일치":"독립 자료 필요"}</td></tr>`).join("");
 $("auditPriceEvidence").textContent=evidence
   ? `검토 대상 ${num(evidence.summary.extremeLabels)}건 / 내부 매수·매도 가격 산술 일치 ${num(evidence.summary.internalPriceMatches)}건 / 외부 시세 검증 완료 ${num(evidence.summary.thirdPartyValidatedCount)}건. 내부 일봉 자료를 다시 확인한 것만으로 실제 시장가격이나 기업행사가 인증되지는 않습니다.`
   : "원본 OHLC 재대조 파일을 조회할 수 없습니다. 검증 미완료 상태를 유지합니다.";
}
Promise.all([
 fetch("/strategy-data-quality.json",{cache:"no-store"}).then(r=>{if(!r.ok)throw Error("audit HTTP "+r.status);return r.json();}),
 fetch("/api/strategy-validation",{cache:"no-store"}).then(r=>{if(!r.ok)throw Error("OOS HTTP "+r.status);return r.json();}),
 fetch("/strategy-extreme-price-evidence.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).catch(()=>null),
 fetch("/strategy-pit-readiness.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).catch(()=>null)
]).then(([data,live,evidence,pit])=>show(data,live,evidence,pit)).catch(e=>{
 $("auditGate").innerHTML=`<strong>실전 자동매매 데이터 게이트: 차단</strong><span>${esc(e.message)} · 검사결과 조회 불가, 실패 우선 적용</span>`;
 $("auditDatesStatus").textContent="누락 기간 미확인 — 차단";
});
