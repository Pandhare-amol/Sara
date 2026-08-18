@echo off
setlocal EnableDelayedExpansion
title SARA Production Launcher
color 0A

rem ============================================================
rem SARA Production Launcher
rem Created by Mr Amol Pandhre and the SARA Team
rem
rem Single entry point for production SARA startup.
rem ============================================================

set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

echo.
echo ============================================================
echo          SARA Production Launcher
echo          Created by Mr Amol Pandhre and the SARA Team
echo ============================================================
echo.

set "TSX_CMD=npx tsx"
where tsx >nul 2>&1 && set "TSX_CMD=tsx"

if not exist "%PROJECT_DIR%\startup\startupManager.ts" (
    echo [SARA][ERROR] startup/startupManager.ts not found!
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [SARA][ERROR] Node.js not found on PATH.
    pause
    exit /b 1
)

set "PYTHON_EXE="
if exist "%PROJECT_DIR%\.venv-1\Scripts\python.exe" (
    set "PYTHON_EXE=%PROJECT_DIR%\.venv-1\Scripts\python.exe"
) else if exist "%PROJECT_DIR%\.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%PROJECT_DIR%\.venv\Scripts\python.exe"
) else (
    where python >nul 2>&1 && set "PYTHON_EXE=python"
)

if not defined PYTHON_EXE (
    echo [SARA][ERROR] Python interpreter not found!
    pause
    exit /b 1
)

echo [SARA] Node.js:  OK
echo [SARA] Python:   %PYTHON_EXE%
echo [SARA] Root:     %PROJECT_DIR%
echo.

echo [SARA] Launching Startup Manager...
echo.
cd /d "%PROJECT_DIR%"
set "NODE_ENV=production"
%TSX_CMD% startup/startupManager.ts

if errorlevel 1 (
    echo.
    echo [SARA] Startup Manager exited. Falling back to start-sara.bat...
    if exist "%PROJECT_DIR%\start-sara.bat" (
        call "%PROJECT_DIR%\start-sara.bat"
    )
)
