@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo Preparando o PromoBridge...
where node >nul 2>nul
if errorlevel 1 (
  echo Instale o Node.js 24 LTS em https://nodejs.org e abra este arquivo novamente.
  pause
  exit /b 1
)
node -e "if(process.versions.node.split('.')[0] !== '24') process.exit(1)"
if errorlevel 1 (
  echo O PromoBridge precisa do Node.js 24 LTS. Instale em https://nodejs.org
  pause
  exit /b 1
)
call npm ci --no-audit --no-fund
if errorlevel 1 goto erro
call npm run build
if errorlevel 1 goto erro
echo Pronto! Abra 02-ABRIR-PAINEL.bat para comecar.
pause
exit /b 0
:erro
echo Nao foi possivel concluir. Confira sua conexao e as mensagens acima.
pause
exit /b 1
