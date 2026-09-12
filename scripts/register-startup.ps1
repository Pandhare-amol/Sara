# Windows Auto-Start Registration for SARA
# Register the SARA supervisor launcher so Windows starts the backend,
# Desktop Agent, and Electron UI together.
# Respects AUTO_START=true/false from .env.

param(
    [switch]$Unregister
)

$TaskName = "SARA_Production_Startup"
$Root = Resolve-Path "$PSScriptRoot\.."
$Launcher = Join-Path $Root "start-sara-silent.bat"

if ($Unregister) {
    Write-Host "[SARA] Unregistering '$TaskName' from Task Scheduler..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    $RunPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    Remove-ItemProperty -Path $RunPath -Name "Sara" -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $RunPath -Name "com.sara.desktop" -ErrorAction SilentlyContinue
    Write-Host "[SARA] Startup registration removed." -ForegroundColor Green
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
    Write-Host "[SARA] AUTO_START=false in .env - skipping registration." -ForegroundColor Yellow
    exit 0
}

if (-not (Test-Path $Launcher)) {
    Write-Host "[SARA][ERROR] Supervisor launcher not found: $Launcher" -ForegroundColor Red
    exit 1
}

Write-Host "[SARA] Registering supervisor startup: $Launcher" -ForegroundColor Cyan

$TaskArguments = '/d /c "' + $Launcher + '"'
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $TaskArguments -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description "SARA supervisor startup" -Force

# Remove the older Run-key registration if it exists. Keeping both mechanisms
# starts two supervisors and causes the stale-lock/retry noise seen at login.
$RunPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
Remove-ItemProperty -Path $RunPath -Name "Sara" -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $RunPath -Name "com.sara.desktop" -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  SARA auto-start registered successfully!" -ForegroundColor Green
Write-Host "  Task name: $TaskName" -ForegroundColor Green
Write-Host "  Trigger:   At logon for $env:USERNAME" -ForegroundColor Green
Write-Host "  Launcher:   $Launcher" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
