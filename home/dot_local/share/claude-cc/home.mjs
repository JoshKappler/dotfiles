#!/usr/bin/env node
// Claude Control Center — Home TUI (WP1)
// Raw-ANSI full-screen alt-screen TUI. Zero npm deps; Node built-ins only.
//
// Sections (top -> bottom):
//   - Directory navigator  : up/down select, right enter dir, left parent dir
//   - Agent count          : 1-8 keys, or +/-
//   - Launch (Enter)       : zellij action new-tab --layout <claude-N.kdl> ...
//   - Mass git-push (g)    : node git-push-all.mjs <currentDir>, render per-repo JSON
//   - Session gauges       : freshest non-stale agents/*.json rateLimits -> 5h + Weekly bars
//   - Subagents            : parents with running subagent children; Enter opens inspector
//   - Cheatsheet footer    : static key list, always visible
//
// Run/test:
//   node home.mjs
//   CC_ROOT=/some/dir node home.mjs
//
// Keys: up/down move selection in the active list; left/right navigate dirs;
//   Tab switches focus (dirs <-> subagents); 1-8 / +/- set agent count;
//   Enter launches (dirs focus) or opens inspector (subagents focus);
//   g = git push; q / Ctrl+C = quit.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

// ---------- shared state contract (re-implemented inline, no shared import) ----------
const HOME = os.homedir();
function stateRoot() { return path.join(HOME, '.claude', 'state', 'cc'); }
function agentsDir() { return path.join(stateRoot(), 'agents'); }
function subagentsRootDir() { return path.join(stateRoot(), 'subagents'); }
function appDir() { return path.join(HOME, '.local', 'share', 'claude-cc'); }
function inspectorPath() { return path.join(appDir(), 'inspector.mjs'); }
function gitPushPath() { return path.join(appDir(), 'git-push-all.mjs'); }
function cloneAllPath() { return path.join(appDir(), 'clone-all.mjs'); }
function layoutPath(n) {
  // Forward slashes work in Node on Windows too; keep them for the zellij arg.
  return appDir().replace(/\\/g, '/') + '/layouts/claude-' + n + '.kdl';
}
const AGENT_STALE_MS = 120 * 1000; // readers ignore agents/*.json older than 120s

function ensureStateRoot() {
  try { fs.mkdirSync(stateRoot(), { recursive: true }); } catch { /* ignore */ }
}

// ---------- ANSI helpers ----------
const ESC = '\x1b';
const ALT_ON = ESC + '[?1049h';
const ALT_OFF = ESC + '[?1049l';
const CURSOR_HIDE = ESC + '[?25l';
const CURSOR_SHOW = ESC + '[?25h';
const CLEAR = ESC + '[2J' + ESC + '[H';
const HOME_POS = ESC + '[H';
function fg(c) { return ESC + '[' + c + 'm'; }
const RESET = fg(0);
const BOLD = fg(1);
const DIM = fg(2);
const GREEN = fg(32);
const BRIGHT_GREEN = fg(92);
const YELLOW = fg(33);
const RED = fg(31);
const CYAN = fg(36);
const INVERSE = fg(7);
// Key chip: bold BLACK text on a bright-green block, so the key letter is dark
// and clearly legible against the green phosphor theme.
const KEYCAP = ESC + '[1;30;102m';

// ---------- safe text ----------
function asciiSafe(s) {
  if (s == null) return '';
  return String(s).replace(/[^\x20-\x7e]/g, '?');
}
function truncate(s, n) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, n);
  return s.slice(0, n - 1) + '~';
}
function pad(s, n) {
  s = String(s == null ? '' : s);
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}
// A key chip: the key glyph in black on a green block, e.g. chip('Enter').
function chip(s) { return KEYCAP + ' ' + s + ' ' + RESET; }

// ---------- terminal size ----------
function termCols() { return (process.stdout.columns && process.stdout.columns > 0) ? process.stdout.columns : 80; }
function termRows() { return (process.stdout.rows && process.stdout.rows > 0) ? process.stdout.rows : 24; }

// ---------- start directory ----------
function defaultRoot() {
  const cand = path.join(HOME, 'OneDrive', 'desktop', 'projects');
  try {
    if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return cand;
  } catch { /* ignore */ }
  return HOME;
}
function initialRoot() {
  const envRoot = process.env.CC_ROOT;
  if (envRoot) {
    try {
      if (fs.existsSync(envRoot) && fs.statSync(envRoot).isDirectory()) return path.resolve(envRoot);
    } catch { /* ignore */ }
  }
  return defaultRoot();
}

// ---------- state ----------
const state = {
  cwd: initialRoot(),
  entries: [],        // { name, isDir }
  dirSel: 0,
  count: 1,
  focus: 'dirs',      // 'dirs' | 'subagents'
  subSel: 0,
  subParents: [],     // [{ parentId, running, total, label }]
  status: '',         // transient inline message
  statusKind: 'info', // info | error | ok
  lastGit: null,      // { repos: [...] } or { error }
  lastClone: null,    // { root, repos: [...] } or { error }
  busy: false,        // true while a blocking spawn (clone/push) is running
};

function loadEntries() {
  let list = [];
  try {
    const names = fs.readdirSync(state.cwd, { withFileTypes: true });
    for (const d of names) {
      let isDir = false;
      try {
        isDir = d.isDirectory();
        if (!isDir && d.isSymbolicLink()) {
          // resolve symlink dirs
          const full = path.join(state.cwd, d.name);
          isDir = fs.statSync(full).isDirectory();
        }
      } catch { isDir = false; }
      list.push({ name: d.name, isDir });
    }
  } catch (e) {
    list = [];
    setStatus('Cannot read directory: ' + asciiSafe(e && e.message), 'error');
  }
  // dirs first, then files, each alphabetical (case-insensitive)
  list.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : (a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0);
  });
  state.entries = list;
  if (state.dirSel >= state.entries.length) state.dirSel = Math.max(0, state.entries.length - 1);
  if (state.dirSel < 0) state.dirSel = 0;
}

function setStatus(msg, kind) {
  state.status = msg || '';
  state.statusKind = kind || 'info';
}

// ---------- agents gauges ----------
function readFreshestAgent() {
  let best = null;
  let dirents;
  try { dirents = fs.readdirSync(agentsDir()); } catch { return null; }
  const now = Date.now();
  for (const f of dirents) {
    if (!f.endsWith('.json')) continue;
    let obj;
    try {
      const raw = fs.readFileSync(path.join(agentsDir(), f), 'utf8');
      obj = JSON.parse(raw);
    } catch { continue; }
    const updatedAt = typeof obj.updatedAt === 'number' ? obj.updatedAt : 0;
    // updatedAt is epoch seconds per schema; tolerate ms too.
    const updMs = updatedAt > 1e12 ? updatedAt : updatedAt * 1000;
    if (now - updMs > AGENT_STALE_MS) continue; // stale
    if (!best || updMs > best._updMs) {
      obj._updMs = updMs;
      best = obj;
    }
  }
  return best;
}

function fmtCountdown(resetsAt) {
  if (resetsAt == null) return '';
  // resetsAt epoch seconds (tolerate ms)
  const secAt = resetsAt > 1e12 ? Math.floor(resetsAt / 1000) : resetsAt;
  const nowS = Math.floor(Date.now() / 1000);
  let d = secAt - nowS;
  if (d <= 0) return 'resets now';
  const h = Math.floor(d / 3600); d -= h * 3600;
  const m = Math.floor(d / 60); const s = d - m * 60;
  if (h > 0) return 'resets in ' + h + 'h' + (m < 10 ? '0' : '') + m + 'm';
  if (m > 0) return 'resets in ' + m + 'm' + (s < 10 ? '0' : '') + s + 's';
  return 'resets in ' + s + 's';
}

function bar(pct, width) {
  if (pct == null || isNaN(pct)) {
    return '[' + ' '.repeat(width) + ']';
  }
  let p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  let color = GREEN;
  if (p >= 90) color = RED;
  else if (p >= 70) color = YELLOW;
  return '[' + color + '#'.repeat(filled) + RESET + DIM + '-'.repeat(width - filled) + RESET + ']';
}

// ---------- subagents scan ----------
function scanSubagents() {
  const parents = [];
  let pdirs;
  try { pdirs = fs.readdirSync(subagentsRootDir(), { withFileTypes: true }); } catch { state.subParents = []; if (state.subSel !== 0) state.subSel = 0; return; }
  for (const pd of pdirs) {
    if (!pd.isDirectory()) continue;
    const parentId = pd.name;
    const pdir = path.join(subagentsRootDir(), parentId);
    let files;
    try { files = fs.readdirSync(pdir); } catch { continue; }
    let running = 0, total = 0;
    let lastLabel = '';
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let obj;
      try { obj = JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8')); } catch { continue; }
      total++;
      if (obj && obj.status === 'running') {
        running++;
        if (obj.label) lastLabel = obj.label;
        else if (obj.agentType) lastLabel = obj.agentType;
      }
    }
    if (running > 0) {
      parents.push({ parentId, running, total, label: lastLabel });
    }
  }
  parents.sort((a, b) => (a.parentId < b.parentId ? -1 : 1));
  state.subParents = parents;
  if (state.subSel >= parents.length) state.subSel = Math.max(0, parents.length - 1);
  if (state.subSel < 0) state.subSel = 0;
}

// ---------- actions ----------
function enterDir() {
  const e = state.entries[state.dirSel];
  if (!e || !e.isDir) return;
  const next = path.join(state.cwd, e.name);
  try {
    if (fs.statSync(next).isDirectory()) {
      state.cwd = next;
      state.dirSel = 0;
      loadEntries();
      setStatus('', 'info');
    }
  } catch (err) {
    setStatus('Cannot enter: ' + asciiSafe(err && err.message), 'error');
  }
}
function parentDir() {
  const parent = path.dirname(state.cwd);
  if (parent && parent !== state.cwd) {
    const prevBase = path.basename(state.cwd);
    state.cwd = parent;
    state.dirSel = 0;
    loadEntries();
    // try to select where we came from
    const idx = state.entries.findIndex((x) => x.name === prevBase);
    if (idx >= 0) state.dirSel = idx;
    setStatus('', 'info');
  }
}

function launch() {
  const n = state.count;
  const dir = state.cwd;
  const name = path.basename(dir) || dir;
  const args = ['action', 'new-tab', '--layout', layoutPath(n), '--cwd', dir, '--name', name];
  let res;
  try {
    res = spawnSync('zellij', args, { encoding: 'utf8' });
  } catch (e) {
    setStatus('Launch failed: ' + asciiSafe(e && e.message), 'error');
    return;
  }
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      setStatus('zellij not found on PATH (cannot launch tab)', 'error');
    } else {
      setStatus('Launch error: ' + asciiSafe(res.error.message), 'error');
    }
    return;
  }
  if (res.status !== 0) {
    const msg = asciiSafe((res.stderr || res.stdout || '').toString().trim().split('\n').pop() || ('exit ' + res.status));
    setStatus('zellij returned error: ' + truncate(msg, 60), 'error');
    return;
  }
  setStatus('Launched ' + n + ' agent' + (n === 1 ? '' : 's') + ' in ' + asciiSafe(name), 'ok');
}

function gitPush() {
  const root = state.cwd;
  setStatus('Pushing repos under ' + asciiSafe(path.basename(root)) + ' ...', 'info');
  redraw();
  let res;
  try {
    res = spawnSync('node', [gitPushPath(), root], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    state.lastGit = { error: asciiSafe(e && e.message) };
    setStatus('git-push failed to spawn', 'error');
    return;
  }
  if (res.error) {
    state.lastGit = { error: asciiSafe(res.error.message) };
    setStatus('git-push spawn error', 'error');
    return;
  }
  let parsed = null;
  const out = (res.stdout || '').toString().trim();
  try { parsed = JSON.parse(out); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.repos)) {
    state.lastGit = { error: 'bad output: ' + truncate(asciiSafe(out || (res.stderr || '').toString()), 80) };
    setStatus('git-push: unexpected output', 'error');
    return;
  }
  state.lastGit = parsed;
  const pushed = parsed.repos.filter((r) => r.pushed).length;
  const errs = parsed.repos.filter((r) => r.error).length;
  setStatus('git push: ' + pushed + ' pushed, ' + errs + ' error(s), ' + parsed.repos.length + ' repo(s)', errs ? 'error' : 'ok');
}

function cloneAll() {
  // Always target the projects root (not the browsed folder): this button means
  // "clone/update ALL my GitHub repos into projects", wherever the cursor is.
  const root = defaultRoot();
  state.busy = true;
  setStatus('Cloning + updating all repos into ' + asciiSafe(path.basename(root)) + ' (this can take a while)...', 'info');
  redraw();
  let res;
  try {
    res = spawnSync('node', [cloneAllPath(), root], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    state.lastClone = { error: asciiSafe(e && e.message) };
    state.busy = false;
    setStatus('clone-all failed to spawn', 'error');
    return;
  }
  state.busy = false;
  if (res.error) {
    state.lastClone = { error: asciiSafe(res.error.message) };
    setStatus('clone-all spawn error', 'error');
    return;
  }
  let parsed = null;
  const outStr = (res.stdout || '').toString().trim();
  try { parsed = JSON.parse(outStr); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.repos)) {
    const why = parsed && parsed.error ? parsed.error : truncate(asciiSafe(outStr || (res.stderr || '').toString()), 80);
    state.lastClone = { error: 'bad output: ' + why };
    setStatus('clone-all: unexpected output', 'error');
    return;
  }
  state.lastClone = parsed;
  const cloned = parsed.repos.filter((r) => r.action === 'cloned').length;
  const updated = parsed.repos.filter((r) => r.action === 'updated').length;
  const errs = parsed.repos.filter((r) => r.action === 'error' || (r.error && r.error !== 'empty repo' && r.error !== 'dirty')).length;
  setStatus('clone/sync: ' + cloned + ' cloned, ' + updated + ' updated, ' + parsed.repos.length + ' repo(s)' +
    (errs ? ', ' + errs + ' error(s)' : ''), errs ? 'error' : 'ok');
}

function openInspector() {
  const p = state.subParents[state.subSel];
  if (!p) { setStatus('No subagent group selected', 'error'); return; }
  const args = ['action', 'new-pane', '--floating', '--close-on-exit', '--', 'node', inspectorPath(), p.parentId];
  let res;
  try {
    res = spawnSync('zellij', args, { encoding: 'utf8' });
  } catch (e) {
    setStatus('Inspector failed: ' + asciiSafe(e && e.message), 'error');
    return;
  }
  if (res.error) {
    if (res.error.code === 'ENOENT') setStatus('zellij not found on PATH (cannot open inspector)', 'error');
    else setStatus('Inspector error: ' + asciiSafe(res.error.message), 'error');
    return;
  }
  if (res.status !== 0) {
    setStatus('zellij returned error opening inspector', 'error');
    return;
  }
  setStatus('Opened inspector for ' + truncate(asciiSafe(p.parentId), 16), 'ok');
}

// ---------- rendering ----------
let lastFrame = '';
function out(s) { process.stdout.write(s); }

function render() {
  const cols = termCols();
  const W = Math.max(40, cols);
  const lines = [];
  const sep = DIM + '-'.repeat(Math.min(W, 78)) + RESET;

  // Title bar
  lines.push(INVERSE + BOLD + pad(' CLAUDE CONTROL CENTER  -  Home', Math.min(W, 78)) + RESET);
  lines.push('');

  // Folder line (state only — all key hints live in the one footer below).
  lines.push(BOLD + 'Folder: ' + RESET + GREEN + truncate(asciiSafe(state.cwd), Math.min(W - 9, 67)) + RESET);
  lines.push(sep);

  // Directory navigator
  const dirFocused = state.focus === 'dirs';
  lines.push((dirFocused ? BRIGHT_GREEN + '> ' : '  ') + BOLD + 'DIRECTORY' + RESET);
  const totalRows = termRows();
  // budget for the directory list
  const navRows = Math.max(4, Math.min(10, totalRows - 22));
  if (state.entries.length === 0) {
    lines.push('    ' + DIM + '(empty)' + RESET);
  } else {
    let start = 0;
    if (state.dirSel >= navRows) start = state.dirSel - navRows + 1;
    const end = Math.min(state.entries.length, start + navRows);
    for (let i = start; i < end; i++) {
      const e = state.entries[i];
      const sel = (i === state.dirSel && dirFocused);
      const marker = sel ? (BRIGHT_GREEN + '>' + RESET) : ' ';
      const label = (e.isDir ? '[' : ' ') + asciiSafe(e.name) + (e.isDir ? '/]' : ' ');
      const text = truncate(label, Math.min(W - 6, 60));
      lines.push('  ' + marker + ' ' + (sel ? INVERSE : (e.isDir ? GREEN : DIM)) + pad(text, Math.min(W - 6, 60)) + RESET);
    }
    if (end < state.entries.length || start > 0) {
      lines.push('    ' + DIM + '(' + (state.dirSel + 1) + '/' + state.entries.length + ')' + RESET);
    }
  }
  lines.push(sep);

  // Launch — the clear "fill a window with agents" affordance. Shows exactly
  // what Enter will do with the current count + selected folder.
  const launchName = path.basename(state.cwd) || state.cwd;
  lines.push(BOLD + 'LAUNCH' + RESET);
  lines.push('  ' + chip('Enter') + ' open a new window of ' + chip(String(state.count)) +
    ' agent' + (state.count === 1 ? '' : 's') + ' in ' + GREEN + truncate(asciiSafe(launchName), 24) + RESET);
  lines.push('  ' + DIM + 'set the count with ' + RESET + chip('1') + DIM + '..' + RESET + chip('8') +
    DIM + ';  add more later inside a tab with ' + RESET + chip('Alt') + '+' + chip('a'));
  lines.push(sep);

  // Gauges
  lines.push(BOLD + 'SESSION LIMITS' + RESET);
  const a = readFreshestAgent();
  const rl = a && a.rateLimits ? a.rateLimits : null;
  const five = rl && rl.fiveHour ? rl.fiveHour : null;
  const week = rl && rl.sevenDay ? rl.sevenDay : null;
  const barW = 24;
  function gaugeLine(label, gauge) {
    if (!gauge || gauge.usedPct == null) {
      return '  ' + pad(label, 8) + ' ' + bar(null, barW) + '   ' + DIM + '--' + RESET;
    }
    const pct = Math.round(gauge.usedPct);
    const cd = fmtCountdown(gauge.resetsAt);
    return '  ' + pad(label, 8) + ' ' + bar(gauge.usedPct, barW) + ' ' + pad(pct + '%', 4) +
      (cd ? '  ' + DIM + cd + RESET : '');
  }
  lines.push(gaugeLine('5-hour', five));
  lines.push(gaugeLine('Weekly', week));
  if (!a) {
    lines.push('  ' + DIM + '(no agent has reported yet -- gauges show -- until first API call)' + RESET);
  }
  lines.push(sep);

  // Subagents
  const subFocused = state.focus === 'subagents';
  lines.push((subFocused ? BRIGHT_GREEN + '> ' : '  ') + BOLD + 'SUBAGENTS' + RESET);
  if (state.subParents.length === 0) {
    lines.push('    ' + DIM + '(no agents running subagents)' + RESET);
  } else {
    const maxShow = 4;
    for (let i = 0; i < Math.min(state.subParents.length, maxShow); i++) {
      const p = state.subParents[i];
      const sel = (i === state.subSel && subFocused);
      const marker = sel ? (BRIGHT_GREEN + '>' + RESET) : ' ';
      const text = truncate(asciiSafe(p.parentId), 14) + '  ' + p.running + '/' + p.total + ' running' +
        (p.label ? '  ' + truncate(asciiSafe(p.label), 28) : '');
      lines.push('  ' + marker + ' ' + (sel ? INVERSE : CYAN) + pad(text, Math.min(W - 6, 60)) + RESET);
    }
  }
  lines.push(sep);

  // clone/sync results (compact) — shown after a `c` run.
  if (state.lastClone) {
    lines.push(BOLD + 'LAST CLONE / SYNC' + RESET);
    if (state.lastClone.error) {
      lines.push('  ' + RED + truncate(asciiSafe(state.lastClone.error), Math.min(W - 4, 70)) + RESET);
    } else {
      const repos = state.lastClone.repos || [];
      const cloned = repos.filter((r) => r.action === 'cloned').length;
      const updated = repos.filter((r) => r.action === 'updated').length;
      const current = repos.filter((r) => r.action === 'up-to-date').length;
      const skipped = repos.filter((r) => r.action === 'skipped').length;
      const errs = repos.filter((r) => r.action === 'error').length;
      lines.push('  ' + GREEN + cloned + ' cloned' + RESET + '  ' + GREEN + updated + ' updated' + RESET +
        '  ' + DIM + current + ' current  ' + skipped + ' skipped' + RESET +
        (errs ? '  ' + RED + errs + ' error' + RESET : ''));
      // surface the most interesting rows (anything not plain up-to-date)
      const notable = repos.filter((r) => r.action !== 'up-to-date').slice(0, 3);
      for (const r of notable) {
        const col = r.action === 'error' ? RED : (r.action === 'cloned' || r.action === 'updated' ? GREEN : DIM);
        lines.push('  ' + pad(truncate(asciiSafe(r.name), 20), 22) + col + pad(r.action, 11) + RESET +
          (r.error ? DIM + truncate(asciiSafe(r.error), 28) + RESET : ''));
      }
    }
    lines.push(sep);
  }

  // git push results (compact)
  if (state.lastGit) {
    lines.push(BOLD + 'LAST GIT PUSH' + RESET);
    if (state.lastGit.error) {
      lines.push('  ' + RED + truncate(asciiSafe(state.lastGit.error), Math.min(W - 4, 70)) + RESET);
    } else {
      const repos = state.lastGit.repos || [];
      if (repos.length === 0) lines.push('  ' + DIM + '(no repos found)' + RESET);
      for (let i = 0; i < Math.min(repos.length, 4); i++) {
        const r = repos[i];
        const base = truncate(asciiSafe(path.basename(r.path || '')), 18);
        let st, col;
        if (r.error) { st = 'ERR ' + truncate(asciiSafe(r.error), 30); col = RED; }
        else if (r.pushed) { st = 'pushed'; col = GREEN; }
        else { st = 'skipped'; col = DIM; }
        lines.push('  ' + pad(base, 20) + ' ' + pad(asciiSafe(r.branch || ''), 14) + ' ' + col + st + RESET);
      }
      if (repos.length > 4) lines.push('  ' + DIM + '... +' + (repos.length - 4) + ' more' + RESET);
    }
    lines.push(sep);
  }

  // status line
  if (state.status) {
    let col = CYAN;
    if (state.statusKind === 'error') col = RED;
    else if (state.statusKind === 'ok') col = BRIGHT_GREEN;
    lines.push(col + truncate(asciiSafe(state.status), Math.min(W - 1, 77)) + RESET);
  } else {
    lines.push('');
  }

  // Cheatsheet footer — the SINGLE place all keys are documented. Key glyphs are
  // black-on-green chips so they read clearly against the phosphor theme.
  lines.push(sep);
  lines.push(
    DIM + 'MOVE  ' + RESET + chip('Up') + chip('Dn') + ' select   ' +
    chip('->') + ' open folder   ' + chip('<-') + ' up a level   ' +
    chip('Tab') + ' subagents');
  lines.push(
    DIM + 'DO    ' + RESET + chip('1') + DIM + '-' + RESET + chip('8') + ' set agents   ' +
    chip('Enter') + ' launch window   ' +
    chip('c') + ' clone all repos   ' + chip('g') + ' push all   ' + chip('q') + ' quit');
  lines.push(
    DIM + 'WINDOW' + RESET + ' ' + chip('Alt') + '+' + chip('[') + chip(']') + ' switch   ' +
    chip('Alt') + '+' + chip('a') + ' add agent   ' +
    chip('Ctrl') + '+' + chip('g') + ' lock   ' +
    chip('Ctrl') + '+' + chip('Alt') + '+' + chip('w') + ' close');

  const frame = HOME_POS + ESC + '[2J' + lines.join('\r\n') + '\r\n';
  lastFrame = frame;
  out(frame);
}

function redraw() {
  scanSubagents();
  render();
}

// ---------- input ----------
function onKey(str, key) {
  if (!key) key = {};
  const name = key.name;

  // quit
  if ((key.ctrl && name === 'c') || name === 'q') {
    cleanupAndExit(0);
    return;
  }

  // count: digits 1-8
  if (str && /^[1-8]$/.test(str)) {
    state.count = parseInt(str, 10);
    setStatus('', 'info');
    redraw();
    return;
  }
  if (str === '+' || str === '=' || name === 'add' || str === ']') {
    state.count = Math.min(8, state.count + 1);
    redraw();
    return;
  }
  if (str === '-' || str === '_' || name === 'subtract' || str === '[') {
    state.count = Math.max(1, state.count - 1);
    redraw();
    return;
  }

  // clone/sync ALL repos into the projects folder
  if (!key.ctrl && (name === 'c' || str === 'c')) {
    cloneAll();
    redraw();
    return;
  }

  // git push
  if (name === 'g' || str === 'g') {
    gitPush();
    redraw();
    return;
  }

  // focus toggle
  if (name === 'tab') {
    state.focus = (state.focus === 'dirs') ? 'subagents' : 'dirs';
    redraw();
    return;
  }

  // navigation
  if (name === 'up') {
    if (state.focus === 'dirs') {
      if (state.dirSel > 0) state.dirSel--;
    } else {
      if (state.subSel > 0) state.subSel--;
    }
    redraw();
    return;
  }
  if (name === 'down') {
    if (state.focus === 'dirs') {
      if (state.dirSel < state.entries.length - 1) state.dirSel++;
    } else {
      if (state.subSel < state.subParents.length - 1) state.subSel++;
    }
    redraw();
    return;
  }
  if (name === 'right') {
    if (state.focus === 'dirs') enterDir();
    redraw();
    return;
  }
  if (name === 'left') {
    if (state.focus === 'dirs') parentDir();
    redraw();
    return;
  }

  // Enter
  if (name === 'return' || name === 'enter') {
    if (state.focus === 'dirs') launch();
    else openInspector();
    redraw();
    return;
  }
}

// ---------- lifecycle ----------
let timer = null;
let cleanedUp = false;
function cleanupAndExit(code) {
  if (cleanedUp) { process.exit(code); return; }
  cleanedUp = true;
  try { if (timer) clearInterval(timer); } catch { /* */ }
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* */ }
  try { out(CURSOR_SHOW + ALT_OFF); } catch { /* */ }
  try { process.stdin.pause(); } catch { /* */ }
  process.exit(code == null ? 0 : code);
}

function main() {
  ensureStateRoot();
  loadEntries();

  out(ALT_ON + CURSOR_HIDE + CLEAR);

  // Try to enter interactive raw mode. On Windows a Zellij pane's stdin can
  // report isTTY=false yet still accept raw keypresses, so attempt setRawMode
  // and only degrade if it actually throws. We NEVER exit here: exiting would
  // let the Home pane's command die and collapse the whole window.
  let rawOk = false;
  try {
    readline.emitKeypressEvents(process.stdin);
    if (typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true);
      rawOk = true;
    }
  } catch { rawOk = false; }
  try { process.stdin.resume(); } catch { /* */ }
  try { process.stdin.setEncoding('utf8'); } catch { /* */ }
  process.stdin.on('keypress', (s, k) => {
    try { onKey(s, k); } catch (e) { setStatus('key error: ' + asciiSafe(e && e.message), 'error'); try { redraw(); } catch { /* */ } }
  });

  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));
  process.stdout.on('resize', () => { try { redraw(); } catch { /* */ } });

  if (!rawOk) setStatus('limited input (no raw TTY detected) - keys may not register', 'error');
  redraw();
  // The interval also keeps the event loop alive so the pane/window never closes,
  // even if no raw input is available.
  timer = setInterval(() => { try { redraw(); } catch { /* */ } }, 1000);
}

main();
