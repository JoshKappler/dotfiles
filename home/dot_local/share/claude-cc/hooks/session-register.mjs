#!/usr/bin/env node
// session-register.mjs — Claude Control Center session lifecycle hook (WP3).
//
// Registered in ~/.claude/settings.json for the SessionStart and SessionEnd hook
// events. Reads the hook payload JSON on stdin and maintains the cc state root:
//   - SessionStart: writes panes/<ZELLIJ_PANE_ID> = <session_id> so a pane can
//     later resolve "which agent am I" for the inspector.
//   - SessionEnd: prunes this session's agents/<session_id>.json, any panes/*
//     file whose contents === session_id, and the subagents/<session_id>/ dir.
//
// Contract: zero npm deps, Node built-ins only. ALWAYS exits 0, never throws —
// a hook must never block or crash the Claude session.
//
// State root: <homedir>/.claude/state/cc
//   agents/<session_id>.json
//   panes/<ZELLIJ_PANE_ID>            (text = session_id)
//   subagents/<session_id>/<agent_id>.json
//
// --- Sample stdin fixtures (Claude Code hook payloads) -----------------------
// SessionStart:
//   { "hook_event_name": "SessionStart", "session_id": "sess-abc123",
//     "cwd": "/home/josh/projects/scuttle" }
// SessionEnd:
//   { "hook_event_name": "SessionEnd", "session_id": "sess-abc123",
//     "cwd": "/home/josh/projects/scuttle" }
//
// --- Manual test recipe ------------------------------------------------------
//   # Register a session into a fake pane:
//   ZELLIJ_PANE_ID=7 echo '{"hook_event_name":"SessionStart","session_id":"sess-abc123"}' \
//     | node session-register.mjs
//   cat ~/.claude/state/cc/panes/7          # -> sess-abc123
//
//   # End it (also create some debris first to prove cleanup):
//   mkdir -p ~/.claude/state/cc/subagents/sess-abc123
//   echo '{}' > ~/.claude/state/cc/agents/sess-abc123.json
//   echo '{"hook_event_name":"SessionEnd","session_id":"sess-abc123"}' \
//     | node session-register.mjs
//   ls ~/.claude/state/cc/agents/            # sess-abc123.json gone
//   ls ~/.claude/state/cc/panes/             # 7 gone
//   ls ~/.claude/state/cc/subagents/         # sess-abc123/ gone
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function stateRoot() {
  return path.join(os.homedir(), '.claude', 'state', 'cc');
}
function agentsDir() {
  return path.join(stateRoot(), 'agents');
}
function panesDir() {
  return path.join(stateRoot(), 'panes');
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
    // If nothing is ever piped, don't hang forever.
    setTimeout(() => resolve(buf), 2000).unref?.();
  });
}

function safeUnlink(p) {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}

function safeRmDir(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function onSessionStart(sessionId) {
  const paneId = process.env.ZELLIJ_PANE_ID;
  if (!paneId || !sessionId) return; // no pane id -> nothing to register
  ensureDir(panesDir());
  try {
    fs.writeFileSync(path.join(panesDir(), String(paneId)), String(sessionId), 'utf8');
  } catch {
    /* ignore */
  }
}

function onSessionEnd(sessionId) {
  if (!sessionId) return;
  // 1. agents/<session_id>.json
  safeUnlink(path.join(agentsDir(), `${sessionId}.json`));

  // 2. any panes/* file whose contents === session_id
  try {
    const dir = panesDir();
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        try {
          const contents = fs.readFileSync(full, 'utf8').trim();
          if (contents === String(sessionId)) safeUnlink(full);
        } catch {
          /* ignore unreadable entry */
        }
      }
    }
  } catch {
    /* ignore */
  }

  // 3. subagents/<session_id>/ dir
  safeRmDir(subagentsDir(sessionId));
}

async function main() {
  const raw = await readStdin();
  let j = {};
  try {
    j = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return; // bad/empty payload -> nothing to do
  }
  const event = j.hook_event_name;
  const sessionId = j.session_id;

  if (event === 'SessionStart') onSessionStart(sessionId);
  else if (event === 'SessionEnd') onSessionEnd(sessionId);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
