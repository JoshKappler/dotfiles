# install-desktop-icon.ps1 — put a clean "Claude Control Center" shortcut on the
# Desktop, right next to the projects folder. Double-clicking it focuses the
# Control Center window if it's open, else launches it (via open-control-center.ahk).
# Idempotent: re-running just refreshes the shortcut. Run any time, or from bootstrap.

$ErrorActionPreference = 'Stop'

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Claude Control Center.lnk'

# Resolve AutoHotkey v2 (winget installs it under LOCALAPPDATA; allow ProgramFiles too).
$ahkCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\AutoHotkey\v2\AutoHotkey64.exe'),
  (Join-Path $env:ProgramFiles 'AutoHotkey\v2\AutoHotkey64.exe'),
  (Join-Path $env:ProgramFiles 'AutoHotkey\AutoHotkey64.exe')
)
$ahk = $ahkCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $ahk) { throw 'AutoHotkey v2 (AutoHotkey64.exe) not found — install it first (winget install AutoHotkey.AutoHotkey).' }

$script = Join-Path $env:USERPROFILE '.local\share\chezmoi\scripts\open-control-center.ahk'
if (-not (Test-Path $script)) { throw "open-control-center.ahk not found at $script" }

# Icon: prefer wezterm's (clean terminal glyph); fall back to the AHK exe.
$wez = Join-Path $env:ProgramFiles 'WezTerm\wezterm-gui.exe'
$icon = if (Test-Path $wez) { "$wez,0" } else { "$ahk,0" }

$projects = Join-Path $env:USERPROFILE 'OneDrive\desktop\projects'
if (-not (Test-Path $projects)) { $projects = $desktop }

$wsh = New-Object -ComObject WScript.Shell
$s = $wsh.CreateShortcut($lnkPath)
$s.TargetPath = $ahk
$s.Arguments = '"' + $script + '"'
$s.IconLocation = $icon
$s.WorkingDirectory = $projects
$s.Description = 'Open the Claude Control Center (focus if already running)'
$s.WindowStyle = 1
$s.Save()

Write-Host "Created: $lnkPath"
Write-Host "  target : $ahk"
Write-Host "  script : $script"
Write-Host "  icon   : $icon"
