param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$distRoot = Join-Path $root 'agent_dist'
$agentDir = Join-Path $distRoot 'sara-agent'
$agentExe = Join-Path $agentDir 'sara-agent.exe'
$specFile = Join-Path $root 'desktop_agent.spec'
$requirements = Join-Path $root 'desktop_agent\build-requirements.txt'
$workDir = Join-Path $root 'build\pyinstaller'

Push-Location $root
try {
    if ((Test-Path $agentExe) -and -not $Force) {
        Write-Host "Verified PyInstaller agent already exists at $agentExe — skipping rebuild."
        exit 0
    }

    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCommand) {
        throw 'Python 3.11+ was not found on PATH. Install Python and retry the agent build.'
    }
    $python = $pythonCommand.Source

    if (-not (Test-Path $specFile)) {
        throw "PyInstaller spec not found: $specFile"
    }
    if (-not (Test-Path $requirements)) {
        throw "Agent build requirements not found: $requirements"
    }

    Write-Host 'Installing the pinned desktop-agent and PyInstaller build requirements...'
    & $python -m pip install -r $requirements
    if ($LASTEXITCODE -ne 0) {
        throw "Installing desktop-agent build requirements failed with exit code $LASTEXITCODE."
    }

    New-Item -ItemType Directory -Force -Path $distRoot, $workDir | Out-Null
    Write-Host 'Running the canonical desktop_agent.spec build...'
    & $python -m PyInstaller --noconfirm --clean --distpath $distRoot --workpath $workDir $specFile
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE."
    }
    if (-not (Test-Path $agentExe -PathType Leaf)) {
        throw "PyInstaller completed but did not create the expected executable: $agentExe"
    }

    Write-Host "Desktop agent built and verified at $agentExe"
}
finally {
    Pop-Location
}
