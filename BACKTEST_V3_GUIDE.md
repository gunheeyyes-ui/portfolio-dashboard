# Backtest Lab V3 — 필터 조합형 연구 백테스트

V3는 **새로운 투자점수를 만들지 않습니다.** 대시보드에 이미 있는 필터·점수·상태·배지를
조합해서, 그중 무엇이 실제 미래수익률에 기여했는지 검증하는 도구입니다.

V2(`backtest-lab-v2.mjs`)는 그대로 두었고, V3는 V2의 캐시(`backtest-cache-v2`)와
계산부를 재사용합니다.

## 2단계 구조

성능 설계의 핵심입니다. 필터를 하나 더 시험한다고 데이터를 다시 받지 않습니다.

```
1) feature matrix   backtest-cache-v2 → backtest-v3/matrix/feature-matrix-*.json
                    (네트워크 호출 없음. 캐시에 없는 종목은 skip으로 기록)
2) filter 평가       matrix만 읽어서 수백 개 조합을 즉시 계산
```

한 번 matrix를 만들면 이후 실행은 몇 초면 끝납니다.

## 실행

```powershell
# 전체 (첫 실행은 matrix 생성)
node .\backtest-lab-v3.mjs --years 2 --limit 100 --holds 1,3,5,10,20,60 --cost 0.23

# 특정 preset만
node .\backtest-lab-v3.mjs --preset LEADER_REBOUND

# 직접 만든 조합
node .\backtest-lab-v3.mjs --config .\backtest-configs\example.json

# matrix만 만들고 멈춤 / 기존 matrix 재사용
node .\backtest-lab-v3.mjs --matrix-only 1
node .\backtest-lab-v3.mjs --from-matrix .\backtest-v3\matrix\feature-matrix-....json

# matrix 강제 재생성
node .\backtest-lab-v3.mjs --rebuild 1

# self-test
node .\backtest-lab-v3.mjs --self-test 1
```

주요 옵션: `--min-trades`(기본 20) `--focus`(리포트 기준 보유일, 기본 10)
`--train`(TRAIN 비율, 기본 0.6) `--sweep 0`(임계값 sweep 끄기) `--raw 1`(원시 관측 CSV)

## 필터 작성법

필터는 코드가 아니라 데이터입니다.

```json
{
  "name": "LeaderA_Risk39_Stab65",
  "all": [
    { "field": "leaderGrade", "op": "in", "value": ["A"] },
    { "field": "scoutRiskScore", "op": "lte", "value": 39 },
    { "field": "scoutStabilizeScore", "op": "gte", "value": 65 }
  ]
}
```

연산자: `eq neq gt gte lt lte between in notIn true false isNA notNA`
결합: `all`(AND) `any`(OR) `not`

`between`은 **양끝 포함**입니다.

### NA 처리

과거 시점에 재현할 수 없는 값은 `null`이며, **0이나 false로 간주하지 않습니다.**
`null`에 대한 모든 비교는 false를 돌려주므로, 데이터가 없는 구간이 조건을 통과하는 일이
없습니다. 결측 자체를 조건으로 쓰려면 `isNA` / `notNA`를 씁니다.

## 사용 가능한 필드

`registry.mjs`가 축(axis)별로 묶어 관리합니다.

| 축 | 필드 |
| --- | --- |
| 종합/타이밍 | combinedScore mainScore scoutContribution combinedRank combinedLabel gateReason gatePass |
| Ranking V2 | rankingTier rankingV2Rank |
| Leader | leaderScore leaderGrade leaderTrendScore leaderRsScore leaderHighScore leaderPersistenceScore leaderRank |
| RS | rs20 |
| Scout | drawdownFromHighPct scoutCheapScore scoutStabilizeScore scoutRiskScore scoutRank scoutStatus noNewLow5 slope5 ret5 ret20 |
| 반등확인 | reboundStateKey leaderReboundPass deepRecoveryPass experimentalNakjuPass |
| 전략 flag | R F F2 B C H2 H3 I |
| 수급 | foreignStreak instStreak totalNetAmount foreignNet5d instNet5d investorKnown |
| 거래강도 | liquidityScore tradingValueRatio20 bodyTurnoverPct smartMoneyBodyPct smartMoneyTradingSharePct |
| 기술 | changeRate changeRate3d vwapRecovered overheat |
| 외부확인 | cafePass minerviniPass |

## 과최적화 방지

- **1-factor**: 모든 필터 단독
- **2-factor**: `CROSS_AXES`에 선언한 의미 있는 축 쌍만 교차 (같은 지표의 두 구간은 교차하지 않음)
- **3-factor**: `CORE_TRIPLES`에 명시한 조합만. 무작위 4~6조건 탐색은 없습니다.
- **threshold sweep**: 인접 cut에서도 성과가 유지되는지 함께 표시 → `견고 가능성` / 취약 구분
- **TRAIN/TEST**: 날짜 기준 분리. TRAIN 우수 / TEST 붕괴는 `과최적화 위험`으로 표시
- **대조군**: 필터 없는 전체 관측 성과를 항상 같이 출력. 이보다 못하면 `역효과`

최고 수익 전략을 자동으로 "최적"이라 부르지 않습니다. 판정은
`유망 / 견고 가능성 / 표본부족 / 과최적화 위험 / 역효과 / 중립` 중 하나입니다.

## 중복 신호

- 일반 전략: `applyPerCodeCooldown` — 같은 종목의 포지션이 열려 있는 동안 새 신호는 건너뜁니다.
- TOP-N 순위 전략: **daily cohort** — 매일 선발된 종목을 모두 셉니다.

두 방식은 **섞지 않습니다.** 리포트에서도 별도 표로 분리되어 있습니다.

## 결과 파일 (`backtest-results-v3/`)

`factor-summary` `strategy-summary` `combo-summary` `threshold-summary`
`rank-topn-summary` `robustness-summary` `strategy-trades` `report-*.md` `diagnostics-*.json`

## 한계 (리포트 상단에도 표시됩니다)

- **CURRENT-UNIVERSE SURVIVORSHIP BIAS** — 현재 시총 상위 종목을 과거로 소급. 당시 편출·상폐 종목이 빠져 있습니다.
- 상장주식수는 현재 값 → 과거 시가총액/회전율은 근사치
- H3/VWAP는 일봉 기반 EOD 근사 (분봉 재구성 아님)
- CAFE는 재무 point-in-time 데이터가 없어 기술+수급 프록시 (라이브와 동일 정의)

## 라이브 대시보드와의 관계

V3는 프로덕션 순수함수를 **직접 import**합니다.

- `public/rebound-ranking-v2.js` → Ranking V2 정렬/Tier
- `strategy-confirmation.js` → CAFE / MTT / 반등상태
- `relative-strength.js` → RS20

Scout·combined·flag 계산은 `backtest-v3/v2-core.mjs`에 V2 코드를 그대로 옮겨 쓰며,
`backtest-lab-v2.mjs` 자체는 수정하지 않았습니다. 라이브 산식은 어느 것도 바뀌지 않습니다.
