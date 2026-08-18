# SARA Production Build Script
# Usage: PowerShell -ExecutionPolicy Bypass -File scripts/build-prod.ps1
#
# Build pipeline:
#   Test → Compile → Generate BUILD_ID → Hash Manifest → Sign Manifest → Package
#
# Created by: Mr Amol Pandhre & the SARA Team

$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\.."
Set-Location $root

function Write-Step([string]$msg) {
    Write-Host "[SARA] $msg" -ForegroundColor Cyan
}
function Write-Success([string]$msg) {
    Write-Host "[SARA] ✓ $msg" -ForegroundColor Green
}
function Write-Fail([string]$msg) {
    Write-Host "[SARA] ✗ $msg" -ForegroundColor Red
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  SARA Production Build Pipeline" -ForegroundColor Cyan
Write-Host "  Created by Mr Amol Pandhre & the SARA Team" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Environment check ──────────────────────────────────────
Write-Step "Checking environment..."
node --version | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Fail "Node.js not found."; exit 1 }
npm --version | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Fail "npm not found."; exit 1 }
Write-Success "Environment OK"

# ── 2. TypeScript type check ──────────────────────────────────
Write-Step "Running TypeScript lint..."
npm run lint
if ($LASTEXITCODE -ne 0) { Write-Fail "TypeScript errors found. Fix before building."; exit 1 }
Write-Success "TypeScript OK"

# ── 3. Compile / bundle ───────────────────────────────────────
Write-Step "Compiling frontend + backend..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Fail "Build failed."; exit 1 }
Write-Success "Compile OK"

# ── 4. Build Python agent ────────────────────────────────────
Write-Step "Building Python desktop agent..."
npm run build:agent
if ($LASTEXITCODE -ne 0) {
    Write-Host "[SARA] Note: Python agent build skipped or failed — continuing." -ForegroundColor Yellow
}

# ── 5. Generate BUILD_ID and build manifest ───────────────────
Write-Step "Generating build identity..."
$BUILD_ID = [System.Guid]::NewGuid().ToString()
$BUILD_TIMESTAMP = (Get-Date -Format "o")
$VERSION = (node -e "const p=require('./package.json');console.log(p.version)" 2>$null)
if (-not $VERSION) { $VERSION = "1.0.0" }

$manifestData = @{
    SARA_NAME       = "SARA"
    SARA_VERSION    = $VERSION
    BUILD_ID        = $BUILD_ID
    BUILD_TIMESTAMP = $BUILD_TIMESTAMP
    author          = "Mr Amol Pandhre & the SARA Team"
    copyright       = "Copyright (C) 2026 Mr Amol Pandhre & the SARA Team"
}
$manifestDir = Join-Path $root "data"
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
$manifestPath = Join-Path $manifestDir "build-manifest.json"
$manifestData | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8
Write-Success "Build identity: SARA v$VERSION ($($BUILD_ID.Substring(0,8)))"

# ── 6. Generate & sign integrity manifest ────────────────────
Write-Step "Generating integrity manifest..."
node scripts/generate_integrity_manifest.js
if ($LASTEXITCODE -ne 0) { Write-Fail "Integrity manifest generation failed."; exit 1 }
Write-Success "Integrity manifest generated and signed"

# ── 7. Package (electron-builder) ────────────────────────────
Write-Step "Packaging with electron-builder..."
npx electron-builder --win nsis portable
if ($LASTEXITCODE -ne 0) { Write-Fail "Packaging failed."; exit 1 }
Write-Success "Package created in ./release"

# ── 8. Summary ────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  SARA Production Build Complete" -ForegroundColor Green
Write-Host "  Version:    $VERSION" -ForegroundColor Green
Write-Host "  Build ID:   $BUILD_ID" -ForegroundColor Green
Write-Host "  Timestamp:  $BUILD_TIMESTAMP" -ForegroundColor Green
Write-Host "  Output:     $root\release\" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
