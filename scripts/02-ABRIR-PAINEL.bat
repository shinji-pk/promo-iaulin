@echo off
chcp 65001 >nul
cd /d "%~dp0.."
if not exist apps\web\dist\index.html (
  echo Primeiro execute 01-INSTALAR.bat.
  pause
  exit /b 1
)
start "PromoBridge - mantenha esta janela aberta" cmd /k npm start
timeout /t 4 /nobreak >nul
start "" http://localhost:3030
