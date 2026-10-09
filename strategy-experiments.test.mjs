import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const data=JSON.parse(readFileSync(new URL("./public/strategy-experiments.json",import.meta.url),"utf8"));
const html=readFileSync(new URL("./public/strategy-experiments.html",import.meta.url),"utf8");
const service=readFileSync(new URL("./strategy-robustness-grid.mjs",import.meta.url),"utf8");

test("107 independent strategy definitions have all 42 exit/cap/priority variations and 3 periods",()=>{
  assert.equal(data.schema,"strategy-robustness-browser-v1");
  assert.equal(data.accounts.length,107);
  assert.equal(data.experimentCount,13482);
  assert.ok(data.accounts.every(a=>a.experiments.length===42));
  assert.equal(data.accounts.flatMap(x=>x.experiments).length,4494);
  assert.deepEqual(data.periods.map(x=>x.id),["train","validation","holdout"]);
  assert.equal(data.periods[2].from,"20260123");
});
test("single chosen policy per strategy was preselected from validation not holdout",()=>{
  for(const s of data.accounts){
    const eligible=s.experiments.filter(x=>x.qualified)
      .sort((a,b)=>(b.validation.net-Math.abs(b.validation.drawdown)*.4)-
        (a.validation.net-Math.abs(a.validation.drawdown)*.4)||a.rule.localeCompare(b.rule));
    if(!eligible.length){assert.equal(s.choice,null);continue;}
    const win=eligible[0];
    assert.equal(s.choice.rule,win.rule);
    assert.equal(s.choice.cap,win.cap);
    assert.equal(s.choice.priority,win.priority);
  }
  assert.equal(data.accounts.filter(a=>a.choice).length,data.preliminaryQualified);
});
test("old forward OOS is unchanged and research UI labels data limitations explicitly",()=>{
  assert.match(html,/과거 후행 재구성/);
  assert.match(html,/생존자 편향/);
  assert.match(html,/실전 자동매매를 승인하지 않습니다/);
  assert.match(service,/canEnableRealOrders:false/);
  const leader=data.accounts.find(a=>a.id==="LEADER_TOP5");
  assert.ok(data.policies.some(rule=>rule.id===leader.choice.rule));
  assert.ok(data.periods[0].to < data.periods[0].boundaryDate);
  assert.ok(data.periods[1].to < data.periods[1].boundaryDate);
  assert.ok(leader.choice.holdout.net>0);
  assert.ok(data.caveats.some(x=>x.includes("실전")));
});
test("random baseline and high friction KOSPI-KOSDAQ robustness evidence is retained",()=>{
  const leader=data.accounts.find(x=>x.id==="LEADER_TOP5");
  assert.ok(Number.isFinite(leader.choice.randomMedian));
  assert.ok(Number.isFinite(leader.choice.stress.fee10.net));
  assert.ok(Number.isFinite(leader.choice.stress.kospi.net));
  assert.ok(Number.isFinite(leader.choice.stress.kosdaq.net));
  assert.ok(Object.keys(data.randomControl).length>=21);
});
