// Full-width project "Git" tab: a local-branch list + a worktree-folders list beside the
// commit graph. Picking a branch (or a worktree's branch) renders its graph on the right,
// where each commit opens a detail pane (meta + message + diff). Branches are read-only; the
// only worktree write is removing an existing worktree folder (no create — that's done from
// the terminal tab chip). Reuses the shared git render helpers from git.js.
import { ROUTES } from '/shared/routes.mjs';
import { state } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { esc, escJs, fmtDate } from '../lib/util.js';
import { ICON } from '../lib/icons.js';
import { toast, toastErr } from '../components/toast.js';
import { computeGraph } from '../lib/git-graph.mjs';
import { ensureDiff2Html, drawDiff, graphSvg, refChips, fmtDateTime, LANE_W, ROW_H } from '../components/git.js';

// One project tab is visible at a time → a single module-level snapshot suffices.
let _t = null;   // { id, cwd, ref, viewing, commits, graph, refs, view:'list'|'commit', sha, detail }
let _busy = false;
const proj = id => state.projects.find(p => p.id === id);

// ── Entry: render the tab shell, then load refs + log in parallel ────────────────────
export async function loadGitTab(id) {
  const host = document.getElementById(`proj-gittab-${id}`);
  if (!host) return;
  const p = proj(id);
  if (!p?.workspace) {
    host.innerHTML = `<div class="empty"><div class="empty-icon">${ICON.branch}</div><p>Set a workspace folder for this project (Edit, top-right) to browse its branches and commit history.</p></div>`;
    return;
  }
  // Preserve the viewed branch across reloads of the same project, but always reset to the
  // list view — a reload re-fetches and would otherwise land in a commit detail whose `detail`
  // payload we don't carry over, leaving the pane stuck on its loading spinner.
  const same = _t?.id === id;
  _t = { id, cwd: p.workspace, ref: same ? (_t.ref || '') : '', view: 'list', sha: null, viewing: same ? _t.viewing : undefined, defaultBranch: same ? _t.defaultBranch : undefined };

  host.innerHTML = `
    <div class="gt-layout">
      <div class="gt-side" id="gt-side-${id}"><div class="loading-row"><div class="spinner"></div> Loading…</div></div>
      <div class="gt-main" id="gt-main-${id}"><div class="loading-row"><div class="spinner"></div> Loading history…</div></div>
    </div>`;

  await ensureDiff2Html();
  if (!document.getElementById(`proj-gittab-${id}`)) return; // tab changed during bundle load
  await Promise.all([loadRefs(id), loadLog(id)]);
}

// ── Left rail: local branches + worktree folders ─────────────────────────────────────
async function loadRefs(id) {
  let data;
  try { data = await api(`${ROUTES.GIT_REFS}?path=${encodeURIComponent(_t.cwd)}`); }
  catch (e) { data = { error: e.message }; }
  if (!_t || _t.id !== id) return;
  _t.refs = data;
  if (data.defaultBranch) _t.defaultBranch = data.defaultBranch; // own the pin source; survives branch picks
  renderSide(id);
}

function renderSide(id) {
  const el = document.getElementById(`gt-side-${id}`);
  if (!el || !_t?.refs) return;
  if (_t.refs.error) { el.innerHTML = `<div class="pg-empty">${esc(_t.refs.error)}</div>`; return; }
  const viewing = _t.viewing || '';
  const def = _t.defaultBranch || '';
  // Pin the repo's default branch (main/develop) to the top of each list; the rest keep their
  // order (branches: most-recent-commit first). No "current" tag — selection is shown by the
  // highlighted row, and any branch/worktree stays clickable.
  const pinDefault = (arr, branchOf) => arr.slice().sort((a, b) => Number(branchOf(b) === def) - Number(branchOf(a) === def));
  const branches = pinDefault(_t.refs.branches || [], b => b.name);
  const worktrees = pinDefault(_t.refs.worktrees || [], w => w.branch);

  // Values interpolated into inline on* handlers use escJs() (a branch name or worktree path may
  // contain a single quote, which esc()'s HTML entity decodes back to a quote that breaks the JS
  // string); title=… stays esc() since that's HTML-text context.
  const branchRow = b => `
    <button class="gt-row${b.name === viewing ? ' viewing' : ''}" onclick="gitTabPick('${id}','${escJs(b.name)}')" title="${esc(b.name)}${b.upstream ? ' → ' + esc(b.upstream) : ''}">
      <span class="gt-row-ic">${b.name === viewing ? ICON.checkCircle : ICON.branch}</span>
      <span class="gt-row-name${b.name === def ? ' current' : ''}">${esc(b.name)}</span>
    </button>`;

  // Worktree folders: click to view that folder's branch. Remove is suppressed on git's main
  // tree (git won't remove the main working tree); other worktrees get a two-click remove.
  const wtRow = w => `
    <div class="gt-row gt-row-wt${w.branch && w.branch === viewing ? ' viewing' : ''}" ${w.branch ? `onclick="gitTabPick('${id}','${escJs(w.branch)}')"` : ''} title="${esc(w.path)}">
      <span class="gt-row-ic">${ICON.worktree || ICON.folder}</span>
      <span class="gt-row-name${w.branch && w.branch === def ? ' current' : ''}">${esc(w.branch || '(detached)')}</span>
      <span class="gt-wt-path">${esc(shortPath(w.path))}</span>
      ${w.isMain ? '' : `<span class="gt-row-act gt-row-rm" onclick="event.stopPropagation();gitTabRemoveWorktree('${id}',this,'${escJs(w.path)}')" title="Remove this worktree folder">remove</span>`}
    </div>`;

  el.innerHTML = `
    <div class="gt-sec">Branches <span class="gt-count">${branches.length}</span></div>
    <div class="gt-list">${branches.length ? branches.map(branchRow).join('') : '<div class="gt-none">none</div>'}</div>
    <div class="gt-sec">Worktrees <span class="gt-count">${worktrees.length}</span></div>
    <div class="gt-list">${worktrees.length ? worktrees.map(wtRow).join('') : '<div class="gt-none">none</div>'}</div>`;
}

// ── Right column: graph/list (and commit detail) ─────────────────────────────────────
async function loadLog(id) {
  let data;
  try { data = await api(`${ROUTES.GIT_LOG}?path=${encodeURIComponent(_t.cwd)}&limit=400${_t.ref ? `&ref=${encodeURIComponent(_t.ref)}` : ''}`); }
  catch (e) { data = { error: e.message }; }
  if (!_t || _t.id !== id) return;
  const main = document.getElementById(`gt-main-${id}`);
  if (!main) return;
  if (data.error) { main.innerHTML = `<div class="pg-empty">${esc(data.error)}</div>`; return; }
  _t.commits = data.commits;
  _t.viewing = data.viewing;
  // _t.defaultBranch is owned by loadRefs (the /refs payload); the log only returns it when no
  // branch is picked, so don't overwrite here or a branch-pick reload would clear the pin.
  _t.graph = computeGraph(data.commits.map(c => ({ sha: c.sha, parents: c.parents })));
  renderSide(id);     // refresh the rail's "viewing" highlight now that we know the branch
  renderMain(id);
  loadAvatars(id);    // overlay real GitHub avatars once they arrive (non-blocking)
}

function renderMain(id) {
  const main = document.getElementById(`gt-main-${id}`);
  if (!main || !_t) return;
  if (_t.view === 'commit') return renderCommit(id);
  if (!_t.commits?.length) { main.innerHTML = `<div class="pg-empty">No commits on this branch.</div>`; return; }
  const w = Math.max(1, _t.graph.laneCount) * LANE_W;
  main.innerHTML = `
    <div class="gt-main-head">${ICON.branch}<span>${esc(_t.viewing || '')}</span><span class="gt-count">${_t.commits.length}</span>
      <button class="pg-refresh" title="Refresh" onclick="loadGitTab('${id}')">${ICON.refresh}</button></div>
    <div class="gt-clog" style="--pg-row-h:${ROW_H}px">${_t.commits.map((c, i) => `
      <div class="pg-crow" onclick="gitTabShowCommit('${id}','${c.sha}')" title="${esc(c.subject)}">
        ${graphSvg(_t.graph.rows[i], _t.graph.laneCount, w)}
        ${avatar(c)}
        <div class="pg-crow-main">
          <div class="pg-crow-subj">${refChips(c.refs)}${esc(c.subject)}</div>
          <div class="pg-crow-meta">${esc(c.author)} · <span title="${esc(c.date)}">${esc(fmtDate(c.date))}</span> · <span class="pg-sha">${esc(c.short)}</span></div>
        </div>
      </div>`).join('')}</div>`;
}

export function gitTabPick(id, ref) {
  if (!_t || _t.id !== id) return;
  _t.ref = ref; _t.view = 'list'; _t.sha = null;
  const main = document.getElementById(`gt-main-${id}`);
  if (main) main.innerHTML = `<div class="loading-row"><div class="spinner"></div> Loading…</div>`;
  loadLog(id);
}

export async function gitTabShowCommit(id, sha) {
  if (!_t || _t.id !== id) return;
  _t.view = 'commit'; _t.sha = sha;
  const main = document.getElementById(`gt-main-${id}`);
  if (main) main.innerHTML = `<div class="pg-empty"><div class="loading-row"><div class="spinner"></div> Loading commit…</div></div>`;
  let data;
  try { data = await api(`${ROUTES.GIT_SHOW}?path=${encodeURIComponent(_t.cwd)}&sha=${encodeURIComponent(sha)}`); }
  catch (e) { data = { error: e.message }; }
  if (!_t || _t.id !== id || _t.sha !== sha) return; // bail if the project/commit changed mid-flight
  _t.detail = data;
  renderCommit(id);
}

export function gitTabBack(id) {
  if (!_t) return;
  _t.view = 'list'; _t.detail = null;
  renderMain(id);
}

function renderCommit(id) {
  const main = document.getElementById(`gt-main-${id}`);
  if (!main || !_t) return;
  const data = _t.detail;
  if (!data) return;
  if (data.error) {
    main.innerHTML = `<div class="gt-cd-bar"><button class="pg-back" onclick="gitTabBack('${id}')">${ICON.caret} Back</button></div><div class="pg-empty">${esc(data.error)}</div>`;
    return;
  }
  const m = data.meta;
  const [subject, ...rest] = (m.message || '').split('\n');
  const bodyText = rest.join('\n').trim();
  const sameCommitter = m.author === m.committer && m.authorEmail === m.committerEmail;
  main.innerHTML = `
    <div class="gt-cd-bar"><button class="pg-back" onclick="gitTabBack('${id}')">${ICON.caret} Back</button></div>
    <div class="gt-cd-scroll">
      <div class="pg-cd-subject">${esc(subject)}</div>
      <div class="pg-cd-fields">
        <div class="pg-cd-row"><span class="pg-cd-k">Author</span><span class="pg-cd-v">${esc(m.author)} <span class="pg-cd-email">${esc(m.authorEmail)}</span></span></div>
        <div class="pg-cd-row"><span class="pg-cd-k"></span><span class="pg-cd-v pg-cd-date" title="${esc(m.authorDate)}">${esc(fmtDateTime(m.authorDate))}</span></div>
        ${sameCommitter ? '' : `<div class="pg-cd-row"><span class="pg-cd-k">Committer</span><span class="pg-cd-v">${esc(m.committer)} <span class="pg-cd-email">${esc(m.committerEmail)}</span></span></div>`}
        <div class="pg-cd-row"><span class="pg-cd-k">SHA</span><span class="pg-cd-v pg-sha" title="${esc(m.sha)}">${esc(m.short)}</span></div>
        ${m.parents.length ? `<div class="pg-cd-row"><span class="pg-cd-k">Parent${m.parents.length > 1 ? 's' : ''}</span><span class="pg-cd-v">${m.parents.map(pp => `<a class="pg-sha pg-parent" onclick="gitTabShowCommit('${id}','${pp}')">${esc(pp.slice(0, 7))}</a>`).join(' ')}</span></div>` : ''}
      </div>
      ${bodyText ? `<pre class="pg-cd-message">${esc(bodyText)}</pre>` : ''}
      <div id="gt-cd-diff-${id}" class="pg-cd-diff"></div>
    </div>`;
  const diffEl = document.getElementById(`gt-cd-diff-${id}`);
  if (data.diff && data.diff.trim()) drawDiff(diffEl, data.diff);
  else if (diffEl) diffEl.innerHTML = `<div class="pg-empty">No changes (empty or merge commit).</div>`;
}

// Remove an existing worktree folder (the only worktree write here — creation lives on the
// terminal tab chip). Two-click confirm: first click arms the button, second removes (the
// codebase avoids blocking window.confirm — see diff.js).
export async function gitTabRemoveWorktree(id, btn, worktreePath) {
  if (_busy || !_t || _t.id !== id) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1'; btn.textContent = 'remove?'; btn.classList.add('armed');
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = 'remove'; btn.classList.remove('armed'); } }, 2500);
    return;
  }
  _busy = true;
  try {
    const r = await apiJson(ROUTES.WORKTREE_REMOVE, 'POST', { path: _t.cwd, worktree: worktreePath });
    if (r.error) toastErr(r.error); else toast('Worktree removed');
  } catch (e) { toastErr(e.message); }
  finally { _busy = false; loadRefs(id); }
}

function shortPath(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/');
}

// Commit avatar: a generated initials badge (instant, no network, colour hashed per author) with
// the author's real GitHub avatar overlaid when known (loadAvatars). The badge is the base, so if
// the image is missing or fails to load the initials show through — no broken-image flash.
// Keyed by author NAME (not email) so one person always gets the same initials + colour, even
// when they commit under several emails.
const _badges = new Map();
function authorBadge(name, email) {
  const key = String(name || email || '?').trim().toLowerCase();
  let b = _badges.get(key);
  if (b) return b;
  const words = String(name || email || '?').trim().split(/\s+/).filter(Boolean);
  const initials = (words.length >= 2 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 1)).toUpperCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  b = { initials, hue: ((h % 360) + 360) % 360 };
  _badges.set(key, b);
  return b;
}
function avatarImg(url) {
  return `<img class="pg-av-img" src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">`;
}
// Real avatar for a commit: GitHub's match for this exact SHA, else the photo resolved for any
// other commit by the same author name (covers the same person's unlinked-email commits).
function avatarUrl(c) {
  return _t?.avatars?.[c.sha] || _t?.avatarByName?.[c.author] || '';
}
function avatar(c) {
  const { initials, hue } = authorBadge(c.author, c.email);
  const url = avatarUrl(c);
  return `<span class="pg-av" data-sha="${c.sha}" data-name="${esc(c.author || '')}" style="background:hsl(${hue} 52% 47%)" title="${esc(c.author || c.email)}">${esc(initials)}${url ? avatarImg(url) : ''}</span>`;
}

// Fetch real GitHub avatars for the visible commits (cached server-side per repo|ref) and patch
// them onto the already-rendered initials badges — kept off the initial render so the graph
// paints instantly and never blocks on the network. No-op without a GitHub repo.
async function loadAvatars(id) {
  const repo = proj(id)?.repo;
  if (!repo) return;
  let map;
  try { map = await api(`${ROUTES.GIT_COMMIT_AVATARS}?repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(_t.ref || '')}&limit=400`); }
  catch { return; }
  if (!_t || _t.id !== id || !map) return;
  _t.avatars = map;
  // Build name → photo from the commits GitHub did resolve, so a person's other commits (under
  // emails GitHub couldn't link) reuse the same avatar instead of dropping to initials.
  const byName = {};
  for (const c of _t.commits || []) { const u = map[c.sha]; if (u && c.author && !byName[c.author]) byName[c.author] = u; }
  _t.avatarByName = byName;
  document.querySelectorAll(`#gt-main-${id} .pg-av[data-sha]`).forEach(sp => {
    const url = map[sp.dataset.sha] || byName[sp.dataset.name];
    if (url && !sp.querySelector('img')) sp.insertAdjacentHTML('beforeend', avatarImg(url));
  });
}
