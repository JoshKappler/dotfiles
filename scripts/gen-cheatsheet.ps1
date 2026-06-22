#!/usr/bin/env pwsh
# gen-cheatsheet.ps1 — concatenate docs/cheatsheet/*.md (sorted by filename)
# into docs/CHEATSHEET.md with a generated header. Do NOT edit CHEATSHEET.md by
# hand; edit the partials in docs/cheatsheet/ and re-run this script.
$ErrorActionPreference = 'Stop'

$repo    = Resolve-Path (Join-Path $PSScriptRoot '..')
$partDir = Join-Path $repo 'docs/cheatsheet'
$outFile = Join-Path $repo 'docs/CHEATSHEET.md'

$parts = Get-ChildItem -Path $partDir -Filter '*.md' -File | Sort-Object Name
if (-not $parts) { throw "No partials found in $partDir" }

$utf8 = [System.Text.UTF8Encoding]::new($false)

$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine('<!-- GENERATED FILE -- do not edit by hand.')
[void]$sb.AppendLine('     Source: docs/cheatsheet/*.md -- regenerate with scripts/gen-cheatsheet.ps1 -->')
[void]$sb.AppendLine('')

foreach ($p in $parts) {
    # Read explicitly as UTF-8 (PowerShell 5.1's Get-Content defaults to the ANSI codepage).
    $content = [System.IO.File]::ReadAllText($p.FullName, $utf8).TrimEnd()
    [void]$sb.AppendLine($content)
    [void]$sb.AppendLine('')
}

# Write UTF-8 without BOM, LF line endings.
$text = ($sb.ToString() -replace "`r`n", "`n")
[System.IO.File]::WriteAllText($outFile, $text, $utf8)

Write-Host "Wrote $outFile from $($parts.Count) partial(s)."
