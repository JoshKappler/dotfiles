# dotfiles

Cross-platform (Windows 11 + macOS) power-user workspace, managed by [chezmoi](https://chezmoi.io)
and synced via GitHub. This repo is the single source of truth for terminal, editor, multiplexer,
launcher, and prompt-library configuration.

**Lives outside OneDrive** (at chezmoi's default source path) — OneDrive corrupts git internals and
does not sync symlinks reliably.

- Design spec: [`docs/specs/2026-06-21-workspace-upgrade-design.md`](docs/specs/2026-06-21-workspace-upgrade-design.md)
- Master cheat sheet: `docs/CHEATSHEET.md` (generated)

## Bootstrap a machine
```sh
# Windows (PowerShell):  scripts/bootstrap-windows.ps1
# macOS (zsh/bash):      scripts/bootstrap-macos.sh
# both end with:         chezmoi init --apply JoshKappler
```

## Stack
WezTerm · Zellij · Helix · espanso · Claude Code slash-commands · gh (repo sync) · chezmoi (sync)
