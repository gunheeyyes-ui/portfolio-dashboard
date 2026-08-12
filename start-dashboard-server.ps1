$ErrorActionPreference = "Stop"

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 5177
$LogDir = Join-Path $AppDir "logs"
$OutLog = Join-Path $LogDir "dashboard.out.log"
$ErrLog = Join-Path $LogDir "dashboard.err.log"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  "[$(Get-Date -Format s)] Dashboard already running on port $Port, pid $($listener.OwningProcess)." | Add-Content -Path $OutLog
  exit 0
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  "[$(Get-Date -Format s)] node.exe was not found in PATH." | Add-Content -Path $ErrLog
  exit 1
}

"[$(Get-Date -Format s)] Starting dashboard server on http://localhost:$Port" | Add-Content -Path $OutLog

Start-Process `
  -FilePath $nodeCommand.Source `
  -ArgumentList "server.mjs" `
  -WorkingDirectory $AppDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog

Start-Sleep -Seconds 2

$started = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($started) {
  "[$(Get-Date -Format s)] Dashboard server started, pid $($started.OwningProcess)." | Add-Content -Path $OutLog
  exit 0
}

"[$(Get-Date -Format s)] Dashboard server did not start." | Add-Content -Path $ErrLog
exit 1
