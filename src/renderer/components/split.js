// PR ↔ terminal split: the terminal panel (left pane) is ALWAYS shown on a tab that can carry one
// (canSplitTerminal) — a paired terminal, or the New Task empty state when no worktree exists yet.
// Opening a tab recreates the task's terminal when its worktree exists on disk, else shows New
// Task; we never auto-spawn a terminal on a fresh link.
// The RIGHT pane is the one thing the user toggles (toolbar split toggle / ⌥⌘Return): `paneView`
// holds its whole state — 'off' (hidden, the terminal fills the panel), 'term' (the context's page)
// or 'diff' (the worktree diff) — and applyPrLayout is the single place that turns that state into
// geometry. Every context takes the same path: a PR, a Jira issue, a plain web page and a bare
// session (a `session:` url, no page) differ only in what the pane has to show.
import { ROUTES } from '/shared/routes.mjs';
import { state, activeTab, projectByRepo, projectByPrUrl, projectByJiraKey, projectById } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { jiraKeyFromUrl, canSplitTerminal, errMsg, basename, hasPage } from '../lib/util.js';
import { toastErr } from './toast.js';
import { createTermView, disposeTerm, fitTerm, visibleTerm } from './terminal.js';
import { buildTerm } from './build.js';
import { dragDivider } from '../lib/drag.js';
import { hideDiffPane } from './diff.js';
import { hideHistory, applyReview } from './history.js';
import { saveTabs, updateTitles, activeLeftWebview, paintLeft, hideTabPanes } from './viewer.js';
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
function adoptPairedTerminal(tab) {
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
          jiraKey: tab.kind === 'jira' ? (tab.jiraKey || jiraKeyFromUrl(tab.url)) : '', cli: '', sessionId: '',
          createdAt: new Date().toISOString() });   // the sidebar orders sessions by this (byCreated)
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
function stopPrTween() {
  if (_prAnimRaf) { cancelAnimationFrame(_prAnimRaf); _prAnimRaf = 0; }
  document.body.classList.remove('pr-tweening', 'pane-resizing');
}
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
  // Start from the boundary's CURRENT value. Not `|| 100`: a pane opening from zero width reads as
  // 0, which is falsy — that fallback silently started it at 100 (full width) and made it shrink
  // leftward, revealing the terminal from the left instead of growing the pane out of the right edge.
  const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pr-split'));
  const from = Number.isFinite(cur) ? cur : 100;
  const dur = 200; let t0 = 0;
  const tick = ts => {
    if (!t0) t0 = ts;
    const k = Math.min(1, (ts - t0) / dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
    setPrSplit((from + (toPct - from) * e).toFixed(2));
    if (k < 1) _prAnimRaf = requestAnimationFrame(tick);
    else { _prAnimRaf = 0; document.body.classList.remove('pr-tweening'); onDone && onDone(); }
  };
  document.body.classList.add('pr-tweening'); // terminals skip their ResizeObserver refit meanwhile
  _prAnimRaf = requestAnimationFrame(tick);
}

// The empty-pane surface (#pane-empty). Shown only while the open pane has nothing in it; the
// single toggle, so no caller has to remember to take it down.
export function showEmptyPane(on) {
  const el = document.getElementById('pane-empty');
  if (el) el.hidden = !on;
}

// The RIGHT pane's state, for every context alike: 'off' hides it (the terminal fills the panel),
// 'term' shows the context's page (blank for a bare session — pick a view or add a web tab), 'diff'
// shows the worktree diff. The toolbar's split toggle flips between 'off' and the last shown view.
export const rightPaneOpen = tab => !!tab && (tab.paneView || 'term') !== 'off';
// …and it is actually hidden only when a terminal is there to fill the panel: a context whose
// session has stopped shows its page again regardless of the persisted state (there'd be nothing
// on screen otherwise), and gets the toolbar's "Reopen session" button instead of the toggle.
export const rightPaneHidden = tab => !rightPaneOpen(tab) && !!(tab?.termId && state.terms.get(tab.termId));

// Resize the right pane to `toPct` with the terminal PINNED at full width underneath
// (body.pane-resizing, see viewer.css): only the pane changes size, the terminal neither moves nor
// reflows until the boundary lands. Used for both directions of the split toggle; `onDone` runs
// after the pin comes off (skipped if the tab is no longer the one on screen).
function resizePane(tab, toPct, onDone) {
  document.body.classList.add('pane-resizing');
  tweenPrSplit(toPct, () => {
    document.body.classList.remove('pane-resizing');
    if (state.activeTabId === tab.id) onDone();
  });
}

// Right pane hidden: the page/diff go away and the terminal fills the panel. Same end state as
// clearPrLayout, except the terminal stays on screen (there it's the terminal that goes).
function collapseRightPane(tab, t, animate) {
  // Nothing about the pane's state is torn down until it has finished closing — its content stays
  // painted so what you see narrowing is the real pane, not an empty box. The feet span the PANEL
  // rather than the pane, so they can't narrow with it: CSS keeps them away for the duration
  // (body.pane-resizing) and they land with the pane.
  t.el.style.display = '';
  const finish = () => {
    document.body.classList.remove('pane-diff', 'pane-build', 'pane-blank');
    hideHistory();
    hideDiffPane();
    hideBuildTerm(tab);
    showEmptyPane(false);
    setPrSplit(0);                               // the pane is gone: the boundary belongs at the right edge
    document.body.classList.remove('pr-split');
    document.body.classList.add('split-closed'); // the toolbar's webview segment goes with the pane
    hideTabPanes(tab);                           // no page painted behind a closed pane
    fitTerm(t);                                  // the terminal owns the full width
    renderContentTabs(); markActiveTab();
    updateTitles();
  };
  // Toggled closed: the pane resizes back into the right edge. The terminal is reflowed to full
  // width UP FRONT — pinned, and still covered by the pane over the strip it's about to take — so
  // the pane narrows over a terminal that is already complete. Without that pre-fit the widening
  // strip would be empty background growing out of the left.
  if (animate && document.body.classList.contains('pr-split')) {
    document.body.classList.add('pane-resizing');   // pin first: fitTerm must measure the full width
    fitTerm(t);
    resizePane(tab, 0, finish);
  } else { stopPrTween(); finish(); }
}

// Show the tab's split content. The terminal (left) is always on; `paneView` picks what the
// RIGHT pane shows — the page ('term', the legacy value for "not the diff"; kept so persisted
// tabs + the server column stay valid) or the diff view of the terminal's worktree ('diff'),
// which covers the page. Also syncs the content-tab bar (the pinned Diff chip appears once a
// terminal exists, and is the active chip while the diff shows) + the body.pane-diff class
// that shows the Review foot.
function showPaneContent(tab, t) {
  // The build terminal takes the pane like the diff does. It can be gone (its shell exited, or the
  // PTY didn't survive) while the tab still remembers the view — fall back to the page rather than
  // showing an empty pane.
  const bt = tab.paneView === 'build' ? buildTerm(tab) : null;
  if (tab.paneView === 'build' && !bt) tab.paneView = 'term';
  const diff = tab.paneView === 'diff';
  document.body.classList.toggle('pane-diff', diff);
  document.body.classList.toggle('pane-build', !!bt);
  renderContentTabs();               // adds the Diff/Build chips (cheap no-op when unchanged)
  markActiveTab();
  t.el.style.display = '';
  // Every OTHER context's build terminal must be hidden: they're all siblings in #split-body, and
  // the last one shown would otherwise sit over this tab's pane.
  for (const x of state.terms.values()) if (x.pairKey?.startsWith('build:')) x.el.style.display = x === bt ? '' : 'none';
  if (bt) { bt.el.classList.add('term-side'); fitTerm(bt); }
  if (diff) applyReview(tab, t.cwd); // restore this tab's Review sub-view (Changes / History)
  else { hideHistory(); hideDiffPane(); } // back to the page: drop the opaque history overlay too
  paintLeft(tab);                    // hides the page under Review/Build, or re-shows it
  return diff;
}

// The pane is going away (collapsed, or the split is being torn down): hide this context's build
// terminal with it. The PTY keeps running — only the view is dropped, exactly like the page's
// webview, so reopening the pane on the Build chip shows the output that arrived meanwhile.
function hideBuildTerm(tab) {
  const bt = tab && buildTerm(tab);
  if (bt) bt.el.style.display = 'none';
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

// Show the tab's paired terminal beside (left of) its webview. `animate` picks WHICH edge moves —
// 'term' (a session was just created: the terminal slides in from the left, the page shrinking to
// make room) or 'pane' (the split toggle: the right pane expands out of / collapses into the right
// edge, the terminal giving up or taking the width). false = land at the resting boundary at once.
export function applyPrLayout(tab, animate = false) {
  adoptPairedTerminal(tab);                 // re-adopt a surviving terminal by URL; never creates one
  const t = tab.termId && state.terms.get(tab.termId);
  const target = Math.round(state.prRatio * 100);
  // No terminal (the session's shell is gone and couldn't be recreated) → just the page. There is
  // no empty state: a tab without a session shows the toolbar's "New session" button instead.
  if (!t) { clearPrLayout(tab); return; }
  if (!rightPaneOpen(tab)) { collapseRightPane(tab, t, animate); return; }
  document.body.classList.remove('split-closed');
  document.body.classList.add('pr-split');
  showPaneContent(tab, t);
  if (animate === 'pane') {
    // Toggled open: the PANE resizes out of the right edge, from zero width, over a pinned terminal;
    // the terminal takes its final width (and refits) once the pane lands.
    setPrSplit(0);
    resizePane(tab, target, () => fitTerm(t));
  } else if (animate) {
    setPrSplit(target); fitTerm(t);              // park at final geometry so the terminal grid sizes correctly…
    setPrSplit(100);                             // …then start with the terminal collapsed and slide it in
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
  const next = ['off', 'diff', 'term', 'build'].includes(view) ? view : 'term';
  const cur = tab.paneView || 'term';
  if (cur === next) return;
  const t = tab.termId && state.terms.get(tab.termId);
  // No live terminal (New Task empty state / still spawning) → there's no worktree to diff, no Diff
  // chip on screen and nothing to collapse to. Don't persist a view from here: it would silently
  // cover (or hide) the page the moment the task's terminal lands.
  if (!t) return;
  if (cur !== 'off') tab.paneLast = cur;      // what the toggle reopens to (view-only, not persisted)
  tab.paneView = next;
  saveTabs();
  // ONE geometry path. Only a change in the pane's VISIBILITY slides the boundary; swapping the
  // page for the diff inside an open pane must not flash it shut and back.
  applyPrLayout(tab, (cur === 'off') !== (next === 'off') ? 'pane' : false);
}

// Toolbar split toggle (pinned to the toolbar's right edge): hide or show the right pane of THIS context.
// Reopening restores the view it had ('term' page / 'diff'), defaulting to the diff for a bare
// session — its pane has no page, so the diff is the only thing it can show without a web tab.
export function toggleSplitPane() {
  const tab = activeTab();
  if (!tab) return;
  setPaneView(rightPaneOpen(tab) ? 'off' : (tab.paneLast || (hasPage(tab) ? 'term' : 'diff')));
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
  document.body.classList.remove('pane-diff', 'pane-build', 'pane-blank');
  hideBuildTerm(tab || activeTab());
  showEmptyPane(false);
  const shown = tab || activeTab();
  if (shown) paintLeft(shown);
  const finish = () => {
    document.body.classList.remove('pr-split', 'split-closed');
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
      // null ⇒ the shell wasn't at a prompt (e.g. a slow rc file): nothing launched, nothing stamped.
      if (!r) toastErr(`Terminal busy — ${task.cli} not started. Run it from the shell when it's ready.`);
      else if (r.sessionId && r.sessionId !== task.sessionId) persistTask({ id: task.id, sessionId: r.sessionId });
    }
    if (state.activeTabId !== tab.id) return;
  }
  applyPrLayout(tab, animate);
}

// Drag the PR/terminal divider. Every mousemove does the LEAST it can: one CSS-var write, coalesced
// to one per frame. The pane's geometry is measured once at mousedown — reading it per move forced a
// synchronous layout of the whole document, one the previous move's var write had just invalidated,
// so the pointer dragged the layout engine along with it.
// The terminal's grid refit is DEBOUNCED, not throttled: a refit re-sizes the tty whenever the
// column count changes, and a full-screen TUI answers that with a clear + full repaint — text
// rewrapping under a moving pointer is what reads as the terminal jumping. So while the pointer is
// moving the pane simply clips the terminal (cheap, and nothing moves that the pointer didn't move),
// and the grid reflows the moment the pointer settles — a pause mid-drag or the drop, whichever
// comes first. body.resizing keeps the terminals' ResizeObserver out of it, so this is the only
// refit during a drag.
// Drag lifecycle (incl. the native-webview mouseup trap) lives in lib/drag.js.
const SETTLE_MS = 90;
export function initPrDivider() {
  const d = document.getElementById('pr-divider');
  if (!d) return;
  let rect = null, x = 0, raf = 0, settle = 0;
  const refit = () => { settle = 0; fitTerm(visibleTerm()); };
  const apply = () => {
    raf = 0;
    if (!rect) return;
    // Clamp by PIXEL width, not just ratio: the terminal pane (left) needs room for the foot
    // buttons (Run/picker/Commit) and the PR pane (right) needs to stay readable. A pure ratio cap
    // let the terminal shrink to a sliver on a small window, overlapping the foot controls.
    // `ratio` is the WEBVIEW's share (--pr-split), i.e. the fraction right of the cursor.
    const MIN_PR = 360, MIN_TERM = 300;
    let ratio = 1 - (x - rect.left) / rect.width;
    const lo = MIN_PR / rect.width, hi = 1 - MIN_TERM / rect.width;
    ratio = lo < hi ? Math.min(hi, Math.max(lo, ratio)) : 0.5;  // window too small for both mins → split evenly
    state.prRatio = ratio;
    setPrSplit(Math.round(ratio * 100));
  };
  dragDivider(d, {
    start() {
      stopPrTween();
      rect = document.getElementById('split-body').getBoundingClientRect();
    },
    move(e) {
      x = e.clientX;
      if (!raf) raf = requestAnimationFrame(apply);
      clearTimeout(settle);                              // still moving: the grid waits
      settle = setTimeout(refit, SETTLE_MS);
    },
    end() {
      if (raf) { cancelAnimationFrame(raf); apply(); }   // the last move must land before we persist
      clearTimeout(settle); settle = 0; rect = null;
      localStorage.setItem('taskhub.prRatio', String(state.prRatio));
      fitTerm(visibleTerm());     // land on the exact boundary, whatever the last settled fit saw
    },
  });
}
