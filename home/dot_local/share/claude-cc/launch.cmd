@echo off
REM Claude Control Center session launcher (runs inside the WezTerm window).
REM Attach to the persistent "claude-cc" session if it exists; otherwise create
REM it with the Home layout (tab 0 = the Node control-center TUI).
REM Prepend the tool dirs so zellij/node/claude resolve even if the inherited
REM PATH is thin (this propagates to the panes zellij spawns: node Home, claude).
set "PATH=%LOCALAPPDATA%\Zellij;%ProgramFiles%\nodejs;%USERPROFILE%\.local\bin;%PATH%"
zellij attach claude-cc 2>nul || zellij -s claude-cc --layout "%USERPROFILE%\.local\share\claude-cc\layouts\cc-default.kdl"
