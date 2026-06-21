#!/usr/bin/env bash
# repo-sync.sh — clone missing + safely fast-forward all of a user's repos.
# Safe by design: ff-only, skips dirty/detached/empty work trees, logs every action.
# Requires: gh (authenticated) + git. Run ad-hoc or via launchd/cron.
set -euo pipefail
ROOT="${1:-$HOME/projects}"
USER_LOGIN="${2:-JoshKappler}"
mkdir -p "$ROOT"
LOG="$ROOT/_repo-sync.log"
log() { printf '%s  %s\n' "$(date -Iseconds)" "$1" | tee -a "$LOG"; }

command -v gh >/dev/null || { echo 'gh CLI not found — install + `gh auth login` first.' >&2; exit 1; }
mapfile -t repos < <(gh repo list "$USER_LOGIN" --limit 200 --json name -q '.[].name')
log "START sync of ${#repos[@]} repos into $ROOT"

for name in "${repos[@]}"; do
  dir="$ROOT/$name"
  if [ ! -d "$dir" ]; then log "CLONE $name"; gh repo clone "$USER_LOGIN/$name" "$dir" >/dev/null 2>&1; continue; fi
  ( cd "$dir"
    if [ -n "$(git status --porcelain)" ]; then log "SKIP  $name (dirty)"; git fetch --quiet; exit 0; fi
    if ! git symbolic-ref --quiet HEAD >/dev/null; then log "SKIP  $name (detached HEAD)"; git fetch --quiet; exit 0; fi
    if ! git rev-parse --verify --quiet HEAD >/dev/null; then log "SKIP  $name (empty repo)"; exit 0; fi
    branch="$(git rev-parse --abbrev-ref HEAD)"; git fetch --quiet
    if git pull --ff-only --quiet 2>/dev/null; then log "PULL  $name ($branch)"; else log "SKIP  $name (no-ff)"; fi )
done
log 'DONE'
