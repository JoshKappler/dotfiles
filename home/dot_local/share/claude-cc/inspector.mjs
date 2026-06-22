#!/usr/bin/env node
// inspector.mjs — Claude Control Center subagent inspector (WP3).
//
// Usage: node inspector.mjs [parentSessionId]
//
// Launched (typically) in a Zellij floating pane from an agent pane. Renders a
// live ASCII table of one parent session's subagents from
//   <stateRoot>/subagents/<parent>/*.json
// columns: type | label | status | lastTool | lastDetail | elapsed.
// Refreshes every 1s. Press q or Esc to exit (restores screen + raw mode).
//
// Parent resolution order:
//   1. CLI arg.
//   2. panes/<ZELLIJ_PANE_ID> file contents (which agent is in this pane).
//   3. scan subagents/: if exactly one parent has a RUNNING child -> use it,
//      else show a numbered picker and read a digit from stdin.
//
// Contract: zero npm deps, Node built-ins only. Never throws on bad/empty state.
//
// --- Sample stdin fixtures (the subagent records this reads) -----------------
// Records are produced by subagent-track.mjs. Equivalent hook payloads:
// SubagentStart:
//   { "hook_event_name":"SubagentStart","session_id":"s1","agent_id":"a1",
//     "agent_type":"Explore","description":"search auth code" }
// PreToolUse (with agent_id):
//   { "hook_event_name":"PreToolUse","session_id":"s1","agent_id":"a1",
//     "tool_name":"Grep","tool_input":{"pattern":"auth"} }
// SubagentStop:
//   { "hook_event_name":"SubagentStop","session_id":"s1","agent_id":"a1" }
//
// On-disk record this inspector renders (subagents/s1/a1.json):
//   { "agentId":"a1","agentType":"Explore","label":"search auth code",
//     "status":"running","lastTool":"Grep","lastDetail":"auth",
//     "startedAt":1738400000,"updatedAt":1738400050 }
//
// --- Manual test recipe ------------------------------------------------------
//   # Seed a record via the tracker, then inspect:
//   echo '{"hook_event_name":"SubagentStart","session_id":"s1","agent_id":"a1","agent_type":"Explore","description":"search auth code"}' | node hooks/subagent-track.mjs
//   echo '{"hook_event_name":"PreToolUse","session_id":"s1","agent_id":"a1","tool_name":"Grep","tool_input":{"pattern":"auth"}}' | node hooks/subagent-track.mjs
//   node inspector.mjs s1            # live table; press q to quit
//
//   # No-arg resolution from a pane file:
//   mkdir -p ~/.claude/state/cc/panes && echo s1 > ~/.claude/state/cc/panes/9
//   ZELLIJ_PANE_ID=9 node inspector.mjs
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

function stateRoot() {
  return path.join(os.homedir(), '.claude', 'state', 'cc');
}
function panesDir() {
  return path.join(stateRoot(), 'panes');
}
function subagentsRoot() {
  return path.join(stateRoot(), 'subagents');
}
function subagentsDir(parent) {
  return path.join(subagentsRoot(), String(parent));
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

// ---- parent resolution -----------------------------------------------------

function listParents() {
  try {
    return fs
      .readdirSync(subagentsRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function readChildren(parent) {
  const dir = subagentsDir(parent);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (rec && typeof rec === 'object') out.push(rec);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function parentHasRunning(parent) {
  return readChildren(parent).some((r) => r.status === 'running');
}

function fromPaneFile() {
  const paneId = process.env.ZELLIJ_PANE_ID;
  if (!paneId) return null;
  try {
    const c = fs.readFileSync(path.join(panesDir(), String(paneId)), 'utf8').trim();
    return c || null;
  } catch {
    return null;
  }
}

function readDigitFromStdin() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Select a parent session (number): ', (ans) => {
      rl.close();
      const n = parseInt(String(ans).trim(), 10);
      resolve(Number.isFinite(n) ? n : NaN);
    });
  });
}

async function resolveParent(argv) {
  // 1. CLI arg
  const arg = argv[2];
  if (arg && arg.trim()) return arg.trim();

  // 2. pane file
  const fromPane = fromPaneFile();
  if (fromPane) return fromPane;

  // 3. scan
  const parents = listParents();
  if (parents.length === 0) return null;

  const running = parents.filter(parentHasRunning);
  if (running.length === 1) return running[0];

  // Picker (prefer the ones with live subagents at the top).
  const ordered = [...running, ...parents.filter((p) => !running.includes(p))];
  process.stdout.write('Multiple parent sessions found:\n\n');
  ordered.forEach((p, i) => {
    const kids = readChildren(p);
    const live = kids.filter((k) => k.status === 'running').length;
    process.stdout.write(`  ${i + 1}. ${p}   (${kids.length} subagents, ${live} running)\n`);
  });
  process.stdout.write('\n');
  const choice = await readDigitFromStdin();
  if (!Number.isFinite(choice) || choice < 1 || choice > ordered.length) {
    return null;
  }
  return ordered[choice - 1];
}

// ---- rendering -------------------------------------------------------------

const ESC = '\x1b';
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
const CLEAR = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

function pad(s, w) {
  s = s == null ? '' : String(s);
  if (s.length > w) return s.slice(0, w - 1) + '…';
  return s + ' '.repeat(w - s.length);
}

function fmtElapsed(startedAt) {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return '-';
  let secs = Math.floor(Date.now() / 1000) - startedAt;
  if (secs < 0) secs = 0;
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m${s.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

// Column widths.
const COLS = [
  { key: 'type', label: 'TYPE', w: 12 },
  { key: 'label', label: 'LABEL', w: 26 },
  { key: 'status', label: 'STATUS', w: 8 },
  { key: 'lastTool', label: 'TOOL', w: 12 },
  { key: 'lastDetail', label: 'DETAIL', w: 30 },
  { key: 'elapsed', label: 'ELAPSED', w: 9 },
];

function renderRow(cells) {
  return COLS.map((c, i) => pad(cells[i], c.w)).join(' | ');
}

function render(parent) {
  const lines = [];
  lines.push(`Subagent Inspector  —  parent: ${parent}`);
  lines.push(`(refreshing every 1s — press q or Esc to quit)`);
  lines.push('');

  const kids = readChildren(parent).sort((a, b) => {
    // running first, then most-recently updated.
    const ar = a.status === 'running' ? 0 : 1;
    const br = b.status === 'running' ? 0 : 1;
    if (ar !== br) return ar - br;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  const header = renderRow(COLS.map((c) => c.label));
  lines.push(header);
  lines.push('-'.repeat(header.length));

  if (kids.length === 0) {
    lines.push('');
    lines.push('  no subagents yet');
  } else {
    for (const k of kids) {
      lines.push(
        renderRow([
          k.agentType || '-',
          k.label || '-',
          k.status || '-',
          k.lastTool || '-',
          k.lastDetail || '-',
          fmtElapsed(k.startedAt),
        ])
      );
    }
  }

  lines.push('');
  const running = kids.filter((k) => k.status === 'running').length;
  lines.push(`total ${kids.length}  ·  running ${running}  ·  ${new Date().toLocaleTimeString()}`);

  // Join with explicit CRLF-safe newline + clear-to-EOL so stale chars vanish.
  return CLEAR + lines.map((l) => l + `${ESC}[K`).join('\n');
}

// ---- main ------------------------------------------------------------------

let timer = null;
let cleanedUp = false;

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (timer) clearInterval(timer);
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  try {
    process.stdin.pause();
  } catch {
    /* ignore */
  }
  process.stdout.write(SHOW_CURSOR + ALT_OFF);
}

function runLive(parent) {
  process.stdout.write(ALT_ON + HIDE_CURSOR);
  const draw = () => {
    try {
      process.stdout.write(render(parent));
    } catch {
      /* ignore transient render errors */
    }
  };
  draw();
  timer = setInterval(draw, 1000);

  // Key handling: q or Esc quits.
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
  } catch {
    /* ignore */
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key) => {
    // q, Q, Esc (\x1b), Ctrl-C (\x03)
    if (key === 'q' || key === 'Q' || key === '\x1b' || key === '\x03') {
      cleanup();
      process.exit(0);
    }
  });

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('exit', cleanup);
}

async function main() {
  ensureDir(subagentsRoot());
  const parent = await resolveParent(process.argv);
  if (!parent) {
    process.stdout.write('No parent session to inspect (no subagents yet).\n');
    process.exit(0);
    return;
  }
  runLive(parent);
}

main().catch((e) => {
  cleanup();
  // Surface the error to stderr but still exit cleanly.
  try {
    process.stderr.write(`inspector error: ${e && e.message ? e.message : e}\n`);
  } catch {
    /* ignore */
  }
  process.exit(0);
});
