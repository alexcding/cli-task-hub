// Left sidebar: the project nav. Under each project folder: its worktrees, each with the tasks
// (agent sessions, live or stopped) running on it, then the project's plain open-tab rows. Hover
// "+" on a project creates a new worktree + task; hover "+" on a worktree adds another task there.
// Layout is always by project; a tab that is a task shows ONLY as a task row. Tasks/tabs matching
// no configured project fall into the unlabeled orphan group.
import { state, prByUrl, setProjects, projectByRepo, projectByJiraKey, projectById } from '../stores/store.js';
import { esc, escJs, ghAvatarSrc, setHtmlIfChanged, basename } from '../lib/util.js';
import { ensureAvatar } from '../lib/avatars.js';
import { ICON, TAB_ICON } from '../lib/icons.js';
import { ciInfo } from './cards.js';
import { closeTab, saveTabs, updateTitles } from './viewer.js';
import { renderContentTabs } from './content-tabs.js';
import { workflowRunState } from './workflow.js';
import { taskSessions, taskUrls, loadWorktrees, worktreesLoaded } from '../services/tasks.js';

// Per-project collapse state: a project whose id is in this set hides
// its nested open-tab rows. Persisted to localStorage so the choice survives re-renders/restart.
let _collapsed = (() => { try { return new Set(JSON.parse(localStorage.getItem('taskhub.projCollapsed') || '[]')); } catch { return new Set(); } })();
const saveCollapsed = () => { try { localStorage.setItem('taskhub.projCollapsed', JSON.stringify([..._collapsed])); } catch {} };

// Toggle the disclosure on a project folder (the caret on its right). stopPropagation in the
// caller keeps the click off the folder button's navigate-to-project handler.
export function toggleProjectTabs(id) {
  if (_collapsed.has(id)) _collapsed.delete(id); else _collapsed.add(id);
  saveCollapsed();
  renderTabs();   // full pipeline: rebuilds the nav AND re-applies the active-row highlight
}

// Render the sidebar's dynamic parts: the project nav (each project's task + open-tab rows
// nested), the orphan rows, the content-tab bar, and the viewer title.
export function renderTabs() {
  renderProjectNav(state.projects);
  const navEl = document.getElementById('opentabs-nav');
  if (navEl) setHtmlIfChanged(navEl, orphanTabsMarkup());
  renderContentTabs();   // the active context's horizontal tab bar (left content pane)
  updateTitles();
  reconcileRows();       // single owner: (re)attach drag-sort + toggle active/busy on every row
}

// Single post-render reconciliation. (Re)attaches drag-sort to current groups, then toggles the
// per-row .active / .busy classes. None of this is baked into the markup, so a tab switch or a
// busy edge never rebuilds the nav (no avatar flicker, no dropped drag handlers). Idempotent —
// safe to call after every render; renderTabs AND renderProjectNav both end with it so a render of
// either nav is self-sufficient (the active-tab highlight no longer depends on a paired call).
function reconcileRows() {
  initTabSort();
  refreshTermBusy();
}

// The project that owns a tab: by repo for GitHub, by the key's project prefix for Jira.
const tabProject = t => (t.kind === 'jira' ? projectByJiraKey(t.jiraKey) : projectByRepo(t.repo));

// Working first, then live over stopped, then by title — a stable order for a worktree's task rows.
const byTaskState = (a, b) => (Number(!!b.busy) - Number(!!a.busy)) || (Number(b.live) - Number(a.live)) || a.title.localeCompare(b.title);

// A worktree row under a project: folder name + branch, hover "+" (another task on it) and trash
// (delete the worktree with its tasks — the only place a worktree is removed), and its task rows
// nested beneath. Worktrees come from git (state.worktrees, loaded per project) plus
// any a task record names (so a task never hides while the list is still loading).
function worktreeRowHtml(p, wt, tasks) {
  const name = basename(wt.path);
  // Only a git-confirmed linked worktree gets the trash; a row synthesised from a task record alone
  // (list still loading, or the folder is gone) can add tasks but not force-delete a folder.
  const confirmed = (state.worktrees[p.id] || []).some(w => w.path === wt.path);
  const del = confirmed
    ? `<button class="wt-btn wt-del" title="Delete worktree (and its tasks)" onclick="event.stopPropagation();deleteWorktree('${p.id}','${escJs(wt.path)}',event)">${ICON.trash}</button>`
    : '';
  const sub = wt.branch && wt.branch !== name ? `<span class="wt-branch">${esc(wt.branch)}</span>` : '';
  return `<div class="wt-row" data-path="${esc(wt.path)}" title="${esc(wt.path)}">
     <span class="tab-ic">${ICON.worktree}</span>
     <span class="tab-title">${esc(name)}</span>${sub}
     <span class="wt-actions">
       <button class="wt-btn" title="New task on this worktree" onclick="event.stopPropagation();newWorktreeTaskIn('${p.id}','${escJs(wt.path)}')">${ICON.plus}</button>
       ${del}
     </span>
   </div>` + tasks.map(taskRowHtml).join('');
}

// The rows nested under a project: its worktrees (each with its tasks), then its plain open tabs
// (tabs that are tasks are excluded — they already show as task rows).
function projectRows(p) {
  const tasks = taskSessions().filter(s => s.projectId === p.id).sort(byTaskState);
  const wts = [...(state.worktrees[p.id] || [])];
  for (const t of tasks) if (!wts.some(w => w.path === t.worktree)) wts.push({ path: t.worktree, branch: t.branch });
  const urls = taskUrls();
  const tabs = state.tabs.filter(t => !urls.has(t.url) && tabProject(t)?.id === p.id);
  return wts.map(wt => worktreeRowHtml(p, wt, tasks.filter(t => t.worktree === wt.path))).concat(tabs.map(tabRowHtml));
}

// Tasks whose project is gone and tabs owned by no configured project, as one unlabeled group (no
// header — "no new section"). Empty string when everything has a home, the common case.
function orphanTabsMarkup() {
  const tasks = taskSessions().filter(s => !projectById(s.projectId)).sort(byTaskState);
  const urls = taskUrls();
  const tabs = state.tabs.filter(t => !urls.has(t.url) && !tabProject(t));
  const rows = tasks.map(taskRowHtml).concat(tabs.map(tabRowHtml));
  return rows.length ? `<div class="proj-tabs" data-project="">${rows.join('')}</div>` : '';
}

// Toggle the per-row .active (active tab) and .busy ("working" spinner, from the paired terminal)
// classes on every open-tab row in ONE pass — class toggles on the existing rows, never a markup
// rebuild, so a tab switch or a busy↔idle edge keeps avatars/spinners stable (no flicker). Also the
// busy-edge entry point imported by terminal.js. A Map keyed by tab id keeps the lookup O(1) (the
// row set spans both navs in project mode, so the old per-row state.tabs.find was O(rows×tabs)).
export function refreshTermBusy() {
  const byId = new Map(state.tabs.map(t => [t.id, t]));
  const active = state.activeTabId;
  document.querySelectorAll('.opentab').forEach(el => {
    const t = byId.get(el.dataset.id);
    // Active: the active tab's row, or a task row whose standalone terminal is the view.
    el.classList.toggle('active', (!!el.dataset.id && el.dataset.id === active) || (!!el.dataset.term && el.dataset.term === state.activeTermId));
    // A task row knows its terminal directly (data-term) — it may have no open tab at all.
    const term = state.terms.get(el.dataset.term || t?.termId || '');
    const busy = !!term?.busy || !!(el.classList.contains('task-row') && t && workflowRunState(t.id));
    el.classList.toggle('busy', busy);
  });
}

// One open-tab row. GitHub tabs show the PR author's avatar (github.com/<login>.png, no API
// call) with the CI status as a colored badge; fall back to the GitHub octicon. Shared by both
// grouping modes — the category groups (#opentabs-nav) and the per-project nesting.
// Left-click activates, middle-click closes, right-click opens a menu.
function tabRowHtml(t) {
  // "Working" spinner on the right of the row, shown only while the paired terminal is
  // busy (the .busy class is toggled on the row by refreshTermBusy — NOT baked into this
  // markup — so a busy↔idle flip never rebuilds the row or restarts the spin animation).
  const spin = '<span class="tab-spin"></span>';
  let icon;
  if (t.kind === 'github') {
    const pr = prByUrl(t.url);
    // Prefer the live author, fall back to the login persisted on the tab so the avatar
    // survives a state.projects reload (Jira/Settings) and shows on cold start before the
    // dashboard snapshot lands — mirrors the category fallback below. CI has no fallback:
    // it's live-only (a persisted badge would go stale).
    const login = pr?.author?.login || t.login;
    const { cls, label } = ciInfo(pr?.ci);
    // CI shown as a Slack-style status badge on the avatar's bottom-right corner.
    const badge = cls === 'ci-none' ? '' : `<span class="ci-badge ${cls}" title="${esc(label)}"></span>`;
    // Prefer the avatar frozen onto the tab, then the shared cache, then the live github.com URL
    // (warming the cache so a later rebuild swaps in the data URI rather than re-fetching), then
    // the octicon. data-av lets ensureAvatar swap the data URI into this img once it lands.
    if (login && !t.avatar) ensureAvatar(login);
    const src = ghAvatarSrc(login, t.avatar);
    const inner = src ? `<img src="${src}"${login ? ` data-av="${esc(login)}"` : ''} alt="" loading="lazy">` : TAB_ICON.github;
    icon = `<span class="tab-ic" title="${login ? esc(login) : ''}">${inner}${badge}</span>`;
  } else {
    icon = `<span class="tab-ic">${TAB_ICON[t.kind] || ''}</span>`;
  }
  return `<div class="opentab" data-id="${t.id}"
        onclick="activateTab('${t.id}')"
        onauxclick="if(event.button===1){event.preventDefault();closeTab('${t.id}')}"
        oncontextmenu="return tabMenu(event,'${t.id}')" title="${esc(t.url)}">
     ${icon}
     <span class="tab-title">${esc(t.title)}</span>
     ${spin}
     <button class="tab-x" onclick="event.stopPropagation();closeTab('${t.id}')" title="Close tab">${ICON.close}</button>
   </div>`;
}

// ── Task rows ─────────────────────────────────────────────────────────────────
// One row per task (services/tasks.js → taskSessions), nested under its worktree row: a state
// dot, the GitHub/Jira mark, the title, and the CLI mark. `.busy` (working spinner + dot) is toggled
// by refreshTermBusy, not baked in; the analyzed resting state (needs input / blocked / done) rides
// on data-state. The last summary is the tooltip. Click opens/resumes (openTaskSession); the trash
// deletes the task with its worktree. Task rows are not drag-reorderable (they sort by state).
const CLI_LABEL = { claude: 'Claude', codex: 'Codex' };
function taskRowHtml(s) {
  const st = !s.live ? 'stopped' : (s.state || 'idle');
  const tab = s.tab;
  const tabAttrs = tab
    ? ` data-id="${tab.id}" onauxclick="if(event.button===1){event.preventDefault();closeTab('${tab.id}')}" oncontextmenu="return tabMenu(event,'${tab.id}')"`
    : '';
  const where = s.url || s.worktree;
  const tip = s.summary ? `${s.title}\n${s.summary}` : (s.live ? where : `${where}\nStopped — click to resume`);
  const cli = CLI_LABEL[s.cli] || '';
  return `<div class="opentab task-row${s.live ? '' : ' stopped'}" data-state="${esc(st)}" data-task="${esc(s.id)}"${s.termId ? ` data-term="${esc(s.termId)}"` : ''}${tabAttrs}
        onclick="openTaskSession('${escJs(s.id)}')" title="${esc(tip)}">
     <span class="task-dot"></span>
     <span class="tab-ic">${TAB_ICON[s.kind] || ICON.terminal}</span>
     <span class="tab-title">${esc(s.title)}</span>
     ${cli ? `<span class="task-cli">${esc(cli)}</span>` : ''}
     <span class="tab-spin"></span>
     <button class="tab-x" onclick="event.stopPropagation();deleteTaskSession('${escJs(s.id)}',event)" title="Delete task (stops its terminal; the worktree stays)">${ICON.trash}</button>
   </div>`;
}

// Drag-to-reorder within each group — the per-project groups (.proj-tabs, nested in the project
// nav) plus the orphan group. After a drop, sync state.tabs to DOM order.
// Idempotent so it's safe to call after EVERY render: a group that already has a Sortable keeps it
// (an in-progress drag is never interrupted, and the markup-stable renders that fix the avatar
// flicker no longer drop the drag); instances on rebuilt-away elements are pruned.
let _sortables = [];
function initTabSort() {
  if (typeof Sortable === 'undefined') return;
  _sortables = _sortables.filter(s => { if (document.body.contains(s.el)) return true; try { s.destroy(); } catch {} return false; });
  document.querySelectorAll('.proj-tabs').forEach(group => {
    if (Sortable.get(group)) return;   // already wired
    // forceFallback: use SortableJS's own mouse-driven drag, NOT the native HTML5 DnD API —
    // native DnD is unreliable in the Tauri shell's WKWebView (it worked under Electron/Chromium),
    // and the fallback behaves identically across engines. fallbackTolerance keeps a plain click
    // (activate tab) from being read as a drag.
    _sortables.push(new Sortable(group, {
      draggable: '.opentab:not(.task-row)', filter: '.tab-x', animation: 150,
      forceFallback: true, fallbackTolerance: 4, onEnd: syncTabOrder,
    }));
  });
}
function syncTabOrder() {
  // Read rows across both navs in document order (#project-nav precedes #opentabs-nav).
  const order = [...document.querySelectorAll('#project-nav .opentab:not(.task-row), #opentabs-nav .opentab:not(.task-row)')].map(el => el.dataset.id);
  state.tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  saveTabs();
}

// Right-click tab menu — a native Electron context menu popped from main (see CH.TAB_MENU
// in ipc/system.js), so it matches the webview/tray menus and the native-mac feel. Copy
// Link / Open Link in Browser act in main; Close tab comes back here since it needs the
// renderer's tab state. preventDefault so the browser's own context menu never shows.
export async function tabMenu(e, id) {
  e.preventDefault();
  const tab = state.tabs.find(t => t.id === id);
  if (await window.taskhub?.tabMenu?.(tab?.url || '') === 'close') closeTab(id);
}

// ── Projects sidebar nav ──────────────────────────────────────────────────────
// Each folder is followed by its rows, nested inline: its worktrees with their tasks, then its plain
// open tabs. setProjects keeps the live PR data the tab rows read for avatars.
export function renderProjectNav(projects) {
  setProjects(projects);
  const el = document.getElementById('project-nav');
  if (!el) return;
  const list = state.projects.map(p => {
    if (p.workspace && !worktreesLoaded(p)) loadWorktrees(p); // async; re-renders when it lands
    const rows = projectRows(p);
    const collapsed = _collapsed.has(p.id);
    // A caret on the folder's right toggles its open-tab rows — shown only when it has any.
    const caret = rows.length
      ? `<span class="proj-toggle${collapsed ? ' collapsed' : ''}" title="${collapsed ? 'Show' : 'Hide'} open tabs"
           onclick="event.stopPropagation();toggleProjectTabs('${p.id}')">${ICON.caret}</span>`
      : '';
    // Hover "+" (only for projects with a local workspace): a new worktree + task.
    const add = p.workspace
      ? `<span class="proj-add" title="New task on a new worktree" onclick="event.stopPropagation();newWorktreeTask('${p.id}')">${ICON.plus}</span>`
      : '';
    const btn = `<button class="nav-btn" data-page="project" data-project="${p.id}" onclick="showPage('project','${p.id}')">
      <span class="icon">${ICON.folder}</span>
      <span class="proj-name">${esc(p.name)}</span>
      ${add}${caret}
    </button>`;
    return btn + (rows.length && !collapsed
      ? `<div class="proj-tabs" data-project="${p.id}">${rows.join('')}</div>`
      : '');
  }).join('');
  setHtmlIfChanged(el, list);
  // Re-apply the active-project highlight showPage set — a rebuild (this runs on tab changes
  // too) drops it, and there's no showPage to restore it on a background SSE refresh.
  // But a project and a tab are never both selected: skip while a tab/terminal is the view (its
  // own .opentab is the active row), so opening a link clears the folder highlight and vice-versa.
  const viewingOverlay = document.body.classList.contains('viewing-tab') || document.body.classList.contains('viewing-term');
  if (!viewingOverlay && state.activeProjectId && document.getElementById('page-project')?.classList.contains('active'))
    el.querySelector(`.nav-btn[data-project="${state.activeProjectId}"]`)?.classList.add('active');
  reconcileRows();   // self-sufficient: wire drag-sort onto the project rows AND toggle active/busy
}

// ── Resizable left sidebar (width persisted in localStorage, restored next launch) ─
export function initSidebarResize() {
  const handle = document.getElementById('sidebar-resizer');
  if (!handle) return;
  const setW = w => document.documentElement.style.setProperty('--sidebar-w', Math.min(420, Math.max(170, w)) + 'px');
  const saved = parseInt(localStorage.getItem('taskhub.sidebarWidth') || '', 10);
  if (saved) setW(saved);
  let dragging = false, x = 0, raf = 0;
  const apply = () => { raf = 0; setW(x); };
  handle.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); document.body.classList.add('resizing'); });
  window.addEventListener('mousemove', e => { if (!dragging) return; x = e.clientX; if (!raf) raf = requestAnimationFrame(apply); });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; document.body.classList.remove('resizing');
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10);
    if (w) localStorage.setItem('taskhub.sidebarWidth', String(w));
  });
}
