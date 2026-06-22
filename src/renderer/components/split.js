// PR ↔ terminal split: each GitHub/Jira tab can show a paired terminal to its right.
// The on/off choice is PER TAB (stored on the tab as `tab.prSplit`, persisted with the
// tab) and defaults to OFF — opening a PR doesn't auto-spawn a terminal until toggled.
import { ROUTES } from '/shared/routes.mjs';
import { state, activeTab, projectByRepo, projectByPrUrl, projectByJiraKey } from '../stores/store.js';
import { api } from '../services/api.js';
import { jiraKeyFromUrl, canSplitTerminal } from '../lib/util.js';
import { toastErr } from './toast.js';
import { createTermView, disposeTerm, fitTerm, visibleTerm } from './terminal.js';
import { hideDiffPane } from './diff.js';
import { hideHistory, applyReview } from './history.js';
import { saveTabs, updateTitles } from './viewer.js';

// Resolve a tab's local folder: the matching git checkout if its branch/key is checked
// out, else the project workspace. GitHub PR → the PR's branch. Jira ticket → the worktree
// whose branch embeds the ticket key (an unambiguous single match only; 0 or >1 falls back
// to the workspace). Returns { path, workspace, matched, isWorktree }:
//   - path: the checkout to use (worktree if any, else workspace; null = tab has no project)
//   - matched: a git tree currently has this branch/key checked out
//   - isWorktree: that tree is a dedicated (linked) worktree, not the shared main checkout
// The server decides matched/isWorktree authoritatively (it parses `git worktree list`),
// so the renderer never infers worktree-ness from a path string compare. Shared by the
// terminal cwd resolver (prCwd) and the viewer titlebar chip (updateFolderChip).
export async function resolveTabFolder(tab) {
  const none = ws => ({ path: ws, workspace: ws, matched: false, isWorktree: false });
  if (tab.kind === 'jira') {
    const key = tab.jiraKey || jiraKeyFromUrl(tab.url);
    const proj = projectByJiraKey(key);
    const ws = (proj && proj.workspace) || null;
    if (!ws || !key) return none(ws);
    try { const r = await api(`${ROUTES.WORKTREE}?path=${encodeURIComponent(ws)}&key=${encodeURIComponent(key)}`); if (r.path) return { path: r.path, workspace: ws, matched: !!r.matched, isWorktree: !!r.isWorktree }; } catch {}
    return none(ws);
  }
  const proj = projectByRepo(tab.repo) || projectByPrUrl(tab.url);
  const ws = (proj && proj.workspace) || null;
  if (!ws) return { path: null, workspace: null, matched: false, isWorktree: false };
  const branch = tab.branch || (proj.prs || []).find(p => p.url === tab.url)?.headRefName;
  if (branch) {
    try { const r = await api(`${ROUTES.WORKTREE}?path=${encodeURIComponent(ws)}&branch=${encodeURIComponent(branch)}`); if (r.path) return { path: r.path, workspace: ws, matched: !!r.matched, isWorktree: !!r.isWorktree }; } catch {}
  }
  return none(ws);
}

// Where a tab's terminal should start (the resolved worktree/workspace folder, or null
// so main falls back to the app's own repo).
async function prCwd(tab) {
  return (await resolveTabFolder(tab)).path;
}

// Lazily create or resume the tab's paired terminal. A live PTY from a previous window
// instance is matched by URL first, then by cwd for older sessions that predate pairKey.
export function ensurePrTerminal(tab) {
  if (tab.termId && state.terms.has(tab.termId)) return Promise.resolve();
  if (tab._termPromise) return tab._termPromise;
  tab._termPromise = (async () => {
    if (state.tabTermInit) { try { await state.tabTermInit; } catch {} }
    if (tab.termId && state.terms.has(tab.termId)) return tab.termId;
    const byKey = [...state.terms.entries()].find(([, t]) => t.paired && t.pairKey === tab.url);
    if (byKey) { tab.termId = byKey[0]; }
    else {
      const cwd = await prCwd(tab);
      const byCwd = [...state.terms.entries()].find(([, t]) => t.paired && !t.pairKey && t.cwd === cwd);
      if (byCwd) { byCwd[1].pairKey = tab.url; tab.termId = byCwd[0]; }
      else tab.termId = await createTermView(cwd, null, { paired: true, pairKey: tab.url }); // title defaults to the folder/worktree name
    }
    // The tab may have been closed while the awaits above were in flight (its closeTab
    // saw termId still null). Mirror the close policy: a bare shell with no context is
    // disposed — nothing references it and the PTY would just leak — but a terminal with
    // context (running process / typed input) is deliberately kept alive; it stays
    // paired by URL, so reopening the same tab re-adopts it via the byKey match above.
    if (!state.tabs.includes(tab)) {
      const t = state.terms.get(tab.termId);
      if (t && !t.hasContext) disposeTerm(tab.termId);
      tab.termId = null;
      return null;
    }
    return tab.termId;
  })()
    .catch(e => toastErr('Terminal failed: ' + e.message))
    .finally(() => { tab._termPromise = null; });
  return tab._termPromise;
}

// Tween the `--pr-split` boundary (0–100%). Because the webview width, terminal pane, and
// divider all derive their geometry from this one variable, animating it collapses/expands the
// whole split as a single unit — the container moves, not just the terminal's contents. CSS
// can't reliably transition a custom property, so we drive it frame-by-frame here.
let _prAnimRaf = 0;
export function stopPrTween() { if (_prAnimRaf) { cancelAnimationFrame(_prAnimRaf); _prAnimRaf = 0; } }
function tweenPrSplit(toPct, onDone) {
  stopPrTween();
  const from = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pr-split')) || 100;
  const dur = 220; let t0 = 0;
  const tick = ts => {
    if (!t0) t0 = ts;
    const k = Math.min(1, (ts - t0) / dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
    document.documentElement.style.setProperty('--pr-split', (from + (toPct - from) * e).toFixed(2) + '%');
    if (k < 1) _prAnimRaf = requestAnimationFrame(tick);
    else { _prAnimRaf = 0; onDone && onDone(); }
  };
  _prAnimRaf = requestAnimationFrame(tick);
}

// Show the tab's pane content per its paneView: the paired terminal (default) or the
// diff view of the same worktree. Also syncs the toolbar — the view-switch buttons'
// active state and the body.pane-diff class that swaps the clear/refresh buttons.
function showPaneContent(tab, t) {
  const diff = tab.paneView === 'diff';
  document.body.classList.toggle('pane-diff', diff);
  document.getElementById('pane-view-term')?.classList.toggle('on', !diff);
  document.getElementById('pane-view-diff')?.classList.toggle('on', diff);
  t.el.style.display = diff ? 'none' : '';
  if (diff) applyReview(tab, t.cwd); // restore this tab's Review sub-view (Changes / History)
  else { hideHistory(); hideDiffPane(); } // Terminal: drop the opaque history overlay too
  return diff;
}

// Show the PR's paired terminal beside its webview. When `animate` is set (toolbar toggle) the
// split expands open from the right; otherwise (switching to an already-split tab) it appears
// at the resting boundary immediately.
export function applyPrLayout(tab, animate = false) {
  const t = tab.termId && state.terms.get(tab.termId);
  if (!t) return;
  const target = Math.round(state.prRatio * 100);
  document.body.classList.add('pr-split');
  const diff = showPaneContent(tab, t);
  if (animate) {
    document.documentElement.style.setProperty('--pr-split', target + '%'); // park at final geometry…
    if (!diff) fitTerm(t);                                                  // …so the grid sizes correctly now
    document.documentElement.style.setProperty('--pr-split', '100%');        // …then start fully collapsed
    tweenPrSplit(target, () => { if (state.activeTabId === tab.id && tab.prSplit && tab.paneView !== 'diff') fitTerm(t); });
  } else {
    document.documentElement.style.setProperty('--pr-split', target + '%');
    if (!diff) fitTerm(t);
  }
  updateTitles(); // terminal segment now has a terminal to name
}

// Toolbar view switch: show the terminal or the worktree diff in THIS tab's pane
// (persisted per tab, like prSplit). The PTY keeps running underneath the diff view,
// so flipping back is instant and loses nothing.
export function setPaneView(view) {
  const tab = activeTab();
  if (!canSplitTerminal(tab) || !tab.prSplit) return;
  const next = view === 'diff' ? 'diff' : 'term';
  if ((tab.paneView || 'term') === next) return;
  tab.paneView = next;
  saveTabs();
  const t = tab.termId && state.terms.get(tab.termId);
  if (!t) return; // terminal still spawning — applyPrLayout will honor paneView when it lands
  showPaneContent(tab, t);
  if (next === 'term') { fitTerm(t); t.term.focus(); }
  updateTitles();
}

// Collapse the split. With `tab`/`animate`, the panel shrinks the terminal to zero width (the
// webview grows to fill) before hiding the pane; without them (e.g. a tab closed) it just drops
// the layout class.
export function clearPrLayout(tab = null, animate = false) {
  hideHistory();
  hideDiffPane();
  document.body.classList.remove('pane-diff');
  const t = animate && tab && tab.termId && state.terms.get(tab.termId);
  if (!t) { stopPrTween(); document.body.classList.remove('pr-split'); return; }
  tweenPrSplit(100, () => {                              // 100% = terminal fully collapsed off the right
    if (state.activeTabId === tab.id && !tab.prSplit) {  // still collapsed (not re-toggled mid-animation)
      document.body.classList.remove('pr-split');
      t.el.style.display = 'none';
    }
  });
}

// Toolbar toggle: flip THIS tab's own terminal on/off (persisted), then animate it
// in/out. Only meaningful for GitHub/Jira tabs.
export function togglePrSplit() {
  const cur = activeTab();
  if (!canSplitTerminal(cur)) return;
  cur.prSplit = !cur.prSplit;
  saveTabs();
  document.getElementById('split-toggle-term')?.classList.toggle('on', cur.prSplit);
  if (cur.prSplit) {
    ensurePrTerminal(cur).then(() => { if (state.activeTabId === cur.id && cur.prSplit) applyPrLayout(cur, true); });
  } else {
    clearPrLayout(cur, true);
  }
}

// Drag the PR/terminal divider: update the split fraction (CSS var) live; refit on drop.
export function initPrDivider() {
  const d = document.getElementById('pr-divider');
  if (!d) return;
  let dragging = false;
  d.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); stopPrTween(); document.body.classList.add('resizing'); });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const r = document.getElementById('split-body').getBoundingClientRect();
    state.prRatio = Math.min(0.85, Math.max(0.2, (e.clientX - r.left) / r.width));
    document.documentElement.style.setProperty('--pr-split', Math.round(state.prRatio * 100) + '%');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; document.body.classList.remove('resizing');
    localStorage.setItem('taskhub.prRatio', String(state.prRatio));
    fitTerm(visibleTerm());
  });
}
