## Claude Control Center

One hotkey opens (or focuses — never duplicates) a single movable, non-maximized WezTerm window hosting the persistent Zellij session `claude-cc`. Windows = AutoHotkey (`scripts/claude-cc.ahk`). macOS twin = Hammerspoon (`home/dot_hammerspoon/init.lua`) with the same hotkey.

| Hotkey | Action |
| --- | --- |
| `Ctrl+Alt+C` | Open the Control Center window, or focus it if already open (one window only) |

**Tab 0 = Home** (a Node TUI, leftmost and permanent). It is a directory navigator + agent-count picker + mass git-push + live usage gauges + a pinned cheatsheet.

| Key | On the Home tab |
| --- | --- |
| `↑` / `↓` | Move the directory selection |
| `→` | Enter the selected directory |
| `←` | Go to the parent directory |
| `1`–`8` (or `+`/`-`) | Pick how many Claude agents to launch |
| `Enter` | Launch that many agents in the selected dir as a **new tab** (Home stays tab 0) |
| `g` | Mass git-push every dirty repo under the current dir (the dotfiles repo is excluded) |

Home also shows exact **5-hour** and **weekly** usage gauges (Pro/Max only — they populate once an agent has made its first API call) and a **subagents** section that opens a live inspector of any agent currently running subagents.

**Inside an agent tab:**

| Key | Action |
| --- | --- |
| `Alt+a` | Add another agent (a new pane running `claude`) in this tab |
| `Alt+i` | Open the subagent inspector (a floating overlay of this agent's subagents) |
| `Ctrl+Alt+w` | Deliberately close the focused agent |
| `Ctrl+g` | Toggle locked mode (passes all keys straight to Claude) |

**No-kill behavior:** switching, adding, or backtracking tabs can never close a running agent. Closing is always a deliberate manual act — `Ctrl+Alt+w` on the focused agent, or exit Claude inside the pane.

Each agent reports a compact one-line status `model · context% · task summary` (statusline `home/dot_local/share/claude-cc/statusline.mjs`), replacing the old multi-line context bar.
