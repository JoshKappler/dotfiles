#!/usr/bin/env node
// agentbar.mjs — a one-line keyboard-shortcut guide pinned at the top of every
// agent tab (a panel of Claude instances), so you always know how to switch
// windows, add/close an instance, and get back to Home. Stays alive (the pane
// would close if the command exited) and re-renders on resize. Zero deps.

const ESC = '\x1b';
const RESET = ESC + '[0m';
const GREEN = ESC + '[32m';
const BGREEN = ESC + '[92m';
const BBLUE = ESC + '[94m';
const BOLD = ESC + '[1m';

function key(s) { return { plain: '[' + s + ']', styled: BOLD + BBLUE + '[' + s + ']' + RESET }; }
function txt(s) { return { plain: s, styled: GREEN + s + RESET }; }
function lbl(s) { return { plain: s, styled: BOLD + BGREEN + s + RESET }; }
const SEP = { plain: '  |  ', styled: BBLUE + '  |  ' + RESET };

function cols() { return (process.stdout.columns && process.stdout.columns > 0) ? process.stdout.columns : 80; }

// Ordered most-important first; trailing groups are dropped if the row is narrow.
function groups() {
  return [
    [lbl('KEYS')],
    [{ plain: 'Alt+[ Alt+]', styled: BOLD + BBLUE + 'Alt+[ Alt+]' + RESET }, txt(' switch window')],
    [key('Alt+a'), txt(' add')],
    [key('Ctrl+Alt+w'), txt(' close')],
    [{ plain: 'Ctrl+h', styled: BOLD + BBLUE + 'Ctrl+h' + RESET }, txt(' +arrows move pane')],
    [key('Ctrl+g'), txt(' lock to Claude')],
    [txt('Home = leftmost tab')],
  ];
}

function build() {
  const W = cols();
  const gs = groups();
  let plain = ' ';
  let styled = ' ';
  for (let i = 0; i < gs.length; i++) {
    const segPlain = gs[i].map((p) => p.plain).join('');
    const segStyled = gs[i].map((p) => p.styled).join('');
    const add = (i === 0 ? '' : SEP.plain) + segPlain;
    if (plain.length + add.length > W - 1) break; // would overflow this row — stop
    styled += (i === 0 ? '' : SEP.styled) + segStyled;
    plain += add;
  }
  return styled;
}

function draw() {
  // Clear the single row and rewrite (no newline — that would scroll the pane).
  try { process.stdout.write(ESC + '[2K\r' + build() + RESET); } catch { /* */ }
}

draw();
process.stdout.on('resize', draw);
// Keep the process (and therefore the pane) alive. Re-draw periodically too, so
// the bar reappears if the pane is cleared/redrawn by Zellij.
setInterval(draw, 5000);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
