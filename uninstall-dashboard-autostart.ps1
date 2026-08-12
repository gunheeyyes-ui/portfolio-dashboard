$ErrorActionPreference = "SilentlyContinue"

$TaskName = "Gunhee Portfolio Dashboard"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

$StartupDir = [Environment]::GetFolderPath("Startup")
$StartupLauncher = Join-Path $StartupDir "Gunhee Portfolio Dashboard.vbs"
Remove-Item -LiteralPath $StartupLauncher -Force

Write-Host "Dashboard autostart removed."
