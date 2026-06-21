# Workspace Upgrade — Design Spec

**Date:** 2026-06-21
**Owner:** Josh Kappler (`JoshKappler`)
**Status:** Draft for review

---

## 1. Goal & context

Turn a raw-terminal workflow into a discoverable, reproducible, **cross-platform (Windows 11 + macOS) power-user workspace**, centered on the fact that **most work happens through the Claude Code CLI agent**.

Five things the user asked for:

1. Clone *all* GitHub repos locally and keep them auto-synced.
2. Upgrade the terminal/editor experience ("fancy terminal that's also an editor").
3. A hotkey that opens **multiple Claude Code sessions in a grid**, flexibly arranged.
4. A **reusable prompt library** summonable by hotkey into any window.
5. Make all of it work **identically on a Windows PC and a MacBook**.

### Hard constraints / preferences
- **Full power-user**, but **every tool must have a built-in, always-visible cheat sheet** — the user is learning and refuses to memorize blind.
- **Cross-platform**: one config set that renders correctly on both Windows 11 and macOS.
- **Claude-Code-centric**: the editor's real job is *reading / reviewing / spot-editing* agent-written code, not heavy authoring.
- **OneDrive caveat**: the user's `projects` folder lives under OneDrive. OneDrive corrupts git internals and does not reliably sync symlinks/junctions. **The config repo must live outside OneDrive.**

### Non-goals (YAGNI)
- No full-time tiling window manager *required* (it's an optional, documented upgrade).
- No heavy Neovim config now — start with Helix; Neovim is a documented later step.
- No cloud/SaaS prompt tools (TextExpander, Raycast Pro) — everything is local plain-text + git.
- Not migrating the `projects` folder out of OneDrive — only the new config repo lives outside it.

---

## 2. The chosen stack

| Layer | Pick | Why | Cross-platform |
|---|---|---|---|
| Terminal emulator | **WezTerm** | Only top-tier GPU terminal native + identical on Win + Mac; single Lua config | ✅ native both |
| Multiplexer / pane grid | **Zellij** | Always-on keybinding hint bar = the cheat sheet; native Windows (no WSL); KDL layouts | ✅ native both |
| Editor | **Helix** (now) → LazyVim/Neovim (later) | Built-in next-key popup = cheat sheet; easiest modal curve; batteries-included; tiny TOML config | ✅ native both |
| Multi-Claude launcher | **WezTerm window running a Zellij `claude-grid` layout**, fired by a hotkey | One app; grid of `claude` panes; easy open/close/rearrange via Zellij; multi-screen via multiple windows | ✅ shared layout + thin per-OS hotkey |
| Prompt library | **espanso** (OS-wide) + **Claude slash-commands** (Claude-native) | espanso = hotkey paste into any window, plain-text YAML; slash-commands = structured Claude prompts; both git-synced | ✅ both |
| Config sync (Win↔Mac) | **chezmoi** | Templates handle per-OS path/value differences; **copies real files, not symlinks → OneDrive-safe**; single binary | ✅ both |
| Repo auto-sync | **`gh` + guarded pull loop + per-OS scheduler** | Enumerates all repos (catches new ones); safe pulls (skip-dirty, ff-only, logged) | ✅ both (Task Scheduler / launchd) |

**Unifying theme:** everything is plain-text config, git-synced by chezmoi, and self-documenting (Zellij hint bar + Helix popup + a generated master cheat sheet). One `chezmoi init` reproduces the whole environment on the MacBook.

---

## 3. Architecture — the dotfiles repo is the spine

A single git repo, **`JoshKappler/dotfiles`**, is the project. It is the **chezmoi source** and lives **outside OneDrive** at chezmoi's default location:

- Windows: `C:\Users\joshu\.local\share\chezmoi`
- macOS: `~/.local/share/chezmoi`

GitHub — **not** OneDrive — is the sync channel between machines.

### Repo layout
```
dotfiles/                         (= chezmoi source root)
├─ .chezmoiroot          → "home"   (so chezmoi only manages home/, not the rest)
├─ home/                            chezmoi-managed; maps into $HOME
│  ├─ dot_config/
│  │  ├─ wezterm/wezterm.lua.tmpl
│  │  ├─ zellij/  (config.kdl + layouts/claude-grid.kdl)
│  │  ├─ helix/   (config.toml + languages.toml)
│  │  └─ espanso/match/  (prompt library YAML)
│  └─ ...                           (gitconfig, shell rc, etc.)
├─ scripts/                         not chezmoi-managed
│  ├─ repo-sync.ps1 / repo-sync.sh
│  ├─ claude-grid.ahk / claude-grid.lua   (launcher hotkey)
│  ├─ gen-cheatsheet.*               (builds CHEATSHEET.md)
│  └─ bootstrap-windows.ps1 / bootstrap-macos.sh
├─ prompts/                         source-of-truth prompt library
│  ├─ espanso/                      (synced into home/dot_config/espanso)
│  └─ claude-commands/              (synced into ~/.claude/commands)
└─ docs/
   ├─ specs/2026-06-21-workspace-upgrade-design.md   (this file)
   └─ CHEATSHEET.md                 (generated master reference)
```

**Working model:** edit via `chezmoi edit <file>` / `chezmoi cd`, preview with `chezmoi diff`, apply with `chezmoi apply`. The user never has to navigate the hidden source path by hand.

### Per-OS differencing
chezmoi Go-templates branch on `.chezmoi.os` (`"windows"` vs `"darwin"`) so a single source file emits the right paths/values for each machine. Example: WezTerm's default shell, font, and any path references differ per OS inside one `wezterm.lua.tmpl`.

---

## 4. Component designs

### 4a. Repo sync (Phase 0 — the "clone everything" ask)
**Current state:** ~28 repos under `JoshKappler`, most already cloned into the OneDrive `projects` folder; `gh` is **not** installed; global git identity unset.

**Design:**
1. Install `gh` (winget on Win / brew on Mac); `gh auth login` once.
2. `scripts/repo-sync` does, idempotently:
   - Enumerate: `gh repo list JoshKappler --limit 200 --json nameWithOwner -q '.[].nameWithOwner'` (limit 200 because the default is 30).
   - For each repo, in the `projects` folder: **missing →** `gh repo clone`; **exists →** check `git status --porcelain` (skip + log if **dirty**), confirm default branch, then `git pull --ff-only` (skip + log if it won't fast-forward).
   - Append every outcome to a timestamped log.
3. Schedule it: **Windows Task Scheduler** runs `repo-sync.ps1`; **macOS launchd** runs `repo-sync.sh`. Default cadence: on login + daily (tunable).

**Safety:** never auto-creates merge commits, never overwrites dirty repos, always logs. The auto-sync is fast-forward-only and skip-dirty by design.

### 4b. Terminal + multiplexer (WezTerm + Zellij)
- **WezTerm** = the app + window/multi-screen host. One Lua config (templated) for both OSes. Its job: render fast, host windows, optionally place/launch them.
- **Zellij** = the pane layer *inside* each WezTerm window: the grid of sessions, the **always-on hint bar** (the cheat sheet), and persistent/detachable sessions.
- **No double-multiplexing confusion:** WezTerm is used only as the host (we do *not* use WezTerm's own pane-splitting for the grid — Zellij owns panes). WezTerm's leader key is set distinct from Zellij's so window/tab actions and pane actions never collide.
- **"Terminal that's also an editor":** a Zellij layout can open Helix in a large pane with shells/agents/logs in others — the IDE-like setup the user saw, as a persistent session.

### 4c. Editor (Helix now, Neovim later)
- **Helix**: `config.toml` + `languages.toml`, tiny and synced verbatim. The **built-in next-key popup is the cheat sheet** — zero config, even documents custom binds. Batteries-included (LSP, tree-sitter, fuzzy find) so reviewing agent code works immediately.
- **Future path:** when modal editing is second nature, graduate to **LazyVim** (Neovim) with **which-key.nvim** as the cheat sheet. Modal muscle memory transfers. Documented, not built now.
- **Optional GUI fallback:** Zed (cross-platform, keeps Helix/Vim keymaps) for eyeballing large multi-file diffs. Documented, not required.

### 4d. Multi-Claude launcher
**Goal:** press a button → multiple Claude Code sessions in a grid; easy to close some, open new ones, rearrange; sometimes spread across screens.

**Design:**
- A Zellij layout **`claude-grid`** (KDL) opens N panes (2×2 / 2×3 presets) each running `claude` in a chosen project dir. The layout is shared cross-platform.
- A thin per-OS hotkey launches a WezTerm window running that layout, positioned on the vertical monitor:
  - **Windows:** AutoHotkey v2 (`scripts/claude-grid.ahk`) — `Run "wezterm start -- zellij ... "`, then place on the vertical monitor's work area.
  - **macOS:** Hammerspoon (`scripts/claude-grid.lua`) — symmetric: launch + place on the right-hand screen.
- **Open/close/rearrange** = Zellij keys (shown in the hint bar): new pane, close pane, move/swap pane, toggle floating pane, new tab, resize.
- **Multi-screen** = fire the launcher again for a second WezTerm window on another monitor (each its own grid). One app, multiple windows on demand.
- **Optional upgrade:** komorebi (Win) / AeroSpace (Mac) full-time tiling to auto-snap windows — documented, off by default.
- **Claude-Code TUI integration:** Zellij configured (lock/passthrough mode + non-conflicting binds) so its keys never collide with Claude Code's full-screen TUI.

### 4e. Prompt library (espanso + Claude slash-commands)
- **espanso** for OS-wide paste into *any* window: short triggers (e.g. `:review`, `:plan`) and a fuzzy-search hotkey expand to full prompts. Multi-line + templated/dynamic supported. `force_clipboard` so multi-line prompts paste cleanly into terminals. Library = plain-text YAML under `prompts/espanso/`, synced into `home/dot_config/espanso/match/`.
- **Claude slash-commands** for structured Claude-native prompts: markdown in `~/.claude/commands/` (personal, cross-project), with `$ARGUMENTS`, `!bash`, `@file`. Source-of-truth in `prompts/claude-commands/`, synced to `~/.claude/commands/`.
- **Same prompt can live in both** — espanso for universal paste, a slash-command for the rich Claude version.

### 4f. Cheat-sheet system (the hard requirement)
Three layers:
1. **Zellij hint bar** — always-on, mode-aware keybinding bar at the bottom of every pane grid.
2. **Helix popup** — built-in next-key menu inside the editor.
3. **Generated `docs/CHEATSHEET.md`** — `scripts/gen-cheatsheet` collects the actual keybindings/prompts from the config files into one master reference, plus a **`cheat` command / espanso trigger** that surfaces it instantly in any terminal.

### 4g. Cross-platform parity
- chezmoi templates handle the differences; `scripts/bootstrap-windows.ps1` and `scripts/bootstrap-macos.sh` install the toolchain (winget / brew) and run `chezmoi init --apply JoshKappler`.
- Windows is built and verified first (current machine). Mac parity is templated as we go and validated when the user is on the MacBook.

---

## 5. Build roadmap

| Phase | Deliverable |
|---|---|
| **0. Repo sync** | `gh` installed; `repo-sync` script clones missing + safely pulls all; scheduled. |
| **1. Foundations** | dotfiles repo + chezmoi initialized; WezTerm, Zellij, Helix installed (winget). |
| **2. Terminal + multiplexer** | WezTerm + Zellij configs with hint bar; host/grid model working. |
| **3. Editor** | Helix config + verification. |
| **4. Launcher** | `claude-grid` Zellij layout + AHK hotkey on Windows. |
| **5. Prompt library** | espanso installed + seed prompts; Claude slash-commands seeded. |
| **6. Mac parity** | chezmoi templates + `bootstrap-macos.sh`; documented Mac setup. |
| **7. Master cheat sheet** | `gen-cheatsheet` + `CHEATSHEET.md` + `cheat` command. |

Each phase ends committed + pushed to `JoshKappler/dotfiles`.

---

## 6. Risks & gotchas (carried from research)
- **OneDrive + git/symlinks** → config repo lives outside OneDrive; chezmoi copies real files (no symlinks). *Decisive design driver.*
- **Nested multiplexer** (Zellij inside WezTerm) → WezTerm hosts only; distinct leader keys; Zellij owns panes.
- **Claude Code TUI key collisions** → Zellij lock/passthrough mode + non-conflicting binds.
- **Auto-pull destroying work** → ff-only + skip-dirty + logging; never autostash unattended.
- **`gh repo list` default limit 30** → always `--limit 200`.
- **Ghostty has no Windows build yet** → WezTerm chosen instead; revisit Ghostty later.
- **Zellij on Windows is newer** (native since v0.44) → verify on the actual machine; tmux-via-WSL is the fallback if blocked.

---

## 7. Success criteria
- `repo-sync` clones any missing repo and fast-forwards the rest without ever touching a dirty repo; runs on schedule.
- A hotkey opens a 2×2 grid of `claude` sessions on the vertical monitor; panes can be closed/opened/moved with on-screen-documented keys; a second window can go on another screen.
- A short trigger expands a full prompt into a Claude Code terminal.
- Helix opens and shows its key popup; reviewing a repo's code works.
- `chezmoi diff` is clean after apply; the same repo `chezmoi init`s on macOS and produces working configs.
- `cheat` surfaces the master cheat sheet in any terminal.

---

## 8. Open questions / future
- Full tiling WM (komorebi/AeroSpace) — adopt later or not at all?
- Graduate Helix → LazyVim — revisit after a month of modal editing.
- Should `repo-sync` also auto-`git fetch` (not pull) on dirty repos so remotes are current without touching the work tree? (Leaning yes.)
