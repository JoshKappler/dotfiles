#!/usr/bin/env node
// git-push-all.mjs — mass git-push for the Claude Control Center (WP4).
//
// Usage:
//   node git-push-all.mjs [root] [--dry]
//     root   directory to scan (default: process.cwd())
//     --dry  do everything EXCEPT the final `git push` (reports pushed:true
//            as if it would have pushed; for safe local testing)
//
// Behavior:
//   - Discovers repos: <root> itself if it contains `.git`, PLUS each immediate
//     child directory containing a `.git` entry (one level deep only).
//   - For each repo: skip if detached HEAD ("detached HEAD"), skip if clean and
//     nothing ahead of upstream (error:null), skip if no upstream ("no upstream").
//     Otherwise `git push` -> pushed:true. On push failure, capture the message.
//   - EXCLUDES any repo whose folder basename is `dotfiles`, and the chezmoi
//     source repo (toplevel == C:\Users\joshu\.local\share\chezmoi, realpath-aware,
//     case-insensitive, separator-normalized).
//   - Prints valid JSON: { "repos": [ {"path","branch","pushed","error"}, ... ] }
//   - Exit 0 ALWAYS, even when individual repos error.
//
// Manual test recipe (safe — no real pushes):
//   # 1. Make a throwaway sandbox with a clean repo, a dirty repo, a detached
//   #    repo, and an upstream-less repo, then run with --dry.
//   mkdir -p /tmp/ccgit && cd /tmp/ccgit
//   git init origin.git --bare
//   git init clean && (cd clean && git remote add origin ../origin.git \
//     && git commit --allow-empty -m init && git push -u origin HEAD \
//     && git branch --set-upstream-to=origin/$(git rev-parse --abbrev-ref HEAD))
//   cp -r clean dirty && (cd dirty && echo x > f.txt)              # dirty tree
//   git init noupstream && (cd noupstream && git commit --allow-empty -m a)
//   git init detached && (cd detached && git commit --allow-empty -m a \
//     && git checkout --detach HEAD)
//   node /path/to/git-push-all.mjs /tmp/ccgit --dry
//   # Expect JSON: clean -> pushed:false error:null; dirty -> pushed:true (dry);
//   #   noupstream -> pushed:false error:"no upstream";
//   #   detached -> pushed:false error:"detached HEAD".
//
//   # 2. To prove a real push would run, drop --dry — but ONLY against a
//   #    throwaway bare remote like above. Never against live dirty repos.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHEZMOI_DIR = 'C:\\Users\\joshu\\.local\\share\\chezmoi';

// Normalize a path for case-insensitive, separator-agnostic comparison.
// Resolves symlinks/realpath when the path exists.
function canon(p) {
  if (!p) return '';
  let resolved = p;
  try {
    resolved = fs.realpathSync(p);
  } catch {
    resolved = path.resolve(p);
  }
  return resolved.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Pre-compute the canonical chezmoi dir (try both the literal path and realpath).
const CHEZMOI_CANON = new Set([canon(CHEZMOI_DIR)]);
{
  // Also add the plain-resolved form in case realpath differs from resolve.
  CHEZMOI_CANON.add(CHEZMOI_DIR.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase());
}

function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Returns true if a directory has a `.git` entry (dir or file — worktrees use a file).
function hasGit(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

// Discover candidate repo paths: <root> itself + immediate children with `.git`.
function discoverRepos(root) {
  const repos = [];
  const seen = new Set();

  const add = (p) => {
    const key = canon(p);
    if (!seen.has(key)) {
      seen.add(key);
      repos.push(p);
    }
  };

  if (hasGit(root)) add(root);

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const ent of entries) {
    let isDir = false;
    try {
      // Follow symlinked dirs too.
      isDir = ent.isDirectory() || (ent.isSymbolicLink() &&
        fs.statSync(path.join(root, ent.name)).isDirectory());
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const child = path.join(root, ent.name);
    if (hasGit(child)) add(child);
  }

  return repos;
}

// Decide whether a repo should be excluded (dotfiles or the chezmoi source).
function isExcluded(repoPath) {
  if (path.basename(repoPath).toLowerCase() === 'dotfiles') return true;
  let top = '';
  try {
    top = git(repoPath, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    top = repoPath;
  }
  if (CHEZMOI_CANON.has(canon(top))) return true;
  return false;
}

// Process one repo, return its result record (never throws).
function processRepo(repoPath, dry) {
  const rec = { path: repoPath, branch: null, pushed: false, error: null };

  // Branch / detached-HEAD detection.
  let branch;
  try {
    branch = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch (e) {
    rec.error = errMsg(e);
    return rec;
  }
  rec.branch = branch;
  if (branch === 'HEAD' || branch === '') {
    rec.error = 'detached HEAD';
    return rec;
  }

  // Upstream presence.
  let hasUpstream = true;
  try {
    git(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    hasUpstream = false;
  }

  // Working-tree dirty?
  let dirty = false;
  try {
    dirty = git(repoPath, ['status', '--porcelain']).trim() !== '';
  } catch (e) {
    rec.error = errMsg(e);
    return rec;
  }

  // Commits ahead of upstream (only meaningful when an upstream exists).
  let ahead = 0;
  if (hasUpstream) {
    try {
      ahead = parseInt(git(repoPath, ['rev-list', '--count', '@{u}..HEAD']).trim(), 10);
      if (!Number.isFinite(ahead)) ahead = 0;
    } catch {
      ahead = 0;
    }
  }

  // Clean AND nothing ahead -> nothing to push.
  if (!dirty && ahead === 0) {
    rec.pushed = false;
    rec.error = null;
    return rec;
  }

  // Dirty/ahead but no upstream -> can't push.
  if (!hasUpstream) {
    rec.error = 'no upstream';
    return rec;
  }

  // Push (or pretend to, under --dry).
  if (dry) {
    rec.pushed = true;
    rec.error = null;
    return rec;
  }
  try {
    git(repoPath, ['push']);
    rec.pushed = true;
    rec.error = null;
  } catch (e) {
    rec.pushed = false;
    rec.error = errMsg(e);
  }
  return rec;
}

// Extract a concise error message from an execFileSync failure.
function errMsg(e) {
  if (!e) return 'unknown error';
  const parts = [];
  if (e.stderr) parts.push(String(e.stderr).trim());
  if (e.stdout) parts.push(String(e.stdout).trim());
  let msg = parts.filter(Boolean).join(' ').trim();
  if (!msg) msg = (e.message || String(e)).trim();
  // Collapse whitespace to keep JSON tidy.
  return msg.replace(/\s+/g, ' ');
}

function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const root = positional[0] ? path.resolve(positional[0]) : process.cwd();

  const repos = [];
  for (const repoPath of discoverRepos(root)) {
    if (isExcluded(repoPath)) continue;
    repos.push(processRepo(repoPath, dry));
  }

  process.stdout.write(JSON.stringify({ repos }) + '\n');
  process.exit(0);
}

main();
