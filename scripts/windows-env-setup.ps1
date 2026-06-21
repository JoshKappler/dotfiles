# windows-env-setup.ps1 — Windows-only env vars for cross-platform config parity.
# Zellij on Windows defaults to %APPDATA%\Zellij\config; point it at ~/.config/zellij
# so the exact same config file works on both Windows and macOS.
# (macOS/Linux use ~/.config/zellij natively, so this is not needed there.)
# Called by bootstrap-windows.ps1; safe to re-run.
$cfg = Join-Path $env:USERPROFILE '.config\zellij'
[Environment]::SetEnvironmentVariable('ZELLIJ_CONFIG_DIR', $cfg, 'User')
Write-Host "Set User env ZELLIJ_CONFIG_DIR = $cfg  (restart shells to pick it up)."
