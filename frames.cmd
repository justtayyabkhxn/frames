@echo off
setlocal
chcp 65001 >nul
set "NODE=%~dp0tools\node\node.exe"
if not exist "%NODE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0standalone\bootstrap-node.ps1"
  if errorlevel 1 (
    echo.
    echo   Setup stopped. Check your internet connection and run frames.cmd again.
    pause
    exit /b 1
  )
  set FRAMES_BANNER_SHOWN=1
)
"%NODE%" --no-warnings "%~dp0standalone\server.mjs" %*
if errorlevel 1 pause
