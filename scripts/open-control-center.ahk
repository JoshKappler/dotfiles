#Requires AutoHotkey v2.0
#SingleInstance Off
; open-control-center.ahk — the DESKTOP-ICON entry point for the Claude Control
; Center. Focuses the window if it's already open, otherwise launches and
; positions it, then exits. The global Ctrl+Alt+C hotkey lives in claude-cc.ahk;
; this is the double-click path, kept as a separate file so it never disturbs
; the persistent hotkey instance (#SingleInstance Off + its own filename).

GridClass := "wezterm-claude-cc"
LaunchCmd := EnvGet("USERPROFILE") "\.local\share\claude-cc\launch.cmd"
; Resolve wezterm by full path so it works regardless of the inherited PATH.
WezExe := FileExist(A_ProgramFiles "\WezTerm\wezterm.exe") ? A_ProgramFiles "\WezTerm\wezterm.exe" : "wezterm"
; Session watchdog: ends the claude-cc Zellij session when this window closes so it
; (and its CLI/agent panes) never lingers in the background. Spawned OUTSIDE the
; window so it survives the close (zellij on_force_close does not fire on Windows).
NodeExe  := FileExist(A_ProgramFiles "\nodejs\node.exe") ? A_ProgramFiles "\nodejs\node.exe" : "node"
Watchdog := EnvGet("USERPROFILE") "\OneDrive\desktop\projects\claude-control-center\session-watchdog.mjs"

FindVerticalMonitor() {
    Loop MonitorGetCount() {
        MonitorGetWorkArea(A_Index, &l, &t, &r, &b)
        if ((b - t) > (r - l))          ; taller than wide = the vertical monitor
            return A_Index
    }
    return MonitorGetPrimary()
}

; Already open? Just focus it — never spawn a second window.
existing := WinExist("ahk_class " GridClass)
if existing {
    WinActivate("ahk_id " existing)
    ExitApp
}

mon := FindVerticalMonitor()
MonitorGetWorkArea(mon, &l, &t, &r, &b)
before := WinGetList("ahk_class " GridClass)
; wezterm execs PROG directly (CreateProcess), which can't run a .cmd — wrap in cmd /c.
Run('"' WezExe '" start --class ' GridClass ' -- cmd /c "' LaunchCmd '"')
win := 0
Loop 60 {                            ; wait up to ~6s for the new window
    Sleep 100
    for hwnd in WinGetList("ahk_class " GridClass) {
        isNew := true
        for old in before
            if (old == hwnd) {
                isNew := false
                break
            }
        if isNew {
            win := hwnd
            break
        }
    }
    if win
        break
}
; Non-maximized + movable: fit comfortably inside the vertical monitor's work
; area with margins, matching the Ctrl+Alt+C hotkey behavior.
if (win && WinExist("ahk_id " win)) {
    try {
        WinRestore("ahk_id " win)
        ww := r - l
        wh := b - t
        w  := ww - 80
        h  := Round(wh * 0.72)
        WinMove(l + 40, t + 40, w, h, "ahk_id " win)
    }
}
; Start the watchdog (outside the window tree) so the session ends with the window.
if (win && FileExist(Watchdog)) {
    try Run('"' NodeExe '" "' Watchdog '" claude-cc', , "Hide")
}
ExitApp
