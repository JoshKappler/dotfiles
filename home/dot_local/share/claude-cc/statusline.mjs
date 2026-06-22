#!/usr/bin/env node
// Claude Control Center — statusLine + state writer (WP2).
//
// Replaces ~/.claude/statusline-context.js. On every statusLine tick Claude Code
// pipes session JSON on stdin. We:
//   1. Print ONE line to stdout:  <model> · <ctxPct>% · <task>
//      (the % is colored green to match the Homebrew terminal).
//   2. Side-effect: write <stateRoot>/agents/<session_id>.json so the Home TUI
//      (WP1) can draw the roster + 5h/weekly limit gauges.
//
// Contract (must stay verbatim — read by WP1):
//   stateRoot = <homedir>/.claude/state/cc
//   agents/<sessionId>.json:
//     { sessionId, cwd, model, ctxPct, task, paneId,
//       rateLimits: { fiveHour:{usedPct,resetsAt}, sevenDay:{usedPct,resetsAt} } | null,
//       updatedAt }
//
// Zero npm deps — Node built-ins only. Never throws. Must finish <300ms, no network.
//
// ---------------------------------------------------------------------------
// MANUAL TEST (PowerShell):
//   Get-Content fixture.json | node statusline.mjs
// (bash:  cat fixture.json | node statusline.mjs )
// then inspect ~/.claude/state/cc/agents/<sessionId>.json
//
// FIXTURE A — full (Pro/Max: rate_limits present, transcript_path set):
// {
//   "session_id": "sess-abc123",
//   "cwd": "/home/josh/projects/scuttle",
//   "model": { "display_name": "Opus" },
//   "context_window": { "used_percentage": 42, "total_input_tokens": 84000, "context_window_size": 200000 },
//   "transcript_path": "/home/josh/.claude/projects/foo/transcript.jsonl",
//   "rate_limits": {
//     "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
//     "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
//   }
// }
//
// FIXTURE B — minimal (no rate_limits, no transcript_path; compute ctx from tokens):
// {
//   "session_id": "sess-min",
//   "cwd": "/home/josh/projects",
//   "model": { "display_name": "Sonnet" },
//   "context_window": { "total_input_tokens": 30000, "context_window_size": 200000 }
// }
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- state path helpers (inlined; no shared import, per plan) --------------
function stateRoot() {
  return path.join(os.homedir(), '.claude', 'state', 'cc');
}
function agentsDir() {
  return path.join(stateRoot(), 'agents');
}

// ---- small utils ----------------------------------------------------------
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

// Strip to printable ASCII, collapse whitespace, drop common markdown noise.
function toAscii(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[`*_#>~]/g, ' ')        // markdown markers
    .replace(/[^\x20-\x7E]/g, '')      // non-ASCII
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim();
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + '…';
}

// Pull a plain-text string out of a message's `content` (string OR array of
// blocks, the standard Anthropic transcript shape).
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block == null) continue;
      if (typeof block === 'string') parts.push(block);
      else if (typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join(' ');
  }
  return '';
}

// Read the transcript JSONL and return the first non-empty line of the LAST
// user turn. Returns '' on any problem (missing file, parse errors, no user).
function readLastUserTask(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return '';
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.split(/\r?\n/);
  let found = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let entry;
    try {
      entry = JSON.parse(t);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    // Detect a user turn: either top-level type/role "user" or nested message.role.
    const topType = entry.type || entry.role;
    const msg = entry.message && typeof entry.message === 'object' ? entry.message : null;
    const msgRole = msg ? msg.role : undefined;
    const isUser = topType === 'user' || msgRole === 'user';
    if (!isUser) continue;
    // Where the text lives can vary; try the common spots in order.
    let text = '';
    if (msg && msg.content !== undefined) text = extractText(msg.content);
    if (!text && entry.content !== undefined) text = extractText(entry.content);
    if (!text && typeof entry.text === 'string') text = entry.text;
    text = toAscii(text);
    if (text) found = text; // keep walking; last one wins
  }
  if (!found) return '';
  const firstLine = found.split('\n')[0].trim();
  return truncate(firstLine, 48);
}

function computeCtxPct(j) {
  const cw = (j && j.context_window) || {};
  let pct = cw.used_percentage;
  if (pct == null) {
    const size = cw.context_window_size || 200000;
    const used = cw.total_input_tokens || 0;
    pct = size ? (used / size) * 100 : 0;
  }
  pct = Number(pct);
  if (!Number.isFinite(pct)) pct = 0;
  pct = Math.max(0, Math.min(100, pct));
  return Math.round(pct);
}

// Map Claude's rate_limits block to our schema; null if not present/usable.
function mapRateLimits(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const pick = (b) => {
    if (!b || typeof b !== 'object') return null;
    const usedPct = b.used_percentage;
    const resetsAt = b.resets_at;
    if (usedPct == null && resetsAt == null) return null;
    return {
      usedPct: usedPct == null ? null : Number(usedPct),
      resetsAt: resetsAt == null ? null : resetsAt,
    };
  };
  const fiveHour = pick(rl.five_hour);
  const sevenDay = pick(rl.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

function writeAgentFile(j, model, ctxPct, task) {
  try {
    const dir = agentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = (j && j.session_id) || '';
    if (!sessionId) return; // no id → nothing addressable to write
    const paneId = process.env.ZELLIJ_PANE_ID || null;
    const record = {
      sessionId,
      cwd: (j && j.cwd) || '',
      model,
      ctxPct,
      task: task || '',
      paneId,
      rateLimits: mapRateLimits(j && j.rate_limits),
      updatedAt: Date.now(),
    };
    const file = path.join(dir, sessionId + '.json');
    // Atomic-ish write: tmp then rename, so a reader never sees a half file.
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // State write is best-effort; never let it affect the status line.
  }
}

function buildLine(model, ctxPct, task) {
  const parts = [];
  parts.push(model || '');
  parts.push(GREEN + ctxPct + '%' + RESET);
  if (task) parts.push(task);
  return parts.join(' · '); // " · "
}

function main(raw) {
  let j = {};
  try {
    j = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    j = {};
  }
  const model = (j && j.model && j.model.display_name) || '';
  const ctxPct = computeCtxPct(j);
  let task = '';
  try {
    task = readLastUserTask(j && j.transcript_path);
  } catch {
    task = '';
  }
  // Print the status line first (the user-facing job), then persist state.
  try {
    process.stdout.write(buildLine(model, ctxPct, task));
  } catch {
    // Last-ditch: emit at least the model (or empty string).
    try { process.stdout.write(model || ''); } catch {}
  }
  writeAgentFile(j, model, ctxPct, task);
}

// ---- read all of stdin, then run -----------------------------------------
let buf = '';
try {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => {
    try { main(buf); } catch {
      try { process.stdout.write(''); } catch {}
    }
  });
  process.stdin.on('error', () => {
    try { main(buf); } catch {
      try { process.stdout.write(''); } catch {}
    }
  });
} catch {
  // If stdin wiring itself fails, still emit something and exit cleanly.
  try { process.stdout.write(''); } catch {}
}
