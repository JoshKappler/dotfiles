# bootstrap-windows.ps1 — one-shot Windows setup for this cross-platform workspace.
#
# Installs the toolchain (winget), wires the Zellij env var, authenticates gh,
# applies the chezmoi dotfiles, syncs project repos + registers the sync task,
# and installs the Claude-grid AutoHotkey launcher into Startup.
#
# Run from anywhere:
#   iwr https://raw.githubusercontent.com/JoshKappler/dotfiles/main/scripts/bootstrap-windows.ps1 | iex
# or, from a clone:
#   pwsh -File scripts/bootstrap-windows.ps1
#
# Idempotent: safe to re-run. Two installs (WezTerm + gh) need elevation and will
# prompt for UAC; the rest install user-scope without a prompt.

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!!  $m" -ForegroundColor Yellow }

# --- locate this script's dir (works whether cloned or piped via iex) --------
if ($PSScriptRoot) {
  $ScriptDir = $PSScriptRoot
} else {
  # Piped through iex: no source dir yet. chezmoi will fetch the repo below;
  # fall back to the standard chezmoi source path for the helper scripts.
  $ScriptDir = Join-Path $env:USERPROFILE '.local\share\chezmoi\scripts'
}

# --- 1. winget toolchain -----------------------------------------------------
# User-scope (silent). 'wez.wezterm' and 'GitHub.cli' need ADMIN — winget will
# raise a UAC prompt for those two; approve it.
$wingetPkgs = @(
  'twpayne.chezmoi'                  # dotfiles manager
  'wez.wezterm'                      # terminal           (ADMIN / UAC)
  'Zellij.Zellij'                    # multiplexer
  'Helix.Helix'                      # editor
  'Espanso.Espanso'                  # text expander
  'AutoHotkey.AutoHotkey'            # launcher hotkeys
  'GitHub.cli'                       # gh (repo sync/auth) (ADMIN / UAC)
  'DEVCOM.JetBrainsMonoNerdFont'     # terminal font
)

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw 'winget not found. Install "App Installer" from the Microsoft Store, then re-run.'
}

Info 'Installing toolchain via winget (WezTerm + gh will prompt for UAC) ...'
foreach ($id in $wingetPkgs) {
  Info "winget install $id"
  winget install --id $id --exact --silent `
    --accept-package-agreements --accept-source-agreements
  # winget exits 0x8A15002B / -1978335189 when "no newer version available" — not an error.
  if ($LASTEXITCODE -ne 0) { Warn "winget '$id' returned exit $LASTEXITCODE (likely already installed; continuing)." }
}

# Make the just-installed tools visible to THIS session without a restart.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')

# --- 2. Windows env parity (ZELLIJ_CONFIG_DIR -> ~/.config/zellij) -----------
Info 'Setting Windows env vars (windows-env-setup.ps1) ...'
& (Join-Path $ScriptDir 'windows-env-setup.ps1')

# --- 3. GitHub auth ----------------------------------------------------------
Info 'Checking GitHub CLI auth ...'
gh auth status 2>$null
if ($LASTEXITCODE -ne 0) {
  Warn 'Not authenticated — launching `gh auth login` (interactive, opens a browser).'
  gh auth login
} else {
  Info 'gh already authenticated.'
}

# --- 4. chezmoi: init + apply the dotfiles -----------------------------------
# If this machine isn't already pointed at the JoshKappler source, clone+apply it.
$alreadySource = $false
$cmSource = (chezmoi source-path 2>$null)
if ($LASTEXITCODE -eq 0 -and $cmSource) {
  if (Test-Path (Join-Path $cmSource '.git')) {
    $url = (git -C $cmSource remote get-url origin 2>$null)
    if ($url -match 'JoshKappler/dotfiles') { $alreadySource = $true }
  }
}
if ($alreadySource) {
  Info "chezmoi source already JoshKappler/dotfiles ($cmSource) — applying."
  chezmoi apply
} else {
  Info 'chezmoi init --apply JoshKappler ...'
  chezmoi init --apply JoshKappler
}

# --- 5. project repos: clone/ff-pull + register the daily sync task ----------
Info 'Syncing project repos (repo-sync.ps1) ...'
& (Join-Path $ScriptDir 'repo-sync.ps1')

Info 'Registering the repo-sync scheduled task (register-sync-task.ps1) ...'
& (Join-Path $ScriptDir 'register-sync-task.ps1')

# --- 6. Claude-grid launcher into Startup ------------------------------------
# Drop a shortcut to claude-grid.ahk in the per-user Startup folder so the
# Ctrl+Alt+4 / Ctrl+Alt+6 hotkeys are live every logon, and start it now.
$ahk = Join-Path $ScriptDir 'claude-grid.ahk'
if (Test-Path $ahk) {
  $startup  = [Environment]::GetFolderPath('Startup')   # shell:startup
  $lnkPath  = Join-Path $startup 'claude-grid.lnk'
  Info "Installing launcher shortcut -> $lnkPath"
  $wsh = New-Object -ComObject WScript.Shell
  $sc  = $wsh.CreateShortcut($lnkPath)
  $sc.TargetPath = $ahk            # .ahk is associated with AutoHotkey's launcher
  $sc.WorkingDirectory = $ScriptDir
  $sc.Description = 'Claude Code grid launcher (Ctrl+Alt+4 / Ctrl+Alt+6)'
  $sc.Save()
  Info 'Starting the launcher now ...'
  Start-Process $ahk
} else {
  Warn "claude-grid.ahk not found at $ahk — skipping launcher install."
}

# --- done --------------------------------------------------------------------
Write-Host ''
Info 'Bootstrap complete. What to try:'
Write-Host '  - Open WezTerm (Start menu). The font should be JetBrainsMono Nerd Font.' -ForegroundColor Green
Write-Host '  - Press Ctrl+Alt+4 for a 2x2 Claude grid (Ctrl+Alt+6 for 2x3) on the vertical monitor.' -ForegroundColor Green
Write-Host '  - In a shell: `chezmoi managed` lists the configs now under management.' -ForegroundColor Green
Write-Host '  - Restart open shells once so ZELLIJ_CONFIG_DIR is picked up.' -ForegroundColor Green
