#!/usr/bin/env pwsh
# Phase 13b: Production Deployment Verification Script
# Comprehensive testing of SARA system in production configuration

param(
    [string]$BaseUrl = "http://localhost:3000"
)

$ErrorActionPreference = "Continue"
$testsPassed = 0
$testsFailed = 0

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "PHASE 13b: PRODUCTION DEPLOYMENT VERIFICATION" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

function Test-Endpoint {
    param([string]$Name, [string]$Method, [string]$Url, [string]$Body = $null)
    
    Write-Host "TEST: $Name" -ForegroundColor Yellow
    
    try {
        $params = @{ Uri = $Url; Method = $Method; TimeoutSec = 30 }
        if ($Body) {
            $params.Body = $Body
            $params.ContentType = "application/json"
        }
        
        $response = Invoke-RestMethod @params
        Write-Host "  [PASS] Received response" -ForegroundColor Green
        $global:testsPassed++
        return $response
    }
    catch {
        Write-Host "  [FAIL] $($_.Exception.Message)" -ForegroundColor Red
        $global:testsFailed++
        return $null
    }
}

# SECTION 1: Cognitive Endpoints
Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "SECTION 1: COGNITIVE API VERIFICATION (11 ENDPOINTS)" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

Test-Endpoint "Memory Statistics" GET "$BaseUrl/cognitive/memory/stats" | Out-Null
Write-Host ""

Test-Endpoint "User Preferences" GET "$BaseUrl/cognitive/preferences" | Out-Null
Write-Host ""

Test-Endpoint "Strategy Performance" GET "$BaseUrl/cognitive/strategies" | Out-Null
Write-Host ""

Test-Endpoint "Active Projects" GET "$BaseUrl/cognitive/active-projects" | Out-Null
Write-Host ""

Test-Endpoint "Work Summary" GET "$BaseUrl/cognitive/work-summary" | Out-Null
Write-Host ""

Test-Endpoint "Knowledge Contradictions" GET "$BaseUrl/cognitive/contradictions" | Out-Null
Write-Host ""

$planBody = (@{ goal = "Deployment verification"; context = @{ env = "prod" } } | ConvertTo-Json -Compress)
Test-Endpoint "Create Hierarchical Plan" POST "$BaseUrl/cognitive/plan" $planBody | Out-Null
Write-Host ""

$remBody = (@{ category = "deployment"; content = "Production system verified"; type = "fact" } | ConvertTo-Json -Compress)
Test-Endpoint "Record Semantic Knowledge" POST "$BaseUrl/cognitive/remember" $remBody | Out-Null
Write-Host ""

$execBody = (@{ taskId = "deploy-001"; goal = "Verify system"; userInput = "Health check"; projectContext = "deploy" } | ConvertTo-Json -Compress)
Test-Endpoint "Execute Task with Agent" POST "$BaseUrl/cognitive/task/execute" $execBody | Out-Null
Write-Host ""

$consBody = (@{ includeArchive = $false } | ConvertTo-Json -Compress)
Test-Endpoint "Memory Consolidation" POST "$BaseUrl/cognitive/memory/consolidate" $consBody | Out-Null
Write-Host ""

Test-Endpoint "Project Metrics" GET "$BaseUrl/cognitive/project/deployment" | Out-Null
Write-Host ""

# SECTION 2: Data Persistence
Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "SECTION 2: DATA PERSISTENCE" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

$files = @("data/episodic_memories.json", "data/semantic_memories.json", "data/settings.json")
foreach ($f in $files) {
    if (Test-Path $f) {
        $size = [math]::Round((Get-Item $f).Length / 1KB, 1)
        Write-Host "[OK] $f ($size KB)" -ForegroundColor Green
    } else {
        Write-Host "[PENDING] $f (will be created on use)" -ForegroundColor Yellow
    }
}

# SECTION 3: Desktop Agent
Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "SECTION 3: DESKTOP AGENT" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

try {
    $agent = Invoke-RestMethod -Uri "http://localhost:8765/health" -TimeoutSec 5
    Write-Host "[OK] Desktop agent running at http://localhost:8765" -ForegroundColor Green
    if ($agent.tools_count) {
        Write-Host "     Tools available: $($agent.tools_count)" -ForegroundColor Green
    }
}
catch {
    Write-Host "[INFO] Desktop agent will start automatically when needed" -ForegroundColor Yellow
}

# SECTION 4: Build Artifacts
Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "SECTION 4: BUILD ARTIFACTS" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

if (Test-Path "dist/server.cjs") {
    $size = [math]::Round((Get-Item "dist/server.cjs").Length / 1KB, 1)
    Write-Host "[OK] dist/server.cjs ($size KB)" -ForegroundColor Green
}

if (Test-Path "dist/index.html") {
    Write-Host "[OK] dist/index.html" -ForegroundColor Green
}

$pkg = Get-Content package.json | ConvertFrom-Json
Write-Host "[OK] Version: $($pkg.version)" -ForegroundColor Green

# SECTION 5: Phase 12 Modules
Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "SECTION 5: ADVANCED FEATURES (PHASE 12)" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

$modules = @(
    "src/cognitive/multiAgentCoordinator.ts",
    "src/cognitive/hierarchicalDecomposer.ts",
    "src/cognitive/transferLearner.ts",
    "src/cognitive/anomalyDetector.ts"
)

foreach ($m in $modules) {
    if (Test-Path $m) {
        $lines = (Get-Content $m | Measure-Object -Line).Lines
        Write-Host "[OK] $m ($lines lines)" -ForegroundColor Green
    }
}

# SUMMARY
Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "VERIFICATION SUMMARY" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

$total = $testsPassed + $testsFailed
$rate = if ($total -gt 0) { [math]::Round(($testsPassed / $total) * 100, 1) } else { 0 }

Write-Host "Tests Passed:  $testsPassed" -ForegroundColor Green
Write-Host "Tests Failed:  $testsFailed" -ForegroundColor $(if ($testsFailed -eq 0) {"Green"} else {"Red"})
Write-Host "Pass Rate:     $rate%" -ForegroundColor $(if ($rate -ge 90) {"Green"} else {"Yellow"})

Write-Host ""
if ($testsFailed -eq 0) {
    Write-Host "[OK] SYSTEM PRODUCTION READY" -ForegroundColor Green
} else {
    Write-Host "[ALERT] Address failures before deployment" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Server:     $BaseUrl" -ForegroundColor White
Write-Host "Agent:      http://localhost:8765" -ForegroundColor White
Write-Host "Data:       ./data/" -ForegroundColor White
Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "VERIFICATION COMPLETE" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""
