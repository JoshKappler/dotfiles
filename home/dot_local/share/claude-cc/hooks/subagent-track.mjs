#!/usr/bin/env node
// subagent-track.mjs — Claude Control Center subagent activity hook (WP3).
//
// Registered in ~/.claude/settings.json for SubagentStart, SubagentStop,
// TaskCreated, TaskCompleted, PreToolUse, PostToolUse. Reads the hook payload
// JSON on stdin and maintains one file per subagent:
//   <stateRoot>/subagents/<session_id>/<agent_id>.json
// read live by inspector.mjs (and Home).
//
// Schema (copy verbatim from the plan's shared interface contract):
//   { "agentId","agentType","label","status","lastTool","lastDetail",
//     "startedAt","updatedAt" }
//   status in { running | done | error }.
//
// Event handling:
//   SubagentStart / TaskCreated   -> upsert, status "running"
//   PreToolUse / PostToolUse      -> (only if agent_id present) lastTool/lastDetail
//   SubagentStop / TaskCompleted  -> status "done"
// Keyed by agent_id; parent = session_id. Skips cleanly when agent_id missing.
//
// Contract: zero npm deps, Node built-ins only. ALWAYS exits 0, never throws.
//
// --- Sample stdin fixtures (Claude Code hook payloads) -----------------------
// SubagentStart:
//   { "hook_event_name": "SubagentStart", "session_id": "sess-abc123",
//     "agent_id": "agt-001", "agent_type": "Explore",
//     "description": "search auth code", "cwd": "/home/josh/projects" }
//
// PreToolUse (inside a subagent — note agent_id present):
//   { "hook_event_name": "PreToolUse", "session_id": "sess-abc123",
//     "agent_id": "agt-001", "agent_type": "Explore",
//     "tool_name": "Grep",
//     "tool_input": { "pattern": "auth", "glob": "**/*.ts" } }
//
// SubagentStop:
//   { "hook_event_name": "SubagentStop", "session_id": "sess-abc123",
//     "agent_id": "agt-001", "agent_type": "Explore" }
//
// --- Manual test recipe ------------------------------------------------------
//   P='{"hook_event_name":"SubagentStart","session_id":"s1","agent_id":"a1","agent_type":"Explore","description":"search auth code"}'
//   echo "$P" | node subagent-track.mjs
//   cat ~/.claude/state/cc/subagents/s1/a1.json    # status running, label set
//
//   T='{"hook_event_name":"PreToolUse","session_id":"s1","agent_id":"a1","tool_name":"Grep","tool_input":{"pattern":"auth"}}'
//   echo "$T" | node subagent-track.mjs
//   cat ~/.claude/state/cc/subagents/s1/a1.json    # lastTool Grep, lastDetail auth
//
//   D='{"hook_event_name":"SubagentStop","session_id":"s1","agent_id":"a1"}'
//   echo "$D" | node subagent-track.mjs
//   cat ~/.claude/state/cc/subagents/s1/a1.json    # status done
//
//   node inspector.mjs s1                           # renders the live table
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function stateRoot() {
  return path.join(os.homedir(), '.claude', 'state', 'cc');
}
function subagentsDir(parent) {
  return path.join(stateRoot(), 'subagents', String(parent));
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    try {
      process.stdin.setEncoding('utf8');
    } catch {
      /* ignore */
    }
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    setTimeout(() => resolve(buf), 2000).unref?.();
  });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function truncate(s, n = 40) {
  if (s == null) return '';
  let str = String(s).replace(/\s+/g, ' ').trim();
  // ASCII-safe: drop control chars.
  str = str.replace(/[^\x20-\x7e]/g, '');
  if (str.length > n) str = str.slice(0, n - 1) + '…';
  return str;
}

// Build a short, readable one-line summary of a tool_input object.
// Picks the most useful field for common tools, falling back to the first
// usable string-ish value.
function summarizeToolInput(input) {
  if (input == null || typeof input !== 'object') return '';
  // Order of preference: the field that best identifies what the tool is doing.
  const preferred = [
    'file_path',
    'path',
    'pattern',
    'command',
    'query',
    'url',
    'prompt',
    'description',
    'old_string',
    'content',
  ];
  for (const key of preferred) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return truncate(v);
  }
  // Fallback: first string / number value found.
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return truncate(v);
    if (typeof v === 'number') return truncate(String(v));
  }
  return '';
}

function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeRecord(file, rec) {
  try {
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function upsert(parent, agentId, mutate) {
  ensureDir(subagentsDir(parent));
  const file = path.join(subagentsDir(parent), `${agentId}.json`);
  const existing = readRecord(file);
  const isNew = !existing;
  const rec = existing || {
    agentId: String(agentId),
    agentType: '',
    label: '',
    status: 'running',
    lastTool: '',
    lastDetail: '',
    startedAt: nowSec(),
    updatedAt: nowSec(),
  };
  // Guarantee the key fields exist even on legacy records.
  rec.agentId = String(agentId);
  if (typeof rec.startedAt !== 'number') rec.startedAt = nowSec();
  mutate(rec, isNew);
  rec.updatedAt = nowSec();
  writeRecord(file, rec);
}

async function main() {
  const raw = await readStdin();
  let j = {};
  try {
    j = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return;
  }

  const event = j.hook_event_name;
  const parent = j.session_id;
  const agentId = j.agent_id;

  // Everything we record is keyed by agent_id under a parent session. Without an
  // agent_id there is no subagent to track (these events also fire in the main
  // session) -> skip cleanly.
  if (!agentId || !parent) return;

  switch (event) {
    case 'SubagentStart':
    case 'TaskCreated': {
      upsert(parent, agentId, (rec) => {
        if (j.agent_type) rec.agentType = String(j.agent_type);
        const label = j.description || j.label || j.agent_type;
        if (label) rec.label = truncate(label, 60);
        rec.status = 'running';
      });
      break;
    }
    case 'PreToolUse':
    case 'PostToolUse': {
      upsert(parent, agentId, (rec) => {
        if (j.agent_type && !rec.agentType) rec.agentType = String(j.agent_type);
        if (j.tool_name) rec.lastTool = String(j.tool_name);
        const detail = summarizeToolInput(j.tool_input);
        if (detail) rec.lastDetail = detail;
        // Keep running unless already closed.
        if (rec.status !== 'done' && rec.status !== 'error') rec.status = 'running';
      });
      break;
    }
    case 'SubagentStop':
    case 'TaskCompleted': {
      upsert(parent, agentId, (rec) => {
        rec.status = 'done';
      });
      break;
    }
    default:
      break;
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
