@echo off
rem Keep stdout reserved exclusively for MCP JSON-RPC.
call "%~dp0dytranob.cmd" mcp %*
exit /b %errorlevel%
