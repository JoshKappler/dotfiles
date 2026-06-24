#!/usr/bin/env node
// Claude Control Center — Home TUI
// Raw-ANSI full-screen alt-screen TUI. Zero npm deps; Node built-ins only.
//
// The Home tab is the "is my whole system up to date / synced" dashboard:
//   - Header           : title + day / date / time on the right
//   - Folder + DIRECTORY navigator (Up/Dn or k/j, ->/l enter, <-/h parent)
//   - LAUNCH           : Enter opens a new window of N agents in the folder
//   - SYNC STATUS      : clone-all + push-all buttons, with last-run times
//   - SESSION LIMITS   : 5h + weekly usage gauges
//   - SUBAGENTS        : parents with running subagent children
//   - SYSTEM           : CPU / MEM / DISK / GPU gauges (kept near the bottom)
//   - Cheatsheet footer
//
// Colors: black background everywhere, no highlight fills. Mostly GREEN (content,
// headers in bold, dim for muted). BLUE is reserved for shortcut keys where
// separation matters. RED for emphasis/errors.
//
// Input: a manual byte-stream parser (Node's stdin in a Zellij pane is a pipe,
// not a console). Arrows + k/j/h/l navigate. Rendering is differential (no full
// screen clear) so holding a key never flickers.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------- shared state ----------
const HOME = os.homedir();
// Self-locating: sibling scripts (git-push-all, clone-all, inspector, layouts/)
// are found relative to THIS file, so the app runs correctly wherever it lives —
// its repo at ~/OneDrive/desktop/projects/claude-control-center, or the old
// ~/.local/share/claude-cc deploy. No hard-coded install path any more.
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
function stateRoot() { return path.join(HOME, '.claude', 'state', 'cc'); }
function agentsDir() { return path.join(stateRoot(), 'agents'); }
function subagentsRootDir() { return path.join(stateRoot(), 'subagents'); }
function syncFile() { return path.join(stateRoot(), 'sync.json'); }
function appDir() { return APP_DIR; }
function inspectorPath() { return path.join(appDir(), 'inspector.mjs'); }
function gitPushPath() { return path.join(appDir(), 'git-push-all.mjs'); }
function cloneAllPath() { return path.join(appDir(), 'clone-all.mjs'); }
// The claude-N.kdl files are TEMPLATES containing the token {{APP}} wherever they
// reference a sibling script. We render the token to the live APP_DIR at launch
// and write the result to the state dir, so the agent tabs work no matter where
// this app folder lives — no stale hard-coded install path baked into the layout.
function layoutPath(n) {
  const tmpl = path.join(appDir(), 'layouts', 'claude-' + n + '.kdl');
  const genDir = path.join(stateRoot(), 'gen');
  const outFile = path.join(genDir, 'claude-' + n + '.kdl');
  try {
    let s = fs.readFileSync(tmpl, 'utf8');
    s = s.split('{{APP}}').join(appDir().replace(/\\/g, '/'));
    fs.mkdirSync(genDir, { recursive: true });
    fs.writeFileSync(outFile, s, 'utf8');
    return outFile.replace(/\\/g, '/');
  } catch {
    return tmpl.replace(/\\/g, '/');   // fallback: use the template as-is
  }
}
const AGENT_STALE_MS = 120 * 1000;

function ensureStateRoot() { try { fs.mkdirSync(stateRoot(), { recursive: true }); } catch { /* */ } }

function readSync() {
  try { return JSON.parse(fs.readFileSync(syncFile(), 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}
function writeSync(patch) {
  try {
    const cur = readSync();
    const next = Object.assign({}, cur, patch);
    fs.writeFileSync(syncFile(), JSON.stringify(next), 'utf8');
  } catch { /* best effort */ }
}

// ---------- ANSI ----------
const ESC = '\x1b';
const ALT_ON = ESC + '[?1049h';
const ALT_OFF = ESC + '[?1049l';
const CURSOR_HIDE = ESC + '[?25l';
const CURSOR_SHOW = ESC + '[?25h';
const HOME_POS = ESC + '[H';
const CLR_EOL = ESC + '[K';
const CLR_BELOW = ESC + '[J';
function sgr(c) { return ESC + '[' + c + 'm'; }
const RESET = sgr(0);
const BOLD = sgr(1);
const DIM = sgr(2);
const GREEN = sgr(32);
const BGREEN = sgr(92);
const DGREEN = sgr(2) + sgr(32);   // muted green (dividers, files, hints)
const BBLUE = sgr(94);             // keys only
const RED = sgr(31);
const BRED = sgr(91);
const REV = sgr(7);                // reverse video — the unmistakable selection bar

function hdr(s) { return BOLD + BGREEN + s + RESET; }     // section header = bold bright green
function keyc(s) { return BOLD + BBLUE + '[' + s + ']' + RESET; } // a shortcut key (blue)

// ---------- text utils ----------
function asciiSafe(s) { if (s == null) return ''; return String(s).replace(/[^\x20-\x7e]/g, '?'); }
function truncate(s, n) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, n);
  return s.slice(0, n - 1) + '~';
}
function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function padLeft(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s; }

function termCols() { return (process.stdout.columns && process.stdout.columns > 0) ? process.stdout.columns : 80; }
function termRows() { return (process.stdout.rows && process.stdout.rows > 0) ? process.stdout.rows : 24; }

// ---------- directories ----------
function defaultRoot() {
  const cand = path.join(HOME, 'OneDrive', 'desktop', 'projects');
  try { if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return cand; } catch { /* */ }
  const cand2 = path.join(HOME, 'desktop', 'projects');
  try { if (fs.existsSync(cand2) && fs.statSync(cand2).isDirectory()) return cand2; } catch { /* */ }
  return HOME;
}
function initialRoot() {
  const envRoot = process.env.CC_ROOT;
  if (envRoot) { try { if (fs.existsSync(envRoot) && fs.statSync(envRoot).isDirectory()) return path.resolve(envRoot); } catch { /* */ } }
  return defaultRoot();
}

// ---------- state ----------
const state = {
  cwd: initialRoot(),
  entries: [],
  dirSel: 0,
  count: 1,
  focus: 'dirs',
  subSel: 0,
  subParents: [],
  status: '',
  statusKind: 'info',
  busy: false,
  sys: null,
  sync: readSync(),
  showHelp: false,   // ? toggles a full-screen plain-English help overlay
  prompt: null,      // when set ('newfolder'), the status line becomes a text input
  promptValue: '',   // the characters typed so far in that input
  autoSync: false,   // a silent background repo-sync is running (started at launch)
};

function loadEntries() {
  let list = [];
  try {
    const names = fs.readdirSync(state.cwd, { withFileTypes: true });
    for (const d of names) {
      let isDir = false;
      try {
        isDir = d.isDirectory();
        if (!isDir && d.isSymbolicLink()) isDir = fs.statSync(path.join(state.cwd, d.name)).isDirectory();
      } catch { isDir = false; }
      list.push({ name: d.name, isDir });
    }
  } catch (e) { list = []; setStatus('Cannot read directory: ' + asciiSafe(e && e.message), 'error'); }
  list.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : (a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0);
  });
  state.entries = list;
  if (state.dirSel >= state.entries.length) state.dirSel = Math.max(0, state.entries.length - 1);
  if (state.dirSel < 0) state.dirSel = 0;
}

function setStatus(msg, kind) { state.status = msg || ''; state.statusKind = kind || 'info'; }

// ---------- agents gauges ----------
function readFreshestAgent() {
  let best = null, dirents;
  try { dirents = fs.readdirSync(agentsDir()); } catch { return null; }
  const now = Date.now();
  for (const f of dirents) {
    if (!f.endsWith('.json')) continue;
    let obj;
    try { obj = JSON.parse(fs.readFileSync(path.join(agentsDir(), f), 'utf8').replace(/^﻿/, '')); } catch { continue; }
    const updatedAt = typeof obj.updatedAt === 'number' ? obj.updatedAt : 0;
    const updMs = updatedAt > 1e12 ? updatedAt : updatedAt * 1000;
    if (now - updMs > AGENT_STALE_MS) continue;
    if (!best || updMs > best._updMs) { obj._updMs = updMs; best = obj; }
  }
  return best;
}
function fmtCountdown(resetsAt) {
  if (resetsAt == null) return '';
  const secAt = resetsAt > 1e12 ? Math.floor(resetsAt / 1000) : resetsAt;
  let d = secAt - Math.floor(Date.now() / 1000);
  if (d <= 0) return 'resets now';
  const h = Math.floor(d / 3600); d -= h * 3600;
  const m = Math.floor(d / 60); const s = d - m * 60;
  if (h > 0) return 'resets in ' + h + 'h' + (m < 10 ? '0' : '') + m + 'm';
  if (m > 0) return 'resets in ' + m + 'm' + (s < 10 ? '0' : '') + s + 's';
  return 'resets in ' + s + 's';
}
function relAgo(ms) {
  if (!ms || typeof ms !== 'number') return 'never';
  let d = Math.floor((Date.now() - ms) / 1000);
  if (d < 0) d = 0;
  if (d < 60) return d + 's ago';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

// Gauge bar: green fill (red when high), dim-green empty, green brackets. No blue, no fill bg.
function bar(pct, width) {
  if (pct == null || isNaN(pct)) return GREEN + '[' + RESET + DGREEN + '-'.repeat(width) + RESET + GREEN + ']' + RESET;
  let p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  const fillCol = p >= 85 ? BRED : GREEN;
  return GREEN + '[' + RESET + fillCol + '#'.repeat(filled) + RESET + DGREEN + '-'.repeat(width - filled) + RESET + GREEN + ']' + RESET;
}

// ---------- system stats ----------
let prevCpu = null;
function cpuPercent() {
  const cpus = os.cpus() || [];
  let idle = 0, total = 0;
  for (const c of cpus) { for (const t in c.times) total += c.times[t]; idle += c.times.idle; }
  if (!prevCpu) { prevCpu = { idle, total }; return null; }
  const di = idle - prevCpu.idle, dt = total - prevCpu.total;
  prevCpu = { idle, total };
  if (dt <= 0) return null;
  return Math.max(0, Math.min(100, 100 * (1 - di / dt)));
}
let gpuExe;
function findGpuExe() {
  if (gpuExe !== undefined) return gpuExe;
  const cands = ['nvidia-smi', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe')];
  for (const c of cands) {
    try { const r = spawnSync(c, ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 2500 }); if (!r.error && r.status === 0) { gpuExe = c; return gpuExe; } } catch { /* */ }
  }
  gpuExe = null; return gpuExe;
}
function sampleGpu() {
  const exe = findGpuExe();
  if (!exe) return null;
  try {
    const r = spawnSync(exe, ['--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 2500 });
    if (r.error || r.status !== 0) return null;
    const parts = ((r.stdout || '').trim().split('\n')[0] || '').split(',').map((x) => parseFloat(x.trim()));
    if (parts.length < 3 || isNaN(parts[0])) return null;
    return { util: parts[0], memUsed: parts[1], memTot: parts[2], temp: parts[3] };
  } catch { return null; }
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function two(n) { return (n < 10 ? '0' : '') + n; }
let sysTick = 0, gpuCache = null;
function sampleSystem() {
  const now = new Date();
  const date = {
    pretty: DOW[now.getDay()] + '  ' + MON[now.getMonth()] + ' ' + two(now.getDate()) + ', ' + now.getFullYear(),
    hms: two(now.getHours()) + ':' + two(now.getMinutes()) + ':' + two(now.getSeconds()),
  };
  const cpu = cpuPercent();
  const totMem = os.totalmem(), freeMem = os.freemem();
  const memPct = totMem > 0 ? 100 * (totMem - freeMem) / totMem : null;
  let disk = null;
  try {
    const root = path.parse(defaultRoot()).root || 'C:\\';
    const st = fs.statfsSync(root);
    const tot = st.blocks * st.bsize, free = st.bfree * st.bsize, avail = st.bavail * st.bsize;
    disk = { pct: tot > 0 ? 100 * (tot - free) / tot : null, freeGB: avail / 1e9, totGB: tot / 1e9 };
  } catch { disk = null; }
  if (sysTick % 5 === 0) gpuCache = sampleGpu();
  sysTick++;
  state.sys = { date, cpu, memPct, memUsedGB: (totMem - freeMem) / 1e9, memTotGB: totMem / 1e9, disk, gpu: gpuCache };
}

// ---------- subagents ----------
function scanSubagents() {
  const parents = [];
  let pdirs;
  try { pdirs = fs.readdirSync(subagentsRootDir(), { withFileTypes: true }); } catch { state.subParents = []; if (state.subSel !== 0) state.subSel = 0; return; }
  for (const pd of pdirs) {
    if (!pd.isDirectory()) continue;
    const parentId = pd.name, pdir = path.join(subagentsRootDir(), parentId);
    let files;
    try { files = fs.readdirSync(pdir); } catch { continue; }
    let running = 0, total = 0, lastLabel = '';
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let obj;
      try { obj = JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8').replace(/^﻿/, '')); } catch { continue; }
      total++;
      if (obj && obj.status === 'running') { running++; if (obj.label) lastLabel = obj.label; else if (obj.agentType) lastLabel = obj.agentType; }
    }
    if (running > 0) parents.push({ parentId, running, total, label: lastLabel });
  }
  parents.sort((a, b) => (a.parentId < b.parentId ? -1 : 1));
  state.subParents = parents;
  if (state.subSel >= parents.length) state.subSel = Math.max(0, parents.length - 1);
  if (state.subSel < 0) state.subSel = 0;
  // Never let focus rest on an empty subagents list — that is the trap where the
  // arrow keys look "dead" (they ARE working, the list is just empty). Bounce
  // focus back to the folder list so arrows always visibly do something.
  if (parents.length === 0 && state.focus === 'subagents') state.focus = 'dirs';
}

// ---------- actions ----------
function enterDir() {
  const e = state.entries[state.dirSel];
  if (!e || !e.isDir) return;
  const next = path.join(state.cwd, e.name);
  try { if (fs.statSync(next).isDirectory()) { state.cwd = next; state.dirSel = 0; loadEntries(); setStatus('', 'info'); } }
  catch (err) { setStatus('Cannot enter: ' + asciiSafe(err && err.message), 'error'); }
}
function parentDir() {
  const parent = path.dirname(state.cwd);
  if (parent && parent !== state.cwd) {
    const prevBase = path.basename(state.cwd);
    state.cwd = parent; state.dirSel = 0; loadEntries();
    const idx = state.entries.findIndex((x) => x.name === prevBase);
    if (idx >= 0) state.dirSel = idx;
    setStatus('', 'info');
  }
}
// Where Enter launches agents: the HIGHLIGHTED entry. If the bar is on a folder,
// agents open INSIDE that folder; if it is on a file (or the list is empty),
// agents open in the current folder that holds it (you can't cd into a file).
// To target the current folder itself, go up a level so it becomes the highlight.
function launchTarget() {
  const e = state.entries[state.dirSel];
  if (e && e.isDir) return path.join(state.cwd, e.name);
  return state.cwd;
}
// ---------- fork-bomb guard ----------
// launch() spawns up to 8 `claude` panes per call. With no limiter, a burst of
// synthetic Enter events — a stuck key, or a mis-parsed terminal query-reply —
// spawns agents without bound. That is the failure that once opened "a million"
// Claude instances and crashed the machine. Two independent brakes prevent it:
//   1. rate limit  — at most one launch per LAUNCH_MIN_INTERVAL_MS, so a flood of
//      Enters collapses to a single launch.
//   2. absolute cap — a single Home session may ever spawn at most MAX_SESSION_PANES
//      panes, so even slow repeats can't run away.
const LAUNCH_MIN_INTERVAL_MS = 1500;
const MAX_SESSION_PANES = 24;
const launchGuard = { lastAt: 0, panes: 0 };
// Pure decision (no side effects, no clock) so it is unit-testable: pass the
// current time and the number of panes requested. Returns {ok} or {ok:false,reason}.
function checkLaunchAllowed(now, requested, st = launchGuard) {
  if (now - st.lastAt < LAUNCH_MIN_INTERVAL_MS) return { ok: false, reason: 'too-fast' };
  if (st.panes + requested > MAX_SESSION_PANES) return { ok: false, reason: 'cap' };
  return { ok: true };
}

function launch() {
  const n = state.count, dir = launchTarget(), name = path.basename(dir) || dir;
  const now = Date.now();
  const gate = checkLaunchAllowed(now, n);
  if (!gate.ok) {
    setStatus(gate.reason === 'too-fast'
      ? 'Launch ignored: too many launches too fast -- wait a moment, then press Enter.'
      : 'Launch blocked: this dashboard has already opened ' + launchGuard.panes + ' agent panes (cap ' + MAX_SESSION_PANES + '). Reopen the dashboard for a fresh budget.',
      'error');
    return;
  }
  // Stamp the time BEFORE spawning so a failed/slow spawn still rate-limits the next press.
  launchGuard.lastAt = now;
  const args = ['action', 'new-tab', '--layout', layoutPath(n), '--cwd', dir, '--name', name];
  let res;
  try { res = spawnSync('zellij', args, { encoding: 'utf8' }); }
  catch (e) { setStatus('Launch failed: ' + asciiSafe(e && e.message), 'error'); return; }
  if (res.error) { setStatus(res.error.code === 'ENOENT' ? 'zellij not found on PATH' : 'Launch error: ' + asciiSafe(res.error.message), 'error'); return; }
  if (res.status !== 0) { setStatus('zellij returned error: ' + truncate(asciiSafe((res.stderr || res.stdout || '').toString().trim().split('\n').pop() || ''), 60), 'error'); return; }
  launchGuard.panes += n;   // count only panes that actually spawned
  setStatus('Launched ' + n + ' agent' + (n === 1 ? '' : 's') + ' in ' + asciiSafe(name) + ' (switch back with Alt+[ )', 'ok');
}
function gitPush() {
  // Sync EVERYTHING under the projects root (not just the folder you're browsing)
  // so [g] always means "upload all my committed work", matching [c].
  const root = defaultRoot();
  state.busy = true; setStatus('PUSH: uploading committed work to GitHub (newer cloud changes are never overwritten)...', 'info'); render();
  let res;
  try { res = spawnSync('node', [gitPushPath(), root], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); }
  catch (e) { state.busy = false; setStatus('push failed to spawn: ' + asciiSafe(e && e.message), 'error'); return; }
  state.busy = false;
  if (res.error) { setStatus('push spawn error', 'error'); return; }
  let parsed = null;
  try { parsed = JSON.parse((res.stdout || '').toString().trim()); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.repos)) { setStatus('push: unexpected output', 'error'); return; }
  const pushed = parsed.repos.filter((r) => r.pushed).length;
  const errs = parsed.repos.filter((r) => r.error).length;
  state.sync.lastPushAt = Date.now();
  writeSync({ lastPushAt: state.sync.lastPushAt });
  const blocked = parsed.repos.filter((r) => r.error && /\b(fetch first|non-fast-forward|rejected|behind)\b/i.test(String(r.error))).length;
  let msg = pushed === 0 ? 'PUSH done: nothing new to upload (already up to date)'
    : 'PUSH done: uploaded ' + pushed + ' repo' + (pushed === 1 ? '' : 's') + ' to GitHub';
  if (blocked) msg += '  -  ' + blocked + ' skipped (GitHub has newer changes; press [c] to pull first, nothing was overwritten)';
  else if (errs) msg += '  -  ' + errs + ' error(s)';
  setStatus(msg, (errs && !blocked) ? 'error' : 'ok');
}
function cloneAll() {
  const root = defaultRoot();
  state.busy = true; setStatus('PULL: downloading everything from GitHub (your local work is never deleted)...', 'info'); render();
  let res;
  try { res = spawnSync('node', [cloneAllPath(), root], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
  catch (e) { state.busy = false; setStatus('clone failed to spawn: ' + asciiSafe(e && e.message), 'error'); return; }
  state.busy = false;
  if (res.error) { setStatus('clone spawn error', 'error'); return; }
  let parsed = null;
  try { parsed = JSON.parse((res.stdout || '').toString().trim()); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.repos)) { setStatus('clone: ' + (parsed && parsed.error ? truncate(asciiSafe(parsed.error), 70) : 'unexpected output'), 'error'); return; }
  const cloned = parsed.repos.filter((r) => r.action === 'cloned').length;
  const updated = parsed.repos.filter((r) => r.action === 'updated').length;
  const errs = parsed.repos.filter((r) => r.action === 'error').length;
  state.sync.lastCloneAt = Date.now();
  writeSync({ lastCloneAt: state.sync.lastCloneAt });
  const parts = [];
  if (cloned) parts.push('downloaded ' + cloned + ' new');
  if (updated) parts.push('updated ' + updated);
  const body = parts.length ? parts.join(', ') : 'everything already up to date';
  setStatus('PULL done: ' + body + '  (' + parsed.repos.length + ' repo' + (parsed.repos.length === 1 ? '' : 's') + ' checked)' + (errs ? ', ' + errs + ' error(s)' : ''), errs ? 'error' : 'ok');
}
// Silent, windowless repo sync kicked off when Home opens, so pressing the global
// hotkey shows the control center INSTANTLY and the "pull everything from GitHub"
// work happens in the background (matching what [c] PULL does, same safety: clone
// missing + fast-forward, never discard local work). No console window, never
// blocks the UI. Result is folded into the SYNC section when it finishes.
function startBackgroundSync() {
  if (state.autoSync) return;
  const root = defaultRoot();
  let child;
  try {
    child = spawn('node', [cloneAllPath(), root], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return; }
  state.autoSync = true;
  setStatus('Auto-sync: pulling the latest from GitHub in the background (your local work is never deleted)...', 'info');
  let out = '';
  try { child.stdout.on('data', (d) => { out += d.toString(); }); } catch { /* */ }
  child.on('error', () => { state.autoSync = false; setStatus('', 'info'); try { redraw(); } catch { /* */ } });
  child.on('close', () => {
    state.autoSync = false;
    let parsed = null;
    try { parsed = JSON.parse((out || '').trim()); } catch { parsed = null; }
    if (parsed && Array.isArray(parsed.repos)) {
      const cloned = parsed.repos.filter((r) => r.action === 'cloned').length;
      const updated = parsed.repos.filter((r) => r.action === 'updated').length;
      state.sync.lastCloneAt = Date.now();
      writeSync({ lastCloneAt: state.sync.lastCloneAt });
      const parts = [];
      if (cloned) parts.push('downloaded ' + cloned + ' new');
      if (updated) parts.push('updated ' + updated);
      setStatus('Auto-sync done: ' + (parts.length ? parts.join(', ') : 'everything already up to date') +
        '  (' + parsed.repos.length + ' repo' + (parsed.repos.length === 1 ? '' : 's') + ' checked)', 'ok');
    } else {
      setStatus('', 'info');
    }
    try { redraw(); } catch { /* */ }
  });
  try { child.unref(); } catch { /* */ }
}

// Create a new folder INSIDE the folder currently being viewed (state.cwd). Driven
// by the small text-input prompt (started with [n]); commit with Enter.
function createFolder(rawName) {
  const name = String(rawName == null ? '' : rawName).trim();
  state.prompt = null; state.promptValue = '';
  if (!name) { setStatus('New folder cancelled.', 'info'); return; }
  if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
    setStatus('Invalid name. A folder name cannot contain  \\ / : * ? " < > |', 'error'); return;
  }
  const target = path.join(state.cwd, name);
  try {
    if (fs.existsSync(target)) { setStatus('A folder named "' + asciiSafe(name) + '" already exists here.', 'error'); return; }
    fs.mkdirSync(target);
    loadEntries();
    state.focus = 'dirs';
    const idx = state.entries.findIndex((e) => e.isDir && e.name === name);
    if (idx >= 0) state.dirSel = idx;
    setStatus('Created folder "' + asciiSafe(name) + '" in ' + asciiSafe(path.basename(state.cwd) || state.cwd) + '.', 'ok');
  } catch (err) {
    setStatus('Could not create folder: ' + asciiSafe(err && err.message), 'error');
  }
}

function openInspector() {
  const p = state.subParents[state.subSel];
  if (!p) { setStatus('No subagent group selected', 'error'); return; }
  const args = ['action', 'new-pane', '--floating', '--close-on-exit', '--', 'node', inspectorPath(), p.parentId];
  let res;
  try { res = spawnSync('zellij', args, { encoding: 'utf8' }); }
  catch (e) { setStatus('Inspector failed: ' + asciiSafe(e && e.message), 'error'); return; }
  if (res.error || res.status !== 0) { setStatus('Could not open inspector', 'error'); return; }
  setStatus('Opened inspector for ' + truncate(asciiSafe(p.parentId), 16), 'ok');
}

// ---------- rendering ----------
function out(s) { process.stdout.write(s); }
function leftRight(leftVisLen, leftColored, rightVisLen, rightColored, W) {
  const gap = Math.max(1, W - leftVisLen - rightVisLen);
  return leftColored + ' '.repeat(gap) + rightColored;
}

function render() {
  const cols = termCols();
  const W = Math.max(54, Math.min(cols, 100));
  if (state.showHelp) { renderHelp(W); return; }
  const lines = [];
  const sep = DGREEN + '-'.repeat(W) + RESET;   // dividers: muted green (not blue)

  const sys = state.sys || {};
  const dt = sys.date || { pretty: '', hms: '' };

  // Header: title left (bright green), day/date/time right (green, not blue).
  const titleL = 'CLAUDE CONTROL CENTER';
  const rightVis = dt.pretty + '   ' + dt.hms;
  lines.push(leftRight(titleL.length, BOLD + BGREEN + titleL + RESET, rightVis.length, GREEN + dt.pretty + RESET + '   ' + BOLD + BGREEN + dt.hms + RESET, W));
  lines.push(sep);

  // Folder
  lines.push(BOLD + BGREEN + 'Folder ' + RESET + GREEN + truncate(asciiSafe(state.cwd), W - 8) + RESET);

  // Directory — the header doubles as the FOCUS indicator: a reverse-video badge
  // when the arrow keys are controlling this list, dim otherwise. No more guessing
  // where the keys go.
  const dirFocused = state.focus === 'dirs';
  if (dirFocused) lines.push(REV + BOLD + BGREEN + pad(' FOLDERS  - the arrow keys are controlling THIS list', W) + RESET);
  else lines.push('  ' + DGREEN + 'FOLDERS   (press Tab to bring the arrow keys here)' + RESET);
  // The folder entries are sized + spliced in LAST (see end of render) so the list
  // grows to fill whatever vertical space the rest of the dashboard leaves free.
  const folderInsertAt = lines.length;
  lines.push(sep);

  // Launch — targets the HIGHLIGHTED folder (matches what Enter does). Spelled out
  // as two explicit steps because "pick a number AND press Enter" was unclear.
  const launchName = path.basename(launchTarget()) || launchTarget();
  lines.push(hdr('LAUNCH') + '   ' + keyc('Enter') + GREEN + ' opens ' + RESET + BOLD + BGREEN + state.count + RESET +
    GREEN + ' Claude agent' + (state.count === 1 ? '' : 's') + ' in: ' + RESET + BGREEN + truncate(asciiSafe(launchName), 22) + RESET);
  lines.push('  ' + GREEN + 'Step 1: press a number ' + RESET + keyc('1') + GREEN + '-' + RESET + keyc('8') + GREEN + ' = how many' + RESET +
    DGREEN + ' (now: ' + RESET + BOLD + BGREEN + state.count + RESET + DGREEN + ')' + RESET + GREEN + '    Step 2: press ' + RESET + keyc('Enter'));
  lines.push('  ' + DGREEN + 'in a tab, switch: ' + RESET + keyc('Alt+arrows') + GREEN + ' between agents' + RESET + DGREEN + ' . ' + RESET +
    keyc('Alt+[') + keyc('Alt+]') + GREEN + ' between tabs' + RESET + DGREEN + '  (focused agent is highlighted)' + RESET);
  lines.push('  ' + DGREEN + 'in a tab, manage: ' + RESET + keyc('Alt+a') + GREEN + ' add' + RESET + DGREEN + ' . ' + RESET +
    keyc('Ctrl+Alt+w') + GREEN + ' close agent' + RESET + DGREEN + ' . ' + RESET + keyc('Ctrl+Alt+q') + GREEN + ' close whole tab' + RESET);
  lines.push(sep);

  // Sync — the GitHub buttons. Plain-English, with the safety promise spelled out.
  lines.push(hdr('GITHUB SYNC') + DGREEN + '   (keeps this PC and your other devices in step)' + RESET);
  lines.push('  ' + keyc('g') + ' ' + BOLD + BGREEN + 'PUSH' + RESET + GREEN + ' - upload my committed work' + RESET +
    DGREEN + '  (never overwrites newer cloud changes)' + RESET + '   ' + DGREEN + 'last: ' + RESET + BGREEN + relAgo(state.sync.lastPushAt) + RESET);
  lines.push('  ' + keyc('c') + ' ' + BOLD + BGREEN + 'PULL' + RESET + GREEN + ' - download everything ' + RESET +
    DGREEN + '  (never deletes your local work)' + RESET + '        ' + DGREEN + (state.autoSync ? '' : 'last: ') + RESET +
    BGREEN + (state.autoSync ? 'syncing now...' : relAgo(state.sync.lastCloneAt)) + RESET);
  lines.push(sep);

  // Session limits
  lines.push(hdr('SESSION LIMITS'));
  const a = readFreshestAgent();
  const rl = a && a.rateLimits ? a.rateLimits : null;
  const five = rl && rl.fiveHour ? rl.fiveHour : null;
  const week = rl && rl.sevenDay ? rl.sevenDay : null;
  const barW = 22;
  function gaugeLine(label, gauge) {
    if (!gauge || gauge.usedPct == null) return '  ' + GREEN + pad(label, 7) + RESET + ' ' + bar(null, barW) + '   ' + DGREEN + '--' + RESET;
    const pct = Math.round(gauge.usedPct), cd = fmtCountdown(gauge.resetsAt), col = pct >= 85 ? BRED : GREEN;
    return '  ' + GREEN + pad(label, 7) + RESET + ' ' + bar(gauge.usedPct, barW) + ' ' + col + padLeft(pct + '%', 4) + RESET + (cd ? '  ' + DGREEN + cd + RESET : '');
  }
  lines.push(gaugeLine('5-hour', five));
  lines.push(gaugeLine('Weekly', week));
  if (!a) lines.push('  ' + DGREEN + '(no agent has reported yet -- shows after the first API call)' + RESET);
  lines.push(sep);

  // Subagents
  const subFocused = state.focus === 'subagents';
  if (subFocused) lines.push(REV + BOLD + BGREEN + pad(' SUBAGENTS  - arrow keys are here; Enter inspects, Tab back to Folders', W) + RESET);
  else lines.push('  ' + hdr('SUBAGENTS') + (state.subParents.length ? DGREEN + '   (Tab to inspect)' + RESET : ''));
  if (state.subParents.length === 0) {
    lines.push('    ' + DGREEN + '(none running -- this list fills only when an agent spawns subagents)' + RESET);
  } else {
    for (let i = 0; i < Math.min(state.subParents.length, 3); i++) {
      const p = state.subParents[i], sel = (i === state.subSel && subFocused);
      const text = truncate(asciiSafe(p.parentId), 14) + '  ' + p.running + '/' + p.total + ' running' + (p.label ? '  ' + truncate(asciiSafe(p.label), 26) : '');
      if (sel) lines.push(REV + BOLD + BGREEN + pad('  > ' + text, W) + RESET);
      else lines.push('    ' + GREEN + text + RESET);
    }
  }
  lines.push(sep);

  // System (kept near the bottom — handy, not important)
  lines.push(hdr('SYSTEM'));
  function statLine(label, pct, suffix) {
    const col = (pct != null && pct >= 85) ? BRED : GREEN;
    const pctTxt = pct == null ? ' n/a' : padLeft(Math.round(pct) + '%', 4);
    return '  ' + GREEN + pad(label, 5) + RESET + ' ' + bar(pct, barW) + ' ' + col + pctTxt + RESET + (suffix ? '  ' + DGREEN + suffix + RESET : '');
  }
  lines.push(statLine('CPU', sys.cpu == null ? null : sys.cpu, ''));
  lines.push(statLine('MEM', sys.memPct == null ? null : sys.memPct, sys.memUsedGB != null ? sys.memUsedGB.toFixed(1) + ' / ' + sys.memTotGB.toFixed(1) + ' GB' : ''));
  lines.push(sys.disk ? statLine('DISK', sys.disk.pct, Math.round(sys.disk.freeGB) + ' free / ' + Math.round(sys.disk.totGB) + ' GB') : statLine('DISK', null, ''));
  if (sys.gpu) { const g = sys.gpu; lines.push(statLine('GPU', g.util, (g.memUsed / 1024).toFixed(1) + ' / ' + (g.memTot / 1024).toFixed(1) + ' GB' + (g.temp ? '   ' + g.temp + 'C' : ''))); }
  else lines.push(statLine('GPU', null, 'no nvidia-smi'));
  lines.push(sep);

  // Status line — or the new-folder text input when that prompt is active.
  if (state.prompt === 'newfolder') {
    lines.push(BOLD + BGREEN + 'New folder in ' + RESET + BGREEN + truncate(asciiSafe(path.basename(state.cwd) || state.cwd), 18) + RESET +
      BOLD + BGREEN + ': ' + RESET + GREEN + asciiSafe(state.promptValue) + RESET + REV + ' ' + RESET +
      DGREEN + '   ' + keyc('Enter') + ' create  .  empty + ' + keyc('Enter') + ' cancel' + RESET);
  } else if (state.status) {
    let col = GREEN;
    if (state.statusKind === 'error') col = RED;
    else if (state.statusKind === 'ok') col = BGREEN;
    lines.push(col + truncate(asciiSafe(state.status), W - 1) + RESET);
  } else lines.push('');

  // Cheatsheet — the one key reference. Blue keys + blue | separators (separation
  // matters here); green labels/descriptions. Press ? for the full plain-English help.
  const C = BBLUE + ' | ' + RESET;
  lines.push(sep);
  lines.push(BOLD + BGREEN + pad('MOVE', 7) + RESET + keyc('Up') + keyc('Dn') + GREEN + ' move bar' + RESET + C + keyc('->') + GREEN + ' open folder' + RESET + C + keyc('<-') + GREEN + ' back' + RESET + C + keyc('Tab') + GREEN + ' switch list' + RESET);
  lines.push(BOLD + BGREEN + pad('DO', 7) + RESET + keyc('1') + GREEN + '-' + RESET + keyc('8') + GREEN + ' #agents' + RESET + C + keyc('Enter') + GREEN + ' launch' + RESET + C + keyc('n') + GREEN + ' new folder' + RESET + C + keyc('g') + GREEN + ' push' + RESET + C + keyc('c') + GREEN + ' pull' + RESET + C + keyc('?') + GREEN + ' help' + RESET + C + keyc('q') + GREEN + ' quit' + RESET);
  lines.push(BOLD + BGREEN + pad('WINDOW', 7) + RESET + keyc('Alt+arrows') + GREEN + ' agent' + RESET + C + keyc('Alt+[') + keyc('Alt+]') + GREEN + ' tab' + RESET + C + keyc('Ctrl+Alt+w') + GREEN + ' close agent' + RESET + C + keyc('Ctrl+Alt+q') + GREEN + ' close tab' + RESET);

  // Fill the leftover vertical space with folder entries, then splice them under
  // the FOLDERS header. Measuring the rest of the dashboard (instead of a fixed
  // constant) keeps the cheat sheet pinned at the bottom however tall the other
  // sections are, and self-corrects on resize / when subagents appear.
  {
    const folderLines = [];
    if (state.entries.length === 0) {
      folderLines.push('    ' + DGREEN + '(this folder has no sub-folders)' + RESET);
    } else {
      const all = state.entries.length;
      const avail = Math.max(3, termRows() - 1 - lines.length);   // -1: leave the bottom row clear
      let start = 0, count = all, indicator = false;
      if (all > avail) {
        count = avail - 1;                                        // reserve a row for the (N of M) line
        indicator = true;
        if (state.dirSel >= count) start = state.dirSel - count + 1;
        if (start > all - count) start = all - count;            // don't scroll past the end
        if (start < 0) start = 0;
      }
      const end = Math.min(all, start + count);
      for (let i = start; i < end; i++) {
        const e = state.entries[i];
        const sel = (i === state.dirSel && dirFocused);
        const label = (e.isDir ? e.name + '/' : e.name);
        if (sel) folderLines.push(REV + BOLD + BGREEN + pad('  > ' + label, W) + RESET);   // selected = full-width reverse bar
        else folderLines.push('    ' + (e.isDir ? GREEN : DGREEN) + truncate(label, W - 6) + RESET);
      }
      if (indicator) folderLines.push('    ' + DGREEN + '(' + (state.dirSel + 1) + ' of ' + all + ')' + RESET);
    }
    lines.splice(folderInsertAt, 0, ...folderLines);
  }

  // Differential frame: home cursor, clear each line to EOL, clear below at the
  // end. No full-screen [2J -> no flicker when keys repeat.
  const body = lines.map((l) => l + CLR_EOL).join('\r\n');
  out(HOME_POS + body + '\r\n' + CLR_BELOW);
}

// Full-screen plain-English help. Toggled with ? ; any key closes it.
function renderHelp(W) {
  const sep = DGREEN + '-'.repeat(W) + RESET;
  const L = [];
  const k = (s) => BOLD + BBLUE + s + RESET;
  const h = (s) => BOLD + BGREEN + s + RESET;
  const g = (s) => GREEN + s + RESET;
  L.push(h('HOW TO USE THE CLAUDE CONTROL CENTER') + DGREEN + '    (press any key to close this help)' + RESET);
  L.push(sep);
  L.push(h('1. The very basics'));
  L.push('   ' + g('The green bar shows what is selected. Move it with the ') + k('Up') + g(' and ') + k('Down') + g(' arrow keys.'));
  L.push('   ' + g('A bright reversed bar near the top tells you which list the arrows control.'));
  L.push('   ' + g('If a list looks "dead", the arrows are on the OTHER list -- press ') + k('Tab') + g(' to switch.'));
  L.push('');
  L.push(h('2. Moving around your folders'));
  L.push('   ' + k('Up') + ' / ' + k('Down') + g('   move the selection bar up and down'));
  L.push('   ' + k('Right') + g(' (or ') + k('l') + g(')   open the highlighted folder (go INTO it)'));
  L.push('   ' + k('Left') + g('  (or ') + k('h') + g(')   go back OUT to the parent folder'));
  L.push('');
  L.push(h('3. Launching and managing Claude agents'));
  L.push('   ' + g('Press a number ') + k('1') + g('-') + k('8') + g(' to choose how many agents, then press ') + k('Enter') + g('.'));
  L.push('   ' + g('They open in a new window (tab) that runs in the folder you have selected.'));
  L.push('   ' + g('Each agent has a titled border ("Claude 1", "Claude 2", ...); the one you are'));
  L.push('   ' + g('typing into is highlighted. Move between them with ') + k('Alt+Arrow keys') + g('.'));
  L.push('   ' + g('Switch between tabs (windows) with ') + k('Alt+[') + g(' and ') + k('Alt+]') + g('.'));
  L.push('   ' + g('Add another Claude: ') + k('Alt+a') + g('.   Close one agent: ') + k('Ctrl+Alt+w') + g('.   Close the whole tab: ') + k('Ctrl+Alt+q') + g('.'));
  L.push('   ' + g('The green shortcut bar at the top of every agent window lists these too.'));
  L.push('');
  L.push(h('4. Making a new project folder'));
  L.push('   ' + g('Press ') + k('n') + g(', type a name, and press ') + k('Enter') + g(' to create a folder inside the one you are'));
  L.push('   ' + g('viewing now. Then press ') + k('Enter') + g(' on it to launch agents in your new project.'));
  L.push('');
  L.push(h('5. GitHub sync  (keeps all your devices in step)'));
  L.push('   ' + k('g') + g(' = ') + h('PUSH') + g(': uploads your committed work to GitHub.'));
  L.push('       ' + DGREEN + 'If another device already pushed newer work, yours is skipped, NOT overwritten.' + RESET);
  L.push('       ' + DGREEN + '(If that happens, press c to pull first, then g again.)' + RESET);
  L.push('   ' + k('c') + g(' = ') + h('PULL') + g(': downloads everything from GitHub and brings repos up to date.'));
  L.push('       ' + DGREEN + 'Your local commits and unsaved changes are never deleted.' + RESET);
  L.push('');
  L.push(h('6. Quitting'));
  L.push('   ' + k('q') + g(' closes this dashboard. Your agent windows keep running.'));
  L.push(sep);
  L.push(BOLD + BGREEN + 'Press any key to go back.' + RESET);
  const body = L.map((l) => l + CLR_EOL).join('\r\n');
  out(HOME_POS + body + '\r\n' + CLR_BELOW);
}

function redraw() { scanSubagents(); render(); }

// ---------- input (manual byte-stream parser) ----------
function act(name, ch) {
  // While the help overlay is up, ANY key just closes it (and does nothing else).
  if (state.showHelp) { state.showHelp = false; setStatus('', 'info'); redraw(); return; }
  // While the new-folder text input is up, keys edit/commit/cancel it — nothing else.
  if (state.prompt === 'newfolder') {
    if (name === 'enter') { createFolder(state.promptValue); redraw(); return; }
    if (name === 'backspace') { state.promptValue = state.promptValue.slice(0, -1); redraw(); return; }
    if (name === 'cancel' || name === 'quit') { state.prompt = null; state.promptValue = ''; setStatus('New folder cancelled.', 'info'); redraw(); return; }
    if (ch != null && ch >= ' ' && ch !== '\x7f') { if (state.promptValue.length < 64) state.promptValue += ch; redraw(); return; }
    return;   // ignore arrows/tab while typing a name
  }
  if (name === 'quit') { cleanupAndExit(0); return; }
  if (name === 'enter') { if (state.focus === 'dirs') launch(); else openInspector(); redraw(); return; }
  if (name === 'tab') {
    // Only hand the arrows to the subagents list when there is actually something
    // there. Otherwise the keys would look dead — the exact confusing trap.
    if (state.focus === 'dirs') {
      if (state.subParents.length > 0) state.focus = 'subagents';
      else setStatus('No subagents are running right now -- the arrow keys stay on your folders.', 'info');
    } else state.focus = 'dirs';
    redraw(); return;
  }
  if (name === 'up') { if (state.focus === 'dirs') { if (state.dirSel > 0) state.dirSel--; } else { if (state.subSel > 0) state.subSel--; } redraw(); return; }
  if (name === 'down') { if (state.focus === 'dirs') { if (state.dirSel < state.entries.length - 1) state.dirSel++; } else { if (state.subSel < state.subParents.length - 1) state.subSel++; } redraw(); return; }
  if (name === 'right') { if (state.focus === 'dirs') enterDir(); redraw(); return; }
  if (name === 'left') { if (state.focus === 'dirs') parentDir(); redraw(); return; }
  if (ch != null) onPrintable(ch);
}
function onPrintable(ch) {
  if (/[1-8]/.test(ch)) { state.count = parseInt(ch, 10); setStatus('', 'info'); redraw(); return; }
  if (ch === '+' || ch === '=') { state.count = Math.min(8, state.count + 1); redraw(); return; }
  if (ch === '-' || ch === '_') { state.count = Math.max(1, state.count - 1); redraw(); return; }
  if (ch === 'c') { cloneAll(); redraw(); return; }
  if (ch === 'g') { gitPush(); redraw(); return; }
  if (ch === 'n') { state.prompt = 'newfolder'; state.promptValue = ''; setStatus('', 'info'); redraw(); return; }
  if (ch === '?') { state.showHelp = true; redraw(); return; }
  if (ch === 'q') { cleanupAndExit(0); return; }
  if (ch === 'k') { act('up'); return; }
  if (ch === 'j') { act('down'); return; }
  if (ch === 'h') { act('left'); return; }
  if (ch === 'l') { act('right'); return; }
  // Unbound key: do nothing (no redraw -> holding it never flickers).
}

// Pure decoder: turn a raw byte string into high-level input EVENTS, fully
// consuming (and discarding) any terminal escape / control sequence so its payload
// bytes are NEVER mistaken for keystrokes. Terminals reply to queries (primary
// device attributes `ESC[?...c`, OSC color reports `ESC]...rgb:...ST`, DCS, …) by
// writing the response onto our stdin; the old parser stripped only the leading
// ESC and replayed the rest as keys, so `rgb:` fired 'g' (PUSH) and `…c` fired 'c'
// (PULL) and froze the UI. Returns { events, rest } where `rest` is the tail of an
// as-yet-incomplete sequence (keep it and wait for the next chunk).
const ARROW = { A: 'up', B: 'down', C: 'right', D: 'left' };
function decodeInput(buf) {
  const events = [];
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const c = buf.charCodeAt(i);
    if (c === 0x1b) {                              // ESC — start of an escape sequence
      if (i + 1 >= n) break;                       // lone ESC so far — wait for more
      const c1 = buf[i + 1];
      if (c1 === '[') {                            // CSI: params 0x30-3f, intermeds 0x20-2f, final 0x40-7e
        const m = buf.slice(i).match(/^\x1b\[[\x30-\x3f]*[\x20-\x2f]*([\x40-\x7e])/);
        if (!m) break;                             // incomplete CSI — wait for the final byte
        const dir = ARROW[m[1]];                   // any non-arrow CSI (DA reports, …) is ignored
        if (dir) events.push({ kind: 'arrow', dir });
        i += m[0].length; continue;
      }
      if (c1 === 'O') {                            // SS3 (application cursor keys): ESC O <final>
        if (i + 2 >= n) break;
        const dir = ARROW[buf[i + 2]];
        if (dir) events.push({ kind: 'arrow', dir });
        i += 3; continue;
      }
      if (c1 === ']') {                            // OSC: ... (BEL | ST) — color reports etc., ignored
        const bel = buf.indexOf('\x07', i + 2);
        const st = buf.indexOf('\x1b\\', i + 2);
        let end = -1, skip = 0;
        if (bel !== -1 && (st === -1 || bel < st)) { end = bel; skip = 1; }
        else if (st !== -1) { end = st; skip = 2; }
        if (end === -1) break;                     // unterminated — wait for more
        i = end + skip; continue;
      }
      if (c1 === 'P' || c1 === 'X' || c1 === '^' || c1 === '_') {  // DCS/SOS/PM/APC ... ST — ignored
        const st = buf.indexOf('\x1b\\', i + 2);
        if (st === -1) break;
        i = st + 2; continue;
      }
      i += 2; continue;                            // other 2-byte escape (ESC =, ESC >, …) — ignored
    }
    i += 1;                                        // a concrete, non-escape key
    if (c === 0x03) { events.push({ kind: 'quit' }); continue; }
    if (c === 0x0d || c === 0x0a) { events.push({ kind: 'enter' }); continue; }
    if (c === 0x09) { events.push({ kind: 'tab' }); continue; }
    if (c === 0x7f || c === 0x08) { events.push({ kind: 'backspace' }); continue; }  // DEL / Ctrl+H
    if (c < 0x20) continue;                         // ignore other control bytes
    events.push({ kind: 'char', ch: buf[i - 1] });
  }
  return { events, rest: buf.slice(i) };
}

function applyEvent(ev) {
  if (ev.kind === 'arrow') act(ev.dir, null);
  else if (ev.kind === 'enter') act('enter');
  else if (ev.kind === 'tab') act('tab');
  else if (ev.kind === 'quit') act('quit');
  else if (ev.kind === 'backspace') act('backspace');
  else if (ev.kind === 'cancel') act('cancel');
  else if (ev.kind === 'char') act(null, ev.ch);
}
let dispatchEvent = applyEvent;                    // swappable so tests can observe without side effects

let inbuf = '';
let escFlushTimer = null;
function clearEscFlush() { if (escFlushTimer) { clearTimeout(escFlushTimer); escFlushTimer = null; } }

// Right after raw mode is enabled the terminal dumps a burst of query-responses
// (DA, OSC color reports) onto stdin. Some arrive header-less (bare `rgb:…`), so
// no parser can tell them from typed keys. They come as ONE cluster at startup, so
// we simply drop all input until the stream has been quiet for a beat. A hard cap
// in main() guarantees the keyboard always comes alive even if reports keep
// trickling. Real launches give the user far longer than this to reach for a key.
let acceptInput = false;
let settleTimer = null;
function settleInput() {
  if (acceptInput) return;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { settleTimer = null; acceptInput = true; inbuf = ''; }, 200);
}

function feed(chunk) {
  if (!acceptInput) { settleInput(); return; }     // swallow the startup report burst
  clearEscFlush();
  inbuf += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk);
  const { events, rest } = decodeInput(inbuf);
  inbuf = rest;
  for (const ev of events) dispatchEvent(ev);
  // A lingering, incomplete escape sequence (rare): drop it after a beat so its
  // bytes can never later be re-read as printable keys. A LONE Esc that lingers is
  // the physical Esc key — use it to cancel the new-folder prompt if one is open.
  if (inbuf.length && inbuf.charCodeAt(0) === 0x1b) {
    const loneEsc = inbuf.length === 1;
    escFlushTimer = setTimeout(() => {
      inbuf = ''; escFlushTimer = null;
      if (loneEsc && state.prompt) { try { dispatchEvent({ kind: 'cancel' }); } catch { /* */ } }
    }, 60);
  }
}

// ---------- lifecycle ----------
let timer = null, cleanedUp = false;
function cleanupAndExit(code) {
  if (cleanedUp) { process.exit(code); return; }
  cleanedUp = true;
  try { if (timer) clearInterval(timer); } catch { /* */ }
  try { clearEscFlush(); } catch { /* */ }
  try { if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false); } catch { /* */ }
  try { out(CURSOR_SHOW + ALT_OFF); } catch { /* */ }
  try { process.stdin.pause(); } catch { /* */ }
  process.exit(code == null ? 0 : code);
}
function tick() { try { sampleSystem(); } catch { /* */ } try { state.sync = readSync(); } catch { /* */ } redraw(); }

function main() {
  ensureStateRoot();
  loadEntries();
  out(ALT_ON + CURSOR_HIDE + ESC + '[2J' + HOME_POS);
  try { if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true); } catch { /* */ }
  try { process.stdin.resume(); } catch { /* */ }
  // Ignore the terminal's startup query-response burst, but make sure the keyboard
  // always wakes: settleInput() opens after 200ms of quiet, the hard cap after 1.5s.
  settleInput();
  setTimeout(() => { acceptInput = true; inbuf = ''; }, 1500);
  process.stdin.on('data', (chunk) => { try { feed(chunk); } catch (e) { setStatus('input error: ' + asciiSafe(e && e.message), 'error'); try { redraw(); } catch { /* */ } } });
  process.stdin.on('error', () => { /* ignore */ });
  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));
  process.stdout.on('resize', () => { try { redraw(); } catch { /* */ } });
  try { cpuPercent(); } catch { /* */ }
  sampleSystem();
  redraw();
  // System stats refresh on the 1s timer only (not on keypress) so values are
  // stable and holding a key can't make CPU/MEM jitter.
  timer = setInterval(tick, 1000);
  // The control center is now on screen; pull the latest from GitHub silently in
  // the background (no window, never blocks) so opening it is instant AND keeps
  // every repo current. Replaces the old visible startup clone window.
  try { startBackgroundSync(); } catch { /* never let sync break the UI */ }
}

// Run the TUI only when launched directly (`node home.mjs`); stay importable so
// input.test.mjs can exercise the parser without entering the alt screen.
function isDirectRun() {
  // Case-insensitive (Windows paths) so a casing quirk never wrongly suppresses
  // the TUI; on any error we default to running it (never strand a blank screen).
  try { return !!process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase(); }
  catch { return true; }
}
if (isDirectRun()) main();

// Test hooks (no effect in normal operation).
export { decodeInput, feed, checkLaunchAllowed, LAUNCH_MIN_INTERVAL_MS, MAX_SESSION_PANES };
export function __setDispatch(fn) { dispatchEvent = fn || applyEvent; }
export function __acceptInputNow() { acceptInput = true; inbuf = ''; }
export function __resetInput() { acceptInput = false; inbuf = ''; if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; } }

// Render ONE frame at a given size and return the raw output string — lets the
// layout be verified deterministically at any terminal size, with no TTY.
export function __renderFrame(rows, cols) {
  const pr = process.stdout.rows, pc = process.stdout.columns, pw = process.stdout.write;
  let buf = '';
  try {
    process.stdout.rows = rows; process.stdout.columns = cols;
    process.stdout.write = (s) => { buf += s; return true; };
    ensureStateRoot(); loadEntries(); state.sync = readSync();
    render();
  } finally {
    process.stdout.write = pw; process.stdout.rows = pr; process.stdout.columns = pc;
  }
  return buf;
}
