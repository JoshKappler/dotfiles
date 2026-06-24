# Claude Control Center

A single tabbed control center for launching and monitoring Claude Code agents,
plus one-button **GitHub sync** to keep all your devices in step.

This is the **canonical source** and it lives in your projects folder
(`~/OneDrive/desktop/projects/claude-control-center`) as its own GitHub repo, so
you can edit it, push it, and pull it on any device exactly like any other
project. The app runs **straight from this folder** — no hidden install copy to
keep in sync.

All app code is **Node ESM (`.mjs`), zero npm dependencies** — Node built-ins and
raw ANSI only. Node is guaranteed present (Claude Code requires it). Every script
is **self-locating** (it finds its siblings relative to itself), so the whole
folder can be moved or cloned anywhere and still works.

## Using the dashboard (the basics)

The dashboard always shows a plain-English guide at the top, and a bright
**reversed bar** marks which list the arrow keys are currently driving.

| Key | What it does |
| --- | --- |
| `Up` / `Down` | Move the green highlight bar |
| `Right` | Open the highlighted folder (go into it) |
| `Left` | Go back out to the parent folder |
| `1`–`8` **then** `Enter` | Two steps: press a number to pick how many agents, **then** press Enter to launch them in the highlighted folder |
| `n` | **New folder** — type a name + Enter to create a folder inside the one you're viewing (empty + Enter cancels) |
| `g` | **PUSH** — upload your committed work to GitHub (never overwrites newer cloud changes) |
| `c` | **PULL** — download everything from GitHub (never deletes your local work) |

Inside an agent window (tab), the green **shortcut bar** pinned at the top lists the
keys for managing the Claude instances in it: `Alt+a` add another, `Alt+[` / `Alt+]`
switch windows, `Ctrl+Alt+w` close the focused one, `Ctrl+g` lock keys to Claude.
Click the **Home** tab (leftmost) to come back to the dashboard.
| `Tab` | Switch the arrows to the Subagents list (only when something is there) |
| `?` | Full-screen plain-English help |
| `q` / `Ctrl+C` | Quit the dashboard (running agents keep going) |

If a list ever looks "dead", the arrows are simply on the *other* list — the
focus bar tells you which, and the dashboard now refuses to strand the arrows on
an empty Subagents list.

## GitHub sync — what the buttons promise

- **`g` PUSH** runs a plain `git push` on every repo under your projects root.
  Git refuses a non-fast-forward push, so if another device already uploaded
  newer work, yours is **skipped, never overwritten** — pull first, then push.
- **`c` PULL** clones anything missing and **fast-forwards** the rest. A dirty or
  diverged repo is fetched but left alone. Your local commits and uncommitted
  changes are **never discarded**.

Both operate on `~/OneDrive/desktop/projects` and skip the `dotfiles` repo.

## Always-on background sync

**On open (Windows):** launching the control center (Ctrl+Alt+C → the Home tab)
kicks off a **silent, windowless** PULL in the background — same as pressing `c`,
same safety (clone missing + fast-forward, never discards local work). So opening
the dashboard is instant *and* every repo is brought current, with no separate
clone window stealing focus at boot. The SYNC section shows `syncing now...` while
it runs, then the result.

The `g`/`c` buttons are the manual path. For hands-off sync, `sync-daemon.mjs`
does the same thing on a schedule, with **no dashboard open**, and it self-updates
this repo first so the control center keeps itself current across machines:

1. `git pull --ff-only` on this repo (the meta bit — the tool updates itself).
2. Run the freshly-pulled `clone-all.mjs` over the projects folder this repo sits
   in: clone anything new, fast-forward the rest, leave dirty/diverged repos alone.

On macOS it is wired to launchd so it is hardwired into startup and always running:

```sh
bash macos/install-sync-agent.sh      # runs at every login + every 10 min
# CC_SYNC_INTERVAL=300 bash macos/install-sync-agent.sh   # custom interval (seconds)
bash macos/uninstall-sync-agent.sh    # stop + remove (repos/logs untouched)
```

Watch it: `tail -f ~/.claude/state/cc/sync.log`. Each line is one tick, e.g.
`self-update: ok | up-to-date=24 cloned=1 skipped=5`. The full last result is in
`~/.claude/state/cc/sync-last.json`.

## Files

| File | Role |
| --- | --- |
| `home.mjs` | **Home TUI** — folder navigator, agent-count picker, launch, GitHub push/pull, live 5h/Weekly limit gauges, subagents list + inspector, help overlay. |
| `statusline.mjs` | statusLine for `~/.claude/settings.json`. Prints `model · ctx% · task` and writes `agents/<sessionId>.json`. |
| `inspector.mjs` | Live subagent inspector, opened in a Zellij floating pane. |
| `git-push-all.mjs` | `node git-push-all.mjs <root>` → pushes repos under `<root>` (excludes `dotfiles`), prints JSON. Never force-pushes. |
| `clone-all.mjs` | `node clone-all.mjs <root>` → clones missing + `--ff-only` pulls all your GitHub repos. Finds clones **one level deep too** (e.g. `other/algora`) and updates them in place instead of re-cloning a top-level duplicate. Never discards local work. |
| `sync-daemon.mjs` | **Always-on background sync.** Self-updates this repo (`git pull --ff-only`), then runs `clone-all.mjs` over the projects folder it lives in. Run on a schedule by the macOS LaunchAgent. Logs to `~/.claude/state/cc/sync.log`. |
| `macos/install-sync-agent.sh` | Installs `sync-daemon.mjs` as a LaunchAgent that runs at login and every 10 min. `macos/uninstall-sync-agent.sh` removes it. |
| `agentbar.mjs` | One-line shortcut bar shown above each agent tab. |
| `hooks/session-register.mjs` | SessionStart/SessionEnd hook: maintains `panes/<id>` and cleans up state. |
| `hooks/subagent-track.mjs` | Subagent/tool hooks: maintains `subagents/<parent>/<agentId>.json`. |
| `layouts/claude-1..8.kdl` | Zellij agent-tab layouts. Reference sibling scripts with the `{{APP}}` token, which `home.mjs` renders to this folder's path at launch (fully portable). |
| `layouts/cc-default.kdl` | Reference copy of the session layout. The live one is deployed by the dotfiles repo to `~/.config/zellij/layouts/`. |

## How it is wired into the machine

The app **code** lives here. The thin **wiring** that makes the OS launch it and
makes Claude report into it lives in the `dotfiles` repo (it installs into hidden
system folders), and points back at this folder:

- `~/.config/zellij/layouts/cc-default.kdl` → runs `home.mjs` from here.
- `~/.config/zellij/config.kdl` (`Alt+i`) → runs `inspector.mjs` from here.
- `~/.claude/settings.json` → runs `statusline.mjs` + the `hooks/` from the stable
  `~/.local/share/claude-cc/` copy (these are always-on, so they run from a
  non-OneDrive path; identical source is kept here for syncing).

## Shared state

State root: `~/.claude/state/cc/` (each component creates it).

- `agents/<sessionId>.json` — per-agent status incl. `rateLimits` and `paneId`
  (readers ignore entries older than 120 s).
- `panes/<ZELLIJ_PANE_ID>` — plain text = the `sessionId` running in that pane.
- `subagents/<parentSessionId>/<agentId>.json` — per-subagent status.
- `gen/claude-N.kdl` — layouts rendered from the `{{APP}}` templates at launch.

## Run / test directly

```sh
node home.mjs                       # uses the default projects dir
CC_ROOT=/path/to/dir node home.mjs  # override the start directory
```

Requires an interactive terminal (TTY). Launch shells out to
`zellij action new-tab --layout <gen>/claude-<N>.kdl --cwd <dir> --name <basename>`;
if `zellij` is not on `PATH`, an inline error is shown — Home never crashes.
