# Claude Control Center — Design Spec

**Date:** 2026-06-21
**Status:** Approved (user said "this looks great, skip approval, build it")
**Supersedes:** the `claude-grid.ahk` "new window per count" launcher.

## Goal

Replace the multi-window Claude grid launcher with a **single, movable, tabbed
control-center window**. One persistent Zellij session: a permanent **Home** tab
(directory navigator + agent-count picker + mass git-push + live 5h/weekly
limit gauges + cheatsheet) plus one tab per launched group of 1–8 Claude agents.
Each agent shows a compact one-line status (model · context% · task). Tab/pane
navigation can never kill a running agent. Any agent using subagents can open a
live inspector of those subagents.

Cross-platform Windows + macOS, deployed by chezmoi from `JoshKappler/dotfiles`,
reproducible on the Mac with one "pull and set me up" instruction.

## Why this shape

Verified against Claude Code internals (docs, 2026-06-21):

- **statusLine stdin JSON** carries everything we need on one line:
  `context_window.used_percentage`, `model.display_name`, `transcript_path`
  (for the task summary), and **`rate_limits.five_hour` / `rate_limits.seven_day`**
  (`used_percentage` + `resets_at`) — the *exact* limits `/usage` shows. These
  appear only on Pro/Max and only after the session's first API response.
- **Hooks** fire `SubagentStart`/`SubagentStop`, `TaskCreated`/`TaskCompleted`,
  and `PreToolUse`/`PostToolUse` (the last carry `agent_id` inside subagents) —
  enough to track and display subagent activity live.
- **No terminal-title control** from Claude — so per-agent status lives *inside*
  the pane (statusLine), not in the Zellij tab bar. This is fine: the user chose
  "just the one-line info," no colored tab dots.
- **Settings**: `statusLine` + `hooks` load from `~/.claude/settings.json`
  (global) — every agent everywhere reports, on both machines.

Node is the implementation language for all app code: Claude Code already
requires Node on both machines, so it is a zero-new-dependency, identically
reproducible choice. **No npm dependencies** — raw ANSI + Node built-ins
(`readline`, stdin raw mode, `fs`, `child_process`) so there is nothing to
`npm install` and nothing to break on the Mac.

## Architecture

```
WezTerm window (class wezterm-claude-cc, movable, NOT fullscreen)
└─ Zellij session "claude-cc"
   ├─ Tab 0  "Home"   → node home.mjs            (permanent, leftmost)
   ├─ Tab 1  "<dir>"  → N panes each running `claude`   (a launched group)
   ├─ Tab 2  ...
   └─ (floating) Subagent Inspector → node inspector.mjs   (toggled per agent)
```

All app code is chezmoi-deployed to `~/.local/share/claude-cc/` (Windows:
`C:\Users\<user>\.local\share\claude-cc\`) — a path we control, identical on
both OSes. Invoked as `node "<homeDir>/.local/share/claude-cc/<file>.mjs"`
(forward slashes work in Node on Windows too).

### Shared state (the contract between components)

State root: `<homeDir>/.claude/state/cc/` (each component `mkdir -p`s it).

- **`agents/<session_id>.json`** — written by `statusline.mjs` on every
  statusLine tick; read by Home for the gauges/roster:
  ```json
  {
    "sessionId": "...", "cwd": "...", "model": "Opus",
    "ctxPct": 42, "task": "refactor auth module", "paneId": "3",
    "rateLimits": {
      "fiveHour": { "usedPct": 23.5, "resetsAt": 1738425600 },
      "sevenDay": { "usedPct": 41.2, "resetsAt": 1738857600 }
    },
    "updatedAt": 1738400000
  }
  ```
- **`panes/<ZELLIJ_PANE_ID>`** — plain text = the `sessionId` of the Claude
  running in that pane. Written by the SessionStart hook; lets a keybind in a
  pane resolve "which agent am I" for the inspector.
- **`subagents/<parent_session_id>/<agent_id>.json`** — written by the subagent
  hook; read by `inspector.mjs` and Home:
  ```json
  {
    "agentId": "...", "agentType": "Explore", "label": "search auth code",
    "status": "running", "lastTool": "Grep", "lastDetail": "auth/*.ts",
    "startedAt": 1738400000, "updatedAt": 1738400050
  }
  ```

Stale files (older than session) are pruned on SessionEnd and ignored by readers
if `updatedAt` is older than a TTL.

## Components

### 1. Home TUI — `home.mjs`
Raw-ANSI full-screen TUI. Sections, top to bottom:
- **Directory navigator** — ↑/↓ move selection, → enter dir, ← parent dir.
  Starts at a configured root (default: the projects dir). Shows current path.
- **Agent count** — `1`–`8` keys (or `+`/`-`) set how many agents to launch.
- **Launch** — `Enter` runs `zellij action new-tab --layout
  <claude-N.kdl> --cwd <selected dir> --name <basename>`; control returns to Home.
- **Mass git-push** — `g` runs `git-push-all.mjs <current dir>` and shows the
  per-repo result inline.
- **Session gauges** — reads the freshest `agents/*.json`, draws two bars:
  5-hour and Weekly `usedPct` + reset countdown. Shows `—` until an agent has
  made its first API call (Pro/Max only).
- **Subagents** — lists agents (across tabs) currently running subagents; select
  one to open its inspector.
- **Cheatsheet** — pinned plain at the bottom: the key bindings, always visible.

### 2. statusLine — `statusline.mjs`
Replaces `~/.claude/statusline-context.js`. Reads stdin JSON, then:
- Prints ONE line: `<model> · <ctx>% · <task>` (task = first line of the latest
  user turn from `transcript_path`, truncated ~48 chars; ASCII-safe).
- Side-effect: writes `agents/<session_id>.json` (incl. rateLimits, paneId from
  `$ZELLIJ_PANE_ID`).

### 3. Hooks — `hooks/session-register.mjs`, `hooks/subagent-track.mjs`
- **SessionStart** → write `panes/<ZELLIJ_PANE_ID>` = sessionId.
- **SessionEnd** → delete this session's `agents/` + `panes/` + `subagents/` entries.
- **SubagentStart / TaskCreated** → upsert subagent file, status `running`.
- **PreToolUse / PostToolUse** (when `agent_id` present) → update `lastTool` /
  `lastDetail` on that subagent.
- **SubagentStop / TaskCompleted** → status `done`.
- Hook exit code `2` / blocked decision observed → status `error`.
Hooks never block (always exit 0 from our side) — they only record.

### 4. Subagent Inspector — `inspector.mjs`
Launched in a Zellij **floating pane** (overlay, toggleable, window-like) via a
keybind from any agent pane. Resolves the focused pane → sessionId via
`panes/<ZELLIJ_PANE_ID>`; if it can't, falls back to a picker of this window's
active agents. Renders a live table of that agent's subagents: type, label,
status, current tool/detail, elapsed. Auto-refreshes; `q` closes.

### 5. git push — `git-push-all.mjs`
`node git-push-all.mjs <root>` → finds git repos under `<root>` (depth-limited),
skips clean/detached/no-upstream, pushes the rest, prints JSON
`{ repos: [{ path, branch, pushed, error }] }`. Excludes the `dotfiles` repo and
respects the existing OneDrive-isolation rules.

### 6. Zellij wiring — `config.kdl` + layouts
- Session default layout `cc-default.kdl`: tab 0 "Home" runs `home.mjs`; includes
  tab-bar + status-bar plugins (the cheatsheet/hint bar must persist in custom
  layouts).
- `claude-1.kdl` … `claude-8.kdl`: a single tab tiling N `command="claude"` panes
  (1, 2, 3, 4 → 2×2, 5–6 → 2×3, 7–8 → 2×4 style splits), each with the bars.
- Keybinds:
  - **Add agent**: one key → `NewPane` running `claude` in the current tab.
  - **Open inspector**: one key → floating pane running `inspector.mjs`.
  - **No-kill guard**: `CloseFocus` / `CloseTab` / `Quit` are **removed from all
    casual nav modes** and reachable only via a deliberate "manage" chord, so
    switching/adding/backtracking tabs can never destroy a running agent.
    Manual close = enter manage mode + confirm, or exit Claude inside the pane.
- Homebrew green-on-black theme retained.

### 7. Launcher — `claude-cc.ahk` (Win) + Hammerspoon (Mac)
Single hotkey **Ctrl+Alt+C**:
- If a `wezterm-claude-cc` window exists → activate it (no second window).
- Else → spawn `wezterm start --class wezterm-claude-cc -- zellij` attaching
  (creating if needed) the `claude-cc` session with `cc-default` layout.
- Position on the vertical monitor at a **movable, non-maximized** size.
Replaces the `^!4/^!6/^!8` grid hotkeys (count now lives in Home).

## Cross-platform notes
- App dir `~/.local/share/claude-cc/` is OS-neutral → NOT in `.chezmoiignore` on
  either OS.
- `settings.json` is templated (`settings.json.tmpl`) so the `node` command path
  uses `{{ .chezmoi.homeDir }}` with forward slashes; merges into the user's
  existing global settings (keep model/permissions/plugins/voice).
- Hooks/statusLine commands are `node "<abs path>"` — Node is guaranteed present.

## Out of scope (per user)
- Colored 🟢/🟡/🔴 per-agent dots (user chose "just the one-line info").
- Estimated limits — gauges are exact-only (5h + weekly), blank until available.

## Acceptance
1. Ctrl+Alt+C opens ONE movable window with Home as the leftmost tab; pressing
   it again focuses the same window.
2. From Home, navigate dirs with arrows, pick 1–8, Enter → a new tab of that many
   Claude agents in that dir; Home remains tab 0.
3. Each agent shows `model · ctx% · task` on one line (old bar gone).
4. Switching/adding/backtracking tabs never closes a running agent; closing is a
   deliberate manual act.
5. Home shows exact 5h + weekly gauges once an agent has called the API.
6. `g` on Home pushes all dirty repos under the current dir (except dotfiles).
7. From an agent using subagents, a keybind opens a live inspector of them.
8. `chezmoi apply` is clean; BOOTSTRAP path reproduces it on the Mac.
