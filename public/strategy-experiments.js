import { buildCandidateGuide } from "./strategy-candidate-guide.js";
import { evaluateResearchQualityGate } from "./strategy-quality-gate.js";
const $ = (key) => document.getElementById(key);
const escapeHtml=(value)=>String(value??"").replace(/[&<>"']/g,(x)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]));
const pct=(v)=> v===null||v===undefined||!Number.isFinite(Number(v))?"—":`${v>0?"+":""}${Number(v).toFixed(2)}%`;
const cls=(v)=>v>0?"positive":v<0?"negative":"";
const number=(x)=>Number(x??0).toLocaleString("ko-KR");
let db=null,oos=new Map(),oosSignalDates=[],filterMode="qual",sortBy="validation",selectedId="LEADER_TOP5";
const policyName=(id)=>({"fixed3":"3일 고정","fixed5":"5일 고정","fixed10":"10일 고정","fixed20":"20일 고정",
 "sl5_tp8_5":"-5%/+8% 최대5D","sl5_tp8_10":"-5%/+8% 최대10D","sl8_tp15_20":"-8%/+15% 최대20D"}[id]||id);
const overallPass=(a)=>{
  const q=a.choice?.holdout;
  return Boolean(q&&q.n>=20&&q.net>0&&q.drawdown>=-20&&q.clean>0);
};
function renderCandidateGuide(){
  if (!db) return;
  const groups = buildCandidateGuide(db.accounts,oos);
  const notes = {
    TIMING_TOP3:"최근 OOS가 상대적으로 우세하지만 과거 매매규칙의 후반 평가 손실이 있었음",
    LEADER_AB_AND_REBOUND_READY:"과거 후반 평가와 최근 OOS가 플러스이나 과거 낙폭·극단수익 민감도를 유의",
    TIMING_TOP20:"폭넓은 종목 분산형 비교군. 최근 시장초과수익 폭은 작음",
    LEADER_TOP5:"과거 수익은 높지만 최근 OOS 손실로 실전 승격 보류",
    LEADER_90_AND_RS90:"Leader·RS 결합의 과거 강세가 최근 OOS에서 재현되지 않음",
    MTT:"과거 강세지만 최근 시장초과수익은 음수",
    DRAWDOWN_40_50:"최근 OOS 플러스여도 과거 계좌손실·최대낙폭이 큼",
    REBOUND_READY:"최근 OOS와 과거 계좌 리플레이가 상충하고 최대낙폭이 큼",
    DRAWDOWN_30_40:"과거 계좌 손실과 큰 최대낙폭으로 연구용만 유지"
  };
  $("candidateGuide").innerHTML=groups.map(group=>`<div class="candidate-group">
    <h3>${escapeHtml(group.title)}</h3>
    <p class="candidate-group-intro">${escapeHtml(group.subtitle)}</p>
    ${group.accounts.length ? group.accounts.map((a,index)=>{
      const recent=oos.get(a.id);
      const back=a.choice?.holdout;
      const explanation=notes[a.id]||"전진 OOS와 과거 계좌 재현 결과를 별도로 확인";
      const rule=a.choice ? `${policyName(a.choice.rule)} · 하루 최대 ${a.choice.cap}종목 · ${a.choice.priority==="native"?"전략순":"타이밍순"}` : "과거에서 선택 조건을 통과한 청산규칙 없음";
      return `<article class="candidate-entry">
        <div class="candidate-entry-heading">
          <strong><span class="candidate-entry-index">${String(index+1).padStart(2,"0")}</span>${escapeHtml(a.name)}</strong>
        </div>
        <div class="candidate-entry-data">
          <div><span>전진 OOS 10D 평균 · 코호트 ${number(recent?.n)}</span><b class="${cls(recent?.net)}">${pct(recent?.net)}</b></div>
          <div><span>시장대비 초과수익</span><b class="${cls(recent?.excess)}">${pct(recent?.excess)}p</b></div>
          <div><span>과거 후반 계좌수익</span><b class="${cls(back?.net)}">${back?pct(back.net):"—"}</b></div>
          <div><span>과거 계좌 MDD</span><b>${back?pct(back.drawdown):"—"}</b></div>
        </div>
        <p class="candidate-entry-details">${escapeHtml(explanation)}</p>
        <p class="candidate-entry-details">과거 연구 조합: ${escapeHtml(rule)}</p>
        <button type="button" class="ghost-btn" data-view-strategy="${escapeHtml(a.id)}">42개 매매조건 비교 ↓</button>
      </article>`;
    }).join(""):'<p class="candidate-empty">현재 조건을 충족하는 전략 없음. 원본 107개 실험은 계속 확인 가능합니다.</p>'}
   </div>`).join("");
  const last=oosSignalDates.at(-1)??"확인 불가";
  $("candidateGuideStatus").textContent=`OOS 최종 신호일: ${last} · 기록된 신호일 ${oosSignalDates.length}일.
  OOS 코호트 N은 시장별 날짜 묶음의 개수로 독립 거래일 수와 다릅니다.
  ① 자동 기준: OOS 10D 코호트 20개 이상, 평균·시장초과 모두 양수,
  과거 후반 재현 -15% 이상, MDD -40% 이상. 연구용 감시 기준이며 실전 적합성 기준이 아닙니다. 이 조건은 연구용 임시 분류이며 실전 주문을 승인하지 않습니다.
  ②③ 대표 비교군은 수동 선정했습니다. 과거 고정 200종목 표본과 OOS 이상값에 주의하세요.`;
}

$("candidateGuide").addEventListener("click",(event)=>{
  const button=event.target.closest("button[data-view-strategy]");
  if (!button || !db) return;
  const id=button.dataset.viewStrategy;
  if (!db.accounts.some(x=>x.id===id)) return;
  selectedId=id;
  $("expStrategy").value=id;
  renderDetails();
  $("expStrategy").scrollIntoView({behavior:"smooth",block:"center"});
});

function renderOverview(){
  if(!db)return;
  let rows=[...db.accounts].filter((a)=>filterMode==="all"||(filterMode==="qual"&&a.choice)||(filterMode==="validated"&&overallPass(a)));
  rows.sort((a,b)=> sortBy==="name"?a.name.localeCompare(b.name):
    (sortBy==="validation"?((b.choice?.validation.net??-1e9)-(a.choice?.validation.net??-1e9)):
      ((b.choice?.holdout.net??-1e9)-(a.choice?.holdout.net??-1e9))) || a.id.localeCompare(b.id));
  $("expStatus").textContent=`보이는 전략 ${rows.length}개 · 통과 여부는 사전 정의한 연구용 필터일 뿐 실전승인 아님 · 실제 OOS는 표본 부족 및 이상가격에 주의`;
  $("expRows").innerHTML=rows.map(a=>{
    const c=a.choice, v=c?.validation, h=c?.holdout, trueOos=oos.get(a.id);
    const desc=c?`${policyName(c.rule)} · 일별 ${c.cap}개 · ${c.priority==="native"?"전략순":"타이밍순"}`:"선별 기준 미통과";
    return `<tr>
     <td><b>${escapeHtml(a.name)}</b><div class="cell-sub">${escapeHtml(a.id)}</div></td>
     <td>${escapeHtml(desc)}</td>
     <td class="${cls(c?.train.net)}">${c?pct(c.train.net):"—"}</td>
     <td class="${cls(v?.net)}">${v?pct(v.net):"—"}</td>
     <td class="${cls(h?.net)}">${h?pct(h.net):"—"}${h&&!overallPass(a)?'<div class="cell-sub">후반 필터 미통과</div>':""}</td>
     <td class="negative">${h?pct(h.drawdown):"—"}</td>
     <td>${h?number(h.n):"—"}</td>
     <td class="${cls(c?.randomMedian)}">${c?pct(c.randomMedian):"—"}</td>
     <td class="${cls(trueOos?.net)}">${trueOos?pct(trueOos.net):"—"}${trueOos?`<div class="cell-sub">코호트 ${number(trueOos.n)} · 시장초과 ${pct(trueOos.excess)}</div>`:""}</td>
    </tr>`;
  }).join("")||'<tr><td colspan="9">조건에 맞는 전략이 없습니다.</td></tr>';
}
function renderDetails(){
  if(!db)return;
  const row=db.accounts.find(a=>a.id===selectedId)||db.accounts[0];
  if(!row)return;
  const recommended=row.choice;
  $("expVariants").innerHTML=[...row.experiments]
    .sort((a,b)=>Number(b.qualified)-Number(a.qualified) || b.validation.net-a.validation.net)
    .map(item=>{
      const chosen=Boolean(recommended&&item.rule===recommended.rule&&item.cap===recommended.cap&&item.priority===recommended.priority);
      return `<tr>
       <td><b>${policyName(item.rule)}</b>${chosen?'<div class="cell-sub">훈련·검증 기준 선정</div>':""}</td>
       <td>${item.cap}종목</td><td>${item.priority==="native"?"전략순":"타이밍순"}</td>
       <td class="${cls(item.train.net)}">${pct(item.train.net)}</td>
       <td class="${cls(item.validation.net)}">${pct(item.validation.net)}</td>
       <td class="${cls(item.holdout.net)}">${pct(item.holdout.net)}</td>
       <td class="negative">${pct(item.holdout.drawdown)}</td>
       <td>${number(item.holdout.n)}</td>
      </tr>`;
    }).join("");
}
function render(){
  if(!db)return;
  $("expMetrics").innerHTML=[
    ["원본 전략",`${db.strategies}개`],["총 조합×기간",number(db.experimentCount)+"회"],
    ["TRAIN+VALIDATION 잠정 통과",db.preliminaryQualified+"개"],
    ["후반 평가 조건도 통과",db.holdoutScreenPositive+"개"],
    ["대상 우주","후행 고정 200종목"],["실제 자동주문","0건"]
  ].map(([title,value])=>`<article class="metric-card"><span>${escapeHtml(title)}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
  const target=$("expStrategy");
  target.innerHTML=db.accounts.map(a=>`<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)} (${escapeHtml(a.id)})</option>`).join("");
  if(!db.accounts.some(a=>a.id===selectedId))selectedId=db.accounts[0].id;
  target.value=selectedId;
  renderOverview();renderDetails();renderCandidateGuide();
}
for(const control of $("expFilter").querySelectorAll("button"))control.addEventListener("click",()=>{
  filterMode=control.dataset.mode;
  for(const other of $("expFilter").querySelectorAll("button"))other.classList.toggle("active",other===control);
  renderOverview();
});
$("expOrder").addEventListener("change",(ev)=>{sortBy=ev.target.value;renderOverview();});
$("expStrategy").addEventListener("change",(ev)=>{selectedId=ev.target.value;renderDetails();});
Promise.all([
  fetch("/strategy-experiments.json",{cache:"no-store"}).then(r=>{if(!r.ok)throw Error("과거 실험 "+r.status);return r.json();}),
  fetch("/api/strategy-validation?market=ALL",{cache:"no-store"}).then(r=>r.ok?r.json():null).catch(()=>null),
  fetch("/strategy-data-quality.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).catch(()=>null)
]).then(([model,oosData,auditData])=>{
  db=model;
  if(db.schema!=="strategy-robustness-browser-v1"||db.accounts?.length!==107)throw Error("107개 실험자료 누락");
  oosSignalDates=oosData?.meta?.signalDates||[];
  const quality=evaluateResearchQualityGate(auditData,oosSignalDates);
  const status=quality.status==="BLOCKED"?"차단":"수동 검토 필요";
  const reasons=quality.reasons.join(", ")||"기본 실전 승인 불가";
  $("qualityGateSummary").innerHTML=`<strong>실전 전략 선정 데이터 검사: ${status}</strong>
    <span>문제 코드: ${escapeHtml(reasons)}. 미기록 거래일 ${quality.missingDates.length}일.
    <b>아래 전략은 연구용 관찰 대상이며 어느 것도 실전 자동주문 가능 상태가 아닙니다.</b>
    <a href="/strategy-data-quality.html">감사 결과 자세히 보기</a></span>`;
  oos=new Map((oosData?.strategies||[]).map(a=>[a.id,{
    n:a.horizons?.["10"]?.cohorts?.n||0,
    net:a.horizons?.["10"]?.cohorts?.avgReturnPct??null,
    excess:a.horizons?.["10"]?.cohorts?.avgExcessReturnPct??null
  }]));
  render();
}).catch((err)=>{
  $("expStatus").textContent=`조회 실패: ${err.message}`;
  $("expRows").innerHTML='<tr><td colspan="9">데이터를 확인해주세요.</td></tr>';
});
