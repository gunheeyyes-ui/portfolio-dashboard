// UI-only research triage. It does not alter trading strategies or forward OOS.
// The historical backtest has severe fixed-universe survivorship bias.
export const MIN_RESEARCH_OOS_COHORTS = 20;
const comparable = (a, o) => {
  const h = a.choice?.holdout;
  return Boolean(
    o && o.n >= MIN_RESEARCH_OOS_COHORTS &&
    o.net > 0 && o.excess > 0 &&
    h && h.net >= -15 && h.drawdown >= -30
  );
};
const byIds = (accounts, ids, blocked) => ids
  .filter((id)=>!blocked.has(id))
  .map((id)=>accounts.find((a)=>a.id===id)).filter(Boolean);
const group = (key,title,subtitle,accounts) => ({key,title,subtitle,accounts});
export function buildCandidateGuide(accounts=[], oosById=new Map()) {
  const ranked = accounts.filter(a => comparable(a,oosById.get(a.id)) &&
    !["FLAG_C","FLAG_I"].includes(a.id))
    .sort((a,b) =>
      (oosById.get(b.id)?.excess??0)-(oosById.get(a.id)?.excess??0) ||
      (oosById.get(b.id)?.net??0)-(oosById.get(a.id)?.net??0) ||
      a.id.localeCompare(b.id)
    ).slice(0,3);
  const blocked = new Set(ranked.map(a=>a.id));
  const historical = byIds(accounts,["LEADER_TOP5","LEADER_90_AND_RS90","MTT"],blocked);
  for(const a of historical)blocked.add(a.id);
  const caution = byIds(accounts,["DRAWDOWN_40_50","REBOUND_READY","DRAWDOWN_30_40"],blocked);
  return [
    group("forward","① 전진 모의매매 우선","최근 OOS가 플러스이고, 과거 후반 계좌손익·낙폭도 최소 안전 기준을 충족한 조합",ranked),
    group("historic","② 과거 강세 · 최근 OOS 확인 필요","백테스트가 좋더라도 실제 OOS 손실이나 시장 초과수익 부진이 있으면 승격하지 않음",historical),
    group("caution","③ 위험 · 자동매매 보류","최근 OOS가 일부 양수더라도 과거 계좌손실·큰 낙폭으로 실전 후보에서 제외",caution)
  ];
}
