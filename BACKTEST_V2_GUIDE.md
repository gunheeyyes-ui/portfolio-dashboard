# 대시보드 통합 백테스트 V2 실행 가이드

## 목적

현재 대시보드가 실제로 유효한지 먼저 검증한다.

1. 종합점수 구간별
2. 종합순위 1~5 / 6~10 / 11~20 / 21~50 / 51+
3. 거래강도 10점 구간별
4. 주도주 A/B/C/D
5. 종합판정별 (최우선/분할/단기/관찰/추격/보류)
6. Gate PASS/BLOCK 및 차단 사유
7. 정찰병 상태, Cheap/Stabilize/Risk, 종합점수 내 Scout 기여점수
8. R / F2 / H3
9. 핵심 교차조합
   - Leader A + 종합 최우선
   - Leader A + R
   - Leader A + F2
   - Leader A + 정찰병
   - 거래강도70+ + 종합 최우선
10. 외부 벤치마크
   - 카페 주도주 눌림 **TECH+SUPPLY 프록시**
   - Minervini MTT

피터 린치/켄 피셔/재무 8조건은 이번 V2에 억지로 넣지 않는다. 당시 시점에 공개되어 있던 재무자료(point-in-time)가 필요하기 때문이다.

## 설치

`backtest-lab-v2.mjs`와 `run-backtest-v2.ps1`을 현재 프로젝트 루트, 즉 `server.mjs`, `signals.js`, `portfolio.js`, `.env`가 있는 폴더에 둔다.

`.env`는 외부로 복사하거나 업로드하지 않는다.

## 1. 계산식 검증

```powershell
node .\backtest-lab-v2.mjs --self-test 1
```

`SELF-TEST PASS`가 나와야 한다.

## 2. 10종목 Smoke test

```powershell
powershell -ExecutionPolicy Bypass -File .\run-backtest-v2.ps1 -Mode smoke -Years 2 -Limit 100
```

또는 직접:

```powershell
node .\backtest-lab-v2.mjs --years 2 --universe market --limit 100 --max 10 --holds 1,3,5,10,20 --cost 0.23
```

오류 없이 결과 파일이 생성되는지 먼저 확인한다.

## 3. 전체 실행

```powershell
powershell -ExecutionPolicy Bypass -File .\run-backtest-v2.ps1 -Mode full -Years 2 -Limit 100
```

직접 실행:

```powershell
node .\backtest-lab-v2.mjs --years 2 --universe market --limit 100 --holds 1,3,5,10,20,60 --cost 0.23
```

첫 실행은 가격 워밍업(신호 시작 전 약 900일)을 수집하기 때문에 오래 걸릴 수 있다. 이후에는 `backtest-cache-v2`를 재사용한다.

## 결과 파일

`backtest-results-v2/`

- `factor-summary-*.csv`
  - 종합점수/순위, 거래강도, Leader, 종합판정, Gate, Scout를 **구간별**로 비교
- `strategy-summary-*.csv`
  - 실제 전략별로 같은 종목의 중복 신호를 보유기간 동안 cooldown 처리한 성과
- `strategy-trades-*.csv`
  - 개별 거래 원자료
- `report-*.md`
  - 핵심 전략 TEST 표와 해석 원칙
- `diagnostics-*.json`
  - 데이터 누락, 오류, 가정
- `observations-*.csv`
  - `--raw 1`일 때만 생성. 매우 큼.

## 통계

각 구간/전략에 대해:

- N
- 승률
- 평균수익률
- 중앙값
- Profit Factor
- MFE / MAE
- +3% / +5% 도달률
- -3% / -5% 도달률
- 전략표에서는 MDD

진입은 **신호일 장마감까지 확인 → 다음 거래일 시가**이며 왕복 비용 기본 0.23%를 차감한다.

## 과적합 방지

전체 기간을 자동으로 앞 60% `TRAIN`, 뒤 40% `TEST`로 나눈다.

채택 기준은 TEST가 우선이다. TRAIN에서만 좋은 조건은 대시보드에 반영하지 않는다.

## 현재 V2의 한계

### 1. Survivorship bias

기본 `--universe market`은 **현재 시총 상위 종목**을 과거에도 사용한다. 과거 당시의 정확한 구성종목/상장폐지 종목을 모두 복원한 것이 아니다.

향후 정확한 historical universe CSV/JSON을 확보하면:

```powershell
node .\backtest-lab-v2.mjs --universe-file .\universe.json ...
```

형태로 교체할 수 있다.

### 2. 과거 시총 근사

거래강도 계산의 시총/회전율은 현재 상장주식수 × 당시 종가를 사용한다. 증자·감자 등이 있었던 종목에는 오차가 가능하다.

### 3. H3 낙주

일봉의 `거래대금 / 거래량`을 VWAP 근사로 사용한다. 실제 장중 저점 → VWAP 회복 순서를 알 수 없으므로 H3 결과는 참고용이다. 정확판은 추후 분봉 데이터로 별도 검증한다.

### 4. 카페 전략

카페 글의 완전한 `실적 + 수급 + 차트` 중 이번 V2는 실적 point-in-time 데이터가 없기 때문에 `주도주 + 월봉 + 수급 + 눌림`만 구현한 **프록시**다.

### 5. 린치/피셔/재무 전략

지금은 제외한다. 과거 날짜에 그때 실제 공개돼 있던 재무제표를 DART 등으로 구성한 뒤 V3에서 검증해야 look-ahead bias가 없다.

## AI에 다시 가져올 파일

전체 실행 후 ChatGPT에는 우선 아래 4개만 올린다.

1. `strategy-summary-*.csv`
2. `factor-summary-*.csv`
3. `report-*.md`
4. `diagnostics-*.json`

`strategy-trades-*.csv`는 필요할 때만 분석한다. `observations-*.csv`는 통째로 AI에 넣지 않는다.
