@echo off
setlocal
REM Claude Control Center session launcher (runs inside the WezTerm window).
REM Prepend the tool dirs so zellij/node/claude resolve even if the inherited
REM PATH is thin (this propagates to the panes zellij spawns: node Home, claude).
set "PATH=%LOCALAPPDATA%\Zellij;%ProgramFiles%\nodejs;%USERPROFILE%\.local\bin;%PATH%"

REM Attach to the persistent session if it exists; blocks until you detach.
zellij attach claude-cc 2>nul
if %errorlevel%==0 goto :done

REM No session yet — create one with the Home layout (tab 0 = the Node TUI).
zellij -s claude-cc --layout "%USERPROFILE%\.local\share\claude-cc\layouts\cc-default.kdl"
if %errorlevel%==0 goto :done

echo.
echo ============================================================
echo  [claude-cc] Zellij exited (errorlevel %errorlevel%) without
echo  staying open. Diagnostics:
echo.
echo  where zellij  ^>
where zellij
echo.
echo  where node    ^>
where node
echo.
echo  layout file:
echo    %USERPROFILE%\.local\share\claude-cc\layouts\cc-default.kdl
if exist "%USERPROFILE%\.local\share\claude-cc\layouts\cc-default.kdl" (echo    [exists]) else (echo    [MISSING])
echo ============================================================
echo  This window is kept open so you can read the error above.
echo  Press any key to close.
pause >nul

:done
