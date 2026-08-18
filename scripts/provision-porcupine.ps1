Param(
    [string]$Url = $env:PORCUPINE_KEYWORD_URL,
    [string]$Dest = "$PSScriptRoot/../data/porcupine/keyword.ppn"
)

if (-not $Url) {
    Write-Host "No URL provided. Set PORCUPINE_KEYWORD_URL or pass -Url 'https://...'"
    exit 2
}

Write-Host "Downloading Porcupine keyword from: $Url"
try {
    $destDir = Split-Path -Path $Dest -Parent
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
    Write-Host "Saved keyword to: $Dest"
} catch {
    Write-Host "Download failed: $_"
    exit 3
}
