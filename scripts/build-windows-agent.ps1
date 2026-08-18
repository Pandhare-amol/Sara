# Build helper for Windows: create a PyInstaller bundle of the desktop agent
# Usage: PowerShell -ExecutionPolicy Bypass -File scripts/build-windows-agent.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root/.. | Out-Null

Write-Host "Building Python desktop agent (placeholder)"

$agentSrc = Join-Path $PWD 'desktop_agent'
$distDir = Join-Path $PWD 'agent_dist\sara-agent'

# If a prebuilt agent exists, copy it
if (Test-Path $distDir) {
  Write-Host "Prebuilt agent already exists at $distDir — skipping build."
  Pop-Location | Out-Null
  exit 0
}

# Try to use pyinstaller in the current environment
$py = "python"
try {
  & $py --version > $null 2>&1
} catch {
  Write-Host "Python not found on PATH. Please install Python or place a prebuilt agent in agent_dist/sara-agent." -ForegroundColor Yellow
  Pop-Location | Out-Null
  exit 1
}

# Ensure pyinstaller is available
try {
  & $py -c "import PyInstaller" > $null 2>&1
} catch {
  Write-Host "PyInstaller not installed. Installing into current environment..."
  & $py -m pip install --user pyinstaller
}

# Build using pyinstaller (simple one-file bundle of desktop_agent/main.py)
$specEntry = Join-Path $agentSrc 'main.py'
if (-not (Test-Path $specEntry)) {
  Write-Host "Agent entry $specEntry not found. Ensure desktop_agent/main.py exists." -ForegroundColor Red
  Pop-Location | Out-Null
  exit 1
}

# Create dist folder
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

# Run pyinstaller
Write-Host "Running PyInstaller..."
& $py -m PyInstaller --noconfirm --onefile --add-data "${agentSrc};." --distpath $distDir $specEntry

if ($LASTEXITCODE -ne 0) {
  Write-Host "PyInstaller failed with exit code $LASTEXITCODE" -ForegroundColor Red
  Pop-Location | Out-Null
  exit $LASTEXITCODE
}

Write-Host "Agent built to $distDir"
Pop-Location | Out-Null
exit 0
