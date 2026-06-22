#!/usr/bin/env node
// Claude Control Center — Home TUI
// Raw-ANSI full-screen alt-screen TUI. Zero npm deps; Node built-ins only.
//
// Sections (top -> bottom):
//   - Header           : title + day / date / time on the right
//   - Folder + DIRECTORY navigator (up/down or k/j select, ->/l enter, <-/h parent)
//   - LAUNCH           : Enter opens a new window of N agents in the folder
//   - SESSION LIMITS   : 5h + weekly usage gauges (from agents/*.json)
//   - SYSTEM           : CPU / MEM / DISK / GPU gauges
//   - SUBAGENTS        : parents with running subagent children (Enter -> inspector)
//   - LAST CLONE/SYNC + LAST GIT PUSH result tables
//   - Cheatsheet footer (the single place keys are documented)
//
// Colors: black background everywhere. Blue = structure/headers/keys, green =
// content/values, red = emphasis/errors. No background-fill highlights.
//
// Input: a manual byte-stream parser (Node's stdin in a Zellij pane is a pipe,
// not a console, so setRawMode is unavailable and readline's keypress decoder
// mishandles arrow escape sequences). We parse arrows/Enter/Tab/printables
// ourselves; k/j/h/l mirror the arrows as a fallback.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// ---------- shared state contract ----------
const HOME = os.homedir();
function stateRoot() { return path.join(HOME, '.claude', 'state', 'cc'); }
function agentsDir() { return path.join(stateRoot(), 'agents'); }
function subagentsRootDir() { return path.join(stateRoot(), 'subagents'); }
function appDir() { return path.join(HOME, '.local', 'share', 'claude-cc'); }
function inspectorPath() { return path.join(appDir(), 'inspector.mjs'); }
function gitPushPath() { return path.join(appDir(), 'git-push-all.mjs'); }
function cloneAllPath() { return path.join(appDir(), 'clone-all.mjs'); }
function layoutPath(n) {
  return appDir().replace(/\\/g, '/') + '/layouts/claude-' + n + '.kdl';
}
const AGENT_STALE_MS = 120 * 1000;

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
function sgr(c) { return ESC + '[' + c + 'm'; }
const RESET = sgr(0);
const BOLD = sgr(1);
const DIM = sgr(2);
const GREEN = sgr(32);
const BGREEN = sgr(92);
const BLUE = sgr(34);        // the "good dark blue" — structure, headers, keys
const BBLUE = sgr(94);
const RED = sgr(31);
const BRED = sgr(91);

// Section header: bold blue (distinct from green content).
function hdr(s) { return BOLD + BLUE + s + RESET; }
// A key: blue bracketed text (blue on black, no fill). e.g. key('Enter').
function keyc(s) { return BOLD + BBLUE + '[' + s + ']' + RESET; }

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
function padLeft(s, n) {
  s = String(s == null ? '' : s);
  if (s.length >= n) return s.slice(0, n);
  return ' '.repeat(n - s.length) + s;
}

// ---------- terminal size ----------
function termCols() { return (process.stdout.columns && process.stdout.columns > 0) ? process.stdout.columns : 80; }
function termRows() { return (process.stdout.rows && process.stdout.rows > 0) ? process.stdout.rows : 24; }

// ---------- start directory ----------
function defaultRoot() {
  const cand = path.join(HOME, 'OneDrive', 'desktop', 'projects');
  try { if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return cand; } catch { /* */ }
  const cand2 = path.join(HOME, 'desktop', 'projects');
  try { if (fs.existsSync(cand2) && fs.statSync(cand2).isDirectory()) return cand2; } catch { /* */ }
  return HOME;
}
function initialRoot() {
  const envRoot = process.env.CC_ROOT;
  if (envRoot) {
    try { if (fs.existsSync(envRoot) && fs.statSync(envRoot).isDirectory()) return path.resolve(envRoot); } catch { /* */ }
  }
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
  lastGit: null,
  lastClone: null,
  busy: false,
  lastInputHex: '',
  lastAction: '',
  sys: null,
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
      obj = JSON.parse(raw.replace(/^﻿/, ''));
    } catch { continue; }
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
  const nowS = Math.floor(Date.now() / 1000);
  let d = secAt - nowS;
  if (d <= 0) return 'resets now';
  const h = Math.floor(d / 3600); d -= h * 3600;
  const m = Math.floor(d / 60); const s = d - m * 60;
  if (h > 0) return 'resets in ' + h + 'h' + (m < 10 ? '0' : '') + m + 'm';
  if (m > 0) return 'resets in ' + m + 'm' + (s < 10 ? '0' : '') + s + 's';
  return 'resets in ' + s + 's';
}

// Gauge bar: green fill, red when high; empty cells are dim-blue dashes (no gray bg).
function bar(pct, width) {
  if (pct == null || isNaN(pct)) return BLUE + '[' + DIM + '-'.repeat(width) + RESET + BLUE + ']' + RESET;
  let p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  const fillCol = p >= 85 ? BRED : GREEN;
  return BLUE + '[' + RESET + fillCol + '#'.repeat(filled) + RESET + DIM + BLUE + '-'.repeat(width - filled) + RESET + BLUE + ']' + RESET;
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

let gpuExe; // undefined=unprobed, null=absent, string=path
function findGpuExe() {
  if (gpuExe !== undefined) return gpuExe;
  const cands = ['nvidia-smi', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe')];
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 2500 });
      if (!r.error && r.status === 0) { gpuExe = c; return gpuExe; }
    } catch { /* next */ }
  }
  gpuExe = null;
  return gpuExe;
}
function sampleGpu() {
  const exe = findGpuExe();
  if (!exe) return null;
  try {
    const r = spawnSync(exe, ['--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 2500 });
    if (r.error || r.status !== 0) return null;
    const line = (r.stdout || '').trim().split('\n')[0] || '';
    const parts = line.split(',').map((x) => parseFloat(x.trim()));
    if (parts.length < 3 || isNaN(parts[0])) return null;
    return { util: parts[0], memUsed: parts[1], memTot: parts[2], temp: parts[3] };
  } catch { return null; }
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function two(n) { return (n < 10 ? '0' : '') + n; }

let sysTick = 0;
let gpuCache = null;
function sampleSystem() {
  const now = new Date();
  const date = {
    day: DOW[now.getDay()],
    pretty: DOW[now.getDay()] + '  ' + MON[now.getMonth()] + ' ' + two(now.getDate()) + ', ' + now.getFullYear(),
    ymd: now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate()),
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
  // GPU is comparatively expensive (spawns nvidia-smi) — refresh every ~5s.
  if (sysTick % 5 === 0) gpuCache = sampleGpu();
  sysTick++;
  state.sys = {
    date,
    cpu,
    memPct,
    memUsedGB: (totMem - freeMem) / 1e9,
    memTotGB: totMem / 1e9,
    disk,
    gpu: gpuCache,
  };
}

// ---------- subagents ----------
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
    let running = 0, total = 0, lastLabel = '';
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let obj;
      try { obj = JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8').replace(/^﻿/, '')); } catch { continue; }
      total++;
      if (obj && obj.status === 'running') {
        running++;
        if (obj.label) lastLabel = obj.label; else if (obj.agentType) lastLabel = obj.agentType;
      }
    }
    if (running > 0) parents.push({ parentId, running, total, label: lastLabel });
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
      state.cwd = next; state.dirSel = 0; loadEntries(); setStatus('', 'info');
    }
  } catch (err) { setStatus('Cannot enter: ' + asciiSafe(err && err.message), 'error'); }
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

function launch() {
  const n = state.count;
  const dir = state.cwd;
  const name = path.basename(dir) || dir;
  const args = ['action', 'new-tab', '--layout', layoutPath(n), '--cwd', dir, '--name', name];
  let res;
  try { res = spawnSync('zellij', args, { encoding: 'utf8' }); }
  catch (e) { setStatus('Launch failed: ' + asciiSafe(e && e.message), 'error'); return; }
  if (res.error) {
    if (res.error.code === 'ENOENT') setStatus('zellij not found on PATH (cannot launch tab)', 'error');
    else setStatus('Launch error: ' + asciiSafe(res.error.message), 'error');
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
  state.busy = true;
  setStatus('Pushing repos under ' + asciiSafe(path.basename(root)) + ' ...', 'info');
  redraw();
  let res;
  try { res = spawnSync('node', [gitPushPath(), root], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); }
  catch (e) { state.busy = false; state.lastGit = { error: asciiSafe(e && e.message) }; setStatus('git-push failed to spawn', 'error'); return; }
  state.busy = false;
  if (res.error) { state.lastGit = { error: asciiSafe(res.error.message) }; setStatus('git-push spawn error', 'error'); return; }
  let parsed = null;
  const outStr = (res.stdout || '').toString().trim();
  try { parsed = JSON.parse(outStr); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.repos)) {
    state.lastGit = { error: 'bad output: ' + truncate(asciiSafe(outStr || (res.stderr || '').toString()), 80) };
    setStatus('git-push: unexpected output', 'error');
    return;
  }
  state.lastGit = parsed;
  const pushed = parsed.repos.filter((r) => r.pushed).length;
  const errs = parsed.repos.filter((r) => r.error).length;
  setStatus('git push: ' + pushed + ' pushed, ' + errs + ' error(s), ' + parsed.repos.length + ' repo(s)', errs ? 'error' : 'ok');
}

function cloneAll() {
  const root = defaultRoot();
  state.busy = true;
  setStatus('Cloning + updating all repos into ' + asciiSafe(path.basename(root)) + ' (this can take a while)...', 'info');
  redraw();
  let res;
  try { res = spawnSync('node', [cloneAllPath(), root], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
  catch (e) { state.busy = false; state.lastClone = { error: asciiSafe(e && e.message) }; setStatus('clone-all failed to spawn', 'error'); return; }
  state.busy = false;
  if (res.error) { state.lastClone = { error: asciiSafe(res.error.message) }; setStatus('clone-all spawn error', 'error'); return; }
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
  const errs = parsed.repos.filter((r) => r.action === 'error').length;
  setStatus('clone/sync: ' + cloned + ' cloned, ' + updated + ' updated, ' + parsed.repos.length + ' repo(s)' +
    (errs ? ', ' + errs + ' error(s)' : ''), errs ? 'error' : 'ok');
}

function openInspector() {
  const p = state.subParents[state.subSel];
  if (!p) { setStatus('No subagent group selected', 'error'); return; }
  const args = ['action', 'new-pane', '--floating', '--close-on-exit', '--', 'node', inspectorPath(), p.parentId];
  let res;
  try { res = spawnSync('zellij', args, { encoding: 'utf8' }); }
  catch (e) { setStatus('Inspector failed: ' + asciiSafe(e && e.message), 'error'); return; }
  if (res.error) {
    if (res.error.code === 'ENOENT') setStatus('zellij not found on PATH (cannot open inspector)', 'error');
    else setStatus('Inspector error: ' + asciiSafe(res.error.message), 'error');
    return;
  }
  if (res.status !== 0) { setStatus('zellij returned error opening inspector', 'error'); return; }
  setStatus('Opened inspector for ' + truncate(asciiSafe(p.parentId), 16), 'ok');
}

// ---------- rendering ----------
function out(s) { process.stdout.write(s); }

// Right-aligned compose: left text + fill + right text within visible width W.
function leftRight(leftVisible, leftColored, rightVisible, rightColored, W) {
  const gap = Math.max(1, W - leftVisible.length - rightVisible.length);
  return leftColored + ' '.repeat(gap) + rightColored;
}

function render() {
  const cols = termCols();
  const W = Math.max(54, Math.min(cols, 96));
  const lines = [];
  const sep = BLUE + '-'.repeat(W) + RESET;

  // Header: title left, day/date/time right.
  const sys = state.sys || {};
  const dt = sys.date || { pretty: '', hms: '' };
  const titleL = 'CLAUDE CONTROL CENTER';
  const rightVisible = dt.pretty + '   ' + dt.hms;
  lines.push(leftRight(titleL, BOLD + BGREEN + titleL + RESET, rightVisible, BLUE + dt.pretty + RESET + '   ' + BOLD + GREEN + dt.hms + RESET, W));
  lines.push(sep);

  // Folder
  lines.push(BOLD + BLUE + 'Folder ' + RESET + GREEN + truncate(asciiSafe(state.cwd), W - 8) + RESET);

  // Directory navigator
  const dirFocused = state.focus === 'dirs';
  lines.push((dirFocused ? BOLD + BGREEN + '> ' + RESET : '  ') + hdr('DIRECTORY'));
  const totalRows = termRows();
  const navRows = Math.max(3, Math.min(8, totalRows - 34));
  if (state.entries.length === 0) {
    lines.push('    ' + BLUE + '(empty)' + RESET);
  } else {
    let start = 0;
    if (state.dirSel >= navRows) start = state.dirSel - navRows + 1;
    const end = Math.min(state.entries.length, start + navRows);
    for (let i = start; i < end; i++) {
      const e = state.entries[i];
      const sel = (i === state.dirSel && dirFocused);
      const label = (e.isDir ? e.name + '/' : e.name);
      const text = truncate(label, W - 6);
      let col;
      if (sel) col = BOLD + BGREEN;
      else if (e.isDir) col = GREEN;
      else col = BLUE;
      lines.push('  ' + (sel ? BGREEN + '> ' + RESET : '  ') + col + text + RESET);
    }
    if (end < state.entries.length || start > 0) {
      lines.push('    ' + BLUE + '(' + (state.dirSel + 1) + '/' + state.entries.length + ')' + RESET);
    }
  }
  lines.push(sep);

  // Launch
  const launchName = path.basename(state.cwd) || state.cwd;
  lines.push(hdr('LAUNCH') + '   ' + keyc('Enter') + ' ' + GREEN + 'open a new window of ' + RESET +
    BOLD + BGREEN + state.count + RESET + GREEN + ' agent' + (state.count === 1 ? '' : 's') + ' in ' + RESET +
    BGREEN + truncate(asciiSafe(launchName), 22) + RESET);
  lines.push('  ' + GREEN + 'count' + RESET + ' ' + keyc('1') + GREEN + '..' + RESET + keyc('8') +
    GREEN + '   add more inside a tab with ' + RESET + keyc('Alt+a'));
  lines.push(sep);

  // Session limits
  lines.push(hdr('SESSION LIMITS'));
  const a = readFreshestAgent();
  const rl = a && a.rateLimits ? a.rateLimits : null;
  const five = rl && rl.fiveHour ? rl.fiveHour : null;
  const week = rl && rl.sevenDay ? rl.sevenDay : null;
  const barW = 22;
  function gaugeLine(label, gauge) {
    if (!gauge || gauge.usedPct == null) return '  ' + GREEN + pad(label, 7) + RESET + ' ' + bar(null, barW) + '   ' + BLUE + '--' + RESET;
    const pct = Math.round(gauge.usedPct);
    const cd = fmtCountdown(gauge.resetsAt);
    const col = pct >= 85 ? BRED : GREEN;
    return '  ' + GREEN + pad(label, 7) + RESET + ' ' + bar(gauge.usedPct, barW) + ' ' + col + padLeft(pct + '%', 4) + RESET +
      (cd ? '  ' + BLUE + cd + RESET : '');
  }
  lines.push(gaugeLine('5-hour', five));
  lines.push(gaugeLine('Weekly', week));
  if (!a) lines.push('  ' + BLUE + '(no agent has reported yet -- shows after the first API call)' + RESET);
  lines.push(sep);

  // System stats
  lines.push(hdr('SYSTEM'));
  function statLine(label, pct, suffix) {
    const col = (pct != null && pct >= 85) ? BRED : GREEN;
    const pctTxt = pct == null ? ' n/a' : padLeft(Math.round(pct) + '%', 4);
    return '  ' + GREEN + pad(label, 5) + RESET + ' ' + bar(pct, barW) + ' ' + col + pctTxt + RESET + (suffix ? '  ' + BLUE + suffix + RESET : '');
  }
  lines.push(statLine('CPU', sys.cpu == null ? null : sys.cpu, ''));
  lines.push(statLine('MEM', sys.memPct == null ? null : sys.memPct,
    sys.memUsedGB != null ? sys.memUsedGB.toFixed(1) + ' / ' + sys.memTotGB.toFixed(1) + ' GB' : ''));
  if (sys.disk) {
    lines.push(statLine('DISK', sys.disk.pct, Math.round(sys.disk.freeGB) + ' free / ' + Math.round(sys.disk.totGB) + ' GB'));
  } else {
    lines.push(statLine('DISK', null, ''));
  }
  if (sys.gpu) {
    const g = sys.gpu;
    lines.push(statLine('GPU', g.util, (g.memUsed / 1024).toFixed(1) + ' / ' + (g.memTot / 1024).toFixed(1) + ' GB' + (g.temp ? '   ' + g.temp + 'C' : '')));
  } else {
    lines.push(statLine('GPU', null, 'no nvidia-smi'));
  }
  lines.push(sep);

  // Subagents
  const subFocused = state.focus === 'subagents';
  lines.push((subFocused ? BOLD + BGREEN + '> ' + RESET : '  ') + hdr('SUBAGENTS'));
  if (state.subParents.length === 0) {
    lines.push('    ' + BLUE + '(no agents running subagents)' + RESET);
  } else {
    const maxShow = 3;
    for (let i = 0; i < Math.min(state.subParents.length, maxShow); i++) {
      const p = state.subParents[i];
      const sel = (i === state.subSel && subFocused);
      const text = truncate(asciiSafe(p.parentId), 14) + '  ' + p.running + '/' + p.total + ' running' +
        (p.label ? '  ' + truncate(asciiSafe(p.label), 26) : '');
      lines.push('  ' + (sel ? BGREEN + '> ' + RESET : '  ') + (sel ? BOLD + BGREEN : GREEN) + text + RESET);
    }
  }
  lines.push(sep);

  // Result tables (clone + git), with a header row and | column separators.
  function tableHeader(c1, c2, c3) {
    return '  ' + BOLD + BLUE + pad(c1, 20) + ' | ' + pad(c2, 9) + ' | ' + c3 + RESET;
  }
  function tableRow(c1, c2, c3, c3col) {
    return '  ' + GREEN + pad(truncate(c1, 20), 20) + RESET + BLUE + ' | ' + RESET + GREEN + pad(truncate(c2, 9), 9) + RESET + BLUE + ' | ' + RESET + (c3col || GREEN) + truncate(c3, W - 38) + RESET;
  }
  if (state.lastClone) {
    lines.push(hdr('LAST CLONE / SYNC'));
    if (state.lastClone.error) {
      lines.push('  ' + RED + truncate(asciiSafe(state.lastClone.error), W - 4) + RESET);
    } else {
      const repos = state.lastClone.repos || [];
      const cloned = repos.filter((r) => r.action === 'cloned').length;
      const updated = repos.filter((r) => r.action === 'updated').length;
      const current = repos.filter((r) => r.action === 'up-to-date').length;
      const skipped = repos.filter((r) => r.action === 'skipped').length;
      const errs = repos.filter((r) => r.action === 'error').length;
      lines.push('  ' + GREEN + cloned + ' cloned   ' + updated + ' updated   ' + current + ' current   ' + skipped + ' skipped' + RESET + (errs ? '   ' + RED + errs + ' error' + RESET : ''));
      const notable = repos.filter((r) => r.action !== 'up-to-date').slice(0, 3);
      if (notable.length) lines.push(tableHeader('repo', 'action', 'note'));
      for (const r of notable) {
        const c3col = r.action === 'error' ? RED : BLUE;
        lines.push(tableRow(asciiSafe(r.name), r.action, asciiSafe(r.error || ''), c3col));
      }
    }
    lines.push(sep);
  }
  if (state.lastGit) {
    lines.push(hdr('LAST GIT PUSH'));
    if (state.lastGit.error) {
      lines.push('  ' + RED + truncate(asciiSafe(state.lastGit.error), W - 4) + RESET);
    } else {
      const repos = state.lastGit.repos || [];
      if (repos.length === 0) lines.push('  ' + BLUE + '(no repos found)' + RESET);
      else lines.push(tableHeader('repo', 'branch', 'status'));
      for (let i = 0; i < Math.min(repos.length, 4); i++) {
        const r = repos[i];
        let st, col;
        if (r.error) { st = 'ERR ' + asciiSafe(r.error); col = RED; }
        else if (r.pushed) { st = 'pushed'; col = GREEN; }
        else { st = 'skipped'; col = BLUE; }
        lines.push(tableRow(asciiSafe(path.basename(r.path || '')), asciiSafe(r.branch || ''), st, col));
      }
      if (repos.length > 4) lines.push('  ' + BLUE + '... +' + (repos.length - 4) + ' more' + RESET);
    }
    lines.push(sep);
  }

  // Status line
  if (state.status) {
    let col = BLUE;
    if (state.statusKind === 'error') col = RED;
    else if (state.statusKind === 'ok') col = BGREEN;
    lines.push(col + truncate(asciiSafe(state.status), W - 1) + RESET);
  } else {
    lines.push('');
  }

  // Cheatsheet — single key reference. Blue label, blue keys, green descriptions,
  // separated by blue | column lines.
  const C = BLUE + ' | ' + RESET;
  lines.push(sep);
  lines.push(BOLD + BLUE + pad('MOVE', 7) + RESET +
    keyc('Up') + keyc('Dn') + GREEN + ' select' + RESET + C +
    keyc('->') + GREEN + ' open' + RESET + C + keyc('<-') + GREEN + ' back' + RESET + C +
    keyc('Tab') + GREEN + ' subagents' + RESET);
  lines.push(BOLD + BLUE + pad('DO', 7) + RESET +
    keyc('1') + GREEN + '-' + RESET + keyc('8') + GREEN + ' agents' + RESET + C +
    keyc('Enter') + GREEN + ' launch' + RESET + C + keyc('c') + GREEN + ' clone all' + RESET + C +
    keyc('g') + GREEN + ' push all' + RESET + C + keyc('q') + GREEN + ' quit' + RESET);
  lines.push(BOLD + BLUE + pad('WINDOW', 7) + RESET +
    BOLD + BBLUE + 'Alt+[ Alt+]' + RESET + GREEN + ' switch' + RESET + C +
    keyc('Alt+a') + GREEN + ' add agent' + RESET + C + keyc('Ctrl+g') + GREEN + ' lock' + RESET + C +
    keyc('Ctrl+Alt+w') + GREEN + ' close' + RESET);
  // Input debug (so we can confirm keystrokes register). Blue, low-key.
  lines.push(DIM + BLUE + 'input ' + (state.lastInputHex || '--') + ' -> ' + (state.lastAction || '(none yet)') + RESET);

  const frame = HOME_POS + ESC + '[2J' + lines.join('\r\n') + '\r\n';
  out(frame);
}

function redraw() {
  try { sampleSystem(); } catch { /* */ }
  scanSubagents();
  render();
}

// ---------- input (manual byte-stream parser) ----------
function recordInput(hex, action) {
  state.lastInputHex = hex;
  state.lastAction = action;
}

function act(name, ch) {
  if (name === 'quit') { cleanupAndExit(0); return; }
  if (name === 'enter') {
    if (state.focus === 'dirs') launch(); else openInspector();
    redraw(); return;
  }
  if (name === 'tab') { state.focus = (state.focus === 'dirs') ? 'subagents' : 'dirs'; redraw(); return; }
  if (name === 'up') {
    if (state.focus === 'dirs') { if (state.dirSel > 0) state.dirSel--; }
    else { if (state.subSel > 0) state.subSel--; }
    redraw(); return;
  }
  if (name === 'down') {
    if (state.focus === 'dirs') { if (state.dirSel < state.entries.length - 1) state.dirSel++; }
    else { if (state.subSel < state.subParents.length - 1) state.subSel++; }
    redraw(); return;
  }
  if (name === 'right') { if (state.focus === 'dirs') enterDir(); redraw(); return; }
  if (name === 'left') { if (state.focus === 'dirs') parentDir(); redraw(); return; }
  // printable
  if (ch != null) onPrintable(ch);
}

function onPrintable(ch) {
  if (/[1-8]/.test(ch)) { state.count = parseInt(ch, 10); setStatus('', 'info'); redraw(); return; }
  if (ch === '+' || ch === '=') { state.count = Math.min(8, state.count + 1); redraw(); return; }
  if (ch === '-' || ch === '_') { state.count = Math.max(1, state.count - 1); redraw(); return; }
  if (ch === 'c') { cloneAll(); redraw(); return; }
  if (ch === 'g') { gitPush(); redraw(); return; }
  if (ch === 'q') { cleanupAndExit(0); return; }
  // vim-style fallback nav (in case arrow escape sequences don't arrive cleanly)
  if (ch === 'k') { act('up'); return; }
  if (ch === 'j') { act('down'); return; }
  if (ch === 'h') { act('left'); return; }
  if (ch === 'l') { act('right'); return; }
  redraw();
}

let inbuf = '';
let escFlushTimer = null;
function clearEscFlush() { if (escFlushTimer) { clearTimeout(escFlushTimer); escFlushTimer = null; } }

function dispatchOne() {
  // Returns true if it consumed something, false if it needs more bytes.
  if (!inbuf.length) return false;
  const c0 = inbuf.charCodeAt(0);
  if (c0 === 0x1b) {
    const m = inbuf.match(/^\x1b(\[|O)[0-9;]*([A-Za-z~])/);
    if (m) {
      const final = m[2];
      const map = { A: 'up', B: 'down', C: 'right', D: 'left' };
      const action = map[final];
      recordInput(Buffer.from(inbuf.slice(0, m[0].length), 'latin1').toString('hex'), action || ('esc-' + final));
      inbuf = inbuf.slice(m[0].length);
      if (action) act(action, null); else redraw();
      return true;
    }
    // Could be a partial escape sequence — wait for more, but flush a lone ESC.
    if (inbuf.length <= 2) return false;
    // Unknown/garbled escape: drop the ESC and continue.
    inbuf = inbuf.slice(1);
    return true;
  }
  const ch = inbuf[0];
  inbuf = inbuf.slice(1);
  if (c0 === 0x03) { recordInput('03', 'quit'); act('quit'); return true; }
  if (c0 === 0x0d || c0 === 0x0a) { recordInput(c0.toString(16), 'enter'); act('enter'); return true; }
  if (c0 === 0x09) { recordInput('09', 'tab'); act('tab'); return true; }
  if (c0 === 0x7f || c0 === 0x08) { recordInput(c0.toString(16), 'backspace'); return true; }
  if (c0 < 0x20) { recordInput(c0.toString(16), 'ctrl'); return true; }
  recordInput(Buffer.from(ch, 'latin1').toString('hex'), ch);
  act(null, ch);
  return true;
}

function feed(chunk) {
  clearEscFlush();
  inbuf += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk);
  // Consume everything we can.
  let safety = 0;
  while (inbuf.length && dispatchOne()) { if (++safety > 4096) { inbuf = ''; break; } }
  // If a lone ESC remains, flush it as Escape after a short wait.
  if (inbuf.length && inbuf.charCodeAt(0) === 0x1b) {
    escFlushTimer = setTimeout(() => {
      if (inbuf.length && inbuf.charCodeAt(0) === 0x1b) {
        recordInput('1b', 'escape');
        inbuf = inbuf.slice(1);
        // process anything trailing the lone ESC
        let s = 0; while (inbuf.length && dispatchOne()) { if (++s > 4096) { inbuf = ''; break; } }
        redraw();
      }
    }, 60);
  }
}

// ---------- lifecycle ----------
let timer = null;
let cleanedUp = false;
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

function main() {
  ensureStateRoot();
  loadEntries();
  out(ALT_ON + CURSOR_HIDE + CLEAR);

  // Best-effort raw mode (works only when stdin is a real console). We never
  // depend on it — the manual 'data' parser handles input either way, and we
  // never exit on a TTY check (that would collapse the pane/window).
  try { if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true); } catch { /* */ }
  try { process.stdin.resume(); } catch { /* */ }
  // Read raw bytes (no setEncoding) so escape sequences arrive intact.
  process.stdin.on('data', (chunk) => {
    try { feed(chunk); } catch (e) { setStatus('input error: ' + asciiSafe(e && e.message), 'error'); try { redraw(); } catch { /* */ } }
  });
  process.stdin.on('error', () => { /* ignore transient pipe errors */ });

  process.on('SIGINT', () => cleanupAndExit(0));
  process.on('SIGTERM', () => cleanupAndExit(0));
  process.stdout.on('resize', () => { try { redraw(); } catch { /* */ } });

  // Prime CPU sampler so the first visible value is real.
  try { cpuPercent(); } catch { /* */ }
  redraw();
  timer = setInterval(() => { try { redraw(); } catch { /* */ } }, 1000);
}

main();
