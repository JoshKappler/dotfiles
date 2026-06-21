# Workspace Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended here — installs and visual verification need the live machine + user) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a cross-platform (Windows 11 + macOS) power-user workspace centered on Claude Code — WezTerm + Zellij + Helix, an espanso/slash-command prompt library, a hotkey Claude-grid launcher, safe repo auto-sync, and a built-in cheat-sheet system — all managed by chezmoi and synced through `JoshKappler/dotfiles`.

**Architecture:** One git repo (`JoshKappler/dotfiles`, the chezmoi source, living *outside* OneDrive) is the source of truth. chezmoi renders configs into `$HOME` with per-OS templating. Tools install via winget (Win) / brew (Mac). GitHub is the sync channel; both machines `chezmoi update` to stay identical. A `BOOTSTRAP.md` lets a fresh Claude reproduce the whole setup on the Mac from one instruction.

**Tech Stack:** chezmoi · WezTerm (Lua) · Zellij (KDL) · Helix (TOML) · espanso (YAML) · Claude Code slash-commands (Markdown) · AutoHotkey v2 (Win) / Hammerspoon (Mac) · gh CLI · PowerShell + Bash · Task Scheduler / launchd.

## Global Constraints

- **Repo home (outside OneDrive):** `C:\Users\joshu\.local\share\chezmoi` (Win) / `~/.local/share/chezmoi` (Mac). Never under OneDrive.
- **Main git:** `https://github.com/JoshKappler/dotfiles.git` (private). Branch `main`. Both machines sync to it.
- **chezmoi managed root:** only the `home/` subtree (via `.chezmoiroot`). `scripts/`, `prompts/`, `docs/` are plain repo content.
- **Per-OS templating:** branch on `.chezmoi.os` (`"windows"` / `"darwin"`).
- **No symlinks** (OneDrive-hostile) — chezmoi copies real files.
- **Cheat-sheet requirement:** every interactive tool must show keybindings on-screen (Zellij hint bar, Helix popup) + a generated `docs/CHEATSHEET.md` surfaced by a `cheat` command.
- **Repo-sync safety:** enumerate with `--limit 200`; fast-forward only; skip dirty/detached; always log.
- **Git identity (this repo):** `user.name=JoshKappler`, `user.email=joshua.kappler@gmail.com`.
- **Commit cadence:** commit + push to `origin/main` at the end of every task.
- **Projects folder (sync target for repo-sync):** `C:\Users\joshu\OneDrive\desktop\projects` (Win) / `~/projects` (Mac — confirm path on the Mac).

---

## Phase 0 — Repo sync + the "clone everything" pass

*Deliverable: every `JoshKappler` repo present locally and fast-forwarded; a safe, scheduled auto-sync script. (`gh` enumeration; immediate pass can use the GitHub API/MCP list while `gh auth` is pending.)*

### Task 0.1: Install + authenticate `gh`

**Files:** none (machine setup).

- [ ] **Step 1:** Install gh. Run: `winget install --id GitHub.cli -e --source winget`
  Expected: "Successfully installed". `[YOU]` may need to approve a UAC prompt.
- [ ] **Step 2:** Open a fresh terminal, verify: `gh --version` → prints a version ≥ 2.x.
- [ ] **Step 3:** `[YOU]` Authenticate (interactive, browser/device flow): `gh auth login` → choose GitHub.com → HTTPS → "Login with a web browser". Confirm with `gh auth status` → "Logged in to github.com account JoshKappler".
- [ ] **Step 4:** Verify enumeration works: `gh repo list JoshKappler --limit 200 --json name -q '.[].name' | measure-object` → count ≈ 28.

### Task 0.2: Write the repo-sync scripts

**Files:**
- Create: `scripts/repo-sync.ps1`
- Create: `scripts/repo-sync.sh`

**Produces:** a script that, idempotently: enumerates all repos, clones missing ones, and `--ff-only` pulls the rest, skipping dirty/detached and logging every outcome.

- [ ] **Step 1:** Create `scripts/repo-sync.ps1`:

```powershell
# repo-sync.ps1 — clone missing + safely fast-forward all of a user's repos.
# Safe by design: ff-only, skips dirty/detached work trees, logs every action.
param(
  [string]$Root = (Join-Path $env:USERPROFILE 'OneDrive\desktop\projects'),
  [string]$User = 'JoshKappler'
)
$ErrorActionPreference = 'Stop'
$log = Join-Path $Root '_repo-sync.log'
function Log($m) { $l = '{0}  {1}' -f (Get-Date -Format s), $m; Add-Content -Path $log -Value $l; Write-Host $l }

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh CLI not found — run Task 0.1 first.' }
$repos = gh repo list $User --limit 200 --json name -q '.[].name'
Log ("START sync of {0} repos into {1}" -f ($repos | Measure-Object).Count, $Root)

foreach ($name in $repos) {
  $dir = Join-Path $Root $name
  if (-not (Test-Path $dir)) { Log "CLONE $name"; gh repo clone "$User/$name" $dir 2>&1 | Out-Null; continue }
  Push-Location $dir
  try {
    if (git status --porcelain) { Log "SKIP  $name (dirty)"; git fetch --quiet; continue }
    if (-not (git symbolic-ref --quiet HEAD)) { Log "SKIP  $name (detached HEAD)"; git fetch --quiet; continue }
    $branch = git rev-parse --abbrev-ref HEAD
    git fetch --quiet
    $out = git pull --ff-only 2>&1
    if ($LASTEXITCODE -eq 0) { Log "PULL  $name ($branch)" } else { Log "SKIP  $name (no-ff)" }
  } finally { Pop-Location }
}
Log 'DONE'
```

- [ ] **Step 2:** Create `scripts/repo-sync.sh` (Mac/Linux twin):

```bash
#!/usr/bin/env bash
# repo-sync.sh — clone missing + safely fast-forward all of a user's repos.
set -euo pipefail
ROOT="${1:-$HOME/projects}"
USER_LOGIN="${2:-JoshKappler}"
LOG="$ROOT/_repo-sync.log"
log() { printf '%s  %s\n' "$(date -Iseconds)" "$1" | tee -a "$LOG"; }

command -v gh >/dev/null || { echo 'gh CLI not found — run Task 0.1 first.' >&2; exit 1; }
mkdir -p "$ROOT"
mapfile -t repos < <(gh repo list "$USER_LOGIN" --limit 200 --json name -q '.[].name')
log "START sync of ${#repos[@]} repos into $ROOT"

for name in "${repos[@]}"; do
  dir="$ROOT/$name"
  if [ ! -d "$dir" ]; then log "CLONE $name"; gh repo clone "$USER_LOGIN/$name" "$dir" >/dev/null 2>&1; continue; fi
  ( cd "$dir"
    if [ -n "$(git status --porcelain)" ]; then log "SKIP  $name (dirty)"; git fetch --quiet; exit 0; fi
    if ! git symbolic-ref --quiet HEAD >/dev/null; then log "SKIP  $name (detached HEAD)"; git fetch --quiet; exit 0; fi
    branch="$(git rev-parse --abbrev-ref HEAD)"; git fetch --quiet
    if git pull --ff-only --quiet 2>/dev/null; then log "PULL  $name ($branch)"; else log "SKIP  $name (no-ff)"; fi )
done
log 'DONE'
```

- [ ] **Step 3:** Commit. `chezmoi cd` then:
```bash
git add scripts/repo-sync.ps1 scripts/repo-sync.sh && git commit -m "feat(sync): add safe repo-sync scripts" && git push
```

### Task 0.3: Run the first full sync

- [ ] **Step 1:** Dry-run mentally / run it: `pwsh -File scripts/repo-sync.ps1`
  Expected: log lines `CLONE …` for any missing repos, `PULL …`/`SKIP …` for the rest, ending `DONE`. No errors.
- [ ] **Step 2:** Verify count: number of subfolders in the projects root ≈ repo count from Task 0.1 Step 4.
- [ ] **Step 3:** Inspect `_repo-sync.log` — confirm no repo was clobbered (dirty ones say `SKIP (dirty)`).

### Task 0.4: Schedule the auto-sync (Windows)

**Files:** Create `scripts/register-sync-task.ps1`

- [ ] **Step 1:** Create `scripts/register-sync-task.ps1`:

```powershell
# Registers a Task Scheduler job: run repo-sync at logon + every day at 9am.
$script = Join-Path $PSScriptRoot 'repo-sync.ps1'
$action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument "-NoProfile -WindowStyle Hidden -File `"$script`""
$tLogon = New-ScheduledTaskTrigger -AtLogOn
$tDaily = New-ScheduledTaskTrigger -Daily -At 9am
Register-ScheduledTask -TaskName 'dotfiles-repo-sync' -Action $action -Trigger @($tLogon,$tDaily) `
  -Description 'Clone/ff-pull all JoshKappler repos (safe)' -Force
```

- [ ] **Step 2:** `[YOU]` Run it: `pwsh -File scripts/register-sync-task.ps1` (may prompt UAC). Expected: task registered.
- [ ] **Step 3:** Verify: `Get-ScheduledTask -TaskName dotfiles-repo-sync` → State Ready. Force a run: `Start-ScheduledTask -TaskName dotfiles-repo-sync`, then check `_repo-sync.log` got a fresh `START…DONE`.
- [ ] **Step 4:** Commit + push the scheduler script.

---

## Phase 1 — Foundations: chezmoi + tool installs

*Deliverable: chezmoi initialized against the GitHub remote with the `home/` tree; core tools installed.*

### Task 1.1: Install the toolchain (winget)

- [ ] **Step 1:** Install: `winget install -e --id twpayne.chezmoi --id wez.wezterm --id zellij.zellij --id Helix.Helix --id espanso.espanso --id AutoHotkey.AutoHotkey`
  (`[YOU]` approve UAC.) If a combined install errors, install ids one at a time.
- [ ] **Step 2:** Open a fresh terminal; verify each: `chezmoi --version`, `wezterm --version`, `zellij --version`, `hx --version`, `espanso --version`, `autohotkey` present. Each prints a version.
- [ ] **Step 3:** Install a coding font: `winget install -e --id DEVCOM.JetBrainsMonoNerdFont` (or equivalent). Verify it appears in `wezterm ls-fonts --list-system | Select-String JetBrains`.

### Task 1.2: Initialize chezmoi against the repo

**Files:** Create `.chezmoiroot`, `home/.keep`, `home/dot_config/.keep`

- [ ] **Step 1:** Create `.chezmoiroot` containing exactly: `home`
- [ ] **Step 2:** Create the managed tree: `home/dot_config/` (with a `.keep` so it's tracked).
- [ ] **Step 3:** Point chezmoi at this source. Since the repo already lives at the default source path, verify: `chezmoi source-path` → prints `…\.local\share\chezmoi`. Run `chezmoi doctor` → no blocking errors (warnings about missing optional tools are fine).
- [ ] **Step 4:** Verify the root scoping works: `chezmoi managed` lists only things under `home/` (currently empty/`.keep`), NOT `scripts/`/`docs/`.
- [ ] **Step 5:** Commit + push (`feat(chezmoi): set .chezmoiroot=home and managed tree`).

---

## Phase 2 — Terminal + multiplexer (WezTerm + Zellij)

*Deliverable: WezTerm opens with the config; Zellij runs with an always-on hint bar; a `claude-grid` layout opens a 2×2 of panes.*

### Task 2.1: WezTerm config

**Files:** Create `home/dot_config/wezterm/wezterm.lua.tmpl`

- [ ] **Step 1:** Create the file:

```lua
-- ~/.config/wezterm/wezterm.lua  (managed by chezmoi)
local wezterm = require 'wezterm'
local config = wezterm.config_builder()

config.font = wezterm.font_with_fallback { 'JetBrainsMono Nerd Font', 'JetBrains Mono', 'Cascadia Code' }
config.font_size = {{ if eq .chezmoi.os "darwin" }}14.0{{ else }}11.0{{ end }}
config.color_scheme = 'Catppuccin Mocha'
config.hide_tab_bar_if_only_one_tab = true
config.window_decorations = 'RESIZE'
config.window_close_confirmation = 'NeverPrompt'
config.adjust_window_size_when_changing_font_size = false
{{ if eq .chezmoi.os "windows" }}
config.default_prog = { 'pwsh.exe', '-NoLogo' }
{{ end }}

-- Leader = CTRL+a, distinct from Zellij's Ctrl-p/Ctrl-t so the two never collide.
-- WezTerm only manages WINDOWS/TABS; Zellij owns panes inside a window.
config.leader = { key = 'a', mods = 'CTRL', timeout_milliseconds = 1000 }
config.keys = {
  { key = 'n', mods = 'LEADER', action = wezterm.action.SpawnWindow },
  { key = 't', mods = 'LEADER', action = wezterm.action.SpawnTab 'CurrentPaneDomain' },
  { key = 'w', mods = 'LEADER', action = wezterm.action.CloseCurrentTab { confirm = false } },
  { key = 'f', mods = 'LEADER', action = wezterm.action.ToggleFullScreen },
}

-- Lightweight cheat cue: when LEADER is held, show the available window/tab keys.
wezterm.on('update-right-status', function(window, _)
  window:set_right_status(window:leader_is_active() and ' LEADER ▸ n:new-win  t:tab  w:close  f:fullscreen ' or '')
end)

return config
```

- [ ] **Step 2:** Apply: `chezmoi apply -v`. Expected: writes `~/.config/wezterm/wezterm.lua`.
- [ ] **Step 3:** `[YOU]` Launch WezTerm. Expected: opens with the font/theme; pressing `Ctrl+a` shows the LEADER hint on the right; `Ctrl+a n` opens a second window.
- [ ] **Step 4:** Commit + push.

### Task 2.2: Zellij config (the hint bar + Claude-safe locking)

**Files:** Create `home/dot_config/zellij/config.kdl`

- [ ] **Step 1:** Create:

```kdl
// ~/.config/zellij/config.kdl  (managed by chezmoi)
theme "catppuccin-mocha"
pane_frames true
default_layout "default"   // the default layout keeps the bottom keybinding HINT BAR visible
show_startup_tips false
copy_on_select true

// Claude Code is a full-screen TUI. Ctrl+g toggles LOCKED mode, which passes
// every key straight through to Claude so Zellij never eats its shortcuts.
// The hint bar always shows how to leave locked mode.
keybinds {
    normal {
        bind "Ctrl g" { SwitchToMode "locked"; }
    }
    locked {
        bind "Ctrl g" { SwitchToMode "normal"; }
    }
}
```

- [ ] **Step 2:** Apply: `chezmoi apply -v`.
- [ ] **Step 3:** `[YOU]` In WezTerm run `zellij`. Expected: the **bottom keybinding hint bar is visible** and updates by mode (Pane/Tab/Resize/etc.); `Ctrl+g` flips to LOCKED and back.
- [ ] **Step 4:** Commit + push.

### Task 2.3: The `claude-grid` layouts

**Files:** Create `home/dot_config/zellij/layouts/claude-grid.kdl` and `claude-grid-6.kdl`

- [ ] **Step 1:** Create `claude-grid.kdl` (2×2):

```kdl
layout {
    tab name="claude" {
        pane split_direction="vertical" {
            pane split_direction="horizontal" { pane command="claude"; pane command="claude"; }
            pane split_direction="horizontal" { pane command="claude"; pane command="claude"; }
        }
    }
}
```

- [ ] **Step 2:** Create `claude-grid-6.kdl` (2 columns × 3 rows):

```kdl
layout {
    tab name="claude" {
        pane split_direction="vertical" {
            pane split_direction="horizontal" { pane command="claude"; pane command="claude"; pane command="claude"; }
            pane split_direction="horizontal" { pane command="claude"; pane command="claude"; pane command="claude"; }
        }
    }
}
```

- [ ] **Step 3:** Apply: `chezmoi apply -v`.
- [ ] **Step 4:** `[YOU]` Test: `zellij --layout claude-grid`. Expected: a 2×2 grid of panes, each launching `claude` (if `claude` is on PATH). Closing a pane (`Ctrl+p x`) and opening a new one (`Ctrl+p n`) works, with the keys shown in the hint bar.
- [ ] **Step 5:** Commit + push.

---

## Phase 3 — Editor (Helix)

*Deliverable: `hx` opens with config; the which-key popup appears; LSP works on a real repo.*

### Task 3.1: Helix config

**Files:** Create `home/dot_config/helix/config.toml` and `home/dot_config/helix/languages.toml`

- [ ] **Step 1:** Create `config.toml`:

```toml
# ~/.config/helix/config.toml (managed by chezmoi)
theme = "catppuccin_mocha"

[editor]
line-number = "relative"
cursorline = true
color-modes = true
bufferline = "multiple"
true-color = true

[editor.cursor-shape]
insert = "bar"
normal = "block"
select = "underline"

[editor.lsp]
display-messages = true
display-inlay-hints = true

[editor.file-picker]
hidden = false
```

- [ ] **Step 2:** Create `languages.toml` (LSPs auto-used if installed; harmless if not):

```toml
# ~/.config/helix/languages.toml
[[language]]
name = "typescript"
auto-format = true

[[language]]
name = "python"
auto-format = true

[[language]]
name = "rust"
auto-format = true
```

- [ ] **Step 3:** Apply: `chezmoi apply -v`. Verify config valid: `hx --health` → theme/config load without errors.
- [ ] **Step 4:** `[YOU]` `hx` a file in a repo, press `Space`. Expected: the **which-key popup** lists available commands; `g` shows goto menu. Confirm modal editing + the popup answer the "integrated cheat sheet" need.
- [ ] **Step 5:** Commit + push.

---

## Phase 4 — Claude-grid launcher (Windows)

*Deliverable: a hotkey opens a WezTerm window running a `claude-grid` layout, filling the vertical monitor; pressing again opens another window for another screen.*

### Task 4.1: The AutoHotkey launcher

**Files:** Create `scripts/claude-grid.ahk`

- [ ] **Step 1:** Create:

```autohotkey
#Requires AutoHotkey v2.0
; claude-grid.ahk — open a grid of Claude Code sessions on the vertical monitor.
;   Ctrl+Alt+4 -> 2x2 (4 sessions)   Ctrl+Alt+6 -> 2x3 (6 sessions)
; Each press opens a NEW WezTerm window (drag to any screen for multi-monitor).

ProjectDir := EnvGet("USERPROFILE") "\OneDrive\desktop\projects"   ; default cwd; edit to taste

FindVerticalMonitor() {
    Loop MonitorGetCount() {
        MonitorGetWorkArea(A_Index, &l, &t, &r, &b)
        if ((b - t) > (r - l))           ; taller than wide = the vertical monitor
            return A_Index
    }
    return MonitorGetPrimary()
}

OpenGrid(layout) {
    mon := FindVerticalMonitor()
    MonitorGetWorkArea(mon, &l, &t, &r, &b)
    Run('wezterm start --position ' l ',' t ' -- zellij --layout ' layout, ProjectDir, , &pid)
    if WinWait('ahk_pid ' pid, , 5)
        WinMove(l, t, r - l, b - t, 'ahk_pid ' pid)   ; fill the vertical monitor
}

^!4:: OpenGrid("claude-grid")
^!6:: OpenGrid("claude-grid-6")
```

- [ ] **Step 2:** `[YOU]` Run it: double-click `scripts/claude-grid.ahk` (or `AutoHotkey64.exe scripts\claude-grid.ahk`). It loads to the tray.
- [ ] **Step 3:** `[YOU]` Press `Ctrl+Alt+4`. Expected: a WezTerm window fills the vertical monitor with a 2×2 grid of `claude` sessions. `Ctrl+Alt+6` → 2×3. A second press of `Ctrl+Alt+4` opens another window (move it to the other screen).
- [ ] **Step 4:** If the wrong monitor is picked (e.g. two portrait monitors), add a `MONITOR_INDEX` override constant and use it instead of `FindVerticalMonitor()`. Tune, re-verify.
- [ ] **Step 5:** Auto-start on login: place a shortcut to the `.ahk` in `shell:startup`. Commit + push the script.

---

## Phase 5 — Prompt library (espanso + Claude slash-commands)

*Deliverable: a short trigger expands a full prompt into any terminal; a `/command` works inside Claude Code; both are git-synced.*

### Task 5.1: espanso base + seed prompts

**Files:** Create `home/dot_config/espanso/config/default.yml` and `home/dot_config/espanso/match/prompts.yml`

- [ ] **Step 1:** Create `config/default.yml` (paste whole multi-line prompts cleanly into terminals):

```yaml
# espanso default config
backend: clipboard          # paste whole blocks at once (terminal-friendly)
auto_restart: true
```

- [ ] **Step 2:** Create `match/prompts.yml` with starter prompts (expand with `force_clipboard`):

```yaml
matches:
  - trigger: ":plan"
    force_clipboard: true
    replace: |
      Before writing any code, restate the task, list the files you'll touch,
      outline your approach as numbered steps, and call out risks/edge cases.
      Wait for my OK before implementing.
  - trigger: ":review"
    force_clipboard: true
    replace: |
      Review the current diff for correctness bugs and obvious simplifications.
      Be terse: file:line, the issue, and the fix. Skip style nits.
  - trigger: ":commitmsg"
    force_clipboard: true
    replace: |
      Write a conventional-commits message for the staged changes:
      a concise <72-char subject, a blank line, then bullet points of what & why.
```

- [ ] **Step 3:** Apply: `chezmoi apply -v`. `[YOU]` Start/restart espanso (`espanso restart`).
- [ ] **Step 4:** `[YOU]` In a WezTerm/Claude pane type `:plan`. Expected: it expands to the full prompt. (espanso search hotkey `Alt+Shift+Space` lists all.)
- [ ] **Step 5:** Commit + push.

### Task 5.2: Claude slash-commands

**Files:** Create `prompts/claude-commands/plan.md`, `prompts/claude-commands/review.md`; managed copy at `home/dot_claude/commands/` (maps to `~/.claude/commands/`).

- [ ] **Step 1:** Create `home/dot_claude/commands/plan.md`:

```markdown
---
description: Restate task, list files, outline steps, wait for OK
---
Before writing code: restate the task in your own words, list the exact files
you'll create/modify, outline your approach as numbered steps, and flag risks.
Then STOP and wait for my approval. $ARGUMENTS
```

- [ ] **Step 2:** Create `home/dot_claude/commands/review.md`:

```markdown
---
description: Terse correctness + simplification review of the current diff
---
Review the current diff. Report only real correctness bugs and clear
simplifications as `file:line — issue — fix`. No style nits. $ARGUMENTS
```

- [ ] **Step 3:** Apply: `chezmoi apply -v` (writes `~/.claude/commands/*.md`).
- [ ] **Step 4:** `[YOU]` In Claude Code, type `/plan` and `/review`. Expected: both appear and run.
- [ ] **Step 5:** Commit + push.

---

## Phase 6 — Mac parity + one-instruction bootstrap

*Deliverable: per-OS bootstrap scripts and a Claude-followable `BOOTSTRAP.md` so the Mac reproduces everything from one instruction.*

### Task 6.1: Bootstrap scripts

**Files:** Create `scripts/bootstrap-windows.ps1`, `scripts/bootstrap-macos.sh`

- [ ] **Step 1:** Create `scripts/bootstrap-windows.ps1`:

```powershell
# Bootstrap a Windows machine to this workspace.
winget install -e --id GitHub.cli --id twpayne.chezmoi --id wez.wezterm `
  --id zellij.zellij --id Helix.Helix --id espanso.espanso --id AutoHotkey.AutoHotkey
gh auth status 2>$null; if ($LASTEXITCODE -ne 0) { gh auth login }
chezmoi init --apply JoshKappler
pwsh -File "$env:USERPROFILE\.local\share\chezmoi\scripts\repo-sync.ps1"
pwsh -File "$env:USERPROFILE\.local\share\chezmoi\scripts\register-sync-task.ps1"
Write-Host "Done. Launch WezTerm; run 'zellij'; press Ctrl+Alt+4 for a Claude grid."
```

- [ ] **Step 2:** Create `scripts/bootstrap-macos.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
command -v brew >/dev/null || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install gh chezmoi wezterm zellij helix espanso hammerspoon
gh auth status >/dev/null 2>&1 || gh auth login
chezmoi init --apply JoshKappler
"$HOME/.local/share/chezmoi/scripts/repo-sync.sh" "$HOME/projects" JoshKappler
echo "Done. Open WezTerm; run 'zellij'. (Hammerspoon hotkey = Mac equivalent of the AHK launcher — see Task 6.3.)"
```

- [ ] **Step 3:** Commit + push both.

### Task 6.2: Hammerspoon launcher (Mac twin of the AHK script)

**Files:** Create `home/dot_hammerspoon/init.lua`

- [ ] **Step 1:** Create:

```lua
-- ~/.hammerspoon/init.lua — Mac twin of claude-grid.ahk
local function verticalScreen()
  for _, s in ipairs(hs.screen.allScreens()) do
    local f = s:frame(); if f.h > f.w then return s end
  end
  return hs.screen.primaryScreen()
end
local function openGrid(layout)
  local s = verticalScreen(); local f = s:frame()
  hs.execute(string.format(
    "wezterm start --position %d,%d -- zellij --layout %s", f.x, f.y, layout), true)
  hs.timer.doAfter(1.0, function()
    local w = hs.window.frontmostWindow(); if w then w:setFrame(f) end
  end)
end
hs.hotkey.bind({"ctrl","alt"}, "4", function() openGrid("claude-grid") end)
hs.hotkey.bind({"ctrl","alt"}, "6", function() openGrid("claude-grid-6") end)
```

- [ ] **Step 2:** Commit + push. (Verified on the Mac in Task 6.4.)

### Task 6.3: `BOOTSTRAP.md` (Claude-followable)

**Files:** Create `BOOTSTRAP.md`

- [ ] **Step 1:** Create:

```markdown
# Reproduce this workspace (Claude: follow top-to-bottom)

You are setting up this machine to match the user's other one. Detect the OS,
run the matching bootstrap, then verify.

## Windows
1. Run: `iwr -useb https://raw.githubusercontent.com/JoshKappler/dotfiles/main/scripts/bootstrap-windows.ps1 | iex`
   (or, if the repo is already cloned, `pwsh -File scripts/bootstrap-windows.ps1`).
2. It installs tools, does `gh auth login` (USER completes the browser step),
   `chezmoi init --apply JoshKappler`, runs repo-sync, and schedules it.

## macOS
1. Run: `bash <(curl -fsSL https://raw.githubusercontent.com/JoshKappler/dotfiles/main/scripts/bootstrap-macos.sh)`
2. Same steps via brew; grant Hammerspoon Accessibility permission when prompted.

## Verify (both)
- `chezmoi managed` lists the wezterm/zellij/helix/espanso/claude configs.
- WezTerm opens; `zellij` shows the bottom hint bar; `hx` shows the Space popup.
- The Claude-grid hotkey (Ctrl+Alt+4 / Ctrl+Alt+6) opens a grid on the vertical monitor.
- `:plan` expands in a terminal; `/plan` works in Claude Code.
- `cheat` prints the master cheat sheet.

## Sync going forward
- Pull latest config: `chezmoi update` (= git pull + re-apply).
- Edit a config: `chezmoi edit <file>` → `chezmoi cd` → commit + push.
```

- [ ] **Step 2:** Commit + push.

### Task 6.4: `[YOU/Mac]` Validate on the MacBook
- [ ] **Step 1:** On the Mac, tell Claude: "pull `JoshKappler/dotfiles` and set me up." Claude follows `BOOTSTRAP.md`.
- [ ] **Step 2:** Walk the Verify checklist. File any per-OS template fixes as follow-up commits.

---

## Phase 7 — Master cheat sheet + `cheat` command

*Deliverable: `docs/CHEATSHEET.md` assembled from the configs, surfaced instantly by a `cheat` command.*

### Task 7.1: Cheat-sheet partials + generator

**Files:** Create `docs/cheatsheet/*.md` partials and `scripts/gen-cheatsheet.ps1`

- [ ] **Step 1:** Create `docs/cheatsheet/00-intro.md`, `10-zellij.md`, `20-helix.md`, `30-wezterm.md`, `40-launcher.md`, `50-prompts.md` — each a short keybinding table for that tool (curated from the configs above; e.g. Zellij `Ctrl+p` pane mode, `Ctrl+g` lock; Helix `Space` which-key; launcher `Ctrl+Alt+4/6`; espanso `:plan/:review/:commitmsg`).
- [ ] **Step 2:** Create `scripts/gen-cheatsheet.ps1`:

```powershell
# Concatenate docs/cheatsheet/*.md (sorted) into docs/CHEATSHEET.md
$dir = Join-Path $PSScriptRoot '..\docs\cheatsheet'
$out = Join-Path $PSScriptRoot '..\docs\CHEATSHEET.md'
"# Workspace Cheat Sheet`n_Generated — edit the partials in docs/cheatsheet/_`n" | Set-Content $out
Get-ChildItem $dir -Filter *.md | Sort-Object Name | ForEach-Object {
  Add-Content $out (Get-Content $_.FullName -Raw); Add-Content $out "`n"
}
Write-Host "Wrote $out"
```

- [ ] **Step 3:** Run it; verify `docs/CHEATSHEET.md` is generated and readable. Commit + push.

### Task 7.2: The `cheat` command

**Files:** Create `home/dot_config/powershell/cheat.ps1` (Win) + a shell function for Mac in `home/dot_zshrc.tmpl`.

- [ ] **Step 1:** Add a `cheat` function (PowerShell profile snippet) that prints `~/.local/share/chezmoi/docs/CHEATSHEET.md` via `bat` if present else `Get-Content`. Mac twin: a `cheat()` zsh function using `glow`/`bat`/`cat`.
- [ ] **Step 2:** Optionally add an espanso trigger `:cheat` that pastes a link/summary.
- [ ] **Step 3:** `[YOU]` Open a new terminal, run `cheat`. Expected: the master cheat sheet prints. Commit + push.

---

## Self-review notes
- **Spec coverage:** repo-sync (P0), terminal+multiplexer (P2), editor (P3), launcher (P4), prompt library (P5), cross-platform+bootstrap (P6), cheat-sheet system (Zellij bar P2 + Helix popup P3 + generated sheet P7). All §4 components mapped.
- **Cheat-sheet requirement:** satisfied in three layers as specced.
- **Safety:** repo-sync is ff-only/skip-dirty/logged (Global Constraints + P0).
- **Cross-platform:** every config is chezmoi-templated; Mac twins exist for the launcher (Hammerspoon) and shell; `BOOTSTRAP.md` makes Mac reproduction one instruction.
- **Known live-tuning points (not placeholders — real configs that get verified/adjusted on hardware):** monitor selection in the launcher (P4 Step 4), font availability (P1.1 Step 3), optional LSP servers (P3).
```
