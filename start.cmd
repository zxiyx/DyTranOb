@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.5 or newer is required. Install Node.js, then run start.cmd again. 1>&2
  pause
  exit /b 1
)
if not exist "src\cli.ts" goto runRuntime
if not exist "node_modules\typescript\bin\tsc" (
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 exit /b 1
)
call npm.cmd run build
if errorlevel 1 exit /b 1
:runRuntime
if not exist "%~dp0dist\cli.js" (
  echo Compiled runtime is missing. Run npm ci and npm run build. 1>&2
  exit /b 1
)
node "%~dp0dist\cli.js" %*
exit /b %errorlevel%
