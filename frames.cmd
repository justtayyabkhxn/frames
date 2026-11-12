@echo off
setlocal
set "NODE=%~dp0tools\node\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" --no-warnings "%~dp0standalone\server.mjs" %*
if errorlevel 1 pause
