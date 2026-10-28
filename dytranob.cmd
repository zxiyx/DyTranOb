@echo off
setlocal
if not exist "%~dp0dist\cli.js" (
  echo Run npm ci and npm run build, or start.cmd first. 1>&2
  exit /b 1
)
node "%~dp0dist\cli.js" %*
exit /b %errorlevel%
