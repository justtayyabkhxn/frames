@echo off
node --no-warnings "%~dp0standalone\server.mjs" %*
if errorlevel 1 pause
