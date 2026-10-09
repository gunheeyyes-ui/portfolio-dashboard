const $ = (key) => document.getElementById(key);
const escapeHtml=(value)=>String(value??"").replace(/[&<>"']/g,(x)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[x]));
const pct=(v)=> v===null||v===undefined||!Number.isFinite(Number(v))?"—":`${v>0?"+":""}${Number(v).toFixed(2)}%`;
const cls=(v)=>v>0?"positive":v<0?"negative":"";
const number=(x)=>Number(x??0).toLocaleString("ko-KR");
let db=null,oos=new Map(),filterMode="qual",sortBy="validation",selectedId="LEADER_TOP5";
const policyName=(id)=>({"fixed3":"3일 고정","fixed5":"5일 고정","fixed10":"10일 고정","fixed20":"20일 고정",
 "sl5_tp8_5":"-5%/+8% 최대5D","sl5_tp8_10":"-5%/+8% 최대10D","sl8_tp15_20":"-8%/+15% 최대20D"}[id]||id);
const overallPass=(a)=>{
  const q=a.choice?.holdout;
  return Boolean(q&&q.n>=20&&q.net>0&&q.drawdown>=-20&&q.clean>0);
};
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
  renderOverview();renderDetails();
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
  fetch("/api/strategy-validation?market=ALL",{cache:"no-store"}).then(r=>r.ok?r.json():null).catch(()=>null)
]).then(([model,oosData])=>{
  db=model;
  if(db.schema!=="strategy-robustness-browser-v1"||db.accounts?.length!==107)throw Error("107개 실험자료 누락");
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
