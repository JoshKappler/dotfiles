#!/usr/bin/env node
// clone-all.mjs — clone-missing + safely fast-forward ALL of your GitHub repos
// into one root (the "clone all my git stuff, up to date" button on Home).
//
// Usage:
//   node clone-all.mjs [root] [--dry]
//     root   directory to populate (default: ~/OneDrive/desktop/projects, else ~)
//     --dry  enumerate + report intended actions, but do NOT clone/fetch/pull
//
// Behavior (safe by design — never discards local work):
//   - Enumerates your NON-FORK repos via `gh repo list --source`.
//   - For each repo (excluding `dotfiles`, the config repo):
//       * missing locally          -> `gh repo clone`            => action "cloned"
//       * present + dirty tree      -> fetch only, leave alone     => action "skipped" (dirty)
//       * present + detached HEAD   -> fetch only                  => action "skipped" (detached)
//       * present + clean, behind   -> `git pull --ff-only`        => action "updated"
//       * present + clean, current  -> nothing                     => action "up-to-date"
//   - Prints valid JSON: { root, repos: [ {name,action,branch,error}, ... ] }
//   - Exit 0 ALWAYS; per-repo failures are captured in `error`.
//
// gh is resolved from PATH, then well-known install locations, so it works even
// when launched from a thin-PATH context (e.g. a freshly spawned zellij pane).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXCLUDE = new Set(['dotfiles']); // the config repo lives at ~/.local/share/chezmoi

// ---------- gh resolution ----------
let GH = null;
function resolveGh() {
  if (GH) return GH;
  const candidates = ['gh'];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(path.join(pf, 'GitHub CLI', 'gh.exe'));
    candidates.push(path.join(pf86, 'GitHub CLI', 'gh.exe'));
  }
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      GH = c;
      return GH;
    } catch { /* try next */ }
  }
  GH = 'gh'; // last resort: let it ENOENT with a clear message
  return GH;
}

function gh(args) {
  return execFileSync(resolveGh(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function errMsg(e) {
  if (!e) return 'unknown error';
  const parts = [];
  if (e.stderr) parts.push(String(e.stderr).trim());
  if (e.stdout) parts.push(String(e.stdout).trim());
  let msg = parts.filter(Boolean).join(' ').trim();
  if (!msg) msg = (e.message || String(e)).trim();
  if (e.code === 'ENOENT') msg = 'command not found: ' + (e.path || 'gh/git');
  return msg.replace(/\s+/g, ' ').slice(0, 200);
}

// Map every clone already on disk, looking ONE level deep as well, so a repo you
// tucked into a grouping folder (e.g. projects/other/algora) is updated in place
// instead of being re-cloned as a top-level duplicate. Keyed by lowercased repo
// name (macOS/Windows filesystems are case-insensitive). A top-level clone always
// wins over a nested one of the same name.
function buildLocationMap(root) {
  const map = new Map(); // name(lowercased) -> absolute dir
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return map; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    if (fs.existsSync(path.join(dir, '.git'))) {
      map.set(e.name.toLowerCase(), dir);   // a repo sitting directly in root
      continue;                             // never descend into a repo
    }
    let kids;                               // a plain grouping folder — peek inside
    try { kids = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const k of kids) {
      if (!k.isDirectory()) continue;
      const key = k.name.toLowerCase();
      if (!map.has(key) && fs.existsSync(path.join(dir, k.name, '.git'))) {
        map.set(key, path.join(dir, k.name));
      }
    }
  }
  return map;
}

function defaultRoot() {
  const cand = path.join(os.homedir(), 'OneDrive', 'desktop', 'projects');
  try { if (fs.statSync(cand).isDirectory()) return cand; } catch { /* */ }
  const cand2 = path.join(os.homedir(), 'desktop', 'projects');
  try { if (fs.statSync(cand2).isDirectory()) return cand2; } catch { /* */ }
  return os.homedir();
}

function listRepos() {
  // --source = owned, non-fork repos only (skips forks like nuclei). Archived
  // repos are included so "all my git stuff" really means all of it.
  const raw = gh(['repo', 'list', '--source', '--limit', '300', '--json', 'name']);
  const arr = JSON.parse(raw.replace(/^[﻿\s]+/, ''));
  return arr.map((r) => r.name).filter(Boolean);
}

function ownerLogin() {
  try {
    const raw = gh(['api', 'user', '--jq', '.login']);
    return raw.trim();
  } catch {
    return null;
  }
}

function processRepo(owner, name, root, dry, existing) {
  const rec = { name, action: 'skipped', branch: null, error: null };
  // Update an existing clone wherever it already lives (incl. one level deep);
  // only a genuinely-missing repo is cloned fresh, at the top level of root.
  const dir = existing.get(name.toLowerCase()) || path.join(root, name);

  // Missing -> clone.
  if (!fs.existsSync(dir)) {
    if (dry) { rec.action = 'would-clone'; return rec; }
    try {
      const slug = owner ? `${owner}/${name}` : name;
      gh(['repo', 'clone', slug, dir]);
      rec.action = 'cloned';
    } catch (e) {
      rec.action = 'error';
      rec.error = errMsg(e);
    }
    return rec;
  }

  // Not a git repo (a stray folder of the same name) -> leave it.
  if (!fs.existsSync(path.join(dir, '.git'))) {
    rec.action = 'skipped';
    rec.error = 'not a git repo';
    return rec;
  }

  // Branch / detached detection. symbolic-ref works even on an unborn (empty)
  // repo and returns its branch name without error; it fails only on detached.
  let branch;
  try { branch = git(dir, ['symbolic-ref', '--short', 'HEAD']).trim(); }
  catch { branch = 'HEAD'; }
  rec.branch = branch;

  // Empty / unborn repo (branch with no commits yet) -> nothing to pull.
  let hasCommit = true;
  try { git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']); }
  catch { hasCommit = false; }
  if (!hasCommit) {
    rec.action = 'skipped';
    rec.error = 'empty repo';
    return rec;
  }

  if (branch === 'HEAD' || branch === '') {
    if (!dry) { try { git(dir, ['fetch', '--quiet']); } catch { /* */ } }
    rec.action = 'skipped';
    rec.error = 'detached HEAD';
    return rec;
  }

  // Dirty tree -> fetch only, never touch the work.
  let dirty = false;
  try { dirty = git(dir, ['status', '--porcelain']).trim() !== ''; }
  catch (e) { rec.action = 'error'; rec.error = errMsg(e); return rec; }
  if (dirty) {
    if (!dry) { try { git(dir, ['fetch', '--quiet']); } catch { /* */ } }
    rec.action = 'skipped';
    rec.error = 'dirty';
    return rec;
  }

  if (dry) { rec.action = 'would-update'; return rec; }

  // Clean: fetch + ff-only pull.
  try {
    git(dir, ['fetch', '--quiet']);
    const before = git(dir, ['rev-parse', 'HEAD']).trim();
    try {
      git(dir, ['pull', '--ff-only', '--quiet']);
    } catch (e) {
      rec.action = 'skipped';
      rec.error = 'no-ff (' + errMsg(e).slice(0, 60) + ')';
      return rec;
    }
    const after = git(dir, ['rev-parse', 'HEAD']).trim();
    rec.action = before === after ? 'up-to-date' : 'updated';
  } catch (e) {
    rec.action = 'error';
    rec.error = errMsg(e);
  }
  return rec;
}

function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const root = positional[0] ? path.resolve(positional[0]) : defaultRoot();

  const result = { root, repos: [] };

  try { fs.mkdirSync(root, { recursive: true }); } catch { /* */ }

  let names;
  try {
    names = listRepos();
  } catch (e) {
    result.error = 'could not list repos: ' + errMsg(e);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
    return;
  }

  const existing = buildLocationMap(root);
  const owner = ownerLogin();
  for (const name of names) {
    if (EXCLUDE.has(name.toLowerCase())) continue;
    result.repos.push(processRepo(owner, name, root, dry, existing));
  }

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(0);
}

main();
