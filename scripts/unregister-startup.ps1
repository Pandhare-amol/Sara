# Windows Task Scheduler unregistration script for SARA Always-On Assistant
$TaskName = "SARA_AlwaysOn_Assistant"

Write-Host "Unregistering SARA Always-On Assistant from Windows Task Scheduler..."
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Successfully unregistered '$TaskName'."
