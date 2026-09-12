@echo off
REM ===========================================================================
REM SARA V2 â€” Silent Auto-Start Launcher
REM ===========================================================================
REM Invoked by the Windows "Run" registry key (HKCU\...\Run\Sara) on login.
REM Starts the SARA supervisor silently. The supervisor starts the backend,
REM Desktop Agent, and Electron UI in the correct order.
REM
REM This script is intentionally self-contained: it locates Python, ensures the
REM two ports are free, launches the Python agent + Node server detached, waits
REM for them to be ready, and finally opens the browser.
REM ===========================================================================

setlocal EnableDelayedExpansion
set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"
if not exist "%PROJECT_DIR%\startup\startupManager.ts" exit /b 1
if not exist "%PROJECT_DIR%\node_modules\tsx\dist\cli.mjs" exit /b 1

REM Use the same supervisor as manual production startup. This keeps backend,
REM Desktop Agent, Electron, health checks, and process ownership consistent.
set "NODE_EXE=node.exe"
where node.exe >nul 2>&1 || set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE_EXE%" if not "%NODE_EXE%"=="node.exe" exit /b 1

start "SARA Supervisor" /B powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ^
  "$env:NODE_ENV='production'; Start-Process -FilePath '%NODE_EXE%' -ArgumentList 'node_modules/tsx/dist/cli.mjs','startup/startupManager.ts' -WorkingDirectory '%PROJECT_DIR%' -WindowStyle Hidden"

endlocal
exit /b 0

