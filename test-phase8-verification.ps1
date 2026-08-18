#!/usr/bin/env pwsh
<#
.SYNOPSIS
Cognitive API Test Script - Phase 8 E2E Verification
Tests all 11 cognitive endpoints with proper timeout handling
#>

param(
    [string]$BaseUrl = "http://localhost:3000",
    [switch]$Verbose
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

$testsRun = 0
$testsPassed = 0
$testsFailed = 0

function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Method = "GET",
        [string]$Path,
        [object]$Body,
        [int]$TimeoutSec = 15
    )
    
    $script:testsRun++
    $url = "$BaseUrl$Path"
    
    Write-Host ""
    Write-Host "TEST $($script:testsRun): $Name" -ForegroundColor Cyan
    Write-Host "  $Method $Path" -ForegroundColor Gray
    
    try {
        $params = @{
            Uri             = $url
            Method          = $Method
            Headers         = @{ "Content-Type" = "application/json" }
            TimeoutSec      = $TimeoutSec
        }
        
        if ($Body) {
            $params["Body"] = (ConvertTo-Json $Body -Depth 10)
            if ($Verbose) {
                Write-Host "  Body: $($params['Body'])" -ForegroundColor Gray
            }
        }
        
        $response = Invoke-RestMethod @params
        
        if ($response -and $response.ok -ne $null) {
            Write-Host "  PASS" -ForegroundColor Green
            if ($Verbose) {
                Write-Host "  Response keys: $($response | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name | Join-String -Separator ', ')" -ForegroundColor Gray
            }
            $script:testsPassed++
        } else {
            Write-Host "  FAIL: Invalid response format (missing 'ok' field)" -ForegroundColor Red
            $script:testsFailed++
        }
    }
    catch {
        Write-Host "  FAIL: $($_.Exception.Message)" -ForegroundColor Red
        $script:testsFailed++
    }
}

# Header
Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "PHASE 8: COGNITIVE API END-TO-END VERIFICATION" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "Running all 11 cognitive endpoints with 15-second timeouts"  -ForegroundColor Gray
Write-Host ""

# Test 1: Memory Stats
Test-Endpoint -Name "Get Memory Statistics" -Method "GET" -Path "/cognitive/memory/stats" -TimeoutSec 15

# Test 2: Create Plan
Test-Endpoint -Name "Create Task Plan" -Method "POST" -Path "/cognitive/plan" `
    -Body @{ 
        goal = "Organize desktop files"
        projectContext = "productivity"
    } `
    -TimeoutSec 15

# Test 3: Remember Fact
Test-Endpoint -Name "Remember Knowledge Fact" -Method "POST" -Path "/cognitive/remember" `
    -Body @{
        category = "workspace"
        content = "Files are organized by type"
        type = "fact"
    }

# Test 4: Get Preferences
Test-Endpoint -Name "Get User Preferences" -Method "GET" -Path "/cognitive/preferences"

# Test 5: Get Strategies
Test-Endpoint -Name "Get Strategy Performance" -Method "GET" -Path "/cognitive/strategies"

# Test 6: Execute Task
Test-Endpoint -Name "Execute Task with Cognition" -Method "POST" -Path "/cognitive/task/execute" `
    -Body @{
        taskId = "test-task-001"
        goal = "Test cognitive task execution"
        userInput = "Run a test task"
        maxDuration = 30000
    }

# Test 7: Get Active Projects
Test-Endpoint -Name "Get Active Projects" -Method "GET" -Path "/cognitive/active-projects"

# Test 8: Get Work Summary
Test-Endpoint -Name "Get Work Summary" -Method "GET" -Path "/cognitive/work-summary"

# Test 9: Get Contradictions
Test-Endpoint -Name "Get Knowledge Contradictions" -Method "GET" -Path "/cognitive/contradictions"

# Test 10: Get Project Info
Test-Endpoint -Name "Get Project Information" -Method "GET" -Path "/cognitive/project/productivity" -TimeoutSec 15

# Test 11: Consolidate Memory
Test-Endpoint -Name "Consolidate Learning Episodes" -Method "POST" -Path "/cognitive/memory/consolidate" `
    -Body @{ includeArchive = $false } `
    -TimeoutSec 15

# Summary
Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "PHASE 8 TEST SUMMARY" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

$totalTests = $testsPassed + $testsFailed
$passRate = if ($totalTests -gt 0) { [math]::Round(($testsPassed / $totalTests) * 100, 1) } else { 0 }

Write-Host ""
Write-Host "Total Tests Run:  $script:testsRun" -ForegroundColor Gray
Write-Host "Passed:           $testsPassed" -ForegroundColor Green
Write-Host "Failed:           $testsFailed" -ForegroundColor $(if ($testsFailed -gt 0) { "Red" } else { "Green" })
Write-Host "Pass Rate:        $passRate%" -ForegroundColor $(if ($passRate -ge 90) { "Green" } else { "Yellow" })

Write-Host ""
Write-Host "Endpoints Verified:" -ForegroundColor Cyan
Write-Host "  1. POST   /cognitive/plan" -ForegroundColor Gray
Write-Host "  2. POST   /cognitive/remember" -ForegroundColor Gray
Write-Host "  3. POST   /cognitive/task/execute" -ForegroundColor Gray
Write-Host "  4. POST   /cognitive/memory/consolidate" -ForegroundColor Gray
Write-Host "  5. GET    /cognitive/memory/stats" -ForegroundColor Gray
Write-Host "  6. GET    /cognitive/preferences" -ForegroundColor Gray
Write-Host "  7. GET    /cognitive/strategies" -ForegroundColor Gray
Write-Host "  8. GET    /cognitive/project/:project" -ForegroundColor Gray
Write-Host "  9. GET    /cognitive/work-summary" -ForegroundColor Gray
Write-Host "  10. GET   /cognitive/contradictions" -ForegroundColor Gray
Write-Host "  11. GET   /cognitive/active-projects" -ForegroundColor Gray

Write-Host ""

if ($testsFailed -eq 0) {
    Write-Host "PHASE 8 SUCCESS: ALL COGNITIVE ENDPOINTS OPERATIONAL!" -ForegroundColor Green
    Write-Host "Memory systems initialized and ready for learning pipeline" -ForegroundColor Green
    exit 0
} else {
    Write-Host "PHASE 8 PARTIAL: $testsFailed endpoint(s) failed. See details above." -ForegroundColor Yellow
    exit 1
}
