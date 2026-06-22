<!-- GENERATED FILE -- do not edit by hand.
     Source: docs/cheatsheet/*.md -- regenerate with scripts/gen-cheatsheet.ps1 -->

# Workspace Cheat Sheet

> Generated from `docs/cheatsheet/*.md` partials and surfaced by the `cheat` command. Edit the partials, not `docs/CHEATSHEET.md`.

**Mental model**

- **WezTerm** = windows (each is a separate screen; leader `Ctrl a`).
- **Zellij** = panes + grid inside a window (watch the bottom hint bar — it always shows the current mode's keys).
- **Helix** = editing (press `Space` for the which-key menu; nothing to memorize).
- **Launcher** = spin up Claude grids with `Ctrl+Alt+4` (2x2) / `Ctrl+Alt+6` (2x3).

## Zellij (multiplexer)

An always-on hint bar at the bottom shows the current mode's keys. Press the **mode** key, then the **action** key. `Esc` or `Enter` returns to normal mode.

| Key | Mode | Then... |
| --- | --- | --- |
| `Ctrl p` | Pane | `n` new pane · `x` close pane · `arrows`/`hjkl` focus · `r` rename · `f` toggle floating · `w` toggle fullscreen |
| `Ctrl t` | Tab | `n` new tab · `arrows` switch tab · `x` close tab |
| `Ctrl n` | Resize | `arrows` resize the focused pane |
| `Ctrl s` | Scroll / search | scroll back · search the scrollback |
| `Ctrl o` | Session | `d` detach from the session |
| `Ctrl g` | **Locked** | passes ALL keys straight to the app — use this when driving a Claude Code TUI; `Ctrl g` again to unlock |
| `Ctrl q` | Quit | quit Zellij |

## Helix (editor)

Modal editor. Press `Space` (or `g`, etc.) and an automatic **which-key popup** appears — so you can discover commands instead of memorizing them.

| Key | Action |
| --- | --- |
| `i` | insert |
| `a` | append |
| `Esc` | back to normal mode |
| `x` | select line (repeat to extend) |
| `w` / `b` | next / previous word |
| `d` | delete selection |
| `y` | yank (copy) |
| `p` | paste |
| `u` | undo |
| `/` | search |
| `Space f` | file picker |
| `Space b` | buffer picker |
| `Space k` | hover docs |
| `g d` | goto definition |
| `g r` | goto references |
| `:w` | write |
| `:q` | quit |
| `:wq` | write + quit |

## WezTerm (terminal)

Leader is `Ctrl a`. Press the leader, then the action key. Pane splitting is delegated to Zellij.

| Key | Action |
| --- | --- |
| `Ctrl a` then `n` | new window (another screen) |
| `Ctrl a` then `t` | new tab |
| `Ctrl a` then `w` | close tab |
| `Ctrl a` then `f` | toggle fullscreen |

## Claude-grid launcher

Windows = AutoHotkey (`scripts/claude-grid.ahk`). macOS twin = Hammerspoon with the same hotkeys. Each press opens a **new** window; open several to spread the grids across screens.

| Hotkey | Action |
| --- | --- |
| `Ctrl+Alt+4` | 2x2 Claude grid (4 sessions) on the vertical monitor |
| `Ctrl+Alt+6` | 2x3 Claude grid (6 sessions) |

## Prompt library (espanso)

Type a trigger in **any** window and espanso pastes the full prompt (via the
clipboard, so multi-line text lands intact — ideal for the Claude Code CLI).

Press **`Alt+Shift+Space`** to open espanso's built-in **search** UI and pick a
prompt by name when you can't remember the trigger.

| Trigger | Expands to |
|---|---|
| `:plan` | Restate the goal, list the files involved, give a numbered minimal plan, then wait for "OK" before changing code. |
| `:review` | Terse, high-signal review: correctness bugs first, then simplifications — each as `file:line`, no praise. |
| `:commit` | A Conventional Commits message (`type(scope): summary`) generated from the staged diff. |
| `:debug` | Systematic, root-cause-first debugging: reproduce, rank hypotheses, prove the cause, then fix. |
| `:explain` | A clear, concise explanation of unfamiliar code — flow, side effects, edge cases, assumptions. |
| `:test` | Write a failing test first (TDD), confirm it fails for the right reason, then implement to green. |
| `:refactor` | Behavior-preserving cleanup: better names/structure, less duplication, tests still pass. |
| `:tidy` | Low-risk local cleanup of the current file/diff: dead code, stray logs, typos, formatting — no logic changes. |
| `:pr` | A pull-request title plus a Summary / Changes / Testing body built from the actual diff. |
| `:spec` | Turn a rough idea into a tight spec: problem, scope/non-goals, approach, acceptance criteria, open questions. |

> **Note:** these same prompts also exist as **Claude Code slash-commands** in
> `~/.claude/commands` (e.g. `/plan`, `/review`). Use the espanso trigger to paste
> into any app or terminal; use the slash-command for the richer, Claude-native
> version with arguments and file references.

