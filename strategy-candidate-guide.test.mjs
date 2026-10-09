import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {buildCandidateGuide} from "./public/strategy-candidate-guide.js";

const full = JSON.parse(readFileSync(new URL("./public/strategy-experiments.json",import.meta.url),"utf8"));
const sampleOos = new Map([
  ["TIMING_TOP3",{n:32,net:2.322,excess:1.515}],
  ["LEADER_AB_AND_REBOUND_READY",{n:23,net:1.972,excess:1.403}],
  ["TIMING_TOP20",{n:32,net:1.139,excess:.333}],
  ["DRAWDOWN_40_50",{n:32,net:2.321,excess:1.515}],
  ["DRAWDOWN_30_40",{n:32,net:1.643,excess:.837}],
  ["REBOUND_READY",{n:32,net:1.694,excess:.888}],
  ["LEADER_TOP5",{n:32,net:-3.756,excess:-4.562}],
  ["LEADER_90_AND_RS90",{n:24,net:-5.97,excess:-6.286}],
  ["MTT",{n:32,net:.433,excess:-.373}]
]);

test("recommendation groups require positive recent OOS and historical capital/MDD gates",()=>{
  const groups=buildCandidateGuide(full.accounts,sampleOos);
  assert.deepEqual(groups.map(g=>g.key),["forward","historic","caution"]);
  assert.deepEqual(groups[0].accounts.map(a=>a.id),[
    "TIMING_TOP3","LEADER_AB_AND_REBOUND_READY","TIMING_TOP20"
  ]);
  assert.deepEqual(groups[1].accounts.map(a=>a.id),[
    "LEADER_TOP5","LEADER_90_AND_RS90","MTT"
  ]);
  assert.deepEqual(groups[2].accounts.map(a=>a.id),[
    "DRAWDOWN_40_50","REBOUND_READY","DRAWDOWN_30_40"
  ]);
});

test("strong retrospective profit cannot override negative OOS or dangerous historic drawdown",()=>{
  const groups=buildCandidateGuide(full.accounts,sampleOos);
  const ids=new Set(groups[0].accounts.map(a=>a.id));
  assert.ok(!ids.has("LEADER_TOP5"));
  assert.ok(!ids.has("DRAWDOWN_40_50"));
  assert.ok(!ids.has("REBOUND_READY"));
});

test("future changes in OOS data change forward candidate ranking rather than freezing old list",()=>{
  const changed=new Map(sampleOos);
  changed.set("TIMING_TOP3",{n:32,net:-1,excess:-2});
  changed.set("LEADER_TOP5",{n:35,net:3,excess:2});
  const groups=buildCandidateGuide(full.accounts,changed);
  const ids=groups[0].accounts.map(a=>a.id);
  assert.ok(ids.includes("LEADER_TOP5"));
  assert.ok(!ids.includes("TIMING_TOP3"));
  assert.equal(new Set(groups.flatMap(g=>g.accounts.map(a=>a.id))).size,groups.reduce((n,g)=>n+g.accounts.length,0));
});

test("candidate summary is visible before detailed 107-strategy table",()=>{
  const page=readFileSync(new URL("./public/strategy-experiments.html",import.meta.url),"utf8");
  const script=readFileSync(new URL("./public/strategy-experiments.js",import.meta.url),"utf8");
  assert.ok(page.indexOf('id="candidateGuidePanel"')<page.indexOf('id="expRows"'));
  assert.match(page,/strategy-candidates.css/);
  assert.match(script,/renderCandidateGuide/);
  assert.match(script,/data-view-strategy/);
  assert.match(script,/OOS 최종 신호일/);
  assert.match(page,/전진 모의매매 연구 우선순위/);
});
