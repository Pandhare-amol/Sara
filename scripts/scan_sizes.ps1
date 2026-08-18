Set-Location 'D:\project\new_jarvis\Sara\myraa-ai-assistant'
Write-Output '---TOP FILES---'
Get-ChildItem -Recurse -File -Force -ErrorAction SilentlyContinue |
  Sort-Object Length -Descending |
  Select-Object @{Name='SizeMB';Expression={[math]::Round($_.Length/1MB,2)}}, FullName -First 50 |
  Format-Table -AutoSize

Write-Output ''
Write-Output '---TOP FOLDERS (top-level)---'
Get-ChildItem -Directory -Force | ForEach-Object {
  $size=(Get-ChildItem -Path $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  [PSCustomObject]@{Name=$_.Name; SizeMB = [math]::Round($size/1MB,2)}
} | Sort-Object SizeMB -Descending | Format-Table -AutoSize -Wrap
