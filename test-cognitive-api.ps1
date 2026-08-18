#!/usr/bin/env pwsh

<#
.SYNOPSIS
Cognitive API Test Verification Script
Validates all 11 cognitive endpoints are working correctly

.DESCRIPTION
This script tests each cognitive endpoint with realistic requests
and validates the response format and data.

Run: .\test-cognitive-api.ps1

.PARAMETER BaseUrl
The base URL of the server (default: http://localhost:3000)

.PARAMETER Verbose
Show detailed request/response information
#>

param(
    [string]$BaseUrl = "http://localhost:3000",
    [switch]$Verbose,
    [switch]$SkipSlowTests
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Test counters
$testsRun = 0
$testsPassed = 0
$testsFailed = 0

# Colors
$successColor = "Green"
$failColor = "Red"
$infoColor = "Cyan"
$warningColor = "Yellow"

# Utility functions
function Write-TestHeader {
    param([string]$Title)
    Write-Host ""
    Write-Host "=" * 70 -ForegroundColor $infoColor
    Write-Host "TEST: $Title" -ForegroundColor $infoColor
    Write-Host "=" * 70 -ForegroundColor $infoColor
}

function Write-TestResult {
    param(
        [string]$Name,
        [bool]$Passed,
        [string]$Message
    )
    $script:testsRun++
    if ($Passed) {
        $script:testsPassed++
        Write-Host "✓ PASS: $Name" -ForegroundColor $successColor
    } else {
        $script:testsFailed++
        Write-Host "✗ FAIL: $Name" -ForegroundColor $failColor
        if ($Message) {
            Write-Host "  Error: $Message" -ForegroundColor $failColor
        }
    }
}

function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Method = "GET",
        [string]$Path,
        [object]$Body,
        [scriptblock]$Validator
    )

    try {
        $url = "$BaseUrl$Path"
        
        if ($Verbose) {
            Write-Host "  Request: $Method $url" -ForegroundColor $infoColor
            if ($Body) {
                Write-Host "  Body: $(ConvertTo-Json $Body -Depth 2)" -ForegroundColor $infoColor
            }
        }

        $params = @{
            Uri     = $url
            Method  = $Method
            Headers = @{ "Content-Type" = "application/json" }
        }

        if ($Body) {
            $params.Body = (ConvertTo-Json $Body -Depth 10)
        }

        $response = Invoke-RestMethod @params

        if ($Verbose) {
            Write-Host "  Response: $(ConvertTo-Json $response -Depth 2)" -ForegroundColor $infoColor
        }

        if ($Validator) {
            $result = & $Validator $response
            Write-TestResult $Name $result.Success $result.Message
        } else {
            Write-TestResult $Name $true
        }
    }
    catch {
        Write-TestResult $Name $false $_.Exception.Message
    }
}

# ============================================================================
# Health Check
# ============================================================================
Write-Host "SARA Cognitive Architecture - API Test Suite" -ForegroundColor $successColor
Write-Host "Target: $BaseUrl" -ForegroundColor $infoColor
Write-Host ""

Write-Host "Checking server health..." -ForegroundColor $infoColor
try {
    $health = Invoke-RestMethod -Uri "$BaseUrl/health" -Method GET
    Write-Host "✓ Server is running" -ForegroundColor $successColor
    Write-Host "  Service: $($health.service)" -ForegroundColor $infoColor
    Write-Host "  Version: $($health.service_version)" -ForegroundColor $infoColor
} catch {
    Write-Host "✗ Server is NOT running at $BaseUrl" -ForegroundColor $failColor
    Write-Host "  Start the server with: npm run dev" -ForegroundColor $warningColor
    exit 1
}

Write-Host ""

# ============================================================================
# Test 1: POST /cognitive/plan
# ============================================================================
Write-TestHeader "POST /cognitive/plan - Create Goal Plan"

Test-Endpoint -Name "Create plan with goal" -Method POST -Path "/cognitive/plan" `
    -Body @{
        goal = "Create a test file"
        projectContext = "Testing"
    } `
    -Validator {
        param($response)
        $success = $response.ok -eq $true -and $response.plan -ne $null
        $message = ""
        if (-not $success) { $message = "Missing 'ok' or 'plan' in response" }
        
        if ($success -and $response.plan.steps) {
            $success = $response.plan.steps.Count -gt 0
            if (-not $success) { $message = "Plan has no steps" }
        }
        
        @{ Success = $success; Message = $message }
    }

Test-Endpoint -Name "Plan has confidence score" -Method POST -Path "/cognitive/plan" `
    -Body @{ goal = "Test goal" } `
    -Validator {
        param($response)
        $success = $response.plan.confidence -ge 0 -and $response.plan.confidence -le 1
        @{ Success = $success; Message = if (-not $success) { "Confidence not 0-1" } else { "" } }
    }

Test-Endpoint -Name "Plan request missing goal fails" -Method POST -Path "/cognitive/plan" `
    -Body @{ projectContext = "Test" } `
    -Validator {
        param($response)
        $success = $response.ok -eq $false -or $response.error -ne $null
        @{ Success = $success; Message = "" }
    }

# ============================================================================
# Test 2: POST /cognitive/remember
# ============================================================================
Write-TestHeader "POST /cognitive/remember - Store Knowledge"

Test-Endpoint -Name "Remember a fact" -Method POST -Path "/cognitive/remember" `
    -Body @{
        category = "general"
        content = "SARA is a cognitive AI assistant"
        type = "fact"
    } `
    -Validator {
        param($response)
        $success = $response.ok -eq $true -and $response.memory -ne $null
        $message = ""
        if (-not $success) { $message = "Missing 'ok' or 'memory'" }
        @{ Success = $success; Message = $message }
    }

Test-Endpoint -Name "Remember a preference" -Method POST -Path "/cognitive/remember" `
    -Body @{
        category = "user"
        content = "User prefers TypeScript"
        type = "preference"
    } `
    -Validator {
        param($response)
        $success = $response.ok -eq $true
        @{ Success = $success; Message = "" }
    }

Test-Endpoint -Name "Remember request missing content fails" -Method POST -Path "/cognitive/remember" `
    -Body @{ category = "test"; type = "fact" } `
    -Validator {
        param($response)
        $success = $response.ok -eq $false
        @{ Success = $success; Message = "" }
    }

# ============================================================================
# Test 3: GET /cognitive/memory/stats
# ============================================================================
Write-TestHeader "GET /cognitive/memory/stats - Memory Statistics"

Test-Endpoint -Name "Get memory statistics" -Method GET -Path "/cognitive/memory/stats" `
    -Validator {
        param($response)
        $success = $response.ok -eq $true -and $response.stats -ne $null
        $message = ""
        if (-not $success) { $message = "Missing stats" }
        
        if ($success) {
            $hasAllMemories = $response.stats.episodic -and $response.stats.semantic -and `
                              $response.stats.procedural -and $response.stats.autobiographical
            $success = $hasAllMemories
            if (-not $success) { $message = "Missing memory engine stats" }
        }
        
        @{ Success = $success; Message = $message }
    }

Test-Endpoint -Name "Stats show episode count" -Method GET -Path "/cognitive/memory/stats" `
    -Validator {
        param($response)
        $success = $response.stats.episodic.count -ge 0
        @{ Success = $success; Message = "" }
    }

# ============================================================================
# Test 4: GET /cognitive/preferences
# ============================================================================
Write-TestHeader "GET /cognitive/preferences - User Preferences"

Test-Endpoint -Name "Get preferences list" -Method GET -Path "/cognitive/preferences" `
    -Validator {
        param($response)
        $success = $response.ok -eq $true -and $response.preferences -ne $null
        $message = ""
        if (-not $success) { $message = "Missing preferences" }
        @{ Success = $success; Message = $message }
    }

# ============================================================================
# Test 5: GET /cognitive/strategies
# ============================================================================
Write-TestHeader "GET /cognitive/strategies - Strategy Statistics"

Test-Endpoint -Name "Get strategies" -Method GET -Path "/cognitive/strategies" `
    -Validator {
        param($response)
        $success = $response.ok -eq $true -and $response.strategies -ne $null
        $message = ""
        if (-not $success) { $message = "Missing strategies" }
        @{ Success = $success; Message = $message }
    }

Test-Endpoint -Name "Strategies have stats" -Method GET -Path "/cognitive/strategies" `
    -Validator {
        param($response)
        $success = $response.stats -ne $null -and $response.stats.total -ge 0
        @{ Success = $success; Message = "" }
    }

# ============================================================================
# Test 6: GET /cognitive/project/:project
# ============================================================================
Write-TestHeader "GET /cognitive/project/:project - Project Context"

Test-Endpoint -Name "Get project context" -Method GET -Path "/cognitive/project/TestProject" `
    -Validator {
        param($response)
        $success = $response.ok -eq $true -and $response.context -ne $null
        @{ Success = $success; Message = "" }
    }

# ============================================================================
# Test 7: GET /cognitive/work-summary
# ============================================================================
Write-TestHeader "GET /cognitive/work-summary - Work Summary"

Test-Endpoint -Name "Get work summary (1 day)" -Method GET -Path "/cognitive/work-summary?days=1" `
    -Validator {
        param($response)
        $success = $response.ok -eq $true -and $response.summary -ne $null
        $message = ""
        if (-not $success) { $message = "Missing summary" }
        @{ Success = $success; Message = $message }
    }

Test-Endpoint -Name "Get work summary (7 days)" -Method GET -Path "/cognitive/work-summary?days=7" `
    -Validator {
        param($response)
        $success = $response.ok -eq $true -and $response.days -eq 7
        @{ Success = $success; Message = "" }
    }

# ============================================================================
# Test 8: GET /cognitive/contradictions
# ============================================================================
Write-TestHeader "GET /cognitive/contradictions - Knowledge Contradictions"

Test-Endpoint -Name "Get contradictions" -Method GET -Path "/cognitive/contradictions" `
    -Validator {
        param($response)
        $success = $response.ok -eq $true -and $response.contradictions -ne $null
        @{ Success = $success; Message = "" }
    }

# ============================================================================
# Test 9: GET /cognitive/active-projects
# ============================================================================
Write-TestHeader "GET /cognitive/active-projects - Active Projects"

Test-Endpoint -Name "Get active projects" -Method GET -Path "/cognitive/active-projects" `
    -Validator {
        param($response)
        $success = $response.ok -eq $true -and $response.projects -ne $null
        @{ Success = $success; Message = "" }
    }

# ============================================================================
# Test 10: POST /cognitive/memory/consolidate
# ============================================================================
if (-not $SkipSlowTests) {
    Write-TestHeader "POST /cognitive/memory/consolidate - Memory Consolidation"
    
    Test-Endpoint -Name "Trigger consolidation" -Method POST -Path "/cognitive/memory/consolidate" `
        -Body @{} `
        -Validator {
            param($response)
            $success = $response.ok -eq $true -and $response.report -ne $null
            $message = ""
            if (-not $success) { $message = "Missing report" }
            
            if ($success) {
                $hasReport = $response.report.episodesAnalyzed -ge 0 -and `
                             $response.report.skillsGenerated -ge 0
                $success = $hasReport
                if (-not $success) { $message = "Report missing key fields" }
            }
            
            @{ Success = $success; Message = $message }
        }
}

# ============================================================================
# Test 11: POST /cognitive/task/execute
# ============================================================================
if (-not $SkipSlowTests) {
    Write-TestHeader "POST /cognitive/task/execute - Full Task Execution"
    
    Test-Endpoint -Name "Execute task with full workflow" -Method POST -Path "/cognitive/task/execute" `
        -Body @{
            goal = "Test task execution"
            userInput = "Execute a test"
            projectContext = "Testing"
        } `
        -Validator {
            param($response)
            $success = $response.ok -eq $true -and $response.result -ne $null
            $message = ""
            if (-not $success) { $message = "Missing result" }
            
            if ($success) {
                $hasResult = $response.result.success -ne $null -and `
                             $response.result.evaluation -ne $null -and `
                             $response.result.episode -ne $null
                $success = $hasResult
                if (-not $success) { $message = "Result missing key fields" }
            }
            
            @{ Success = $success; Message = $message }
        }
    
    Test-Endpoint -Name "Task execution generates reward" -Method POST -Path "/cognitive/task/execute" `
        -Body @{
            goal = "Test reward"
            userInput = "Check reward signal"
        } `
        -Validator {
            param($response)
            $success = $response.result.reward -ne $null
            @{ Success = $success; Message = "" }
        }
    
    Test-Endpoint -Name "Task execution missing goal fails" -Method POST -Path "/cognitive/task/execute" `
        -Body @{ userInput = "Missing goal" } `
        -Validator {
            param($response)
            $success = $response.ok -eq $false
            @{ Success = $success; Message = "" }
        }
}

# ============================================================================
# Summary
# ============================================================================
Write-Host ""
Write-Host "=" * 70 -ForegroundColor $infoColor
Write-Host "TEST SUMMARY" -ForegroundColor $infoColor
Write-Host "=" * 70 -ForegroundColor $infoColor

$totalTests = $testsPassed + $testsFailed
$passRate = if ($totalTests -gt 0) { [math]::Round(($testsPassed / $totalTests) * 100, 1) } else { 0 }

Write-Host "Total Tests: $testsRun" -ForegroundColor $infoColor
Write-Host "Passed: $testsPassed" -ForegroundColor $successColor
Write-Host "Failed: $testsFailed" -ForegroundColor $(if ($testsFailed -gt 0) { $failColor } else { $successColor })
Write-Host "Pass Rate: $passRate%" -ForegroundColor $(if ($passRate -ge 90) { $successColor } else { $warningColor })

Write-Host ""

if ($testsFailed -eq 0) {
    Write-Host "✓ ALL TESTS PASSED!" -ForegroundColor $successColor
    exit 0
} else {
    Write-Host "✗ Some tests failed. Check output above." -ForegroundColor $failColor
    exit 1
}
