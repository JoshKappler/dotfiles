#!/usr/bin/env bash
# cheat.sh — print the generated workspace cheat sheet.
# Prefers glow > bat > less > cat, whichever is installed.
#
# Add a `cheat` command to your shell (~/.bashrc or ~/.zshrc):
#     cheat() { "$HOME/.local/share/chezmoi/scripts/cheat.sh"; }
#   or as an alias:
#     alias cheat="$HOME/.local/share/chezmoi/scripts/cheat.sh"
# (adjust the path if your chezmoi source dir differs: `chezmoi source-path`).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
doc="$(cd "$script_dir/.." && pwd)/docs/CHEATSHEET.md"

if [ ! -f "$doc" ]; then
  echo "Cheat sheet not found at $doc — run scripts/gen-cheatsheet.sh first." >&2
  exit 1
fi

if command -v glow >/dev/null 2>&1; then
  glow "$doc"
elif command -v bat >/dev/null 2>&1; then
  bat --language markdown --style plain "$doc"
elif command -v less >/dev/null 2>&1; then
  less "$doc"
else
  cat "$doc"
fi
