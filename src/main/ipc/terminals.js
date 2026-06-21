// Terminals (node-pty). Each open terminal is an independent pseudo-terminal keyed by
// id, so many worktree folders can have their own live shell at once. The renderer
// (window.taskhub.term) drives each by id: create → write/onData → resize → kill.
// Output is pushed to the window as `term:data` events; the shell's death is announced
// as `term:exit`.
const { app, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const { sendToWin } = require('../windows/window');
const { CH } = require('../../shared/channels');

const terminals = new Map(); // id -> { pty, cwd, title, paired, pairKey, hasContext, chunks, bufLen, seq }
let termSeq = 0;
const TERM_BUF_MAX = 256 * 1024; // per-terminal output kept for replay when a window reattaches

function registerIpc() {
  // Spawn a login + interactive shell so it sources the user's dotfiles and gets the
  // full environment (PATH, nvm, Homebrew, aliases) — identical to a Terminal.app tab.
  ipcMain.handle(CH.TERM_CREATE, (_e, { cwd, shell: sh, paired = false, pairKey = '' } = {}) => {
    const id = 'pty' + (++termSeq);
    // Fallback when no workspace is given: the app's own repo (dev), else home. In a
    // packaged build getAppPath() points inside app.asar, which isn't a usable cwd.
    const appPath = app.getAppPath();
    const fallback = appPath && !appPath.includes('app.asar') ? appPath : os.homedir();
    const dir = cwd && typeof cwd === 'string' ? cwd : fallback;
    const shellPath = sh || process.env.SHELL || '/bin/zsh';
    const p = pty.spawn(shellPath, ['-l', '-i'], {
      name: 'xterm-256color',
      cwd: dir,
      cols: 80, rows: 24,
      // TASKHUB_RUN_ID lets an installed Claude/Codex hook ping back tagged with THIS terminal's
      // id (the hook echoes ${TASKHUB_RUN_ID}), so the renderer can drive this tab's busy spinner.
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8', TASKHUB_RUN_ID: id },
    });
    const entry = { pty: p, cwd: dir, title: path.basename(dir) || dir, paired: !!paired, pairKey: String(pairKey || ''), hasContext: false, chunks: [], bufLen: 0, seq: 0, shell: path.basename(shellPath) };
    // Keep a rolling tail of output as WHOLE chunks (never sliced mid-byte/escape) so a
    // window that was closed and reopened can replay the recent screen. Each chunk carries a
    // monotonic seq so the renderer can replay the backlog and then resume the live stream
    // with neither a gap nor a duplicate across the attach round-trip.
    p.onData(chunk => {
      entry.chunks.push(chunk);
      entry.bufLen += chunk.length;
      while (entry.bufLen > TERM_BUF_MAX && entry.chunks.length > 1) entry.bufLen -= entry.chunks.shift().length;
      // A single chunk bigger than the cap would otherwise keep the buffer unbounded; clamp it
      // to its tail so replay memory stays bounded (rare — PTY reads are normally well under it).
      if (entry.bufLen > TERM_BUF_MAX && entry.chunks.length === 1) {
        entry.chunks[0] = entry.chunks[0].slice(-TERM_BUF_MAX);
        entry.bufLen = entry.chunks[0].length;
      }
      sendToWin(CH.TERM_DATA, { id, chunk, seq: ++entry.seq }); // live stream always gets the full chunk
    });
    p.onExit(({ exitCode, signal }) => { terminals.delete(id); sendToWin(CH.TERM_EXIT, { id, exitCode, signal }); });
    terminals.set(id, entry);
    return { id, cwd: dir, title: path.basename(dir) || dir, paired: entry.paired, pairKey: entry.pairKey, hasContext: entry.hasContext };
  });

  ipcMain.on(CH.TERM_WRITE,  (_e, { id, data })       => { const t = terminals.get(id); if (t) { t.hasContext = true; t.pty.write(data); } });
  ipcMain.on(CH.TERM_RESIZE, (_e, { id, cols, rows }) => { try { terminals.get(id)?.pty.resize(cols, rows); } catch {} });
  ipcMain.handle(CH.TERM_KILL, (_e, { id }) => { killTerm(id); return true; });
  // Lets the renderer rehydrate its terminal list after a reload (PTYs outlive the page).
  ipcMain.handle(CH.TERM_LIST, () => [...terminals.entries()].map(([id, t]) => ({ id, cwd: t.cwd, title: t.title, paired: !!t.paired, pairKey: t.pairKey || '', hasContext: !!t.hasContext })));
  // Reattach to a live PTY after the window was reopened: returns the buffered backlog to
  // replay plus the seq of its last chunk, so the renderer can resume the live stream cleanly.
  ipcMain.handle(CH.TERM_ATTACH, (_e, { id }) => {
    const t = terminals.get(id);
    return t ? { buf: t.chunks.join(''), seq: t.seq } : { buf: '', seq: 0 };
  });
  // The PTY's current foreground process, compared against the shell THIS terminal was spawned
  // with (no hardcoded shell list). atShell=true ⇒ sitting at a prompt; false ⇒ a program (e.g.
  // an already-running claude/codex) is in the foreground. Unknown → assume at-prompt.
  ipcMain.handle(CH.TERM_FG, (_e, { id }) => {
    const t = terminals.get(id);
    if (!t) return { process: '', atShell: true };
    let proc = '';
    try { proc = (t.pty.process || '').trim(); } catch {}
    if (proc) return { process: proc, atShell: proc === t.shell };
    // Process name unreadable on this platform → fall back to whether a child process is running
    // under the PTY (a CLI in the foreground ⇒ not at a prompt). Safer than assuming "at shell".
    let busy = false;
    try { const { hasChildProcess } = require('../native/usage'); busy = hasChildProcess(t.pty.pid); } catch {}
    return { process: '', atShell: !busy };
  });
}

const getPids = () => [...terminals.values()].map(t => t.pty.pid).filter(Boolean);

// Kill a terminal's PTY and drop it from the registry. The one teardown path so every
// removal (explicit kill, reap-on-window-close) stays in sync.
function killTerm(id) {
  const t = terminals.get(id);
  if (!t) return;
  try { t.pty.kill(); } catch {}
  terminals.delete(id);
}

function killAll() {
  for (const id of [...terminals.keys()]) killTerm(id);
}

// Reap the terminals with nothing worth preserving when the dashboard window closes:
// PTYs deliberately outlive the window so running work survives a reopen, but a bare
// shell prompt is dead weight until app quit. "Worth preserving" = was typed into
// (hasContext) OR is currently running a child process (e.g. a command auto-started by
// the shell's dotfiles, which never set hasContext since no key was pressed).
function killEmpty() {
  const { hasChildProcess } = require('../native/usage'); // lazy: usage.js requires this module
  for (const [id, t] of terminals) {
    if (t.hasContext || hasChildProcess(t.pty.pid)) continue;
    killTerm(id);
  }
}

module.exports = { registerIpc, getPids, killAll, killEmpty };
