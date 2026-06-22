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
