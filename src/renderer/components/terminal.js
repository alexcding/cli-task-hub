// Terminals (xterm.js, backed by main-process PTYs). Shares the right-side viewer
// with webview tabs (only one pane shown at a time); each terminal is an xterm view
// bound to a main-process PTY by id.
import { state, activeTab } from '../stores/store.js';
import { codeFontStack, loadScript } from '../lib/util.js';
import { agentOutput } from '../lib/terminal-tail.mjs';
import { termTheme } from '../services/theme.js';
import { renderTabs, refreshTermBusy } from './sidebar.js';
import { ensurePanelOpen, hideAllPanes, updateNavButtons, closeSplit, activateTab as activateWebTab } from './viewer.js';
import { clearPrLayout } from './split.js';

// Load the vendored xterm bundle + addons once, on first use (keeps it off the
// initial page load). Resolves when window.Terminal / FitAddon / WebglAddon exist.
let _xtReady = null;
// xterm.js + addons are UMD — if Monaco's AMD loader has set a global define() with `.amd`,
// they'd register as anonymous AMD modules instead of setting window.Terminal/FitAddon. Drop
// the marker immediately before EACH script evaluates (not once up front) so a Monaco load
// running concurrently can't re-install it in the gap. Monaco doesn't need the marker.
const loadUmd = src => { try { if (window.define) delete window.define.amd; } catch {} return loadScript(src); };
export function loadXterm() {
  if (_xtReady) return _xtReady;
  _xtReady = (async () => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/xterm.css'; document.head.appendChild(css);
    await loadUmd('/vendor/xterm.js');
    await Promise.all([loadUmd('/vendor/xterm-addon-fit.js'), loadUmd('/vendor/xterm-addon-webgl.js')]);
    await ensureTermFont(); // load SF Mono (if present) before xterm measures glyph width
  })();
  return _xtReady;
}

// Await the SF Mono loads (system copy + the one served from /sf-mono) so xterm
// measures the real glyph width. The font stack itself lives in util.js
// (codeFontStack), shared with the diff pane and configurable in Settings.
async function ensureTermFont() {
  if (!document.fonts) return;
  try { await Promise.all([document.fonts.load('13px "SF Mono"'), document.fonts.load('13px "SFMonoServed"')]); } catch {}
}

// POSIX single-quote a path so spaces and shell metacharacters survive being typed into
// the shell (a single quote inside the path is closed, escaped, and reopened).
const shQuote = p => `'${String(p).replace(/'/g, `'\\''`)}'`;

// Write dropped/pasted file paths into the PTY as quoted, space-separated tokens (with a
// trailing space so they read as arguments). Marks the terminal as having context.
function insertTermPaths(entry, paths) {
  const text = paths.filter(Boolean).map(shQuote).join(' ');
  if (!text) return false;
  entry.hasContext = true;
  taskhub.term.write(entry.id, text + ' ');
  return true;
}

// Tauri build: the OS file-drop is captured by Tauri (the DOM `drop` above gets no files), so the
// bridge resolves the terminal under the cursor and hands the dropped paths here. (Electron uses the
// DOM drop + pathForFile path above; this hook is inert there.)
if (typeof window !== 'undefined' && window.__TAURI__) {
  window.__taskhubTermDrop = (id, paths) => {
    const entry = state.terms.get(id);
    if (entry) insertTermPaths(entry, paths);
  };
}

// Finder → terminal path entry: drop a file/folder (or paste one copied in Finder) and its
// absolute path is typed at the prompt. webUtils.getPathForFile (via the preload) resolves
// the path; it returns '' for clipboard image bytes that aren't a real file.
//
// A pasted IMAGE (a screenshot — bytes, not a file) can't be typed as a path. The terminal
// never carries the image itself; instead Claude Code (a real host process behind the PTY)
// reads the macOS clipboard directly when it receives Ctrl+V (\x16). ⌘V normally never gets
// there because the browser/xterm consume it for text paste — so on a ⌘V image paste we
// forward \x16 to the PTY, letting Claude Code grab the still-present clipboard image. (Plain
// Ctrl+V already reaches the PTY as \x16 via xterm, so that path works without us.)
function wireTermDnd(el, entry, term) {
  el.dataset.termId = entry.id;   // lets the Tauri bridge route a window-level file drop to this PTY
  el.addEventListener('dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  el.addEventListener('drop', e => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return; // a text/selection drag — let xterm handle it
    e.preventDefault();
    const paths = files.map(f => taskhub.pathForFile(f)).filter(Boolean);
    if (insertTermPaths(entry, paths)) term.focus();
  });
  // Capture phase, on the container: fires before xterm's own paste handler (on its inner
  // textarea), so we can preventDefault before xterm pastes nothing for a file/image.
  el.addEventListener('paste', e => {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = [...(cd.files || [])];
    // A real file (dragged-in or Finder-copied) → insert its path.
    const paths = files.map(f => taskhub.pathForFile(f)).filter(Boolean);
    if (paths.length) { e.preventDefault(); e.stopPropagation(); insertTermPaths(entry, paths); return; }
    // No path, but the clipboard holds an image (a screenshot — checked via files AND items,
    // since Chromium exposes it through either) → forward Ctrl+V so a clipboard-reading TUI
    // (Claude Code) reads the image itself, instead of xterm dropping it.
    const hasImage = files.some(f => f.type.startsWith('image/'))
      || [...(cd.items || [])].some(it => it.kind === 'file' && it.type.startsWith('image/'));
    if (hasImage) {
      e.preventDefault(); e.stopPropagation();
      entry.hasContext = true;
      taskhub.term.write(entry.id, '\x16');
    }
    // else: plain text → fall through to xterm's native paste.
  }, true);
}

// Create an xterm view bound to a fresh PTY (does NOT activate it). `paired` marks a
// terminal that belongs to a GitHub/Jira tab and `pairKey` is that tab's URL.
// Detect file paths printed in terminal output (Claude Code / build tools / stack traces) and
// make them clickable — opening the file in an editor tab. Matches path-with-extension tokens
// that contain a slash (so a bare word isn't a false positive), with an optional :line[:col].
// Registered per terminal; failures are swallowed so a link-API change never breaks the term.
const FILE_LINK_RE = /(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)+[\w.@+-]+\.[\w]+(?::\d+(?::\d+)?)?/g;

function wireFileLinks(term, getEntry) {
  try {
    term.registerLinkProvider({
      provideLinks(lineNo, callback) {
        const line = term.buffer.active.getLine(lineNo - 1);
        if (!line) { callback(undefined); return; }
        const text = line.translateToString(true);
        const links = [];
        FILE_LINK_RE.lastIndex = 0;
        let m;
        while ((m = FILE_LINK_RE.exec(text))) {
          const raw = m[0];
          if (raw.includes('://')) continue;                 // part of a URL, not a file path
          links.push({
            text: raw,
            range: { start: { x: m.index + 1, y: lineNo }, end: { x: m.index + raw.length, y: lineNo } },
            activate: () => openFileLink(raw, getEntry?.()),
          });
        }
        callback(links.length ? links : undefined);
      },
    });
  } catch { /* link provider API unavailable — terminals still work */ }
}

// Resolve a clicked path token (strip a trailing :line[:col], join a relative path to the
// terminal's cwd) and open it in an editor tab at the given line.
function openFileLink(raw, entry) {
  let p = raw, line = 0;
  const mm = raw.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (mm) { p = mm[1]; line = parseInt(mm[2], 10); }
  if (!p.startsWith('/') && !p.startsWith('~')) {
    const cwd = entry?.cwd ? entry.cwd.replace(/\/$/, '') : '';
    p = cwd ? cwd + '/' + p : p;
  }
  window.openFileTab?.(p, line);
}

export async function createTermView(cwd, title, { paired = false, pairKey = '' } = {}) {
  await loadXterm();
  const { id, cwd: dir, title: t, pairKey: key, hasContext } = await taskhub.term.create({ cwd: cwd || undefined, paired, pairKey });
  return attachTermView(id, dir, title || t, { paired, pairKey: key || pairKey, hasContext });
}

// Build an xterm view bound to an EXISTING PTY id (used right after create and to
// rehydrate live PTYs after the window was closed and reopened). `replay` re-draws the
// PTY's buffered output captured while no window was attached. Does NOT activate the view.
export async function attachTermView(id, dir, title, { paired = false, pairKey = '', hasContext = false, replay = false } = {}) {
  await loadXterm();
  const th = termTheme();
  const el = document.createElement('div');
  el.className = 'term-pane'; el.style.display = 'none'; el.style.background = th.background;
  document.getElementById('split-body').appendChild(el);
  // fontWeight 450 (vs the default 400): the WebGL renderer rasterizes glyphs with grayscale AA
  // and no stem-darkening, so SF Mono comes out thin on macOS — a hair over normal restores
  // some of the heft the native font-smoothing would otherwise give, without reading as medium.
  const term = new Terminal({ cursorBlink: true, fontSize: state.fonts.term.size, fontFamily: codeFontStack(state.fonts.term.family),
    fontWeight: 450, fontWeightBold: 650, theme: th, scrollback: 4000, allowProposedApi: true });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  wireFileLinks(term, () => state.terms.get(id)); // ⌘-click a printed file path → open it in an editor tab
  // GPU renderer. The WebGL context can be lost (GPU reset, sleep/wake, the window backgrounded);
  // when it is, the addon stops painting and the terminal would freeze blank. Dispose it on loss so
  // xterm falls back to its DOM renderer (slower, but always paints) instead of a dead screen.
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
    term.loadAddon(webgl);
  } catch {} // WebGL unavailable → xterm uses the DOM renderer
  // Tasks-page status fields: `cli` (claude/codex, from the hook SSE events) labels the session;
  // `summary`/`state` hold the last headless-analysis result for the card; `summaryFor` is the
  // message text we last analyzed (dedupe key). The live preview is read off the xterm buffer.
  const entry = { id, el, term, fit, off: null, offExit: null, cwd: dir, title, paired, pairKey, hasContext: !!hasContext, busy: false, cli: '', summary: '', state: '', summaryFor: '', gen: 0 };
  // Register in state.terms and wire BOTH listeners before any await. On replay there's an
  // attach round-trip below; if the PTY exits during it, onExit must already be subscribed
  // (and the entry findable) so onTermExit → disposeTerm cleans up instead of leaving a
  // frozen view whose paired tab never collapses.
  state.terms.set(id, entry);
  // keystrokes → PTY. A shell prompt by itself is disposable; once the user types, closing its
  // task tab asks before stopping the PTY.
  term.onData(d => {
    entry.hasContext = true;
    taskhub.term.write(id, d);
  });
  // Shift+Enter and Shift+Backspace: xterm sends the SAME bytes for these as the un-shifted keys
  // (CR for Enter, DEL for Backspace), so a TUI can't tell them apart — we intercept each combo and
  // inject the sequence the TUI understands:
  //   • Shift+Enter → LF (\x0a, == Ctrl+J): Claude Code / Codex insert a newline (plain Enter still
  //     sends \r = submit).
  //   • Shift+Backspace → NAK (\x15, == Ctrl+U): kill the input line back to the start (plain
  //     Backspace still deletes one char).
  // Returning false stops xterm's default handling (so onData doesn't also fire the plain key); we
  // write the byte ourselves on keydown.
  term.attachCustomKeyEventHandler(e => {
    if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'Enter' || e.key === 'Backspace')) {
      if (e.type === 'keydown') { entry.hasContext = true; taskhub.term.write(id, e.key === 'Enter' ? '\n' : '\x15'); }
      return false;
    }
    return true;
  });
  wireTermDnd(el, entry, term); // drag/paste a Finder file → its path typed at the prompt
  entry.offExit = taskhub.term.onExit(id, () => onTermExit(id, state.terms.get(id)?.paired));
  // Subscribe to live output FIRST. On replay we queue chunks until the buffered backlog is
  // written, then flush only the chunks newer than the backlog (by seq) — so output produced
  // during the attach round-trip is neither dropped nor duplicated at the boundary.
  let flushing = !!replay;
  const queued = [];
  entry.off = taskhub.term.onData(id, (chunk, seq) => {
    if (flushing) queued.push({ seq, chunk });
    else term.write(chunk);
  });
  if (replay) {
    let attachSeq = 0;
    try {
      const res = await taskhub.term.attach(id);
      const buf = typeof res === 'string' ? res : res?.buf;
      if (buf) term.write(buf);
      attachSeq = typeof res === 'object' && res ? res.seq || 0 : 0;
    } catch {}
    // The PTY may have exited mid-round-trip; disposeTerm() then dropped our entry. Bail
    // rather than writing to a disposed xterm (re-adding happened above, before the await).
    if (state.terms.get(id) !== entry) return id;
    flushing = false;
    for (const q of queued) if (q.seq > attachSeq) term.write(q.chunk);
  }
  return id;
}

// The tab "working" spinner is driven ENTIRELY by the chosen CLI's hooks (turn-start/turn-done over
// SSE) — there is no output-based fallback. So the spinner means exactly "a hook-enabled claude/codex
// turn is running"; a plain shell command, a build, or a CLI without the hook installed shows no
// spinner. Only paired terminals carry a tab indicator.

// turn-done (or disposal): clear the spinner AND resolve any workflow step waiting on this turn.
function goIdle(entry) {
  if (entry.busy) { entry.busy = false; refreshTermBusy(); }
  flushTurnWaiters(entry.id, true);
}

// Record which CLI (claude/codex) a paired terminal is running, from the hook SSE events
// (see app.js). Labels the session on the Tasks page; pure mutator.
export function setTermCli(id, cli) {
  const e = state.terms.get(id);
  if (e && e.paired && cli) e.cli = String(cli);
}

// The terminal's currently-rendered rows around the cursor (clean parsed text, current even when
// the pane is hidden). Bounded lookback — we only ever want the tail. Shared so both the Tasks
// page preview and the workflow runner's decision read the SAME thing.
function terminalRows(id, lookback = 120) {
  const buf = state.terms.get(id)?.term?.buffer?.active;
  if (!buf) return [];
  let end = (buf.baseY | 0) + (buf.cursorY | 0);
  if (!(end > 0) || end >= buf.length) end = buf.length - 1;
  const rows = [];
  for (let i = Math.max(0, end - lookback); i <= end; i++) rows.push(buf.getLine(i)?.translateToString(true) || '');
  return rows;
}
// The agent's last message, extracted and de-chromed (see lib/terminal-tail.mjs). `lines` for the
// card preview (short), or the full block to hand a headless analysis. '' / [] when unavailable.
export function terminalTailLines(id, maxLines) { try { return agentOutput(terminalRows(id), { maxLines }); } catch { return []; } }
export function readAgentMessage(id, maxLines = 40) { return terminalTailLines(id, maxLines).join('\n'); }

// Drive a terminal's busy state from a CLI hook (turn-start/turn-done over SSE), keyed by the
// TASKHUB_RUN_ID we injected = the terminal id. NO time cap: a turn ends only when the Stop hook
// fires (feature-dev can run 30+ minutes), so a fixed cutoff would falsely end it. A lost turn-done
// leaves the spinner on until the next turn / abort / tab close — acceptable (rare; localhost curl).
export function setTermBusy(id, busy) {
  const entry = state.terms.get(id);
  if (!entry || !entry.paired) return;
  if (busy) { if (!entry.busy) { entry.busy = true; refreshTermBusy(); } }
  else goIdle(entry);
}

// Workflow step-clock: resolve TRUE when this terminal's turn finishes (the Stop hook, any duration).
// Resolves FALSE on abort or terminal disposal. No internal timeout — the Stop hook ends the turn,
// so a fixed cutoff would guillotine long agentic runs (hence workflows require hooks installed).
const _turnWaiters = new Map(); // id -> [fn(ok)]
function flushTurnWaiters(id, ok) {
  const a = id && _turnWaiters.get(id);
  if (a) { _turnWaiters.delete(id); a.forEach(fn => { try { fn(ok); } catch {} }); }
}
export function whenTurnDone(id, { timeoutMs = 0, signal } = {}) {
  return new Promise(resolve => {
    let done = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      const arr = _turnWaiters.get(id);
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); if (!arr.length) _turnWaiters.delete(id); }
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = v => { if (done) return; done = true; cleanup(); resolve(v); };
    const fn = ok => finish(ok !== false);
    const onAbort = () => finish(false);
    const a = _turnWaiters.get(id) || []; a.push(fn); _turnWaiters.set(id, a);
    const timer = timeoutMs > 0 ? setTimeout(() => finish(false), timeoutMs) : null;
    if (signal) { if (signal.aborted) finish(false); else signal.addEventListener('abort', onAbort); }
  });
}

function bindPairedTermToTab(id, pairKey) {
  if (!pairKey) return;
  const tab = state.tabs.find(t => t.url === pairKey);
  if (tab && !tab.termId) tab.termId = id;
}

// After the window is reopened, the renderer is fresh but the main-process PTYs can still
// be alive. Terminals are kept hidden until their matching GitHub/Jira tab is opened again.
// There is no standalone terminal group; older unkeyed PTYs can still be claimed by cwd.
export async function rehydrateTerminals() {
  if (!window.taskhub?.term?.list) return;
  let live = [];
  try { live = await taskhub.term.list(); } catch { return; }
  for (const { id, cwd, title, pairKey, hasContext } of live) {
    if (state.terms.has(id)) continue;
    try {
      await attachTermView(id, cwd, title, { paired: true, pairKey, hasContext, replay: true });
      bindPairedTermToTab(id, pairKey);
    } catch {}
  }
  if (live.length) renderTabs();
}

// Tear down a terminal's listeners + PTY + xterm view. No view switching.
export function disposeTerm(id) {
  const t = state.terms.get(id);
  if (!t) return;
  flushTurnWaiters(id, false); // unblock any workflow step awaiting this terminal's turn
  try { t.off?.(); t.offExit?.(); } catch {}
  try { taskhub.term.kill(id); } catch {}
  try { t.term.dispose(); } catch {}
  t.el.remove();
  state.terms.delete(id);
}

// The shell exited (e.g. the user typed `exit`). Clean up; a paired terminal also
// collapses its PR/Jira split.
function onTermExit(id, paired) {
  if (paired) {
    const tab = state.tabs.find(x => x.termId === id);
    disposeTerm(id);
    if (tab) { tab.termId = null; if (state.activeTabId === tab.id) clearPrLayout(); }
  } else {
    closeTerminal(id);
  }
}

export function activateTerminal(id) {
  const t = state.terms.get(id);
  if (!t) return;
  state.activeTabId = null; state.activeTermId = id;
  ensurePanelOpen();
  hideAllPanes();
  document.body.classList.remove('pr-split'); // a direct terminal is full-width
  t.el.style.display = '';
  document.body.classList.add('viewing-term'); // hide the webview-only toolbar buttons
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  updateNavButtons();
  fitTerm(t);
  t.term.focus();
  renderTabs(); // also refreshes titles
}

export function closeTerminal(id) {
  disposeTerm(id);
  if (state.activeTermId === id) {
    state.activeTermId = null;
    const next = [...state.terms.keys()].find(k => !state.terms.get(k).paired);
    if (next) activateTerminal(next);
    else if (!state.tabs.length) closeSplit();
    else activateWebTab(state.tabs[0].id);
  } else {
    renderTabs();
  }
}

// Size the PTY to the rendered terminal (FitAddon measures the DOM, so the pane must
// be visible first). Debounced refit on window resize wired in initTerminals().
export function fitTerm(t) {
  if (!t) return;
  try { t.fit.fit(); const { cols, rows } = t.term; taskhub.term.resize([...state.terms].find(([, v]) => v === t)[0], cols, rows); } catch {}
}

// The terminal currently on screen: a direct full-width one, or a PR/Jira paired one.
export function visibleTerm() {
  if (state.activeTermId) return state.terms.get(state.activeTermId);
  const cur = activeTab();
  return cur && cur.termId ? state.terms.get(cur.termId) : null;
}

export function initTerminals() {
  let raf = 0;
  window.addEventListener('resize', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; fitTerm(visibleTerm()); });
  });
}
