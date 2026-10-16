@echo off
setlocal
title SARA Launcher
color 0B

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

if not exist "%PROJECT_DIR%\package.json" (
    echo [ERROR] SARA project files were not found.
    pause
    exit /b 1
)

where node.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or is not available on PATH.
    pause
    exit /b 1
)

echo ============================================================
echo                 SARA DESKTOP LAUNCHER
echo ============================================================
echo.
echo SARA will start its managed Electron, backend, and desktop-agent services.
echo Existing processes and listeners will not be terminated automatically.
echo.

call npm run electron
set "SARA_EXIT_CODE=%ERRORLEVEL%"
if not "%SARA_EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] SARA exited with code %SARA_EXIT_CODE%.
    pause
)
exit /b %SARA_EXIT_CODE%
