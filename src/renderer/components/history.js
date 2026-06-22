// The Review pane has two sub-views, switched by the bottom-bar segmented control: the working
// diff (current uncommitted changes, rendered by diff.js) and this commit history. History is a
// half-height split — the commit list on top, the selected commit's diff below.
//
// The LIST reuses the project Git tab's renderer (git.js renderCommitRows: graph lanes + author
// avatars + ref chips), so it looks identical to the project-detail history; it's scoped to the
// branch's own commits (GIT_LOG aheadOnly, base..HEAD). The selected commit's diff (GIT_SHOW)
// uses our read-only .diff-table renderer (diff.js renderReadOnly), so the code follows the
// --diff-font / --diff-font-size tokens (font picker + ⌘+/⌘− zoom) like the working diff.
//
// The choice (Changes vs History) is remembered per tab and in-memory (tab.reviewView), so
// toggling Terminal⇄Review keeps the spot; a freshly opened tab starts on Changes.
import { ROUTES } from '/shared/routes.mjs';
import { activeTab, prByUrl } from '../stores/store.js';
import { api } from '../services/api.js';
import { esc } from '../lib/util.js';
import { parseDiff } from '../lib/diff-parse.mjs';
import { fmtDateTime, renderCommitRows, avatarImg, ROW_H } from './git.js';
import { renderDiffPane, renderReadOnly, wireDiffCollapse } from './diff.js';

let _view = 'changes'; // Review sub-view: 'changes' (working diff) | 'history' (commits)
let _cwd = '';         // worktree the history list was loaded for
let _commits = [];     // last loaded list
let _base = '';        // base branch the list is scoped against (commits ahead of it)
let _avatars = null;   // sha → GitHub avatar url (loaded after the list paints)
let _byName = null;    // author name → avatar url (covers a person's unlinked-email commits)
let _sel = null;       // sha currently shown in the bottom pane
let _seq = 0;          // list loads — bump to discard out-of-order results
let _cseq = 0;         // commit-detail fetches — separate so list/detail don't cancel each other
// Top/bottom split ratio (list height fraction), default 3/7, persisted like the PR divider.
let _ratio = Math.min(0.85, Math.max(0.15, parseFloat(localStorage.getItem('taskhub.histSplit')) || 0.3));

const pane = () => document.getElementById('history-pane');
const top = () => document.getElementById('hist-top');
const bottom = () => document.getElementById('hist-bottom');
const isHistory = () => _view === 'history';

function syncSwitch() {
  document.getElementById('review-changes')?.classList.toggle('on', _view === 'changes');
  document.getElementById('review-history')?.classList.toggle('on', _view === 'history');
}

function hidePane() {
  const p = pane();
  if (p) { p.hidden = true; p.innerHTML = ''; }
}

// Hide the history overlay only — leave the tab's chosen sub-view intact so re-entering Review
// restores it. Called by split.js when leaving the Review pane (to Terminal / another tab /
// closing the split); the history-pane is opaque, so it must come off the right pane.
export function hideHistory() {
  hidePane();
}

// Enter (or re-enter) the Review pane: restore THIS tab's sub-view — Changes by default, or the
// History it was last left on. Stored per tab and in-memory, so toggling Terminal⇄Review keeps
// the spot while a freshly opened tab starts on Changes.
export function applyReview(tab, cwd) {
  _cwd = cwd || '';
  _view = tab && tab.reviewView === 'history' ? 'history' : 'changes';
  syncSwitch();
  if (_view === 'history') openHistory(_cwd);
  else { hidePane(); renderDiffPane(_cwd); }
}

// Bottom-bar segmented control: flip the Review pane between the working diff and commit history,
// remembering the choice on the active tab.
export function setReviewView(view) {
  _view = view === 'history' ? 'history' : 'changes';
  const tab = activeTab();
  if (tab) tab.reviewView = _view;
  syncSwitch();
  if (_view === 'history') openHistory(_cwd);
  else { hidePane(); if (_cwd) renderDiffPane(_cwd); } // Changes: drop the history overlay, show the working diff
}

function openHistory(cwd) {
  const p = pane();
  if (!p) return;
  p.hidden = false;
  if (!cwd) { p.innerHTML = `<div class="hist-empty">No local folder is mapped to this tab.</div>`; return; }
  _cwd = cwd; _sel = null; _commits = []; _base = ''; _avatars = null; _byName = null;
  initOnce(p);
  p.style.setProperty('--hist-split', (_ratio * 100).toFixed(2) + '%');
  // Two stacked panes (list on top, the picked commit's diff below) with a draggable divider.
  p.innerHTML = `
    <div class="hist-top" id="hist-top">${loading('Loading history…')}</div>
    <div class="hist-divider" id="hist-divider" title="Drag to resize"></div>
    <div class="hist-bottom" id="hist-bottom"><div class="hist-empty">Select a commit to view its changes.</div></div>`;
  loadList(cwd);
}

const loading = (text) => `<div class="hist-empty"><div class="loading-row"><div class="spinner"></div> ${esc(text)}</div></div>`;

async function loadList(cwd) {
  const seq = ++_seq;
  // aheadOnly=1 → just this branch's own commits (base..HEAD), not the whole graph. Pass the
  // PR's real base branch when this is a PR tab, so we diff against its actual target (e.g.
  // develop) rather than the repo default; the server falls back to the default otherwise.
  const tab = activeTab();
  const base = prByUrl(tab?.url || '')?.baseRefName || '';
  const q = base ? `&base=${encodeURIComponent(base)}` : '';
  let data;
  try { data = await api(`${ROUTES.GIT_LOG}?path=${encodeURIComponent(cwd)}&limit=200&aheadOnly=1${q}`); }
  catch (e) { data = { error: e.message }; }
  if (!isHistory() || seq !== _seq || cwd !== _cwd) return; // superseded / left history mid-flight
  const t = top();
  if (!t) return;
  if (data.error) { t.innerHTML = `<div class="hist-empty">${esc(data.error)}</div>`; return; }
  _commits = data.commits || [];
  _base = data.base || '';
  renderList();
  loadAvatars(cwd, tab?.repo || '', tab?.branch || ''); // overlay real avatars once they arrive
}

function renderList() {
  const t = top();
  if (!t) return;
  if (!_commits.length) { t.innerHTML = `<div class="hist-empty">${_base ? `No commits ahead of ${esc(_base)}.` : 'No commits on this branch yet.'}</div>`; return; }
  const head = `<div class="hist-head">${_base ? `<span class="hist-base">vs ${esc(_base)}</span>` : ''}<span class="hist-count">${_commits.length}</span></div>`;
  const rows = renderCommitRows(_commits, null, {
    onclick: sha => `histShowCommit('${sha}')`,
    selected: _sel,
    avatarUrl: c => (_avatars && (_avatars[c.sha] || _byName?.[c.author])) || '',
    lanes: false, // single branch (base..HEAD) — no graph column needed
  });
  t.innerHTML = head + `<div class="hist-clog" style="--pg-row-h:${ROW_H}px">${rows}</div>`;
  // Default to the newest commit so the diff pane shows something instead of the placeholder.
  if (!_sel) histShowCommit(_commits[0].sha);
}

// Fetch real GitHub avatars for the listed commits (cached server-side per repo|ref) and patch
// them onto the initials badges — off the initial render so the list paints instantly. No-op
// without a GitHub repo. Guarded on the worktree, not the seq, so selecting a commit (which
// bumps the detail seq) never cancels the patch.
async function loadAvatars(cwd, repo, ref) {
  if (!repo) return;
  let map;
  try { map = await api(`${ROUTES.GIT_COMMIT_AVATARS}?repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}&limit=200`); }
  catch { return; }
  if (!isHistory() || cwd !== _cwd || !map) return;
  _avatars = map;
  const byName = {};
  for (const c of _commits) { const u = map[c.sha]; if (u && c.author && !byName[c.author]) byName[c.author] = u; }
  _byName = byName;
  top()?.querySelectorAll('.pg-crow .pg-av[data-sha]').forEach(sp => {
    const url = map[sp.dataset.sha] || byName[sp.dataset.name];
    if (url && !sp.querySelector('img')) sp.insertAdjacentHTML('beforeend', avatarImg(url));
  });
}

export async function histShowCommit(sha) {
  if (!isHistory()) return;
  _sel = sha;
  // Reflect the selection in the list without rebuilding it.
  top()?.querySelectorAll('.pg-crow[data-sha]').forEach(r => r.classList.toggle('sel', r.dataset.sha === sha));
  const cseq = ++_cseq;
  const b = bottom();
  if (!b) return;
  b.innerHTML = loading('Loading commit…');
  let data;
  try { data = await api(`${ROUTES.GIT_SHOW}?path=${encodeURIComponent(_cwd)}&sha=${encodeURIComponent(sha)}`); }
  catch (e) { data = { error: e.message }; }
  if (!isHistory() || cseq !== _cseq || _sel !== sha) return; // bailed if the selection changed mid-flight
  renderCommit(data);
}

function renderCommit(data) {
  const b = bottom();
  if (!b) return;
  if (data.error) { b.innerHTML = `<div class="hist-empty">${esc(data.error)}</div>`; return; }
  const m = data.meta;
  const [subject, ...rest] = (m.message || '').split('\n');
  const body = rest.join('\n').trim();
  // Same renderer as the working-changes pane (read-only), so the code follows our diff font/size.
  const diffHtml = (data.diff && data.diff.trim())
    ? `<div class="hist-cd-diff">${renderReadOnly(parseDiff(data.diff))}</div>`
    : `<div class="hist-empty">No changes (empty or merge commit).</div>`;
  b.innerHTML = `
    <div class="hist-detail">
      <div class="hist-cd-subject">${esc(subject)}</div>
      <div class="hist-cd-meta">${esc(m.author)} · <span title="${esc(m.authorDate)}">${esc(fmtDateTime(m.authorDate))}</span> · <span class="hist-sha">${esc(m.short)}</span></div>
      ${body ? `<pre class="hist-cd-body">${esc(body)}</pre>` : ''}
    </div>${diffHtml}`;
  b.scrollTop = 0;
}

// Wired once on the persistent pane (its innerHTML is rebuilt per open, so delegate here rather
// than on the regenerated inner nodes): file collapse on header click, plus the top/bottom
// divider drag. The drag updates --hist-split live (list height fraction) and persists on drop.
let _wired = false;
function initOnce(p) {
  if (_wired) return;
  _wired = true;
  wireDiffCollapse(p); // file collapse/expand — shared with the Changes pane + Git tab
  let dragging = false;
  p.addEventListener('mousedown', e => {
    if (!e.target.closest('#hist-divider')) return;
    dragging = true; e.preventDefault(); document.body.classList.add('resizing');
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const r = p.getBoundingClientRect();
    _ratio = Math.min(0.85, Math.max(0.15, (e.clientY - r.top) / r.height));
    p.style.setProperty('--hist-split', (_ratio * 100).toFixed(2) + '%');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; document.body.classList.remove('resizing');
    localStorage.setItem('taskhub.histSplit', String(_ratio));
  });
}
