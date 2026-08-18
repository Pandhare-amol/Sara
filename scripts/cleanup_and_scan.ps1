Set-Location 'D:\project\new_jarvis\Sara\myraa-ai-assistant'
$targets = @('release','agent_dist','agent_build','node_modules','mobile_app\node_modules','.venv','.pnpm-store')
foreach($t in $targets) {
  if (Test-Path $t) {
    Write-Output "Removing $t"
    Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Output "$t not found"
  }
}

Write-Output "Running git gc..."
if (Test-Path '.git') {
  git gc --aggressive --prune=now
} else {
  Write-Output ".git not found, skipping git gc"
}

Write-Output "Repairing npm cache (optional)..."
try { npm cache verify --silent } catch { }

Write-Output "Cleanup done."
Write-Output "---POST-CLEAN SCAN---"
Set-Location 'D:\project\new_jarvis\Sara\myraa-ai-assistant'
.\scripts\scan_sizes.ps1
