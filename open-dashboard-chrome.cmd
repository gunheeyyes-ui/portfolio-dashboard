@echo off
setlocal
set "URL=http://localhost:5177"

where chrome >nul 2>nul
if %errorlevel%==0 (
  start "" chrome "%URL%"
  exit /b 0
)

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%URL%"
  exit /b 0
)

if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%URL%"
  exit /b 0
)

start "" "%URL%"
