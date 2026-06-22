@echo off
setlocal
REM Claude Control Center session launcher (runs inside the WezTerm window).
REM Prepend the tool dirs so zellij/node/claude resolve even if the inherited
REM PATH is thin (this propagates to the panes zellij spawns: node Home, claude).
set "PATH=%LOCALAPPDATA%\Zellij;%ProgramFiles%\nodejs;%ProgramFiles%\GitHub CLI;%USERPROFILE%\.local\bin;%PATH%"

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
