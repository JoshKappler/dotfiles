# Claude Control Center (`claude-cc`)

Single tabbed control center for launching and monitoring Claude Code agents.
Deployed by chezmoi to `~/.local/share/claude-cc/` on Windows and macOS.

All app code is **Node ESM (`.mjs`), zero npm dependencies** — Node built-ins
and raw ANSI only. Node is guaranteed present (Claude Code requires it).

## Files

| File | Role |
| --- | --- |
| `home.mjs` | **Home TUI** (WP1). Raw-ANSI full-screen alt-screen UI: directory navigator, agent-count picker (1-8), launch (Enter), mass git-push (`g`), live 5h/Weekly limit gauges, subagents list + inspector launch, and a pinned cheatsheet footer. |
| `statusline.mjs` | statusLine for `~/.claude/settings.json`. Prints `model . ctx% . task` per tick and writes `agents/<sessionId>.json` state. |
| `inspector.mjs` | Live subagent inspector. Opened in a Zellij floating pane; renders a refreshing table of one parent's subagents. |
| `git-push-all.mjs` | `node git-push-all.mjs <root>` -> pushes dirty repos one level under `<root>` (excludes `dotfiles`/chezmoi source), prints JSON. |
| `hooks/session-register.mjs` | SessionStart/SessionEnd hook: maintains `panes/<id>` and cleans up state. |
| `hooks/subagent-track.mjs` | Subagent/tool hooks: maintains `subagents/<parent>/<agentId>.json`. |
| `layouts/claude-1..8.kdl` | Zellij tab layouts (one per agent count). Produced by the lead, not WP1. |

## Shared state

State root: `~/.claude/state/cc/` (each component `mkdir -p`s it).

- `agents/<sessionId>.json` — per-agent status incl. `rateLimits` and `paneId`.
  Readers ignore entries whose `updatedAt` is older than 120 s (stale).
- `panes/<ZELLIJ_PANE_ID>` — plain text = the `sessionId` running in that pane.
- `subagents/<parentSessionId>/<agentId>.json` — per-subagent status.

## Home TUI — run / test

```sh
node ~/.local/share/claude-cc/home.mjs          # uses the default projects dir
CC_ROOT=/path/to/dir node home.mjs              # override the start directory
```

Requires an interactive terminal (TTY); piped/non-TTY invocation prints a short
notice and exits.

### Keys

| Key | Action |
| --- | --- |
| `up` / `down` | Move selection in the focused list |
| `->` / `<-` | Enter directory / go to parent |
| `Tab` | Switch focus between the directory list and the subagents list |
| `1`-`8`, `+` / `-` | Set the number of agents to launch |
| `Enter` | Launch the agent group (dirs focus) / open inspector (subagents focus) |
| `g` | Push all dirty git repos under the current directory |
| `q` / `Ctrl+C` | Quit (restores raw mode + leaves the alt screen) |

Launch shells out to:
`zellij action new-tab --layout <homeDir>/.local/share/claude-cc/layouts/claude-<N>.kdl --cwd <dir> --name <basename>`.
If `zellij` is not on `PATH`, an inline error line is shown — Home never crashes.
