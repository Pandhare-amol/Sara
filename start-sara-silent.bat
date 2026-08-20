@echo off
REM ===========================================================================
REM SARA V2 â€” Silent Auto-Start Launcher
REM ===========================================================================
REM Invoked by the Windows "Run" registry key (HKCU\...\Run\Sara) on login.
REM Starts both backends silently (no console popups) and opens the UI tab.
REM
REM This script is intentionally self-contained: it locates Python, ensures the
REM two ports are free, launches the Python agent + Node server detached, waits
REM for them to be ready, and finally opens the browser.
REM ===========================================================================

setlocal EnableDelayedExpansion
set "PROJECT_DIR=%~dp0"
set "PYTHON_EXE="

for %%P in ("C:\Users\k8673\AppData\Local\Microsoft\WindowsApps\python3.13.exe" "C:\Users\MSI\AppData\Local\Programs\Python\Python311\python.exe" "python" "python3") do (
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
    exit /b 1
)

cd /d "%PROJECT_DIR%"

REM --- 1. Clear any stale processes on our ports (silent) ---------------------
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)

REM --- 2. Start the Desktop Control Agent (Python, port 8765) -----------------
start "" /B ""%PYTHON_EXE%"" -m uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765 > nul 2>&1

REM Give the agent a few seconds to come online before starting the web server.
timeout /t 3 /nobreak >nul

REM --- 3. Start the SARA web server (Node, port 3000) ------------------------
start "" /B cmd /c "cd /d "%PROJECT_DIR%" && npm run dev > nul 2>&1"

REM --- 4. Wait for the web server to accept connections, then open the UI ----
for /l %%i in (1,1,20) do (
    timeout /t 1 /nobreak >nul
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:3000' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 (
        start "" "http://localhost:3000"
        goto :done
    )
)
REM If the server never came up in time, still try to open the tab once.
start "" "http://localhost:3000"

:done
endlocal
exit /b 0

