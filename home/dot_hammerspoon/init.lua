-- init.lua — Hammerspoon: macOS twin of scripts/claude-cc.ahk.
--   Ctrl+Alt+C  -> focus the Claude Control Center window if open, else launch it.
-- ONE movable, non-maximized WezTerm window hosts the persistent "claude-cc"
-- Zellij session: a permanent Home tab (navigator + agent-count picker + mass
-- git-push + 5h/weekly limit gauges + cheatsheet) plus one tab per group of 1-8
-- Claude agents. Agent count / new tabs are chosen from Home, so one hotkey is enough.
--
-- Requires: wezterm + zellij + node + claude on PATH (Homebrew).
-- NOTE: Hammerspoon needs Accessibility permission (System Settings > Privacy &
-- Security > Accessibility) to move/resize windows and bind global hotkeys.

local function weztermPath()
  for _, p in ipairs({ "/opt/homebrew/bin/wezterm", "/usr/local/bin/wezterm" }) do
    if hs.fs.attributes(p) then return p end
  end
  return "wezterm"
end
local WEZTERM = weztermPath()

-- Find the portrait (taller-than-wide) screen; fall back to the primary screen.
local function verticalScreen()
  for _, scr in ipairs(hs.screen.allScreens()) do
    local f = scr:frame()
    if f.h > f.w then return scr end
  end
  return hs.screen.primaryScreen()
end

-- Attach to the persistent "claude-cc" session if it exists, else create it with
-- the Home layout. Runs inside the new WezTerm window.
local SESSION_CMD =
  'zellij attach claude-cc 2>/dev/null || ' ..
  'zellij -s claude-cc --layout "$HOME/.local/share/claude-cc/layouts/cc-default.kdl"'

local function focusExisting()
  local app = hs.application.get("WezTerm") or hs.application.get("wezterm-gui")
  if not app then return false end
  for _, w in ipairs(app:allWindows()) do
    if w:isStandard() then w:focus(); return true end
  end
  return false
end

local function openCenter()
  if focusExisting() then return end           -- already open: just focus it

  local scr = verticalScreen()
  local f = scr:frame()
  local before = {}
  for _, w in ipairs(hs.window.allWindows()) do before[w:id()] = true end

  -- `wezterm start -- sh -lc "<attach-or-create>"`; login shell so PATH (Homebrew) is present.
  local cmd = string.format('%s start -- sh -lc %q >/dev/null 2>&1 &', WEZTERM, SESSION_CMD)
  hs.execute(cmd, true)

  local tries = 0
  hs.timer.doUntil(
    function() return tries >= 60 end,
    function()
      tries = tries + 1
      local app = hs.application.get("WezTerm") or hs.application.get("wezterm-gui")
      if not app then return end
      for _, w in ipairs(app:allWindows()) do
        if w:isStandard() and not before[w:id()] then
          w:moveToScreen(scr)
          -- Non-maximized + movable: comfortable sub-region of the vertical screen.
          w:setFrame({ x = f.x + 20, y = f.y + 20, w = f.w - 40, h = f.h * 0.72 })
          tries = 60
          return
        end
      end
    end,
    0.1)
end

hs.hotkey.bind({ "ctrl", "alt" }, "c", openCenter)
hs.alert.show("Claude Control Center loaded  (Ctrl+Alt+C)")
