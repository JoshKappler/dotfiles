# repo-sync.ps1 — clone missing + safely fast-forward all of a user's repos.
# Safe by design: ff-only, skips dirty/detached/empty work trees, logs every action.
# Requires: gh (authenticated) + git. Run ad-hoc or via Task Scheduler (register-sync-task.ps1).
param(
  [string]$Root = (Join-Path $env:USERPROFILE 'OneDrive\desktop\projects'),
  [string]$User = 'JoshKappler',
  [string[]]$Exclude = @('dotfiles')   # the config repo lives at ~/.local/share/chezmoi, NOT in projects
)
$ErrorActionPreference = 'Continue'    # git/gh write progress to stderr; don't let that abort the loop
if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root | Out-Null }
$log = Join-Path $Root '_repo-sync.log'
function Log($m) { $l = '{0}  {1}' -f (Get-Date -Format s), $m; Add-Content -Path $log -Value $l; Write-Host $l }

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh CLI not found — install + `gh auth login` first.' }

# Enumerate every repo (limit 200 because gh defaults to 30). Forks are excluded by gh's default.
$repos = gh repo list $User --limit 200 --json name -q '.[].name'
Log ("START sync of {0} repos into {1}" -f ($repos | Measure-Object).Count, $Root)

foreach ($name in $repos) {
  if ($Exclude -contains $name) { Log "SKIP  $name (excluded)"; continue }
  $dir = Join-Path $Root $name
  if (-not (Test-Path $dir)) { Log "CLONE $name"; gh repo clone "$User/$name" $dir 2>&1 | Out-Null; continue }
  Push-Location $dir
  try {
    if (git status --porcelain) { Log "SKIP  $name (dirty)"; git fetch --quiet; continue }
    if (-not (git symbolic-ref --quiet HEAD)) { Log "SKIP  $name (detached HEAD)"; git fetch --quiet; continue }
    # Unborn/empty repo: HEAD points at a branch with no commits.
    git rev-parse --verify --quiet HEAD > $null
    if ($LASTEXITCODE -ne 0) { Log "SKIP  $name (empty repo)"; continue }
    $branch = git rev-parse --abbrev-ref HEAD
    git fetch --quiet
    git pull --ff-only 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Log "PULL  $name ($branch)" } else { Log "SKIP  $name (no-ff)" }
  } finally { Pop-Location }
}
Log 'DONE'
