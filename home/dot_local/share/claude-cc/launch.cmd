@echo off
setlocal
REM Claude Control Center session launcher (runs inside the WezTerm window).
REM Prepend the tool dirs so zellij/node/claude resolve even if the inherited
REM PATH is thin (this propagates to the panes zellij spawns: node Home, claude).
set "PATH=%LOCALAPPDATA%\Zellij;%ProgramFiles%\nodejs;%ProgramFiles%\GitHub CLI;%USERPROFILE%\.local\bin;%PATH%"

REM Belt-and-suspenders: kill any stale claude-cc session left over from a
REM previous window so opening ALWAYS starts fresh and nothing lingers in the
REM background. (The session-watchdog normally ends it on window close; this
REM covers the case where it didn't, e.g. before the AHK hotkey is reloaded.)
REM Safe: launch.cmd only runs when no Control Center window is already open.
zellij delete-session claude-cc --force >nul 2>&1

REM Attach to the persistent "claude-cc" session, creating it (with the
REM default_layout "cc-default" = the Home tab) if it doesn't exist yet. This is
REM the canonical attach-or-create; do NOT use `-s NAME --layout` (0.44.3 treats
REM that as an attach and exits with "session not found").
zellij attach -c claude-cc
if %errorlevel%==0 goto :done

echo.
echo ============================================================
echo  [claude-cc] Zellij exited (errorlevel %errorlevel%).
echo.
echo  where zellij  ^>
where zellij
echo  where node    ^>
where node
echo.
echo  This window is kept open so you can read the error above.
echo  Press any key to close.
pause >nul

:done
