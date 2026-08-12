$ErrorActionPreference = "SilentlyContinue"

$Port = 5177
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

foreach ($listener in $listeners) {
  Stop-Process -Id $listener.OwningProcess -Force
}

Write-Host "Dashboard server on port $Port stopped."
