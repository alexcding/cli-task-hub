// PR ↔ terminal split: each GitHub/Jira tab can show its right panel — a paired terminal, or the
// New Task empty state when no worktree exists yet. The on/off choice is PER TAB (`tab.prSplit`,
// persisted) and defaults OFF — opening a link shows just the page until the user expands the panel
// (⌘J). Expanding recreates the task's terminal when its worktree exists on disk, else shows New
// Task; we never auto-spawn a terminal on a fresh link.
import { ROUTES } from '/shared/routes.mjs';
import { state, activeTab, projectByRepo, projectByPrUrl, projectByJiraKey } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { jiraKeyFromUrl, canSplitTerminal } from '../lib/util.js';
import { toastErr } from './toast.js';
import { createTermView, disposeTerm, fitTerm, visibleTerm } from './terminal.js';
import { hideDiffPane } from './diff.js';
import { hideHistory, applyReview } from './history.js';
import { saveTabs, updateTitles, activeLeftWebview } from './viewer.js';

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

// Remove a worktree via the server (non-forced — a dirty tree comes back as { error }, never a
// throw). Shared by the folder-chip delete (viewer.js) and the Tasks-page task delete (tasks.js)
// so the API call + error normalization live in one place.
export async function removeWorktree(workspace, worktree) {
  if (!workspace || !worktree) return { error: 'workspace and worktree required' };
  try { return await apiJson(ROUTES.WORKTREE_REMOVE, 'POST', { path: workspace, worktree }); }
  catch (e) { return { error: e.message }; }
}

// External apps (e.g. Xcode) with files open under a worktree — surfaced before a task delete so we
// can warn the user to close them (an open app re-saves state into the just-removed folder, leaving
// a husk). Advisory only; returns distinct process names. Never throws — a failed probe just yields
// nothing rather than blocking the delete.
export async function worktreeHolders(worktree) {
  if (!worktree) return [];
  try { return (await api(`${ROUTES.WORKTREE_HOLDERS}?path=${encodeURIComponent(worktree)}`))?.holders || []; }
  catch { return []; }
}

// Re-adopt a surviving paired terminal for this tab by its URL (kept alive after a close, or
// rehydrated after a window reload). Sets tab.termId and returns it, or null if none — never
// creates one (that's ensurePrTerminal / New Task). The single source for URL-keyed adoption,
// shared by ensurePrTerminal and applyPrLayout so the lookup can't drift between them.
export function adoptPairedTerminal(tab) {
  if (tab.termId && state.terms.has(tab.termId)) return tab.termId;
  const found = [...state.terms.entries()].find(([, t]) => t.paired && t.pairKey === tab.url);
  tab.termId = found ? found[0] : null;
  return tab.termId;
}

// Lazily create or resume the tab's paired terminal. A live PTY from a previous window
// instance is matched by URL first, then by cwd for older sessions that predate pairKey.
// `cwd0` lets a caller that has already resolved the folder (openPrPanel) skip the prCwd resolve.
export function ensurePrTerminal(tab, cwd0) {
  if (tab.termId && state.terms.has(tab.termId)) return Promise.resolve();
  if (tab._termPromise) return tab._termPromise;
  tab._termPromise = (async () => {
    if (state.tabTermInit) { try { await state.tabTermInit; } catch {} }
    if (tab.termId && state.terms.has(tab.termId)) return tab.termId;
    if (!adoptPairedTerminal(tab)) {           // no surviving terminal for this URL → adopt-by-cwd or create
      const cwd = cwd0 != null ? cwd0 : await prCwd(tab);
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

let _prAnimRaf = 0;
export function stopPrTween() { if (_prAnimRaf) { cancelAnimationFrame(_prAnimRaf); _prAnimRaf = 0; } }
function setPrSplit(toPct) {
  document.documentElement.style.setProperty('--pr-split', toPct + '%');
  // The native child webview (Tauri shim) follows the new boundary now rather than on the next rAF
  // tick (throttled when the renderer isn't painting). Without this it lingers at its old width,
  // painting over the terminal pane + its foot border until a divider drag forces a reposition.
  activeLeftWebview()?.syncBounds?.();
}
// Slide the `--pr-split` boundary (0–100%) frame-by-frame: the webview width, terminal pane, and
// divider all derive from this one variable, so animating it opens/closes the whole split as a unit
// (CSS can't reliably transition a custom property). The callers hide the heavy pane content (a diff
// table reflows every frame) before the slide, so only the webview width animates — that's smooth.
function tweenPrSplit(toPct, onDone) {
  stopPrTween();
  const from = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pr-split')) || 100;
  const dur = 200; let t0 = 0;
  const tick = ts => {
    if (!t0) t0 = ts;
    const k = Math.min(1, (ts - t0) / dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
    setPrSplit((from + (toPct - from) * e).toFixed(2));
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

// Show the PR's paired terminal beside its webview. With `animate` (toolbar toggle) the split slides
// open from the right; otherwise (switching to an already-split tab) it appears at the resting
// boundary immediately.
export function applyPrLayout(tab, animate = false) {
  adoptPairedTerminal(tab);                 // re-adopt a surviving terminal by URL; never creates one
  const t = tab.termId && state.terms.get(tab.termId);
  const target = Math.round(state.prRatio * 100);
  const empty = document.getElementById('term-empty');
  document.body.classList.add('pr-split');
  // No terminal yet → show the New Task empty state in the right pane: no Terminal/Review tabs,
  // just the button (newTask creates the worktree + opens the terminal, then re-runs this).
  if (!t) {
    document.body.classList.add('pr-empty');
    document.body.classList.remove('pane-diff');
    hideHistory(); hideDiffPane();
    if (empty) empty.hidden = false;
    if (animate) { setPrSplit(100); tweenPrSplit(target); } else setPrSplit(target);
    updateTitles();
    return;
  }
  document.body.classList.remove('pr-empty');
  if (empty) empty.hidden = true;
  const diff = showPaneContent(tab, t);
  if (animate) {
    setPrSplit(target); if (!diff) fitTerm(t);   // park at final geometry so the terminal grid sizes correctly…
    setPrSplit(100);                             // …then start fully collapsed and slide open
    tweenPrSplit(target, () => { if (state.activeTabId === tab.id && tab.prSplit && tab.paneView !== 'diff') fitTerm(t); });
  } else {
    setPrSplit(target); if (!diff) fitTerm(t);
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

// Collapse the split. With `tab`/`animate` it slides the boundary closed (webview grows to fill)
// then tears down; without them (e.g. a tab closed) it drops the layout immediately.
export function clearPrLayout(tab = null, animate = false) {
  const t = animate && tab && tab.termId && state.terms.get(tab.termId);
  // Hide the heavy right-pane CONTENT up front — a diff table reflows on every frame as its width
  // shrinks (the jank). The terminal's canvas just clips, so it stays and slides cheaply. We keep
  // pane-diff/pr-split set during the slide so the foot doesn't flip to the terminal buttons; both
  // classes drop together at the end, so only the webview width animates in between.
  hideHistory();
  hideDiffPane();
  document.getElementById('term-empty')?.setAttribute('hidden', '');
  const finish = () => {
    document.body.classList.remove('pr-split', 'pane-diff', 'pr-empty');
    if (t) t.el.style.display = 'none';
  };
  if (!t) { stopPrTween(); finish(); return; }        // nothing to animate → collapse immediately
  tweenPrSplit(100, () => {                            // 100% = panel fully collapsed off the right
    if (state.activeTabId === tab.id && !tab.prSplit) finish(); // still collapsed (not re-toggled mid-slide)
  });
}

// Open the tab's right panel. A surviving live terminal → show it. Else recovery is RECORD-based
// ONLY: recreate the terminal for an explicitly-created task (persisted in state.tasks) using its
// recorded worktree — that's how opening the link from anywhere (dashboard, tray) "finds the task"
// and resumes it. A worktree merely existing on disk is NOT a task; with no record we show the New
// Task empty state, so a task (and its Tasks-page card) appears only when the user explicitly starts
// one — never auto-conjured from a stray worktree.
export async function openPrPanel(tab, animate = false) {
  if (adoptPairedTerminal(tab)) { applyPrLayout(tab, animate); return; } // a live terminal survived
  const task = state.tasks.find(t => t.url === tab.url);
  if (task && task.worktree) {
    await ensurePrTerminal(tab, task.worktree);
    if (state.activeTabId !== tab.id || !tab.prSplit) return;
  }
  applyPrLayout(tab, animate);
}

// Toolbar toggle: flip THIS tab's own panel on/off (persisted) and slide it in/out. Opening
// recreates the task's terminal if its worktree exists, else shows New Task (openPrPanel). Only
// meaningful for GitHub/Jira tabs.
export function togglePrSplit() {
  const cur = activeTab();
  if (!canSplitTerminal(cur)) return;
  cur.prSplit = !cur.prSplit;
  saveTabs();
  document.getElementById('split-toggle-term')?.classList.toggle('on', cur.prSplit);
  if (cur.prSplit) openPrPanel(cur, true);
  else clearPrLayout(cur, true);
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
    // Clamp by PIXEL width, not just ratio: the terminal pane (right) needs room for the foot
    // buttons (Run/picker/Commit) and the PR pane (left) needs to stay readable. A pure ratio cap
    // let the terminal shrink to a sliver on a small window, overlapping the foot controls.
    const MIN_LEFT = 360, MIN_TERM = 300;
    let ratio = (e.clientX - r.left) / r.width;
    const lo = MIN_LEFT / r.width, hi = 1 - MIN_TERM / r.width;
    ratio = lo < hi ? Math.min(hi, Math.max(lo, ratio)) : 0.5;  // window too small for both mins → split evenly
    state.prRatio = ratio;
    setPrSplit(Math.round(state.prRatio * 100));
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; document.body.classList.remove('resizing');
    localStorage.setItem('taskhub.prRatio', String(state.prRatio));
    fitTerm(visibleTerm());
  });
}
