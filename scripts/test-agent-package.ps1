$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceAgent = Join-Path $root 'agent_dist\sara-agent\sara-agent.exe'
$packagedAgent = Join-Path $root 'release\win-unpacked\resources\agent\sara-agent.exe'

if (-not (Test-Path $sourceAgent -PathType Leaf)) {
    throw "Built agent executable is missing: $sourceAgent"
}
if (-not (Test-Path $packagedAgent -PathType Leaf)) {
    throw "Electron package is missing the expected agent resource: $packagedAgent"
}

$sourceHash = (Get-FileHash -Algorithm SHA256 -Path $sourceAgent).Hash
$packagedHash = (Get-FileHash -Algorithm SHA256 -Path $packagedAgent).Hash
if ($sourceHash -ne $packagedHash) {
    throw 'The packaged agent executable does not match the built agent executable.'
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$tempData = Join-Path ([System.IO.Path]::GetTempPath()) ("sara-agent-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempData | Out-Null
$oldHost = $env:SARA_AGENT_HOST
$oldPort = $env:SARA_AGENT_PORT
$oldData = $env:SARA_DATA_DIR
$oldToken = $env:SARA_AGENT_INTERNAL_TOKEN
$agentProcess = $null
$tokenBytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($tokenBytes)
$testToken = [Convert]::ToBase64String($tokenBytes)

try {
    $env:SARA_AGENT_HOST = '127.0.0.1'
    $env:SARA_AGENT_PORT = [string]$port
    $env:SARA_DATA_DIR = $tempData
    $env:SARA_AGENT_INTERNAL_TOKEN = $testToken
    $agentProcess = Start-Process -FilePath $packagedAgent -WorkingDirectory (Split-Path $packagedAgent) -WindowStyle Hidden -PassThru

    $health = $null
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        if ($agentProcess.HasExited) {
            throw "Bundled agent exited before its health endpoint became ready (exit code $($agentProcess.ExitCode))."
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
            $auth = Invoke-RestMethod -Uri "http://127.0.0.1:$port/auth/check" -Headers @{ 'X-SARA-Agent-Token' = $testToken } -TimeoutSec 2
            $protocolReady = $health.service -eq 'sara-desktop-agent' -and
                $auth.service -eq 'sara-desktop-agent' -and
                $health.agent_auth_required -eq $true -and
                $auth.agent_auth_required -eq $true -and
                [int]$health.agent_auth_protocol_version -eq 1 -and
                [int]$auth.agent_auth_protocol_version -eq 1 -and
                [int]$health.tool_count -gt 0
            if ($protocolReady) { break }
            $health = $null
        } catch {
            Start-Sleep -Milliseconds 300
        }
    }
    if (-not $health) {
        throw 'Bundled agent did not return a healthy response with registered tools within 45 seconds.'
    }

    Write-Host "Packaged agent smoke test passed (tools=$($health.tool_count), sha256=$packagedHash)."
}
finally {
    if ($agentProcess -and -not $agentProcess.HasExited) {
        Stop-Process -Id $agentProcess.Id -Force -ErrorAction SilentlyContinue
        $agentProcess.WaitForExit(5000) | Out-Null
    }
    if ($null -eq $oldHost) { Remove-Item Env:SARA_AGENT_HOST -ErrorAction SilentlyContinue } else { $env:SARA_AGENT_HOST = $oldHost }
    if ($null -eq $oldPort) { Remove-Item Env:SARA_AGENT_PORT -ErrorAction SilentlyContinue } else { $env:SARA_AGENT_PORT = $oldPort }
    if ($null -eq $oldData) { Remove-Item Env:SARA_DATA_DIR -ErrorAction SilentlyContinue } else { $env:SARA_DATA_DIR = $oldData }
    if ($null -eq $oldToken) { Remove-Item Env:SARA_AGENT_INTERNAL_TOKEN -ErrorAction SilentlyContinue } else { $env:SARA_AGENT_INTERNAL_TOKEN = $oldToken }
    $rng.Dispose()
    [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
    Remove-Item -LiteralPath $tempData -Recurse -Force -ErrorAction SilentlyContinue
}
