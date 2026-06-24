#!/usr/bin/env node
// agentbar.mjs — a one-line keyboard-shortcut guide pinned at the top of every
// agent tab (a panel of Claude instances), so you always know how to add/close an
// instance, switch windows, and get back to Home. Rendered as a SOLID reversed
// strip (green bar, dark text) so it is impossible to overlook among the agents'
// own green UIs. Stays alive (the pane would close if the command exited) and
// re-renders on resize. Zero deps.

const ESC = '\x1b';
const RESET = ESC + '[0m';
const BOLD = ESC + '[1m';
const REV = ESC + '[7m';   // reverse video — turns the whole row into a solid bar

function cols() { return (process.stdout.columns && process.stdout.columns > 0) ? process.stdout.columns : 80; }

// Ordered most-important first; trailing groups are dropped if the row is narrow,
// so the keys you need most survive even on a thin window. Plain text only — the
// whole line is painted as one reversed bar, so per-word colors would fight it.
function groups() {
  return [
    'SHORTCUTS',
    'Alt+Arrows = switch agent',
    'Alt+[ / Alt+] = switch tab',
    'Alt+a = add agent',
    'Ctrl+Alt+w = close agent',
    'Ctrl+Alt+q = close tab',
    'Ctrl+g = lock keys to Claude',
  ];
}

const SEP = '   .   ';
function build() {
  const W = cols();
  const gs = groups();
  let line = ' ' + gs[0];
  for (let i = 1; i < gs.length; i++) {
    const add = SEP + gs[i];
    if (line.length + add.length > W - 1) break;   // would overflow — stop adding
    line += add;
  }
  if (line.length > W) line = line.slice(0, W);
  if (line.length < W) line += ' '.repeat(W - line.length);   // pad so the bar fills the row
  return line;
}

function draw() {
  // Clear the single row and rewrite it as one solid reversed bar (no newline —
  // that would scroll the pane).
  try { process.stdout.write(ESC + '[2K\r' + REV + BOLD + build() + RESET); } catch { /* */ }
}

draw();
process.stdout.on('resize', draw);
// Keep the process (and therefore the pane) alive. Re-draw periodically too, so
// the bar reappears if the pane is cleared/redrawn by Zellij.
setInterval(draw, 5000);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
