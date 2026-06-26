// Left sidebar: project nav, the grouped open-tab rows, drag-reorder, and the
// right-click tab menu.
import { state, prByUrl, prGroup, setProjects, projectByRepo, projectByJiraKey } from '../stores/store.js';
import { PR_CATEGORY, PR_GROUP } from '/shared/constants.mjs';
import { ROUTES } from '/shared/routes.mjs';
import { apiJson } from '../services/api.js';
import { esc, ghAvatarSrc, setHtmlIfChanged } from '../lib/util.js';
import { ensureAvatar } from '../lib/avatars.js';
import { ICON, TAB_ICON } from '../lib/icons.js';
import { ciInfo } from './cards.js';
import { toastErr } from './toast.js';
import { closeTab, saveTabs, updateTitles } from './viewer.js';
import { renderContentTabs } from './content-tabs.js';

// How the open-tab rows are grouped: 'category' (Mine/Review/Jira — the default) or
// 'project' (one group per owning project). A view-only preference, so it lives here as a
// module-local; persisted to taskhub.db (settings key `sidebarGroup`) and mirrored to
// localStorage so a cold start renders the right grouping before the settings fetch lands.
// Mirrors the theme service (services/theme.js): a setter that applies+persists, and a
// sync-from-settings called once at bootstrap.
let _groupMode = (() => { try { return localStorage.getItem('taskhub.sidebarGroup') || 'category'; } catch { return 'category'; } })();
const normGroup = v => (v === 'project' ? 'project' : 'category');

// Reflect the current mode on the Settings → Appearance toggle (no-op until that DOM exists).
export function applySidebarGroupUI() {
  document.querySelectorAll('#sidebar-group-toggle .theme-opt')
    .forEach(b => b.classList.toggle('active', b.dataset.groupOpt === _groupMode));
}

// Settings picker: apply + re-render now, then persist to the DB (localStorage is just the
// pre-fetch cache). Called from the Appearance toggle via the window bridge.
export function setSidebarGroup(value) {
  _groupMode = normGroup(value);
  try { localStorage.setItem('taskhub.sidebarGroup', _groupMode); } catch {}
  applySidebarGroupUI();
  rerenderSidebar();
  apiJson(ROUTES.settingsKey('sidebarGroup'), 'PUT', { value: _groupMode }).catch(e => toastErr(e.message));
}

// taskhub.db is authoritative — re-sync from it after the pre-paint localStorage guess (init).
export function syncSidebarGroupFromSettings(saved) {
  if (saved) {
    _groupMode = normGroup(saved);
    try { localStorage.setItem('taskhub.sidebarGroup', _groupMode); } catch {}
  }
  applySidebarGroupUI();
  rerenderSidebar();
}

// Per-project collapse state (project grouping mode): a project whose id is in this set hides
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

// Rebuild both nav containers for the current grouping mode (called on a mode switch / settings
// sync). In project mode renderTabs() already rebuilds the project nav (nested tabs) itself, so a
// plain renderTabs() suffices. In category mode renderTabs() only fills #opentabs-nav, so the
// project nav must be rebuilt separately to drop any nesting left from project mode.
function rerenderSidebar() {
  if (_groupMode !== 'project') renderProjectNav(state.projects);
  renderTabs();
}

// Render the open tabs as grouped rows in the left nav, and show the active tab's
// title in the viewer header.
export function renderTabs() {
  const navEl = document.getElementById('opentabs-nav');
  if (_groupMode === 'project') {
    // Project mode: the tab rows nest under each project's folder in the Projects nav (no
    // separate section). renderProjectNav owns that tree; #opentabs-nav holds only orphans —
    // tabs whose repo/key matches no configured project — so an open tab is never invisible.
    renderProjectNav(state.projects);
    if (navEl) setHtmlIfChanged(navEl, orphanTabsMarkup());
  } else if (navEl) {
    // Category mode (default): Mine/Review/Jira groups live in their own #opentabs-nav section.
    setHtmlIfChanged(navEl, tabsMarkup());
  }
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

// Project mode only: tabs that map to no configured project, as one unlabeled draggable group
// (no header — "no new section"). Empty string when every tab has a home, the common case.
function orphanTabsMarkup() {
  const orphans = state.tabs.filter(t => !tabProject(t));
  return orphans.length ? `<div class="proj-tabs" data-project="">${orphans.map(tabRowHtml).join('')}</div>` : '';
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
    el.classList.toggle('active', el.dataset.id === active);
    el.classList.toggle('busy', !!(t?.termId && state.terms.get(t.termId)?.busy));
  });
  // Every busy↔idle edge also moves the Tasks-nav running count (window bridge avoids a cycle).
  window.updateTasksBadge?.();
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

// Category-mode markup for #opentabs-nav: GitHub groups (Mine/Review) then a Jira group, each a
// labeled list of .opentab rows.
function tabsMarkup() {
  // Render one labeled group of tab rows; self-hides when empty. `attrs` are extra
  // attributes on the wrapper (data-kind/data-cat used for drag-reorder scoping).
  const groupHtml = (label, attrs, items) =>
    items.length ? `<div class="tab-group" ${attrs}><span class="tab-group-label">${label}</span>${items.map(tabRowHtml).join('')}</div>` : '';
  const group = (label, kind) => groupHtml(label, `data-kind="${kind}"`, state.tabs.filter(t => t.kind === kind));
  // GitHub tabs split into Mine vs Review (same split as the dashboard sections). Prefer
  // the live PR (prGroup understands awaitingMyReview, so a commented PR groups under
  // Review not Mine); fall back to the group saved on the tab so a restored tab (or one
  // whose PR has merged and left the snapshot) keeps its group instead of vanishing.
  const ghCat = t => {
    const pr = prByUrl(t.url);
    return pr ? prGroup(pr) : (t.category === PR_CATEGORY.REVIEW ? PR_GROUP.REVIEW : PR_GROUP.MINE);
  };
  const ghGroup = (label, cat) =>
    groupHtml(label, `data-kind="github" data-cat="${cat}"`, state.tabs.filter(t => t.kind === 'github' && ghCat(t) === cat));
  // Only the two categorized GitHub groups render. Tabs that are neither 'mine' nor
  // 'review' (uncategorized / stale / not-yet-loaded PRs) show no row. Each group
  // self-hides when empty, so no bare headers appear.
  return ghGroup('Mine', PR_GROUP.MINE) + ghGroup('Review', PR_GROUP.REVIEW)
       + group('Jira', 'jira');
}

// Drag-to-reorder within each group. Reorder stays within a group — category groups
// (#opentabs-nav .tab-group) in category mode, per-project groups (.proj-tabs, nested in the
// project nav, plus the orphan group) in project mode. After a drop, sync state.tabs to DOM order.
// Idempotent so it's safe to call after EVERY render: a group that already has a Sortable keeps it
// (an in-progress drag is never interrupted, and the markup-stable renders that fix the avatar
// flicker no longer drop the drag); instances on rebuilt-away elements are pruned.
let _sortables = [];
function initTabSort() {
  if (typeof Sortable === 'undefined') return;
  _sortables = _sortables.filter(s => { if (document.body.contains(s.el)) return true; try { s.destroy(); } catch {} return false; });
  document.querySelectorAll('#opentabs-nav .tab-group, .proj-tabs').forEach(group => {
    if (Sortable.get(group)) return;   // already wired
    // forceFallback: use SortableJS's own mouse-driven drag, NOT the native HTML5 DnD API —
    // native DnD is unreliable in the Tauri shell's WKWebView (it worked under Electron/Chromium),
    // and the fallback behaves identically across engines. fallbackTolerance keeps a plain click
    // (activate tab) from being read as a drag.
    _sortables.push(new Sortable(group, {
      draggable: '[data-id]', filter: '.tab-x', animation: 150,
      forceFallback: true, fallbackTolerance: 4, onEnd: syncTabOrder,
    }));
  });
}
function syncTabOrder() {
  // Read rows across both navs in document order (#project-nav precedes #opentabs-nav).
  const order = [...document.querySelectorAll('#project-nav [data-id], #opentabs-nav [data-id]')].map(el => el.dataset.id);
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
// In project grouping mode each folder is followed by its open-tab rows, nested inline (no
// separate "open tabs" section). In category mode it's folders only; the tabs live in
// #opentabs-nav. setProjects keeps the live PR data the tab rows read for author avatars.
export function renderProjectNav(projects) {
  setProjects(projects);
  const el = document.getElementById('project-nav');
  if (!el) return;
  const projectMode = _groupMode === 'project';
  const list = state.projects.map(p => {
    const tabs = projectMode ? state.tabs.filter(t => tabProject(t)?.id === p.id) : [];
    const collapsed = _collapsed.has(p.id);
    // A caret on the folder's right toggles its open-tab rows — shown only when it has any.
    const caret = tabs.length
      ? `<span class="proj-toggle${collapsed ? ' collapsed' : ''}" title="${collapsed ? 'Show' : 'Hide'} open tabs"
           onclick="event.stopPropagation();toggleProjectTabs('${p.id}')">${ICON.caret}</span>`
      : '';
    const btn = `<button class="nav-btn" data-page="project" data-project="${p.id}" onclick="showPage('project','${p.id}')">
      <span class="icon">${ICON.folder}</span>
      <span class="proj-name">${esc(p.name)}</span>
      ${caret}
    </button>`;
    if (!projectMode) return btn;
    return btn + (tabs.length && !collapsed
      ? `<div class="proj-tabs" data-project="${p.id}">${tabs.map(tabRowHtml).join('')}</div>`
      : '');
  }).join('');
  // No projects yet → show a prominent CTA; otherwise the "+" on the section title is enough.
  const cta = state.projects.length ? '' :
    `<button class="nav-btn" style="color:var(--accent)" onclick="openNewProjectModal()"><span class="icon" style="color:var(--accent)">${ICON.plus}</span> New project</button>`;
  setHtmlIfChanged(el, list + cta);
  // Re-apply the active-project highlight showPage set — a rebuild (project mode runs this on tab
  // changes too) drops it, and there's no showPage to restore it on a background SSE refresh.
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
