# register-sync-task.ps1 — register a Task Scheduler job that runs repo-sync
# at logon + daily at 9am. Re-run to update. Requires pwsh (PowerShell 7+).
$script = Join-Path $PSScriptRoot 'repo-sync.ps1'
if (-not (Test-Path $script)) { throw "repo-sync.ps1 not found next to this script." }

$exe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $exe) { $exe = 'powershell.exe' }   # fall back to Windows PowerShell if pwsh absent

$action  = New-ScheduledTaskAction -Execute $exe -Argument "-NoProfile -WindowStyle Hidden -File `"$script`""
$tLogon  = New-ScheduledTaskTrigger -AtLogOn
$tDaily  = New-ScheduledTaskTrigger -Daily -At 9am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd

Register-ScheduledTask -TaskName 'dotfiles-repo-sync' -Action $action -Trigger @($tLogon, $tDaily) `
  -Settings $settings -Description 'Clone/ff-pull all JoshKappler repos (safe: ff-only, skip-dirty)' -Force

Write-Host "Registered scheduled task 'dotfiles-repo-sync' (runs at logon + daily 9am)."
Write-Host "Test it now with:  Start-ScheduledTask -TaskName dotfiles-repo-sync"
