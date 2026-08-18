@echo off
title SARA Production Launch
echo Starting SARA Production Assistant...

set NODE_ENV=production
set SARA_FORCE_PROD=1
cd /d "%~dp0\.."

if exist "dist\server.cjs" (
    echo Launching SARA backend bundle...
    node dist\server.cjs
) else (
    echo Bundle dist\server.cjs not found. Running build first...
    npm run build
    node dist\server.cjs
)
