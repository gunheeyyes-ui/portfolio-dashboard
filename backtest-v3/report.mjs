// Report rendering. Every table states its sample size, and no table is
// titled "best strategy" — results carry a verdict instead.

const VERDICT_NOTE = {
  "유망": "TEST에서도 개선 + 표본 충분",
  "견고 가능성": "인접 threshold에서도 비슷",
  "표본부족": "N 부족 — 결론 보류",
  "과최적화 위험": "TRAIN 우수 / TEST 붕괴",
  "역효과": "대조군(전체)보다 나쁨",
  "중립": "뚜렷한 개선 없음"
};

function table(rows, columns) {
  if (!rows.length) return "_해당 조건을 만족하는 결과가 없습니다._\n";
  const head = `| ${columns.map((c) => c.label).join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${columns.map((c) => fmtCell(c.get(r))).join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}\n`;
}

function fmtCell(v) {
  if (v === null || v === undefined || v === "") return "-";
  return String(v).replace(/\|/g, "\\|");
}

const STRATEGY_COLUMNS = [
  { label: "전략", get: (r) => r.strategy },
  { label: "TEST N", get: (r) => r.testTrades },
  { label: "TEST 평균%", get: (r) => r.testAvgPct },
  { label: "TEST 승률%", get: (r) => r.testWinRatePct },
  { label: "TEST PF", get: (r) => r.testPF },
  { label: "TRAIN 평균%", get: (r) => r.trainAvgPct },
  { label: "Gap", get: (r) => r.generalizationGap },
  { label: "초과%", get: (r) => r.testExcessPct },
  { label: "판정", get: (r) => r.verdict }
];

function topBy(rows, horizon, { minTest, limit = 10, filter = () => true }) {
  return rows
    .filter((r) => r.horizonDays === horizon && (r.testTrades ?? 0) >= minTest && filter(r))
    .sort((a, b) => (b.testAvgPct ?? -999) - (a.testAvgPct ?? -999))
    .slice(0, limit);
}

function section(title, body) {
  return `\n## ${title}\n\n${body}`;
}

export function buildReport(ctx) {
  const {
    stamp, startDate, endDate, universe, skipped, observations, splitDate,
    holds, focusHorizon, costPct, minTrades, baseline,
    singles, twoFactor, triples, presets, topN, sweep, diagnostics
  } = ctx;

  const marketCount = (m) => universe.filter((u) => u.market === m).length;
  const base = baseline.find((b) => b.horizonDays === focusHorizon);

  const byAxis = (axis) => singles.filter((r) => r.axis === axis);

  let md = `# Backtest Lab V3 리포트

> **CURRENT-UNIVERSE SURVIVORSHIP BIAS** — 과거 시점의 실제 구성종목이 아니라 현재 시가총액 상위 종목을
> 과거로 소급 적용했습니다. 당시 상장폐지·편출된 종목이 빠져 있어 성과가 낙관적으로 치우칠 수 있습니다.
> 또한 상장주식수는 현재 값을 사용하므로 과거 시가총액/회전율은 근사치입니다.

- 기간: ${startDate} ~ ${endDate} (TRAIN/TEST 분리일 **${splitDate}**)
- 유니버스: KOSPI ${marketCount("KOSPI")} / KOSDAQ ${marketCount("KOSDAQ")} (캐시 없음으로 제외 ${skipped.length})
- 관측치: **${observations.length.toLocaleString()}**
- 보유기간: ${holds.join(", ")}일 · 왕복비용 ${costPct}%
- 아래 표는 모두 **${focusHorizon}일 보유, TEST 표본** 기준이며 최소 ${minTrades}거래 이상만 노출합니다.
- 진입은 항상 **신호 다음 거래일 시가**입니다.

### 대조군 (전체 관측, 필터 없음)

| 보유 | TEST N | TEST 평균% | TEST 승률% | TEST PF |
| --- | --- | --- | --- | --- |
${baseline.map((b) => `| ${b.horizonDays}일 | ${b.testTrades} | ${b.testAvgPct ?? "-"} | ${b.testWinRatePct ?? "-"} | ${b.testPF ?? "-"} |`).join("\n")}

필터의 가치는 이 대조군을 **넘는지**로 판단해야 합니다. ${focusHorizon}일 대조군 평균은 **${base?.testAvgPct ?? "-"}%** 입니다.

### 판정 기준

${Object.entries(VERDICT_NOTE).map(([k, v]) => `- **${k}** — ${v}`).join("\n")}
`;

  md += section("A. 단독 필터 (TEST 상위)", table(topBy(singles, focusHorizon, { minTest: minTrades }), STRATEGY_COLUMNS));
  md += section("B. 2-factor 조합 (TEST 상위)", table(topBy(twoFactor, focusHorizon, { minTest: minTrades }), STRATEGY_COLUMNS));
  md += section("C. 핵심 3-factor", table(topBy(triples, focusHorizon, { minTest: Math.max(5, Math.floor(minTrades / 2)) }), STRATEGY_COLUMNS));
  md += section("프리셋", table(topBy(presets, focusHorizon, { minTest: minTrades, limit: 25 }), STRATEGY_COLUMNS));

  md += section("D. 순위체계 비교 (TOP-N, daily cohort)",
    `쿨다운을 적용하지 않은 **일별 코호트** 기준이라 위 전략 표와 직접 비교하면 안 됩니다.\n\n` +
    table(
      topN.filter((r) => r.horizonDays === focusHorizon).sort((a, b) => a.rankSystem.localeCompare(b.rankSystem) || a.topN - b.topN),
      [
        { label: "순위체계", get: (r) => r.rankSystem },
        { label: "TOP", get: (r) => r.topN },
        { label: "TEST N", get: (r) => r.testTrades },
        { label: "TEST 평균%", get: (r) => r.testAvgPct },
        { label: "TEST 승률%", get: (r) => r.testWinRatePct },
        { label: "TEST PF", get: (r) => r.testPF },
        { label: "초과%", get: (r) => r.testExcessPct },
        { label: "판정", get: (r) => r.verdict }
      ]));

  const axisTable = (axis) => table(
    byAxis(axis).filter((r) => r.horizonDays === focusHorizon).sort((a, b) => a.strategy.localeCompare(b.strategy)),
    STRATEGY_COLUMNS);

  md += section("E. 낙폭 구간별", axisTable("drawdown"));
  md += section("F. Leader 등급별", axisTable("leaderGrade"));
  md += section("G. Risk / Stabilize", axisTable("risk") + "\n" + axisTable("stab"));
  md += section("H. RS20 구간별", axisTable("rs20"));
  md += section("Ranking V2 Tier별", axisTable("rankingTier"));
  md += section("전략 flag별 (I는 대조군 검증용)", axisTable("flag"));

  md += section("I. TRAIN vs TEST — 과최적화 경고",
    table(
      singles.concat(twoFactor, triples).filter((r) => r.horizonDays === focusHorizon && r.overfitWarning)
        .sort((a, b) => (b.trainAvgPct ?? 0) - (a.trainAvgPct ?? 0)).slice(0, 15),
      STRATEGY_COLUMNS));

  md += section("J. Threshold 민감도 (Robust / Fragile)",
    `인접 cut에서도 성과가 유지되면 견고, 특정 값에서만 좋으면 취약합니다.\n\n` +
    table(sweep, [
      { label: "지표", get: (r) => r.sweep },
      { label: "cut", get: (r) => `${r.direction}${r.cut}` },
      { label: "TEST N", get: (r) => r.testTrades },
      { label: "TEST 평균%", get: (r) => r.testAvgPct },
      { label: "인접 cut TEST 평균%", get: (r) => r.neighbourTestAvg },
      { label: "판정", get: (r) => r.verdict }
    ]));

  md += section("데이터 한계", `
- ${diagnostics.investorNAPct}% 관측치에서 외국인/기관 수급이 **DATA UNAVAILABLE** 입니다. 해당 필터는 그 구간을 제외하고 계산했으며 0으로 간주하지 않았습니다.
- Leader 계산불가 ${diagnostics.leaderNA}건, Scout 계산불가 ${diagnostics.scoutNA}건.
- H3/VWAP는 일봉 거래대금÷거래량 기반 **EOD 근사**이며 분봉 재구성이 아닙니다.
- 재무 point-in-time 데이터가 없어 CAFE는 기술+수급 프록시입니다(라이브와 동일 정의).
- 제외된 종목 ${skipped.length}개: ${skipped.slice(0, 10).map((s) => s.code).join(", ")}${skipped.length > 10 ? " …" : ""}
`);

  return md;
}
