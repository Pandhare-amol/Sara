@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title SARA Launcher
color 0B

set "PROJECT_DIR=%~dp0"
set "PYTHON_EXE="

for %%P in ("C:\Users\k8673\AppData\Local\Microsoft\WindowsApps\python3.13.exe" "C:\Users\k8673\AppData\Local\Programs\Python\Python311\python.exe" "python" "python3") do (
    if not defined PYTHON_EXE (
        if exist %%~fP (
            set "TRY_PY=%%~fP"
        ) else (
            where %%~P >nul 2>&1
            if not errorlevel 1 (
                set "TRY_PY=%%~P"
            )
        )
        if defined TRY_PY (
            "!TRY_PY!" -m uvicorn --version >nul 2>&1
            if not errorlevel 1 (
                set "PYTHON_EXE=!TRY_PY!"
            )
        )
        set "TRY_PY="
    )
)

if not defined PYTHON_EXE (
    echo [ERROR] Could not find a Python interpreter for the desktop agent.
    pause
    exit /b 1
)

echo ============================================================
echo                 SARA ALL-IN-ONE LAUNCHER
echo ============================================================
echo.

echo [1/4] Cleaning up any old instances...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo     Killing stale process on port 3000 ^(PID %%a^)
    taskkill /PID %%a /F >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING"') do (
    echo     Killing stale process on port 8765 ^(PID %%a^)
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 2 /nobreak >nul
echo     Done.
echo.

echo [2/4] Starting Desktop Control Agent ^(Python, port 8765^)...
start "SARA Desktop Agent" /MIN cmd /k "cd /d "%PROJECT_DIR%" && ""%PYTHON_EXE%"" -m uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765"
echo     Launching in background window...
echo.

echo [3/4] Waiting for agent to be ready...
set "READY=0"
for /l %%i in (1,1,15) do (
    timeout /t 1 /nobreak >nul
    powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8765/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 (
        set "READY=1"
        echo     Desktop Agent is ONLINE - 52 tools ready!
        goto :agent_ready
    )
    echo     ...waiting %%i/15
)
:agent_ready
if "%READY%"=="0" (
    echo     [WARNING] Desktop Agent did not respond in time.
    echo     SARA will still run, but desktop control may be unavailable.
)
echo.

echo [4/4] Starting SARA Server ^(Node, port 3000^)...
echo ============================================================
echo   Desktop Agent : http://127.0.0.1:8765
echo   SARA UI      : http://localhost:3000
echo ============================================================
echo.
echo   Close this window to stop SARA.
echo   ^(Desktop Agent runs in its own minimized window.\)
echo.

cd /d "%PROJECT_DIR%"
npm run dev

echo.
echo SARA has stopped. Cleaning up Desktop Agent...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)

