@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title DyTranOb
call "%~dp0start.cmd" %*
set "dytranobExitCode=%errorlevel%"
echo.
if not "%dytranobExitCode%"=="0" echo 启动失败，请查看上方错误信息。
pause
exit /b %dytranobExitCode%
