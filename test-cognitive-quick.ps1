#!/usr/bin/env pwsh
<#
.SYNOPSIS
Quick Cognitive API Test Script
Tests all 11 cognitive endpoints with simple, robust validation
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
        [string]$Method,
        [string]$Path,
        [object]$Body
    )
    
    $testsRun++
    $url = "$BaseUrl$Path"
    
    Write-Host ""
    Write-Host "TEST: $Name" -ForegroundColor Cyan
    Write-Host "  $Method $Path" -ForegroundColor Gray
    
    try {
        $params = @{
            Uri             = $url
            Method          = $Method
            Headers         = @{ "Content-Type" = "application/json" }
            TimeoutSec      = 10
        }
        
        if ($Body) {
            $params["Body"] = (ConvertTo-Json $Body -Depth 10)
            if ($Verbose) {
                Write-Host "  Body: $($params['Body'])" -ForegroundColor Gray
            }
        }
        
        $response = Invoke-RestMethod @params
        
        if ($response -and $response.ok -ne $null) {
            Write-Host "  PASS: Endpoint responded successfully" -ForegroundColor Green
            if ($Verbose) {
                Write-Host "  Response: $(ConvertTo-Json $response -Depth 2)" -ForegroundColor Gray
            }
            $testsPassed++
        } else {
            Write-Host "  FAIL: Invalid response format" -ForegroundColor Red
            $testsFailed++
        }
    }
    catch {
        Write-Host "  FAIL: $($_.Exception.Message)" -ForegroundColor Red
        $testsFailed++
    }
}

# Header
Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "COGNITIVE API TEST SUITE" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

# Test 1: Memory Stats
Test-Endpoint -Name "Get Memory Statistics" -Method "GET" -Path "/cognitive/memory/stats"

# Test 2: Create Plan
Test-Endpoint -Name "Create Task Plan" -Method "POST" -Path "/cognitive/plan" `
    -Body @{ 
        goal = "Organize desktop files"
        projectContext = "productivity"
    }

# Test 3: Remember Fact
Test-Endpoint -Name "Remember Knowledge" -Method "POST" -Path "/cognitive/remember" `
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
        goal = "Test task execution"
        userInput = "Run test task"
        maxDuration = 30000
    }

# Test 7: Get Active Projects
Test-Endpoint -Name "Get Active Projects" -Method "GET" -Path "/cognitive/active-projects"

# Test 8: Get Work Summary
Test-Endpoint -Name "Get Work Summary" -Method "GET" -Path "/cognitive/work-summary"

# Test 9: Get Contradictions
Test-Endpoint -Name "Get Knowledge Contradictions" -Method "GET" -Path "/cognitive/contradictions"

# Test 10: Get Project Info
Test-Endpoint -Name "Get Project Information" -Method "GET" -Path "/cognitive/project/productivity"

# Test 11: Consolidate Memory
if (-not $PSBoundParameters.ContainsKey('Verbose')) {
    Test-Endpoint -Name "Consolidate Learning" -Method "POST" -Path "/cognitive/memory/consolidate" `
        -Body @{ includeArchive = $false }
}

# Summary
Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "TEST SUMMARY" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

$totalTests = $testsPassed + $testsFailed
$passRate = if ($totalTests -gt 0) { [math]::Round(($testsPassed / $totalTests) * 100, 1) } else { 0 }

Write-Host ""
Write-Host "Total Tests:  $testsRun" -ForegroundColor Gray
Write-Host "Passed:       $testsPassed" -ForegroundColor Green
Write-Host "Failed:       $testsFailed" -ForegroundColor $(if ($testsFailed -gt 0) { "Red" } else { "Green" })
Write-Host "Pass Rate:    $passRate%" -ForegroundColor $(if ($passRate -ge 90) { "Green" } else { "Yellow" })

Write-Host ""

if ($testsFailed -eq 0) {
    Write-Host "ALL TESTS PASSED!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "SOME TESTS FAILED!" -ForegroundColor Red
    exit 1
}
