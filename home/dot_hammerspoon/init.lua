-- init.lua — Hammerspoon: macOS twin of scripts/claude-grid.ahk.
--   Ctrl+Alt+4  -> 2x2 grid (4 Claude Code sessions)
--   Ctrl+Alt+6  -> 2x3 grid (6 Claude Code sessions)
-- Each hotkey opens a NEW WezTerm window running `zellij --layout <claude-grid…>`,
-- then places + maximizes it on the *vertical* (portrait) monitor.
--
-- Requires: wezterm + zellij on PATH (Homebrew), claude on PATH.
-- Zellij layouts live in ~/.config/zellij/layouts/ (claude-grid.kdl / claude-grid-6.kdl).
-- macOS reads ~/.config/zellij natively, so no ZELLIJ_CONFIG_DIR is needed here.
--
-- NOTE: Hammerspoon needs Accessibility permission (System Settings > Privacy &
-- Security > Accessibility) to move/resize windows and bind global hotkeys.

-- Homebrew installs wezterm at /opt/homebrew/bin (Apple Silicon) or /usr/local/bin (Intel).
local function weztermPath()
  for _, p in ipairs({ "/opt/homebrew/bin/wezterm", "/usr/local/bin/wezterm" }) do
    if hs.fs.attributes(p) then return p end
  end
  return "wezterm" -- fall back to PATH
end
local WEZTERM = weztermPath()

-- Default working directory for the grid sessions.
local PROJECT_DIR = os.getenv("HOME") .. "/projects"

-- Find the portrait (taller-than-wide) screen; fall back to the primary screen.
local function verticalScreen()
  for _, scr in ipairs(hs.screen.allScreens()) do
    local f = scr:frame()           -- usable frame (excludes menu bar / Dock)
    if f.h > f.w then return scr end
  end
  return hs.screen.primaryScreen()
end

-- Open one WezTerm window running the given zellij layout, then move + maximize
-- it onto the vertical monitor once macOS has created the window.
local function openGrid(layout)
  local scr = verticalScreen()
  local frame = scr:frame()
  local before = {}
  for _, w in ipairs(hs.window.allWindows()) do before[w:id()] = true end

  -- Launch detached. wezterm `start --cwd <dir> -- <prog>` runs the program in a
  -- fresh window. `true` = run via a login shell so PATH (Homebrew) is present.
  local cmd = string.format(
    '%s start --cwd %q -- zellij --layout %s >/dev/null 2>&1 &',
    WEZTERM, PROJECT_DIR, layout)
  hs.execute(cmd, true)

  -- Poll up to ~6s for the new WezTerm window, then snap it to the portrait screen.
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
          w:setFrame(frame)         -- fill the vertical monitor exactly
          tries = 60                 -- done
          return
        end
      end
    end,
    0.1)
end

-- Bind the two hotkeys (Ctrl+Alt = {"ctrl","alt"}), matching the AHK launcher.
hs.hotkey.bind({ "ctrl", "alt" }, "4", function() openGrid("claude-grid") end)
hs.hotkey.bind({ "ctrl", "alt" }, "6", function() openGrid("claude-grid-6") end)

hs.alert.show("claude-grid loaded  (Ctrl+Alt+4 / Ctrl+Alt+6)")
