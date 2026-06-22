# Claude Control Center — Implementation Plan

> Executed via parallel subagents (file-disjoint WPs). Lead owns the integration
> hubs (settings.json, zellij config + layouts, launcher, chezmoi apply, verify).

**Spec:** `docs/specs/2026-06-21-control-center-design.md`
**Repo:** `~/.local/share/chezmoi` (chezmoi root `home/`), branch `main`.

## Global constraints
- **Language:** Node ESM (`.mjs`), **zero npm deps** — built-ins only
  (`node:fs`, `node:path`, `node:os`, `node:readline`, `node:child_process`,
  `process.stdin` raw mode, raw ANSI).
- **ASCII-safe output** (Homebrew green terminal; avoid non-ASCII that breaks PS
  5.1 tooling). Box-drawing/bars may use `=`/`#`/`-` or basic Unicode block only
  inside Node strings (Node files are UTF-8, safe) — but NO em-dashes in any
  PowerShell/`.ps1`/`.cmd` file.
- **App dir:** all app files under `home/dot_local/share/claude-cc/` → deployed to
  `~/.local/share/claude-cc/`.
- **State root:** `path.join(os.homedir(), '.claude', 'state', 'cc')`; every
  component creates it with `fs.mkdirSync(root, {recursive:true})`.
- **Cross-platform:** never hardcode `/` vs `\` — use `node:path`. Resolve home
  via `os.homedir()`. Pane id via `process.env.ZELLIJ_PANE_ID` (may be unset →
  handle gracefully).
- Subagents: NO git, NO browser, NO chezmoi apply, do NOT touch the hub files
  (settings.json*, config.kdl, layouts, .ahk, .chezmoiignore). Build only your
  listed files. Leave them on disk; the lead integrates + verifies.

## Shared interface contracts (all WPs depend on these — copy verbatim)

**State helper behavior** (each WP re-implements inline; no shared import to keep
files independent):
- `stateRoot()` → `path.join(os.homedir(), '.claude', 'state', 'cc')`
- `agentsDir()` → `<stateRoot>/agents`, file `<sessionId>.json`
- `panesDir()` → `<stateRoot>/panes`, file `<ZELLIJ_PANE_ID>` (text = sessionId)
- `subagentsDir(parent)` → `<stateRoot>/subagents/<parentSessionId>`, file
  `<agentId>.json`
- TTL: readers ignore `agents/*.json` whose `updatedAt` is > 120 s old (stale).

**agents/<sessionId>.json schema** (written by WP2, read by WP1):
```json
{ "sessionId","cwd","model","ctxPct","task","paneId",
  "rateLimits": { "fiveHour": {"usedPct","resetsAt"},
                  "sevenDay": {"usedPct","resetsAt"} },
  "updatedAt" }
```
`rateLimits` may be `null` (not yet available). `ctxPct` integer 0–100.

**subagents/<parent>/<agentId>.json schema** (written by WP3, read by WP1+WP3):
```json
{ "agentId","agentType","label","status","lastTool","lastDetail",
  "startedAt","updatedAt" }
```
`status` ∈ `running|done|error`.

**Launch invocation Home emits (WP1):**
`zellij action new-tab --layout <homeDir>/.local/share/claude-cc/layouts/claude-<N>.kdl --cwd <dir> --name <basename>`
(N = 1..8). Layout files are produced by the LEAD, not WP1 — WP1 only builds the
command string.

**git-push CLI (WP4):** `node git-push-all.mjs <root>` → stdout JSON
`{ "repos": [ {"path","branch","pushed":bool,"error":string|null} ] }`,
exit 0 even on per-repo errors. Excludes any repo whose folder name is
`dotfiles` or whose path is the chezmoi source dir.

---

## WP1 — Home TUI  (agent A)
**Files (create):**
- `home/dot_local/share/claude-cc/home.mjs`
- `home/dot_local/share/claude-cc/README.md` (brief: what each file is)

**Build:** raw-ANSI alt-screen TUI, `process.stdin` raw mode + keypress parsing
(`readline.emitKeypressEvents`). Sections per spec §Components.1:
navigator (↑/↓/→/←), count (1–8 or +/-), Enter=launch (print/run the new-tab
command via `child_process.spawnSync('zellij', [...])`; if `zellij` missing,
show an inline error), `g`=git push (spawn WP4, render JSON result),
gauges (read freshest `agents/*.json` rateLimits → two bars + reset countdown,
`—` if null/stale), subagents section (scan `subagents/*/*.json`, list agents
with live subagents; Enter on one spawns inspector as a floating pane via
`zellij action new-pane --floating --close-on-exit -- node <inspector path> <parentSessionId>`),
cheatsheet footer (static key list). Redraw on key + on a 1 s timer.
Start dir from `process.env.CC_ROOT || <projects dir default>`.

**Accept:** `node home.mjs` runs, arrows navigate the real filesystem, 1–8
sets count, layout shows all sections + footer, no crash when state dir empty.

## WP2 — statusLine + state writer  (agent B)
**Files (create):**
- `home/dot_local/share/claude-cc/statusline.mjs`

**Build:** read all of stdin, `JSON.parse`. Print ONE line to stdout:
`<model.display_name> · <ctxPct>% · <task>` where `ctxPct` =
`context_window.used_percentage` (fallback compute from tokens/size; clamp 0–100)
and `task` = first non-empty line of the LAST user message in the JSONL at
`transcript_path` (read file, parse lines, find last `{type:"user"}` /
`message.role==="user"`, strip, truncate ~48 chars, ASCII-only). Use green ANSI
for the % to match Homebrew. Then write `agents/<session_id>.json` per schema,
including `paneId` from `$ZELLIJ_PANE_ID` and `rateLimits` from `j.rate_limits`
(map `five_hour`→`fiveHour`, `seven_day`→`sevenDay`; null if absent). Never throw
(wrap in try/catch; on any error still print a minimal line). Must complete fast
(<300 ms) — no network.

**Accept:** piping a sample JSON (with and without `rate_limits`/`transcript_path`)
prints the one-liner and writes a well-formed `agents/<id>.json`. Include the 2
sample JSON fixtures inline in the file's top comment for manual testing.

## WP3 — hooks + subagent tracking + inspector  (agent C)
**Files (create):**
- `home/dot_local/share/claude-cc/hooks/session-register.mjs`
- `home/dot_local/share/claude-cc/hooks/subagent-track.mjs`
- `home/dot_local/share/claude-cc/inspector.mjs`

**session-register.mjs:** read stdin JSON. If `hook_event_name==="SessionStart"`
write `panes/<ZELLIJ_PANE_ID>` = `session_id` (skip if no pane id). If
`"SessionEnd"` delete this session's `agents/<id>.json`, its `panes/*` entry whose
content == session_id, and `subagents/<id>/` dir. Always exit 0.

**subagent-track.mjs:** read stdin JSON; branch on `hook_event_name`:
`SubagentStart`/`TaskCreated` → upsert `subagents/<session_id>/<agent_id>.json`
status `running` (capture `agent_type`, and `description`/`label` if present);
`PreToolUse`/`PostToolUse` with `agent_id` → set `lastTool`=`tool_name`,
`lastDetail`=short summary of `tool_input` (e.g. file path / pattern / cmd,
truncated); `SubagentStop`/`TaskCompleted` → status `done`. Use `agent_id` as the
key; `session_id` as parent. Always exit 0. Tolerate missing fields.

**inspector.mjs:** `node inspector.mjs [parentSessionId]`. If no arg, resolve via
`panes/<ZELLIJ_PANE_ID>`; if still none, scan `subagents/` and if exactly one
parent has live subagents use it, else print a numbered picker and read a digit.
Then alt-screen render a live table of `subagents/<parent>/*.json` (type, label,
status, lastTool, lastDetail, elapsed from startedAt), refresh every 1 s, `q`/Esc
exits. ASCII table.

**Accept:** feeding sample SubagentStart→PreToolUse→SubagentStop JSON to
subagent-track creates/updates/closes the file; `inspector.mjs <id>` renders it.
Include sample JSON fixtures in each file's top comment.

## WP4 — git push-all  (agent D)
**Files (create):**
- `home/dot_local/share/claude-cc/git-push-all.mjs`

**Build:** `node git-push-all.mjs <root>`. Walk `<root>` one level deep for
child dirs containing `.git` (also accept `<root>` itself being a repo). For each:
skip if working tree clean OR detached HEAD OR no upstream; else
`git -C <path> push`. Collect `{path, branch, pushed, error}`. Exclude folder
named `dotfiles` and the chezmoi source path (`git -C <p> rev-parse --show-toplevel`
matching the chezmoi dir). Print the JSON contract to stdout, exit 0 always.
Use `child_process.execFileSync('git', ...)` with try/catch per repo.

**Accept:** running against a dir with a clean repo + a dirty repo reports
`pushed:false` for clean and attempts the dirty one; never throws; dotfiles
excluded.

---

## LEAD integration (after WPs land)
1. **settings.json** → create `home/dot_claude/settings.json.tmpl` merging the
   user's current global settings (model `opus`, `bypassPermissions`, plugins,
   voice, effort) with new `statusLine.command` = `node "{{ .chezmoi.homeDir }}/.local/share/claude-cc/statusline.mjs"` and a `hooks` block registering
   session-register (SessionStart, SessionEnd) and subagent-track (SubagentStart,
   SubagentStop, TaskCreated, TaskCompleted, PreToolUse, PostToolUse), each
   `node "<homeDir>/.local/share/claude-cc/hooks/<file>.mjs"`. Remove the old
   `statusline-context.js` reference.
2. **Zellij** → `cc-default.kdl` (Home tab 0 + bars), `claude-1..8.kdl` (N panes +
   bars), config.kdl keybinds (add-agent, open-inspector, no-kill guard) + keep
   homebrew theme.
3. **Launcher** → rewrite `scripts/claude-grid.ahk` → `claude-cc.ahk` (single
   Ctrl+Alt+C, focus-or-spawn, movable non-max window on vertical monitor) +
   update Hammerspoon twin + the Startup shortcut.
4. **Cheatsheet/docs** → regenerate; update BOOTSTRAP if needed.
5. `chezmoi apply` → verify clean; launch the window; smoke-test acceptance 1–7;
   commit + push to main.
