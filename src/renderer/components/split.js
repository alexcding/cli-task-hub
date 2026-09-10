// PR ↔ terminal split: the terminal panel (left pane) is ALWAYS shown on a tab that can carry one
// (canSplitTerminal) — a paired terminal, or the New Task empty state when no worktree exists yet.
// There is no per-tab on/off. Opening a tab recreates the task's terminal when its worktree exists
// on disk, else shows New Task; we never auto-spawn a terminal on a fresh link.
import { ROUTES } from '/shared/routes.mjs';
import { state, activeTab, projectByRepo, projectByPrUrl, projectByJiraKey, projectById } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { jiraKeyFromUrl, canSplitTerminal, errMsg, basename } from '../lib/util.js';
import { toastErr } from './toast.js';
import { createTermView, disposeTerm, fitTerm, visibleTerm } from './terminal.js';
import { dragDivider } from '../lib/drag.js';
import { hideDiffPane } from './diff.js';
import { hideHistory, applyReview } from './history.js';
import { saveTabs, updateTitles, activeLeftWebview, paintLeft } from './viewer.js';
import { renderContentTabs, markActiveTab } from './content-tabs.js';
import { launchCli } from './cli-launch.js';
import { persistTask, taskForTab, taskTerm, newTaskId } from '../services/tasks.js';

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
  if (tab.kind === 'web') {
    // A web tab has no project of its own: its folder is the worktree of a task linked to it, or
    // nothing.
    const task = taskForTab(tab);
    return task ? { path: task.worktree, workspace: task.workspace, matched: true, isWorktree: true }
                : { path: null, workspace: null, matched: false, isWorktree: false };
  }
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
export async function removeWorktree(workspace, worktree, { force = false } = {}) {
  if (!workspace || !worktree) return { error: 'workspace and worktree required' };
  try { return await apiJson(ROUTES.WORKTREE_REMOVE, 'POST', { path: workspace, worktree, force }); }
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

// Re-adopt a surviving paired terminal for this tab (kept alive after a close, or rehydrated after
// a window reload / app relaunch): the terminal of the tab's task (tasks link to a tab by url; the
// terminal is keyed by task id). Sets tab.termId and returns it, or null if none — never creates
// one (that's ensurePrTerminal / New Task). Shared by ensurePrTerminal and applyPrLayout.
export function adoptPairedTerminal(tab) {
  if (tab.termId && state.terms.has(tab.termId)) return tab.termId;
  const task = taskForTab(tab);
  const found = task ? taskTerm(task) : null;
  tab.termId = found ? found[0] : null;
  return tab.termId;
}

// The project a tab belongs to (by repo / Jira key / PR url).
const tabProject = tab => tab.kind === 'jira'
  ? projectByJiraKey(tab.jiraKey || jiraKeyFromUrl(tab.url))
  : tab.kind === 'web' ? projectById(taskForTab(tab)?.projectId)
  : (projectByRepo(tab.repo) || projectByPrUrl(tab.url));

// Lazily create or resume the tab's paired terminal. A live PTY from a previous window instance
// (or app run — PTYs live in the daemon) is matched through the tab's task. With no surviving
// terminal, the tab's task record is created if missing (a paired terminal IS a task: it always
// sits on a worktree of the tab's project) and a shell opens in that worktree.
// `cwd0` lets a caller that has already resolved the folder (openPrPanel / newSession) skip the resolve;
// `meta.branch` records the branch the caller just created the worktree for; `meta.project` names
// the project for a tab that can't resolve one itself (a web tab getting its first session).
export function ensurePrTerminal(tab, cwd0, meta = {}) {
  if (tab.termId && state.terms.has(tab.termId)) return Promise.resolve();
  if (tab._termPromise) return tab._termPromise;
  tab._termPromise = (async () => {
    if (state.tabTermInit) { try { await state.tabTermInit; } catch {} }
    if (tab.termId && state.terms.has(tab.termId)) return tab.termId;
    if (!adoptPairedTerminal(tab)) {           // no surviving terminal for this tab's task → create one
      const f = cwd0 != null ? null : await resolveTabFolder(tab);
      const cwd = cwd0 != null ? cwd0 : f?.path;
      if (!cwd) throw new Error('no local folder for this tab');
      let task = taskForTab(tab);
      if (!task) {
        const proj = meta.project || tabProject(tab);
        if (!proj?.workspace) throw new Error('tab belongs to no project with a workspace');
        // A task lives on a linked worktree of the project, never on the main checkout: the sidebar
        // renders a session row for it, removable (folder included) via right-click.
        const norm = p => String(p).replace(/[/\\]+$/, '');
        if (norm(cwd) === norm(proj.workspace)) throw new Error('this branch is checked out in the main repo — a task needs its own worktree');
        task = await persistTask({ id: newTaskId(), projectId: proj.id, workspace: proj.workspace, worktree: cwd,
          branch: meta.branch || tab.branch || '', title: tab.title || basename(cwd), kind: tab.kind, url: tab.url,
          jiraKey: tab.kind === 'jira' ? (tab.jiraKey || jiraKeyFromUrl(tab.url)) : '', cli: '', sessionId: '' });
      }
      tab.termId = await createTermView(cwd, task.title, { paired: true, pairKey: task.id });
    }
    // The tab may have been closed while the awaits above were in flight (its closeTab
    // saw termId still null). Mirror the close policy: a bare shell with no context is
    // disposed — nothing references it and the PTY would just leak — but a terminal with
    // context (running process / typed input) is deliberately kept alive; it stays keyed to
    // the task, so reopening the same tab re-adopts it via adoptPairedTerminal above.
    if (!state.tabs.includes(tab)) {
      const t = state.terms.get(tab.termId);
      if (t && !t.hasContext) disposeTerm(tab.termId);
      tab.termId = null;
      return null;
    }
    return tab.termId;
  })()
    .catch(e => { console.error('[term] create failed', e); toastErr('Terminal failed: ' + errMsg(e)); })
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

// Show the tab's split content. The terminal (left) is always on; `paneView` picks what the
// RIGHT pane shows — the page ('term', the legacy value for "not the diff"; kept so persisted
// tabs + the server column stay valid) or the diff view of the terminal's worktree ('diff'),
// which covers the page. Also syncs the content-tab bar (the pinned Diff chip appears once a
// terminal exists, and is the active chip while the diff shows) + the body.pane-diff class
// that shows the Review foot.
function showPaneContent(tab, t) {
  const diff = tab.paneView === 'diff';
  document.body.classList.toggle('pane-diff', diff);
  renderContentTabs();               // adds the Diff chip (cheap no-op when the bar is unchanged)
  markActiveTab();
  t.el.style.display = '';
  if (diff) applyReview(tab, t.cwd); // restore this tab's Review sub-view (Changes / History)
  else { hideHistory(); hideDiffPane(); } // back to the page: drop the opaque history overlay too
  paintLeft(tab);                    // hides the page under Review, or re-shows it
  return diff;
}

// Leaving the Diff view for the page (a content tab was picked / a file link opened). Flips the
// STATE only — paneView, body.pane-diff, the diff/history panes — and leaves the single paintLeft
// + renderContentTabs/markActiveTab + saveTabs to the caller, which does them anyway (going through
// setPaneView here doubled every one of those, including an immediate PUT /tabs). No-op otherwise.
export function leaveReview(tab) {
  if (!tab || tab.paneView !== 'diff') return;
  tab.paneView = 'term';
  if (tab === activeTab()) { document.body.classList.remove('pane-diff'); hideHistory(); hideDiffPane(); }
}

// Show the tab's paired terminal beside (left of) its webview. With `animate` (a session just
// created) the split slides open from the left; otherwise (switching to a tab that already has one)
// it appears at the resting boundary immediately.
export function applyPrLayout(tab, animate = false) {
  adoptPairedTerminal(tab);                 // re-adopt a surviving terminal by URL; never creates one
  const t = tab.termId && state.terms.get(tab.termId);
  const target = Math.round(state.prRatio * 100);
  // No terminal (the session's shell is gone and couldn't be recreated) → just the page. There is
  // no empty state: a tab without a session shows the toolbar's "New session" button instead.
  if (!t) { clearPrLayout(tab); return; }
  document.body.classList.add('pr-split');
  showPaneContent(tab, t);
  if (animate) {
    setPrSplit(target); fitTerm(t);              // park at final geometry so the terminal grid sizes correctly…
    setPrSplit(100);                             // …then start fully collapsed and slide open
    tweenPrSplit(target, () => { if (state.activeTabId === tab.id) fitTerm(t); });
  } else {
    setPrSplit(target); fitTerm(t);
  }
  updateTitles(); // terminal segment now has a terminal to name
}

// Diff chip (content-tab bar) / ⇧⌘D: show the page or the worktree diff in THIS tab's right pane
// (persisted per tab, as `paneView`). The page's webview is only hidden, not torn down,
// so flipping back is instant and loses nothing.
export function setPaneView(view) {
  const tab = activeTab();
  if (!canSplitTerminal(tab)) return;
  const next = view === 'diff' ? 'diff' : 'term';
  if ((tab.paneView || 'term') === next) return;
  const t = tab.termId && state.terms.get(tab.termId);
  // No live terminal (New Task empty state / still spawning) → there's no worktree to diff and no
  // Diff chip on screen. Don't persist 'diff' from here: it would silently cover the page with an
  // empty diff the moment the task's terminal lands.
  if (!t) return;
  tab.paneView = next;
  saveTabs();
  showPaneContent(tab, t);
  updateTitles();
}

// Collapse the split — a tab that can't carry a terminal became the view, or the shell exited.
// With `tab`/`animate` it slides the boundary closed (webview grows to fill) then tears down;
// without them (the common case) it drops the layout immediately.
export function clearPrLayout(tab = null, animate = false) {
  const t = animate && tab && tab.termId && state.terms.get(tab.termId);
  // Hide the heavy Review CONTENT up front — a diff table reflows on every frame as its width
  // grows (the jank). The terminal's canvas just clips, so it stays and slides cheaply. pr-split
  // stays set during the slide and drops at the end, so only the boundary animates in between.
  hideHistory();
  hideDiffPane();
  // The Diff view may have been covering the page: drop pane-diff and re-show the page NOW, so the
  // slide animates the page growing (not a bare pane with the page popping in at the end). `tab`
  // is null for the argument-less callers (shell exit, tab switch) — the active tab is the one
  // whose pane needs repainting then.
  document.body.classList.remove('pane-diff');
  const shown = tab || activeTab();
  if (shown) paintLeft(shown);
  const finish = () => {
    document.body.classList.remove('pr-split');
    if (t) t.el.style.display = 'none';
    renderContentTabs(); markActiveTab();              // the Diff chip goes with the split
    updateTitles();                                    // …and the toolbar offers the session back
  };
  if (!t) { stopPrTween(); finish(); return; }        // nothing to animate → collapse immediately
  tweenPrSplit(100, () => {                            // 100% = panel fully collapsed off the right
    if (state.activeTabId === tab.id) finish();
  });
}

// Open the tab's terminal panel (left pane). A surviving live terminal → show it. Else recovery is
// RECORD-based ONLY: recreate the terminal for an explicitly-created task (persisted in state.tasks)
// using its recorded worktree — that's how opening the link from anywhere (dashboard, tray) "finds
// the session" and resumes it. A worktree merely existing on disk is NOT a session, so a session
// appears only when the user explicitly starts one — never auto-conjured from a stray worktree.
export function openPrPanel(tab, animate = false) {
  // One recovery per tab at a time. Two callers can overlap — activateTab fires this without
  // awaiting it, and the toolbar's "Reopen session" is offered until the terminal is actually
  // live — and while ensurePrTerminal dedupes the terminal itself, each call would still run its
  // own launchCli below, sending the agent's resume command twice. Later callers join the
  // in-flight run instead (they lose only `animate`, which the first caller already decided).
  if (tab._panelPromise) return tab._panelPromise;
  tab._panelPromise = _openPrPanel(tab, animate).finally(() => { tab._panelPromise = null; });
  return tab._panelPromise;
}
async function _openPrPanel(tab, animate) {
  if (adoptPairedTerminal(tab)) { applyPrLayout(tab, animate); return; } // a live terminal survived
  const task = taskForTab(tab);
  if (task && task.worktree) {
    await ensurePrTerminal(tab, task.worktree);
    // The shell is fresh (the old one is gone) — pick the agent's conversation back up: exact
    // resume with the stored id, else a fresh launch of the task's CLI (which mints a new id).
    if (task.cli && tab.termId && state.terms.has(tab.termId)) {
      const r = await launchCli(tab.termId, null, task.cli, { sessionId: task.sessionId || '', resume: !!task.sessionId });
      if (r?.sessionId && r.sessionId !== task.sessionId) persistTask({ id: task.id, sessionId: r.sessionId });
    }
    if (state.activeTabId !== tab.id) return;
  }
  applyPrLayout(tab, animate);
}

// Drag the PR/terminal divider: update the split fraction (CSS var) live and refit the terminal
// as it moves (rAF-throttled), so the grid follows the boundary rather than snapping on drop.
// Drag lifecycle (incl. the native-webview mouseup trap) lives in lib/drag.js.
export function initPrDivider() {
  const d = document.getElementById('pr-divider');
  if (!d) return;
  let raf = 0;
  dragDivider(d, {
    move(e) {
      stopPrTween();
      const r = document.getElementById('split-body').getBoundingClientRect();
      // Clamp by PIXEL width, not just ratio: the terminal pane (left) needs room for the foot
      // buttons (Run/picker/Commit) and the PR pane (right) needs to stay readable. A pure ratio cap
      // let the terminal shrink to a sliver on a small window, overlapping the foot controls.
      // `ratio` is the WEBVIEW's share (--pr-split), i.e. the fraction right of the cursor.
      const MIN_PR = 360, MIN_TERM = 300;
      let ratio = 1 - (e.clientX - r.left) / r.width;
      const lo = MIN_PR / r.width, hi = 1 - MIN_TERM / r.width;
      ratio = lo < hi ? Math.min(hi, Math.max(lo, ratio)) : 0.5;  // window too small for both mins → split evenly
      state.prRatio = ratio;
      setPrSplit(Math.round(state.prRatio * 100));
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; fitTerm(visibleTerm()); });
    },
    end() {
      localStorage.setItem('taskhub.prRatio', String(state.prRatio));
      fitTerm(visibleTerm());
    },
  });
}
