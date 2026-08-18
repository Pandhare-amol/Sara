#!/usr/bin/env powershell
<#
SARA Diagnostic and Startup Script
Validates health checks and network configuration before starting SARA

Usage:
  .\scripts\sara-diagnostic.ps1 -Full
  .\scripts\sara-diagnostic.ps1 -HealthCheck
  .\scripts\sara-diagnostic.ps1 -Start
#>

param(
  [switch]$Full,
  [switch]$HealthCheck,
  [switch]$Start,
  [switch]$Quiet
)

$ErrorActionPreference = "Continue"

# Colors for output
$colors = @{
  Success = "Green"
  Error = "Red"
  Warning = "Yellow"
  Info = "Cyan"
  Diagnostic = "Magenta"
}

function Log {
  param($Message, $Type = "Info")
  if (-not $Quiet) {
    $color = $colors[$Type]
    Write-Host "[$Type] $Message" -ForegroundColor $color
  }
}

function TestPort {
  param($Port, $HostName = "127.0.0.1")
  try {
    $tcp = [System.Net.Sockets.TcpClient]::new()
    $ar = $tcp.BeginConnect($HostName, $Port, $null, $null)
    $wait = $ar.AsyncWaitHandle.WaitOne(1000, $false)
    if ($wait) {
      $tcp.EndConnect($ar)
      $tcp.Close()
      return $true
    }
    return $false
  }
  catch {
    return $false
  }
}

function HealthCheck {
  param($Port, $ServiceName, $Path = "/health")
  Log "Checking $ServiceName on port $Port..." "Diagnostic"
  
  if (-not (TestPort $Port)) {
    Log "$ServiceName port $Port not responding" "Error"
    return $false
  }

  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port$Path" `
      -TimeoutSec 3 `
      -ErrorAction Stop
    
    if ($response.StatusCode -eq 200) {
      Log "$ServiceName ($Port$Path) - OK" "Success"
      return $true
    }
    else {
      Log "$ServiceName returned status $($response.StatusCode)" "Warning"
      return $false
    }
  }
  catch {
    Log "$ServiceName health check failed: $($_.Exception.Message)" "Error"
    return $false
  }
}

function CheckProcesses {
  Log "Checking for existing SARA processes..." "Diagnostic"
  
  $processes = @{
    "node" = 0
    "python" = 0
    "electron" = 0
  }
  
  Get-Process | Where-Object { $processes.ContainsKey($_.ProcessName) } | ForEach-Object {
    $processes[$_.ProcessName]++
  }
  
  foreach ($proc in $processes.Keys) {
    $count = $processes[$proc]
    if ($count -gt 0) {
      Log "$proc : $count process(es) running" "Warning"
    }
  }
}

function RunHealthChecks {
  Log "Starting health checks..." "Diagnostic"
  
  $results = @{
    Backend = HealthCheck 3000 "Backend/Frontend"
    DesktopAgent = HealthCheck 8765 "Desktop Agent"
  }
  
  $allHealthy = $results.Values | Where-Object { $_ -eq $true } | Measure-Object | Select-Object -ExpandProperty Count
  $total = $results.Count
  
  Log "Health check results: $allHealthy/$total services healthy" $(
    if ($allHealthy -eq $total) { "Success" } else { "Warning" }
  )
  
  return $allHealthy -eq $total
}

function DiagnosticReport {
  Log "=== SARA Diagnostic Report ===" "Diagnostic"
  Log "System: $($PSVersionTable.OS)" "Info"
  
  $nodeVersion = (node --version 2>$null) -or "Not found"
  Log "Node.js: $nodeVersion" "Info"
  
  $pythonVersion = (python --version 2>$null) -or "Not found"
  Log "Python: $pythonVersion" "Info"
  Log "" "Info"
  
  CheckProcesses
  Log "" "Info"
  
  $healthy = RunHealthChecks
  Log "" "Info"
  
  if ($healthy) {
    Log "All systems healthy - ready to start Electron" "Success"
  }
  else {
    Log "Some services not responding - check logs" "Error"
  }
  
  return $healthy
}

function StartSARA {
  Log "Starting SARA..." "Diagnostic"
  Log "Backend (port 3000) and Desktop Agent (port 8765) should start automatically" "Info"
  Log "Electron will launch after services are healthy" "Info"
  Log "" "Info"
  
  # Start the production startup manager
  & npm run start:prod 2>&1
}

# Main execution
if ($Full) {
  DiagnosticReport
  Log "" "Info"
  StartSARA
}
elseif ($HealthCheck) {
  DiagnosticReport
}
elseif ($Start) {
  StartSARA
}
else {
  Log "SARA Diagnostic Script" "Info"
  Log "Usage:" "Info"
  Log "  .\scripts\sara-diagnostic.ps1 -Full        # Full diagnostic + start" "Info"
  Log "  .\scripts\sara-diagnostic.ps1 -HealthCheck # Health check only" "Info"
  Log "  .\scripts\sara-diagnostic.ps1 -Start       # Start SARA directly" "Info"
  Log "" "Info"
  DiagnosticReport
}
