// Create a compact, sanitized research-only browser snapshot from local grid data.
// The historical private quote cache and full experiment raw records never reach the dashboard.
import { readFileSync, writeFileSync } from "node:fs";
const input = process.argv[2] || "backtest-results-v3/strategy-robustness-grid.json";
const output = process.argv[3] || "public/strategy-experiments.json";
const raw = JSON.parse(readFileSync(input,"utf8"));
if (raw.schema !== "strategy-robustness-grid-v3" || raw.strategyCount !== 107) throw Error("MISMATCHED_GRID");
const metric=(x)=>x?{
  net:x.netPct,drawdown:x.mddPct,n:x.closed,win:x.winPct,pf:x.pf,clean:x.removeTop5PnlPct,
  anomalous:x.abnormalTrades,signals:x.signals,skipped:x.skipped
}:null;
const accounts=raw.results.map((a)=>{
  const choice=a.preHoldoutSelected;
  const stress=raw.costAndMarketStress?.[a.id]||null;
  const control=raw.selectedCandidates.find(x=>x.id===a.id)?.control||null;
  return {
    id:a.id,name:a.name,group:a.group,matched:a.matched,screenPassed:a.screenPassed,
    choice:choice?{
      rule:choice.rule,cap:choice.dailyLimit,priority:choice.priority,
      train:metric(choice.train),validation:metric(choice.validation),holdout:metric(choice.holdout),
      randomMedian:control?.medianPct??null,stress:stress?{
        fee05:metric(stress.roundTripFee05),fee10:metric(stress.roundTripFee10),
        kospi:metric(stress.kospiOnly),kosdaq:metric(stress.kosdaqOnly)
      }:null
    }:null,
    experiments:a.experiments.map(e=>({
      rule:e.rule,cap:e.dailyLimit,priority:e.priority,qualified:e.screenPass,
      train:metric(e.train),validation:metric(e.validation),holdout:metric(e.holdout)
    }))
  };
});
const out={
  schema:"strategy-robustness-browser-v1",
  source:"107 strategies × 7 exits × 3 daily caps × 2 ranking choices × 3 historical chronological windows",
  generatedAt:raw.computedAt,strategies:raw.strategyCount,experimentCount:raw.experimentCount,
  periods:raw.periods,policies:raw.policies,priorities:raw.priorities,dailyCaps:raw.dailyCaps,
  preliminaryQualified:raw.preHoldoutQualified,holdoutScreenPositive:raw.holdoutPositive,
  universe:200,sourceObservations:raw.observations,
  randomControl:raw.randomControl.byPolicy,
  caveats:[
    "연구용 과거 재구성: 후행 선정된 고정 200종목 캐시, 상장폐지·신규편입 종목 누락에 의한 심한 생존자 편향",
    "2026년 전략 정의를 과거에 적용했으므로 날짜로 분할한 HOLDOUT도 엄밀한 미래 OOS가 아님",
    "조건·보유기간·우선순위 13,482회 다중 탐색으로 과최적화·가짜 발견 위험",
    "극단 거래 상위 5개 이익 제거는 사후 민감도 분석이지 실제 체결 백테스트가 아님",
    "관리종목·상하한가 대기열·부분체결·시장충격의 과거 기록 없음; 단순화된 슬리피지 비용만 반영",
    "독립 전략 107개가 아니라 실제 신호·종목이 겹치는 중복 조건이 다수 존재",
    "실전자동주문 비활성화; 실전 후보 판단은 미래 OOS와 전진 가상매매 검증이 우선"
  ],
  accounts
};
if(out.accounts.length!==107||out.accounts.some(a=>a.experiments.length!==42))throw Error("INCOMPLETE_GRID");
writeFileSync(output,JSON.stringify(out));
console.log(JSON.stringify({status:"ok",file:output,rows:out.accounts.length,variations:out.accounts.reduce((s,a)=>s+a.experiments.length,0),checks:out.experimentCount}));
