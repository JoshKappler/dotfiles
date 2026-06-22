# Reproduce this workspace (Claude: follow top-to-bottom)

This repo is the single source of truth for a cross-platform (Windows 11 + macOS)
power-user workspace centered on the **Claude Code CLI**: WezTerm terminal, Zellij
multiplexer, Helix editor, espanso text expansion, a Claude-grid launcher hotkey,
and project-repo auto-sync — all managed by [chezmoi](https://chezmoi.io) from the
private repo `JoshKappler/dotfiles`.

The two bootstrap scripts below do everything end-to-end. Run the one for the OS,
answer the interactive prompts, then walk the **Verify** checklist.

> chezmoi source lives at `~/.local/share/chezmoi` (its default), deliberately
> **outside OneDrive** — OneDrive corrupts git internals and mangles symlinks.

---

## Windows

One-liner (PowerShell — pwsh 7+ preferred, Windows PowerShell works too):

```powershell
iwr https://raw.githubusercontent.com/JoshKappler/dotfiles/main/scripts/bootstrap-windows.ps1 | iex
```

Or from a clone: `pwsh -File scripts/bootstrap-windows.ps1`

What it does, in order:
1. **winget-installs** the toolchain: chezmoi, WezTerm, Zellij, Helix, espanso,
   AutoHotkey, gh, JetBrains Mono Nerd Font.
2. Runs `scripts/windows-env-setup.ps1` to set `ZELLIJ_CONFIG_DIR` →
   `%USERPROFILE%\.config\zellij` (Windows-only parity fixup).
3. `gh auth status`, else `gh auth login`.
4. `chezmoi init --apply JoshKappler` (clones this repo + applies all configs).
5. `scripts/repo-sync.ps1` then `scripts/register-sync-task.ps1` (clone/ff-pull
   project repos + a logon+daily Task Scheduler job).
6. Drops a `claude-grid.ahk` shortcut into the Startup folder and starts it.

**Interactive bits:** WezTerm and gh install **per-machine and trigger a UAC
elevation prompt** — approve them. `gh auth login` opens a browser for GitHub
auth. Restart any open shells once afterward so `ZELLIJ_CONFIG_DIR` is picked up.

---

## macOS

One-liner (zsh/bash):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/JoshKappler/dotfiles/main/scripts/bootstrap-macos.sh)
```

Or from a clone: `bash scripts/bootstrap-macos.sh`

What it does, in order:
1. Installs **Homebrew** if missing.
2. `brew install` the toolchain: gh, chezmoi, wezterm, zellij, helix, espanso,
   hammerspoon, plus the `font-jetbrains-mono-nerd-font` cask.
3. `gh auth login` if not already authenticated.
4. `chezmoi init --apply JoshKappler`.
5. `scripts/repo-sync.sh "$HOME/projects" JoshKappler` (project-repo clone/ff-pull).

**Interactive bits:** `gh auth login` opens a browser. The launcher hotkeys are
driven by **Hammerspoon, which needs Accessibility permission** — System Settings
> Privacy & Security > Accessibility > enable **Hammerspoon**, then open
Hammerspoon and Reload Config. Zellij on macOS reads `~/.config/zellij`
natively, so there is no env var to set (that step is Windows-only).

---

## Verify

After bootstrap, confirm each:

- [ ] `chezmoi managed` lists the configs (wezterm, zellij, helix, espanso, …).
- [ ] **WezTerm** opens and uses the JetBrains Mono Nerd Font.
- [ ] **Zellij** shows its keybind hint bar at the bottom (run `zellij`).
- [ ] **Helix** (`hx`) shows the `Space` command popup when you press Space.
- [ ] **Ctrl+Alt+4** opens a 2×2 Claude grid on the vertical monitor
      (Ctrl+Alt+6 → 2×3). Windows = AutoHotkey, macOS = Hammerspoon.
- [ ] espanso: typing **`:plan`** expands to its snippet.
- [ ] In Claude Code, the **`/plan`** slash command works.
- [ ] **`cheat`** prints the master cheat sheet.

---

## Sync going forward

- **Pull the latest dotfiles + re-apply:** `chezmoi update` (= git pull + apply).
- **Edit a config:** `chezmoi edit <path>` (edits the source, then `chezmoi apply`),
  or edit in the repo and commit. Push to `JoshKappler/dotfiles`; other machines
  pick it up on their next `chezmoi update`.
- **Project repos** stay current automatically via the repo-sync task (Windows:
  `dotfiles-repo-sync` in Task Scheduler, logon + daily 9am). Run it ad-hoc with
  `scripts/repo-sync.ps1` (Win) / `scripts/repo-sync.sh` (Mac).
