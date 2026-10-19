@echo off
chcp 65001 >nul
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\iniciar-windows.ps1" -Mode start
set "PROMOBRIDGE_EXIT=%errorlevel%"
pause
exit /b %PROMOBRIDGE_EXIT%
