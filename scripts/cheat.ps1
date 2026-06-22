#!/usr/bin/env pwsh
# cheat.ps1 — print the generated workspace cheat sheet.
# Uses `bat` for syntax highlighting/paging if available, else plain Get-Content.
#
# Add a `cheat` command to your PowerShell profile (notepad $PROFILE):
#     function cheat { & "$HOME\.local\share\chezmoi\scripts\cheat.ps1" }
# (adjust the path if your chezmoi source dir differs: `chezmoi source-path`).
$ErrorActionPreference = 'Stop'

$doc = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'docs/CHEATSHEET.md'
if (-not (Test-Path $doc)) {
    Write-Error "Cheat sheet not found at $doc — run scripts/gen-cheatsheet.ps1 first."
    exit 1
}

if (Get-Command bat -ErrorAction SilentlyContinue) {
    & bat --language markdown --style plain $doc
} else {
    Get-Content -Path $doc
}
