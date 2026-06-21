// Terminals (xterm.js, backed by main-process PTYs). Shares the right-side viewer
// with webview tabs (only one pane shown at a time); each terminal is an xterm view
// bound to a main-process PTY by id.
import { state, activeTab } from '../stores/store.js';
import { codeFontStack } from '../lib/util.js';
import { termTheme } from '../services/theme.js';
import { renderTabs, refreshTermBusy } from './sidebar.js';
import { ensurePanelOpen, hideAllPanes, showSplitLoading, updateNavButtons, closeSplit, activateTab as activateWebTab } from './viewer.js';
import { clearPrLayout } from './split.js';

// Load the vendored xterm bundle + addons once, on first use (keeps it off the
// initial page load). Resolves when window.Terminal / FitAddon / WebglAddon exist.
let _xtReady = null;
export function loadXterm() {
  if (_xtReady) return _xtReady;
  const loadScript = src => new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
  _xtReady = (async () => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/xterm.css'; document.head.appendChild(css);
    await loadScript('/vendor/xterm.js');
    await Promise.all([loadScript('/vendor/xterm-addon-fit.js'), loadScript('/vendor/xterm-addon-webgl.js')]);
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

// Create an xterm view bound to a fresh PTY (does NOT activate it). `paired` marks a
// terminal that belongs to a GitHub/Jira tab and `pairKey` is that tab's URL.
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
  try { term.loadAddon(new WebglAddon.WebglAddon()); } catch {} // GPU renderer; falls back to DOM
  // goal/activity/cli drive the Tasks page's live status: `goal` = what the agent was last asked
  // (UserPromptSubmit), `activity` = what it's doing right now (PreToolUse, cleared when idle),
  // `cli` = which agent (claude/codex). All set from CLI-hook SSE events keyed by this id.
  const entry = { id, el, term, fit, off: null, offExit: null, cwd: dir, title, paired, pairKey, hasContext: !!hasContext, busy: false, goal: '', activity: '', cli: '' };
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
  entry.activity = ''; // "what it's doing right now" only applies while a turn is live
  flushTurnWaiters(entry.id, true);
}

// Tasks-page status, set from the CLI's hooks (see app.js SSE). Pure mutators — the caller
// re-renders the Tasks page when it's the active view. Only paired terminals carry status.
export function setTermGoal(id, text) {
  const e = state.terms.get(id);
  if (e && e.paired && text) e.goal = String(text);
}
export function setTermActivity(id, text) {
  const e = state.terms.get(id);
  if (e && e.paired) e.activity = text ? String(text) : '';
}
export function setTermCli(id, cli) {
  const e = state.terms.get(id);
  if (e && e.paired && cli) e.cli = String(cli);
}

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
  showSplitLoading(false);
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
export function clearVisibleTerm() { const t = visibleTerm(); if (t) { t.term.clear(); t.term.focus(); } }

export function initTerminals() {
  let raf = 0;
  window.addEventListener('resize', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; fitTerm(visibleTerm()); });
  });
}
