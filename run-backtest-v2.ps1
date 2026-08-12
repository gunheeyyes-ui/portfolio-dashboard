param(
  [ValidateSet('smoke','full')]
  [string]$Mode = 'smoke',
  [int]$Years = 2,
  [int]$Limit = 100
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js가 PATH에 없습니다.'
}
if (-not (Test-Path '.\backtest-lab-v2.mjs')) {
  throw 'backtest-lab-v2.mjs가 현재 폴더에 없습니다.'
}
if (-not (Test-Path '.\.env')) {
  Write-Warning '.env가 없습니다. KIS 캐시만으로 충분하지 않으면 API 호출이 실패합니다.'
}

Write-Host '1) 계산식 self-test'
node .\backtest-lab-v2.mjs --self-test 1
if ($LASTEXITCODE -ne 0) { throw 'Self-test 실패' }

if ($Mode -eq 'smoke') {
  Write-Host '2) Smoke test: 시장별 상위 Universe에서 최대 10종목만 실행'
  node .\backtest-lab-v2.mjs --years $Years --universe market --limit $Limit --max 10 --holds 1,3,5,10,20 --cost 0.23
} else {
  Write-Host '2) Full test: KOSPI/KOSDAQ 시총 상위 종목 전체 실행'
  node .\backtest-lab-v2.mjs --years $Years --universe market --limit $Limit --holds 1,3,5,10,20,60 --cost 0.23
}

if ($LASTEXITCODE -ne 0) { throw '백테스트 실행 실패' }

Write-Host ''
Write-Host '완료. backtest-results-v2 폴더에서 다음 4개를 우선 확인하세요:'
Write-Host ' - factor-summary-*.csv'
Write-Host ' - strategy-summary-*.csv'
Write-Host ' - report-*.md'
Write-Host ' - diagnostics-*.json'
Write-Host 'strategy-trades/observations 원자료는 AI에 통째로 넣지 마세요.'
