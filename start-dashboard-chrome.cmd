@echo off
setlocal
cd /d "%~dp0"

start "Portfolio Dashboard Server" cmd /k "npm start"
timeout /t 2 /nobreak >nul
call "%~dp0open-dashboard-chrome.cmd"
