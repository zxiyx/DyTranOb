@echo off
call "%~dp0start.cmd" --mock %*
exit /b %errorlevel%
