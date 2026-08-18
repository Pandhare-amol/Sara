# Windows Auto-Start Registration for SARA
# Register the real SARA executable so Windows launches the native app directly.
# Respects AUTO_START=true/false from .env.

param(
    [switch]$Unregister
)

$TaskName = "SARA_Production_Startup"
$Root = Resolve-Path "$PSScriptRoot\.."
$AppExe = $null

$CandidatePaths = @(
    (Join-Path $Root "release\SARA-Setup-*.exe"),
    (Join-Path $Root "release\win-unpacked\SARA.exe"),
    (Join-Path $Root "dist\win-unpacked\SARA.exe"),
    (Join-Path $Root "dist\SARA.exe")
)

foreach ($pattern in $CandidatePaths) {
    $matches = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($matches) {
        $AppExe = $matches.FullName
        break
    }
}

if ($Unregister) {
    Write-Host "[SARA] Unregistering '$TaskName' from Task Scheduler..." -ForegroundColor Yellow
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host "[SARA] ✓ Unregistered successfully." -ForegroundColor Green
    } catch {
        Write-Host "[SARA] Task '$TaskName' was not registered." -ForegroundColor Gray
    }
    exit 0
}

$EnvFile = Join-Path $Root ".env"
$AutoStart = $true
if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile) {
        if ($line -match "^AUTO_START\s*=\s*(.+)$") {
            $val = $matches[1].Trim().Trim('"').Trim("'")
            if ($val -eq "false") { $AutoStart = $false }
            break
        }
    }
}

if (-not $AutoStart) {
    Write-Host "[SARA] AUTO_START=false in .env — skipping registration." -ForegroundColor Yellow
    exit 0
}

if (-not $AppExe) {
    Write-Host "[SARA][ERROR] SARA executable not found. Build the app first with electron-builder or package a release." -ForegroundColor Red
    exit 1
}

Write-Host "[SARA] Registering native Windows startup: $AppExe" -ForegroundColor Cyan

$Action = New-ScheduledTaskAction -Execute $AppExe -WorkingDirectory (Split-Path $AppExe -Parent)
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description "SARA — native desktop app startup" -Force

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  SARA auto-start registered successfully!" -ForegroundColor Green
Write-Host "  Task name: $TaskName" -ForegroundColor Green
Write-Host "  Trigger:   At logon for $env:USERNAME" -ForegroundColor Green
Write-Host "  Executable: $AppExe" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
