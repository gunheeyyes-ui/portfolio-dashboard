# KRX 전종목 과거 데이터 수집 준비 및 감사 보강 (2026-10-09)

## 확인된 원천

KRX Data Marketplace OPEN API, 신청·승인 후 아래 두 API를 사용:
- `https://data-dbg.krx.co.kr/svc/apis/sto/stk_bydd_trd?basDd=YYYYMMDD` : KOSPI
- `https://data-dbg.krx.co.kr/svc/apis/sto/ksq_bydd_trd?basDd=YYYYMMDD` : KOSDAQ

반환: `BAS_DD`, `ISU_CD`, `ISU_NM`, `TDD_OPNPRC`, `TDD_HGPRC`, `TDD_LWPRC`, `TDD_CLSPRC`, `ACC_TRDVOL`, `ACC_TRDVAL`, `MKTCAP`, `LIST_SHRS`. 날짜별 시장 상장주식수와 당시 거래가를 함께 가져오므로 사후 상장주식수 소급 문제에 대한 올바른 원천이다.

KRX 공식 소개: https://openapi.krx.co.kr/contents/OPP/INFO/OPPINFO003.jsp

**인증 주의**: 승인된 `KRX_AUTH_KEY`가 실행환경에 존재할 때만 수집 가능. 개인계정과 API별 활용 승인 필요. 키 값은 코드/JSON/로그/Git에 기록하지 않음. 이 세션의 PC 실행환경에서는 KRX API키가 설정돼 있지 않아 일별 전종목 자료를 다운로드하지 못함. 익명 샘플 API의 HTTP 401은 실데이터로 처리하지 않음.

## 구성

- `krx-pit-universe.mjs`: 단일일자 KOSPI/KOSDAQ 원천 2세트를 수집·검증하여 로컬 폴더에 저장. 필드 날짜와 시세·코드 오류 시 Fail Closed. 중복코드·OHLC 형식검증, 각 시장 최소 500종목 휴리스틱 적용. 저장 원천과 날짜 확인 후만 PIT 스냅샷으로 간주.
- `krx-pit-backfill.mjs`: 과거 매트릭스의 459거래일을 기준으로 미수집 날짜를 찾아 소량 분할 수집. 완성된 날짜는 재사용, 부분저장 날짜는 완성. 기본은 4일씩, 네트워크 요청 간 휴식.
- `build-strategy-pit-readiness.mjs`: 지정 경로의 원천 스냅샷을 전수 재검증. 459일 × 2시장 = **918개의 일별 시장 파일이 필요**. 현재 검증 완료 **0개**, 대기 **918개**, readiness BLOCKED. 이 수치는 후행 고정 200종목 백테스트 결과와 별개.
- `strategy-extreme-price-evidence.mjs`: 현 94개 극단수익 라벨을 종목별 캐시의 실제 시가·종가·거래비용으로 독립 산식 재계산. **94/94건 산술 일치**, 계산 불일치 0, 영향 종목 11개. 단 동일 KIS 캐시를 재계산한 것은 **외부 독립 검증이 아니며** KRX/기업공시 대조 완료 0건.
- `public/strategy-oos-gap-reasons.js`: 라이브 OOS `meta.skipped`를 확인해 원인 확인과 미확인을 분리. 2026-09-15 시장 데이터 KOSPI 29/KOSDAQ 30으로 판단 후 격리된 기록 있음. 나머지 12개 미기록 거래일에 같은 원인을 임의 귀속하지 않음.

## 실데이터 준비 시 실행

PC 로컬 실무 경로에 승인된 KRX API 키를 **환경변수**로 준비 (채팅, 소스코드, 문서에 직접 노출하지 말 것). 전종목 수집을 안전한 분량으로 반복 실행:

```powershell
node krx-pit-backfill.mjs <과거-feature-matrix.json> <로컬-KRX-PIT-보관폴더> 4
node build-strategy-pit-readiness.mjs <과거-feature-matrix.json> <로컬-KRX-PIT-보관폴더> public/strategy-pit-readiness.json
```

입력 파일을 확보하더라도 곧바로 실전 자동매매를 풀지 않는다. 각 시장 500종목 이상은 **기본 커버리지 검증일 뿐 상장·폐지 전체 검증의 충분조건이 아니며**, 기업행사/정정주가, 결측 및 당시 신호 산식 재계산, 올바른 체결 모델이 별도 필요하다.

## 현재 상태

- PIT 전종목 증거: **0/918** 검증 완료; 공식 키 접근 불가
- 가격라벨: **94/94** 내부 산술재현, 외부 0
- OOS 미기록 거래일: 13일 중 9월 15일 1일은 불완전 EOD 데이터 격리 원인 확인, 나머지 12일은 서버 당시 로그가 없어 원인 불확정
- 자동매매: 원본 107전략 및 428계좌 보존, 실전 자동주문 차단
