// PR ↔ terminal split: each GitHub/Jira tab can show a paired terminal to its right.
// The on/off choice is PER TAB (stored on the tab as `tab.prSplit`, persisted with the
// tab) and defaults to OFF — opening a PR doesn't auto-spawn a terminal until toggled.
import { state, activeTab, projectByRepo, projectByPrUrl, projectByJiraKey } from './store.js';
import { api } from './api.js';
import { jiraKeyFromUrl, canSplitTerminal } from './util.js';
import { toastErr } from './toast.js';
import { createTermView, fitTerm, visibleTerm } from './terminal.js';
import { saveTabs, updateTitles } from './viewer.js';

// Where a tab's terminal should start. GitHub PR: the worktree at the PR's branch, else
// the project workspace. Jira ticket: the worktree whose branch embeds the ticket key,
// else the project workspace. null → main falls back to the app's own repo.
async function prCwd(tab) {
  if (tab.kind === 'jira') return jiraCwd(tab);
  const proj = projectByRepo(tab.repo) || projectByPrUrl(tab.url);
  const ws = proj && proj.workspace;
  if (!ws) return null;
  const branch = tab.branch || (proj.prs || []).find(p => p.url === tab.url)?.headRefName;
  if (branch) {
    try { const r = await api(`/api/worktree?path=${encodeURIComponent(ws)}&branch=${encodeURIComponent(branch)}`); if (r.path) return r.path; } catch {}
  }
  return ws;
}

// Jira ticket → terminal cwd. Find the owning project by key prefix, then ask the
// server for a worktree whose branch embeds the key. Per design: an unambiguous single
// match opens there; zero or multiple matches fall back to the project workspace.
async function jiraCwd(tab) {
  const key = tab.jiraKey || jiraKeyFromUrl(tab.url);
  const proj = projectByJiraKey(key);
  const ws = proj && proj.workspace;
  if (!ws || !key) return ws || null;
  try { const r = await api(`/api/worktree?path=${encodeURIComponent(ws)}&key=${encodeURIComponent(key)}`); if (r.path) return r.path; } catch {}
  return ws;
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
    if (byKey) { tab.termId = byKey[0]; return byKey[0]; }
    const cwd = await prCwd(tab);
    const byCwd = [...state.terms.entries()].find(([, t]) => t.paired && !t.pairKey && t.cwd === cwd);
    if (byCwd) { byCwd[1].pairKey = tab.url; tab.termId = byCwd[0]; return byCwd[0]; }
    tab.termId = await createTermView(cwd, null, { paired: true, pairKey: tab.url }); // title defaults to the folder/worktree name
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

// Show the PR's paired terminal beside its webview. When `animate` is set (toolbar toggle) the
// split expands open from the right; otherwise (switching to an already-split tab) it appears
// at the resting boundary immediately.
export function applyPrLayout(tab, animate = false) {
  const t = tab.termId && state.terms.get(tab.termId);
  if (!t) return;
  const target = Math.round(state.prRatio * 100);
  document.body.classList.add('pr-split');
  t.el.style.display = '';
  if (animate) {
    document.documentElement.style.setProperty('--pr-split', target + '%'); // park at final geometry…
    fitTerm(t);                                                             // …so the grid sizes correctly now
    document.documentElement.style.setProperty('--pr-split', '100%');        // …then start fully collapsed
    tweenPrSplit(target, () => { if (state.activeTabId === tab.id && tab.prSplit) fitTerm(t); });
  } else {
    document.documentElement.style.setProperty('--pr-split', target + '%');
    fitTerm(t);
  }
  updateTitles(); // terminal segment now has a terminal to name
}

// Collapse the split. With `tab`/`animate`, the panel shrinks the terminal to zero width (the
// webview grows to fill) before hiding the pane; without them (e.g. a tab closed) it just drops
// the layout class.
export function clearPrLayout(tab = null, animate = false) {
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
