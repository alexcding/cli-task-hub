// Left sidebar: the project nav. Under each project folder: ONLY its session rows (one agent session
// per worktree, live or stopped). Every open tab that is not a task — PR, Jira issue or plain web
// page — sits in one "Tabs" group below the projects; a tab joins its project as a session row the
// moment a task is created for it. Hover "+" on a project creates a new worktree + session. Tasks
// whose project is gone fall into the unlabeled orphan group.
import { state, prByUrl, setProjects, projectById } from '../stores/store.js';
import { dragDivider } from '../lib/drag.js';
import { esc, escJs, ghAvatarSrc, setHtmlIfChanged, basename, isSessionUrl } from '../lib/util.js';
import { ensureAvatar } from '../lib/avatars.js';
import { ICON, TAB_ICON } from '../lib/icons.js';
import { ciInfo } from './cards.js';
import { closeTab, saveTabs, updateTitles } from './viewer.js';
import { renderContentTabs } from './content-tabs.js';
import { workflowRunState } from './workflow.js';
import { taskSessions, taskUrls, taskById, persistTask } from '../services/tasks.js';
import { openMenu, closeMenu } from './menu.js';
import { toast, toastErr } from './toast.js';
import { deleteTaskSession } from './tasks.js';

// Per-project collapse state: a project whose id is in this set hides
// its nested open-tab rows. Persisted to localStorage so the choice survives re-renders/restart.
let _collapsed = (() => { try { return new Set(JSON.parse(localStorage.getItem('taskhub.projCollapsed') || '[]')); } catch { return new Set(); } })();
const saveCollapsed = () => { try { localStorage.setItem('taskhub.projCollapsed', JSON.stringify([..._collapsed])); } catch {} };

// Collapse/expand ANIMATES: the rows are always in the DOM inside .proj-tabs (a 1fr→0fr grid track,
// see viewer.css), so this flips the class in place and swaps the folder icon — no markup rebuild,
// which would cut the transition. The nav's render cache is then pointed at what a fresh render
// would produce, so the next renderTabs sees "unchanged" and leaves the animating nodes alone.
function toggleProjectTabs(id) {
  const nav = document.getElementById('project-nav');
  const group = nav?.querySelector(`.proj-tabs[data-project="${id}"]`);
  if (!group) return; // nothing to collapse (no sessions/tabs) — and the icon must stay "closed"
  if (_collapsed.has(id)) _collapsed.delete(id); else _collapsed.add(id);
  saveCollapsed();
  const collapsed = _collapsed.has(id);
  group.classList.toggle('collapsed', collapsed);
  const icon = nav.querySelector(`.nav-btn[data-project="${id}"] .icon`);
  if (icon) icon.innerHTML = collapsed ? ICON.folder : ICON.folderOpen; // same rule as projectNavHtml (rows exist here)
  nav._lastHtml = projectNavHtml();
}

// Click on a project folder. First click focuses the project (shows its detail page); a click on the
// folder that is ALREADY in view toggles its rows collapsed/expanded. "In view" means the project
// page is the visible view — not merely the last-selected project while a tab/terminal is showing
// (then the click brings the project page back instead). No separate disclosure caret.
export function projectClick(id) {
  const body = document.body.classList;
  const focused = document.querySelector('.page.active')?.id === 'page-project' && state.activeProjectId === id
    && !body.contains('viewing-tab') && !body.contains('viewing-term');
  if (focused) toggleProjectTabs(id); else window.showPage?.('project', id);
}

// Render the sidebar's dynamic parts: the project nav (each project's task + open-tab rows
// nested), the orphan rows, the content-tab bar, and the viewer title.
export function renderTabs() {
  renderProjectNav(state.projects);
  const navEl = document.getElementById('opentabs-nav');
  if (navEl) setHtmlIfChanged(navEl, orphanTabsMarkup(taskSessions()) + openTabsMarkup());
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

const rowLabel = s => basename(s.worktree || '') || s.title || '';
// Sessions sort by when they were created, oldest first: a new session appends at the bottom of its
// project and no row ever moves again — pinning included, which only ADDS a mirror row to the Pinned
// group above the projects (pinnedNavMarkup). Ordering by run state (working → live → stopped)
// reshuffled the list under the pointer every time an agent started or finished a turn. `createdAt`
// is an ISO string (stamped at creation, immutable server-side), so a plain compare is
// chronological; a record from before it was stamped sorts first.
const byCreated = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
  || rowLabel(a).localeCompare(rowLabel(b));

// Pinned sessions, as a labelled group ABOVE the projects (#pinned-nav). These rows are MIRRORS:
// the session also stays exactly where it was under its project, in creation order — pinning adds a
// shortcut at the top, it never moves or hides the original. Both copies carry the same data-task /
// data-term, and every post-render pass walks `.opentab` with querySelectorAll (refreshTermBusy,
// syncSpinner), so the two stay in lockstep for active/busy/spinner state. Empty string when
// nothing is pinned — the label goes with the group.
function pinnedNavMarkup(sessions) {
  const rows = sessions.filter(s => s.pinned).sort(byCreated).map(sessionRowHtml);
  if (!rows.length) return '';
  // A plain wrapper on purpose: NOT .proj-tabs/.proj-tabs-inner, whose class names carry the
  // collapse grid (nothing to collapse here) and, more importantly, pick up drag-to-reorder in
  // initTabSort — a drop in this group would rewrite tab order from mirror rows.
  return `<div class="nav-label" style="margin-top:4px">Pinned</div>
    <div class="pinned-group">${rows.join('')}</div>`;
}

// One SESSION row per task record under a project (services/tasks.js → taskSessions). The worktree is
// the unit of work and the session is the agent running there — one per worktree — so the row is
// titled by the worktree folder. The sidebar reads ONLY session records: git worktrees without a
// session are not shown (no separate worktree UI).
function projectRows(p, sessions) {
  return sessions.filter(s => s.projectId === p.id).sort(byCreated).map(sessionRowHtml);
}

// Tasks whose project is gone, as one unlabeled group (no header). Empty string when every task
// has a home, the common case.
function orphanTabsMarkup(sessions) {
  const tasks = sessions.filter(s => !projectById(s.projectId)).sort(byCreated);
  return tasks.length ? `<div class="proj-tabs" data-project=""><div class="proj-tabs-inner">${tasks.map(sessionRowHtml).join('')}</div></div>` : '';
}

// Every open tab that is NOT a task — a PR, a Jira issue or a plain web page — under one "Tabs"
// label below the projects. A project folder holds only its sessions; a tab joins a project (as a
// session row) the moment a task is created for it, and leaves this group.
function openTabsMarkup() {
  const urls = taskUrls();
  const tabs = state.tabs.filter(t => !urls.has(t.url));
  if (!tabs.length) return '';
  return `<div class="nav-label">Tabs</div><div class="proj-tabs" data-project=""><div class="proj-tabs-inner">${tabs.map(tabRowHtml).join('')}</div></div>`;
}

// Toggle the per-row .active (active tab) and .busy ("working" spinner, from the paired terminal)
// classes on every open-tab row in ONE pass — class toggles on the existing rows, never a markup
// rebuild, so a tab switch or a busy↔idle edge keeps avatars/spinners stable (no flicker). Also the
// busy-edge entry point imported by terminal.js. A Map keyed by tab id keeps the lookup O(1) (the
// row set spans both navs in project mode, so the old per-row state.tabs.find was O(rows×tabs)).
export function refreshTermBusy() {
  const byId = new Map(state.tabs.map(t => [t.id, t]));
  const active = state.activeTabId;
  let anyBusy = false;
  document.querySelectorAll('.opentab').forEach(el => {
    const t = byId.get(el.dataset.id);
    // Active: the active tab's row, or a task row whose standalone terminal is the view.
    el.classList.toggle('active', (!!el.dataset.id && el.dataset.id === active) || (!!el.dataset.term && el.dataset.term === state.activeTermId));
    // A task row knows its terminal directly (data-term) — it may have no open tab at all.
    const term = state.terms.get(el.dataset.term || t?.termId || '');
    const busy = !!term?.busy || !!(el.classList.contains('task-row') && t && workflowRunState(t.id));
    el.classList.toggle('busy', busy);
    if (busy && el.classList.contains('task-row')) anyBusy = true;
  });
  syncSpinner(anyBusy);
}

// One open-tab row in the Tabs group. GitHub tabs show the PR author's avatar (github.com/<login>.png,
// no API call) with the CI status as a colored badge; fall back to the GitHub octicon. Jira tabs
// show the Jira mark, web tabs a globe. Left-click activates, middle-click closes, right-click opens a menu.
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
    icon = `<span class="tab-ic">${TAB_ICON[t.kind] || ICON.globe}</span>`; // web tabs: globe
  }
  return `<div class="opentab" data-id="${t.id}"
        onclick="activateTab('${t.id}')"
        onauxclick="if(event.button===1){event.preventDefault();closeTab('${t.id}')}"
        oncontextmenu="return tabMenu(event,'${t.id}')" title="${esc(t.url)}">
     ${icon}
     <span class="tab-title">${esc(t.title)}</span>
     ${spin}
   </div>`;
}

// ── Session rows ──────────────────────────────────────────────────────────────
// One row per session (services/tasks.js → taskSessions): a 16px leading status slot + the worktree
// folder name. Status visuals follow unpeel's sidebar (DESIGN.md §5): busy = a glyph spinner at
// 120ms/frame — Claude Code's blooming asterisk in coral for Claude rows, unpeel's braille cycle in
// green for Codex; live-but-idle = that glyph held static in grey; needs input = a 6px amber dot
// with a 20% halo; blocked = the same in red; stopped = the row dims. `.busy` is toggled by
// refreshTermBusy, not baked in; the analyzed resting state rides on data-state. The last summary is
// the tooltip. Click opens/resumes (openTaskSession); right-click opens sessionMenu. Session rows
// are not drag-reorderable (they sort by creation time — see byCreated).
function sessionRowHtml(s) {
  const st = !s.live ? 'stopped' : (s.state || 'idle');
  const where = (!s.url || isSessionUrl(s.url)) ? s.worktree : s.url; // a bare session's url is synthetic — show the folder
  const tip = s.summary ? `${s.title}\n${s.summary}` : (s.live ? where : `${where}\nStopped — click to resume`);
  const attrs = [
    `data-state="${esc(st)}"`, `data-task="${esc(s.id)}"`,
    s.termId && `data-term="${esc(s.termId)}"`,
    s.tab && `data-id="${s.tab.id}"`, // no middle-click close: a session's tab goes only with Remove session
    s.cli && `data-cli="${esc(s.cli)}"`,
  ].filter(Boolean).join(' ');
  // Hover-only, in both copies of the row (the Pinned group above the projects is what says a
  // session is pinned). On a pinned row the glyph is filled (.task-row.pinned .task-pin svg), so
  // hovering it reads as the toggle that undoes the pin.
  const pin = `<span class="task-pin" title="${s.pinned ? 'Unpin session' : 'Pin session to the top'}"
        onclick="event.stopPropagation();toggleSessionPin('${escJs(s.id)}')">${ICON.pin}</span>`;
  return `<div class="opentab task-row${s.live ? '' : ' stopped'}${s.pinned ? ' pinned' : ''}" ${attrs}
        onclick="openTaskSession('${escJs(s.id)}')" oncontextmenu="return sessionMenu(event,'${escJs(s.id)}')" title="${esc(tip)}">
     <span class="task-lead"><span class="task-spin">${spinFrames(s.cli)[0]}</span><span class="task-mark">${staticGlyph(s.cli)}</span></span>
     <span class="tab-title">${esc(rowLabel(s))}</span>
     ${pin}
   </div>`;
}

// Busy-spinner frames per CLI. Claude rows use Claude Code's own spinner — the asterisk that
// blooms · ✢ ✳ ✶ ✻ ✽ and back, in Claude coral; everything else (Codex, unknown) uses unpeel's
// braille cycle ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏. One shared 120ms ticker advances every visible busy row's glyph in
// lockstep and runs only while at least one row is busy (started/stopped by refreshTermBusy).
const SPIN_FRAMES = {
  claude: ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'],
  default: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};
const spinFrames = cli => SPIN_FRAMES[cli] || SPIN_FRAMES.default;
// Resting glyph for a LIVE but idle session — the spinner's full-bloom frame held still (Claude's ✻,
// a filled braille cell otherwise), colourless: colour is reserved for activity.
const STATIC_GLYPH = { claude: '✻', default: '⠿' };
const staticGlyph = cli => STATIC_GLYPH[cli] || STATIC_GLYPH.default;
let _spinTimer = null, _spinFrame = 0;
function syncSpinner(anyBusy) {
  if (anyBusy && !_spinTimer) {
    _spinTimer = setInterval(() => {
      _spinFrame = (_spinFrame + 1) % 10;
      document.querySelectorAll('.task-row.busy .task-spin').forEach(el => {
        el.textContent = spinFrames(el.closest('.task-row')?.dataset.cli)[_spinFrame];
      });
    }, 120);
  } else if (!anyBusy && _spinTimer) {
    clearInterval(_spinTimer); _spinTimer = null;
  }
}

// Pin / unpin a session: a pinned session gains a mirror row in the Pinned group above the projects
// (pinnedNavMarkup) — ordering inside its project is untouched. Persisted on the task record, so it
// survives restarts; persistTask re-renders the sidebar for us.
export function toggleSessionPin(id) {
  const t = taskById(id);
  if (!t) return;
  persistTask({ id, pinned: !t.pinned });
}

// Right-click a session row: Pin/Unpin, Reveal in Finder (its worktree folder), Copy link (when the
// session has a PR/Jira page), and Remove session — which removes the worktree with it (one unit;
// tasks.js → deleteTaskSession is the single removal path).
// The real macOS menu when the shell offers one (bridge.js sessionMenu → muda popup, same contract
// as tabMenu/folderMenu: it resolves the chosen id and the actions run HERE, since they need the
// task record and the in-app confirm). The in-page menu stays as the fallback for a plain browser
// (web-only dev, where window.taskhub is undefined). preventDefault up front — an async handler
// returns a promise, so `return sessionMenu(...)` can't suppress the browser's own menu.
export async function sessionMenu(e, id) {
  e.preventDefault();
  const t = taskById(id);
  const url = t?.url && /^https?:/.test(t.url) ? t.url : null;
  const reveal = () => window.taskhub?.openPath?.(t.worktree);
  // Guarded: after the modal native popup the webview may have no transient activation left, so a
  // clipboard write can be refused — silently, and as an unhandled rejection, without this.
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); toast('Link copied'); }
    catch { toastErr('Could not copy the link'); }
  };
  if (window.taskhub?.sessionMenu) {
    closeMenu(); // dismiss any open in-page menu (the native menu won't fire the click that would)
    const action = await window.taskhub.sessionMenu({ pinned: !!t?.pinned, hasWorktree: !!t?.worktree, hasUrl: !!url });
    if (action === 'pin') toggleSessionPin(id);
    else if (action === 'finder') reveal();
    else if (action === 'copy') copy();
    else if (action === 'remove') deleteTaskSession(id);
    return false;
  }
  return openMenu(e, [
    { label: t?.pinned ? 'Unpin session' : 'Pin session', onClick: () => toggleSessionPin(id) },
    t?.worktree && { label: 'Reveal in Finder', onClick: reveal },
    url && { label: 'Copy link', onClick: copy },
    { label: 'Remove session…', danger: true, onClick: () => deleteTaskSession(id) },
  ]);
}

// Drag-to-reorder within each group — the per-project groups (.proj-tabs > .proj-tabs-inner, nested
// in the project nav) plus the orphan group. After a drop, sync state.tabs to DOM order.
// Idempotent so it's safe to call after EVERY render: a group that already has a Sortable keeps it
// (an in-progress drag is never interrupted, and the markup-stable renders that fix the avatar
// flicker no longer drop the drag); instances on rebuilt-away elements are pruned.
let _sortables = [];
function initTabSort() {
  if (typeof Sortable === 'undefined') return;
  _sortables = _sortables.filter(s => { if (document.body.contains(s.el)) return true; try { s.destroy(); } catch {} return false; });
  // The rows' direct parent is .proj-tabs-inner (the clipping wrapper inside the animated group).
  document.querySelectorAll('.proj-tabs-inner').forEach(group => {
    if (Sortable.get(group)) return;   // already wired
    // forceFallback: use SortableJS's own mouse-driven drag, NOT the native HTML5 DnD API —
    // native DnD is unreliable in the Tauri shell's WKWebView (it worked under Electron/Chromium),
    // and the fallback behaves identically across engines. fallbackTolerance keeps a plain click
    // (activate tab) from being read as a drag.
    _sortables.push(new Sortable(group, {
      draggable: '.opentab:not(.task-row)', animation: 150,
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
// Each folder is followed by its session rows, nested inline (open tabs live in the Tabs group below
// the projects). setProjects keeps the live PR data the tab rows read for avatars.
// The project nav's markup — one string, so the render cache and the in-place collapse toggle agree.
function projectNavHtml(sessions) {
  return state.projects.map(p => {
    const rows = projectRows(p, sessions);
    const collapsed = _collapsed.has(p.id);
    // The folder icon mirrors the collapse state: open flap while expanded, closed while collapsed
    // (or with nothing to show). Collapsing is a click on the already-focused folder (projectClick).
    // Hover "+" (only for projects with a local workspace): a new worktree + task.
    const add = p.workspace
      ? `<span class="proj-add" title="New session on a new worktree" onclick="event.stopPropagation();newWorktreeTask('${p.id}')">${ICON.plus}</span>`
      : '';
    const btn = `<button class="nav-btn" data-page="project" data-project="${p.id}" onclick="projectClick('${p.id}')">
      <span class="icon">${rows.length && !collapsed ? ICON.folderOpen : ICON.folder}</span>
      <span class="proj-name">${esc(p.name)}</span>
      ${add}
    </button>`;
    // Rows always render (collapsed ones are hidden by the 0fr track) so collapse/expand can animate.
    return btn + (rows.length
      ? `<div class="proj-tabs${collapsed ? ' collapsed' : ''}" data-project="${p.id}"><div class="proj-tabs-inner">${rows.join('')}</div></div>`
      : '');
  }).join('');
}

export function renderProjectNav(projects) {
  setProjects(projects);
  // ONE taskSessions() pass for this whole render — it overlays terminal state per task
  // (O(tasks × terms)), so the per-project + pinned markup helpers take the array rather than
  // each rebuilding it.
  const sessions = taskSessions();
  const pinnedEl = document.getElementById('pinned-nav');
  if (pinnedEl) setHtmlIfChanged(pinnedEl, pinnedNavMarkup(sessions));   // the Pinned group sits above the projects
  const el = document.getElementById('project-nav');
  if (!el) return;
  const list = projectNavHtml(sessions);
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
  let x = 0, raf = 0;
  const apply = () => { raf = 0; setW(x); };
  dragDivider(handle, {
    move(e) { x = e.clientX; if (!raf) raf = requestAnimationFrame(apply); },
    end() {
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10);
      if (w) localStorage.setItem('taskhub.sidebarWidth', String(w));
      // The workarea just changed width without a window resize — let the terminal refit.
      window.dispatchEvent(new Event('resize'));
    },
  });
}
