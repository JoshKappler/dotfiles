#!/usr/bin/env bash
# bootstrap-macos.sh — one-shot macOS setup for this cross-platform workspace.
#
# Installs Homebrew (if missing) + the toolchain, authenticates gh, applies the
# chezmoi dotfiles, and syncs project repos. macOS twin of bootstrap-windows.ps1.
#
# Run from anywhere:
#   bash <(curl -fsSL https://raw.githubusercontent.com/JoshKappler/dotfiles/main/scripts/bootstrap-macos.sh)
# or, from a clone:
#   bash scripts/bootstrap-macos.sh
#
# Idempotent: safe to re-run.
set -euo pipefail

info() { printf '\033[36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m!!  %s\033[0m\n' "$1"; }

# --- locate this script's dir (works whether cloned or piped) ----------------
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  # Piped via process substitution: no file on disk. chezmoi fetches the repo
  # below; fall back to the standard chezmoi source path for helper scripts.
  SCRIPT_DIR="$HOME/.local/share/chezmoi/scripts"
fi

# --- 1. Homebrew -------------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  info 'Installing Homebrew ...'
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
# Put brew on PATH for this session (Apple Silicon: /opt/homebrew, Intel: /usr/local).
if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

# --- 2. toolchain ------------------------------------------------------------
info 'Installing toolchain via Homebrew ...'
brew install gh chezmoi wezterm zellij helix espanso hammerspoon
info 'Installing JetBrains Mono Nerd Font (cask) ...'
brew install --cask font-jetbrains-mono-nerd-font

# --- 3. GitHub auth ----------------------------------------------------------
info 'Checking GitHub CLI auth ...'
if ! gh auth status >/dev/null 2>&1; then
  warn 'Not authenticated — launching `gh auth login` (interactive, opens a browser).'
  gh auth login
else
  info 'gh already authenticated.'
fi

# --- 4. chezmoi: init + apply the dotfiles -----------------------------------
# If this machine isn't already pointed at the JoshKappler source, clone+apply it.
already_source=false
if cm_source="$(chezmoi source-path 2>/dev/null)" && [ -d "$cm_source/.git" ]; then
  if git -C "$cm_source" remote get-url origin 2>/dev/null | grep -q 'JoshKappler/dotfiles'; then
    already_source=true
  fi
fi
if [ "$already_source" = true ]; then
  info "chezmoi source already JoshKappler/dotfiles ($cm_source) — applying."
  chezmoi apply
else
  info 'chezmoi init --apply JoshKappler ...'
  chezmoi init --apply JoshKappler
fi

# --- 5. project repos: clone/ff-pull -----------------------------------------
# macOS projects live at ~/projects (Windows uses OneDrive\desktop\projects).
info 'Syncing project repos (repo-sync.sh) ...'
bash "$SCRIPT_DIR/repo-sync.sh" "$HOME/projects" JoshKappler

# --- done --------------------------------------------------------------------
echo
info 'Bootstrap complete.'
warn 'Hammerspoon needs Accessibility permission for the Ctrl+Alt+C launcher hotkey:'
echo  '     System Settings > Privacy & Security > Accessibility > enable Hammerspoon.'
echo  '     Then open Hammerspoon once and Reload Config.'
info 'Note: zellij on macOS reads ~/.config/zellij natively — no env var needed (that is a Windows-only fixup).'
echo
info 'What to try:'
echo  '  - Open WezTerm. The font should be JetBrains Mono Nerd Font.'
echo  '  - Press Ctrl+Alt+C to open the Claude Control Center; from its Home tab pick a dir + agent count and launch.'
echo  '  - In a shell: `chezmoi managed` lists the configs now under management.'
