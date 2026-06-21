#Requires AutoHotkey v2.0
#SingleInstance Force
; claude-grid.ahk — open a grid of Claude Code sessions on the vertical monitor.
;   Ctrl+Alt+4  -> 2x2 grid (4 sessions)
;   Ctrl+Alt+6  -> 2x3 grid (6 sessions)
; Each press opens a NEW WezTerm window (its own grid); open several to spread
; across screens. Windows auto-size to fill the *vertical* (portrait) monitor.
; Requires: wezterm + zellij on PATH, ZELLIJ_CONFIG_DIR set (windows-env-setup.ps1),
; claude on PATH. Layouts live in ~/.config/zellij/layouts/.

ProjectDir := EnvGet("USERPROFILE") "\OneDrive\desktop\projects"   ; default cwd for the sessions
GridClass  := "wezterm-claude-grid"                                 ; custom Win32 class for matching

FindVerticalMonitor() {
    Loop MonitorGetCount() {
        MonitorGetWorkArea(A_Index, &l, &t, &r, &b)
        if ((b - t) > (r - l))          ; taller than wide = the vertical monitor
            return A_Index
    }
    return MonitorGetPrimary()
}

OpenGrid(layout) {
    mon := FindVerticalMonitor()
    MonitorGetWorkArea(mon, &l, &t, &r, &b)
    before := WinGetList("ahk_class " GridClass)
    Run('wezterm start --class ' GridClass ' --cwd "' ProjectDir '" -- zellij --layout ' layout)
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
    if win {
        WinRestore("ahk_id " win)
        WinMove(l + 20, t + 20, , , "ahk_id " win)   ; nudge onto the vertical monitor
        WinMaximize("ahk_id " win)                    ; fill its work area exactly (DPI/taskbar-safe)
    }
}

^!4:: OpenGrid("claude-grid")
^!6:: OpenGrid("claude-grid-6")
