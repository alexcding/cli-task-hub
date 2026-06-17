// Entry point: navigation, SSE live updates, init, and the window bridge that keeps
// the inline on* handlers in markup working (ES modules aren't globals).
import { ROUTES } from '/shared/routes.mjs';
import { state, activeTab, projectById } from './stores/store.js';
import { api, forceSync } from './services/api.js';
import { canSplitTerminal } from './lib/util.js';
import { initTheme, setAppTheme, syncThemeFromSettings } from './services/theme.js';
import { setFontFamily, bumpFontSize, resetFontSize, zoomTarget, syncFontsFromSettings, populateFontMenus } from './services/fonts.js';
import { renderTabs, renderProjectNav, tabMenu, initSidebarResize } from './components/sidebar.js';
import { closeMenu, isMenuOpen } from './components/menu.js';
import * as viewer from './components/viewer.js';
import * as terminal from './components/terminal.js';
import * as split from './components/split.js';
import { toggleCommitPop, commitAction } from './components/commit.js';
import { loadDashboard, scrollDash, setUsageTab } from './pages/dashboard.js';
import { loadProjectPage, projShowSection, reloadProjectPRs, loadProjectWebhooks, saveProjectWebhooks, previewFixVersion } from './pages/project.js';
import { loadGitTab, gitTabPick, gitTabShowCommit, gitTabBack, gitTabRemoveWorktree } from './pages/git-tab.js';
import * as jiraView from './pages/jira.js';
import { loadScrumboard, setBoardProject, setBoardFilter, setBoardQuery, applyBoardQuery,
  boardDragStart, boardDragEnd, boardDragOver, boardDragLeave, boardDrop } from './pages/scrumboard.js';
import { loadLogs, setLogCategory, clearLogs } from './pages/logs.js';
import { loadSettings, saveConfig, switchSettingsTab, setReviewSound, previewReviewSound, setActivityNotify, toggleSecret } from './pages/settings.js';
import { showActivityToast } from './components/activity-toast.js';
import * as modal from './components/modal.js';

// ── Navigation ────────────────────────────────────────────────────────────────
function showPage(name, projectId) {
  // Navigating to a native page forces a sync now instead of waiting out the poll cycle.
  // This is what surfaces a change made inside an embedded webview the server can't observe
  // on its own — chiefly a PR merged/closed in the GitHub viewer (no SSE, not necessarily a
  // webhook). Fire-and-forget so navigation never blocks; the resulting SSE `sync` re-renders
  // the page via scheduleRefresh().
  syncOnNav();
  // The viewer replaces the content, so navigating to a page must hide it and bring
  // <main> back (the open tabs stay listed in the left nav).
  document.getElementById('split').hidden = true;
  document.body.classList.remove('viewing-tab', 'viewing-term', 'pr-split', 'pane-diff');
  state.activeTabId = null; state.activeTermId = null;  // terminals stay alive, just unfocused
  renderTabs();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-'+(name==='project'?'project':name)).classList.add('active');
  document.querySelectorAll('.nav-btn[data-page]').forEach(b => { if(b.dataset.page===name) b.classList.add('active'); });
  document.getElementById('topbar-actions').innerHTML = '';

  if (name === 'dashboard') {
    document.getElementById('page-title').textContent = 'Dashboard';
    loadDashboard();
  } else if (name === 'scrumboard') {
    document.getElementById('page-title').textContent = 'Scrumboard';
    loadScrumboard();
  } else if (name === 'project' && projectId) {
    state.activeProjectId = projectId;
    const proj = projectById(projectId);
    document.getElementById('page-title').textContent = proj?.name || 'Project';
    // Edit lives on the page now — the gear button beside the project title (project.js).
    document.querySelectorAll('.nav-btn[data-project]').forEach(b => { if(b.dataset.project===projectId) b.classList.add('active'); });
    loadProjectPage(projectId);
  } else if (name === 'activity') {
    document.getElementById('page-title').textContent = 'Activity';
    loadLogs();
  } else if (name === 'settings') {
    document.getElementById('page-title').textContent = 'Settings';
    loadSettings();
    populateFontMenus(); // a settings visit is a user gesture — a chance to upgrade to the full list if the permission was deferred
  }
  // (Reads are also stale-while-revalidate on their own — /api/dashboard, project PRs and the
  // Jira feeds each kick a background sync when their snapshot is stale — but that can't see a
  // webview-side change, which is why syncOnNav forces a poll on navigation.)
}

// forceSync POSTs /api/poll, which runs gh across every project + acli across the Jira feeds —
// too heavy to fire on every click. Throttle leading-edge: the first nav syncs at once (so a
// webview-side merge surfaces immediately), then rapid page/tab switching is suppressed for the
// window. The 60s interval poll backstops anything that changes mid-window.
let _lastNavSync = 0;
function syncOnNav() {
  const t = Date.now();
  if (t - _lastNavSync < 10_000) return;
  _lastNavSync = t;
  forceSync();
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
// ⌘-shortcuts arrive from the native app menu (main/app-menu.js) as action names,
// not from keydown — menu accelerators still fire when focus is inside a <webview>
// or xterm, where this page never sees the key.
function cycleTab(dir) {
  const n = state.tabs.length;
  if (!n) return;
  const i = state.tabs.findIndex(t => t.id === state.activeTabId);
  viewer.activateTab(state.tabs[i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n].id);
}

function handleShortcut(action) {
  const tab = activeTab(); // non-null only while a tab is the active view
  switch (action) {
    case 'nav:dashboard': showPage('dashboard'); break;
    case 'nav:scrumboard': showPage('scrumboard'); break;
    case 'nav:activity':  showPage('activity'); break;
    case 'nav:settings':  showPage('settings'); break;
    case 'project:new':   modal.openNewProjectModal(); break;
    case 'nav:back':      viewer.splitBack(); break;
    case 'nav:forward':   viewer.splitForward(); break;
    case 'tab:next':      cycleTab(1); break;
    case 'tab:prev':      cycleTab(-1); break;
    // ⌘W mac semantics: close the active tab; with no tab in view, close the window.
    case 'tab:close':
      if (tab) viewer.closeTab(tab.id);
      else window.taskhub?.closeWindow?.();
      break;
    case 'tab:closeAll':  if (state.tabs.length) viewer.closeSplit(); break;
    case 'pane:toggleTerm': split.togglePrSplit(); break;
    case 'pane:toggleView':
      if (canSplitTerminal(tab) && tab.prSplit) split.setPaneView(tab.paneView === 'diff' ? 'term' : 'diff');
      break;
    case 'term:clear':    terminal.clearVisibleTerm(); break;
    // ⌘+ / ⌘− / ⌘0: font size of the pane in view (terminal or diff), persisted.
    // zoomTarget() is null when nothing zoomable is on screen → no-op.
    case 'font:bigger':   { const z = zoomTarget(); if (z) bumpFontSize(z, 1); break; }
    case 'font:smaller':  { const z = zoomTarget(); if (z) bumpFontSize(z, -1); break; }
    case 'font:reset':    { const z = zoomTarget(); if (z) resetFontSize(z); break; }
    // Reload the embedded page when a tab is in view; otherwise re-fetch the active page's data.
    case 'view:reload':
      if (tab && tab.started) {
        tab.loaded = false;
        viewer.showSplitLoading(true);
        try { tab.wv.reload(); } catch {}
      } else {
        refreshActivePage();
      }
      break;
  }
}
window.__shortcut = handleShortcut; // called by the app menu via executeJavaScript (like __openTab)

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (isMenuOpen()) { closeMenu(); return; }   // close any open context menu first
  modal.closeModal();
  if (!document.getElementById('split').hidden) viewer.closeSplit();
});

// ── Live updates (SSE) ──────────────────────────────────────────────────────────
// The server pushes a "sync" event whenever a project's snapshot changes; we
// seamlessly re-read the snapshot (no spinner). Debounced to coalesce bursts.
let _refreshTimer = null;
function refreshActivePage() {
  if (document.getElementById('modal').style.display === 'flex') return; // don't disrupt editing
  const active = document.querySelector('.page.active')?.id;
  if (active === 'page-dashboard') {
    loadDashboard();
  } else if (active === 'page-activity') {
    loadLogs();
  } else if (active === 'page-scrumboard') {
    loadScrumboard();
  } else if (active === 'page-project' && state.activeProjectId) {
    // The digest shows PRs and Jira at once — refresh both. PRs keep the chosen state filter.
    const id = state.activeProjectId;
    const sel = document.getElementById(`pr-state-${id}`);
    if (sel) reloadProjectPRs(id, sel.value || 'open', { silent: true });
    // Only refetch Jira for projects that actually have it configured (a key or saved JQL).
    const p = projectById(id);
    if ((p?.jiraProjectKey || p?.jql) && document.getElementById(`proj-jira-${id}`)) jiraView.loadProjectJira(id);
  }
}
function scheduleRefresh() {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(refreshActivePage, 400);
}

function connectStream() {
  let everConnected = false;
  const es = new EventSource(ROUTES.STREAM);
  es.onopen = () => {
    // Reconnect after a drop = the dev server restarted → reload to pick up changes.
    if (everConnected) location.reload();
    everConnected = true;
  };
  es.onmessage = (e) => {
    let d = {}; try { d = JSON.parse(e.data); } catch {}
    if (d.type === 'reload') { location.reload(); return; } // dev: a file changed
    if (d.type === 'tabs') return; // tab-set changes drive the tray menu; the sidebar already updated locally
    // Activity toasts are NOT triggered here: the main process is the single decider (it
    // alone can tell if the app is frontmost vs an embedded webview holding focus) and pushes
    // the toast via window.__activityToast. An 'activity' event still refreshes the page below.
    scheduleRefresh();
  };
  es.onerror = () => {}; // EventSource auto-reconnects
}

// ── Window bridge ─────────────────────────────────────────────────────────────
// Everything referenced from inline on* attributes (static markup and JS-built HTML
// strings) must be a global. One explicit assignment keeps the list auditable.
Object.assign(window, {
  showPage, setAppTheme, setFontFamily, bumpFontSize,
  // sidebar / tabs
  activateTab: viewer.activateTab, closeTab: viewer.closeTab, tabMenu,
  openPrSplit: viewer.openPrSplit, openRepo: viewer.openRepo, openExternal: viewer.openExternal, jiraClick: viewer.jiraClick,
  openTabFolder: viewer.openTabFolder, createTabWorktree: viewer.createTabWorktree,
  folderMenu: viewer.folderMenu, removeTabWorktree: viewer.removeTabWorktree,
  // viewer toolbar
  splitBack: viewer.splitBack, splitHome: viewer.splitHome,
  togglePrSplit: split.togglePrSplit, clearVisibleTerm: terminal.clearVisibleTerm,
  setPaneView: split.setPaneView, toggleCommitPop, commitAction,
  // views
  loadScrumboard, setBoardProject, setBoardFilter, setBoardQuery, applyBoardQuery,
  boardDragStart, boardDragEnd, boardDragOver, boardDragLeave, boardDrop,
  loadProjectJira: jiraView.loadProjectJira, setProjJiraFilter: jiraView.setProjJiraFilter,
  openStatusMenu: jiraView.openStatusMenu, openAssignMenu: jiraView.openAssignMenu,
  projShowSection, reloadProjectPRs, loadProjectWebhooks, saveProjectWebhooks, previewFixVersion, scrollDash, setUsageTab,
  loadGitTab, gitTabPick, gitTabShowCommit, gitTabBack, gitTabRemoveWorktree,
  loadLogs, setLogCategory, clearLogs,
  loadSettings, saveConfig, switchSettingsTab, setReviewSound, previewReviewSound, setActivityNotify, toggleSecret,
  __activityToast: showActivityToast, // main pushes activity toasts here when the app is frontmost
  // project modal
  openNewProjectModal: modal.openNewProjectModal, openEditProjectModal: modal.openEditProjectModal,
  closeModal: modal.closeModal, saveProject: modal.saveProject,
  deleteProjectFromModal: modal.deleteProjectFromModal,
  chooseModalWorkspace: modal.chooseModalWorkspace,
});

// ── Init ──────────────────────────────────────────────────────────────────────
initTheme();
viewer.initTrayBridge();
split.initPrDivider();
initSidebarResize();
terminal.initTerminals();
connectStream();

// Restore saved web tabs first, then reattach live paired PTYs to matching tabs.
// The state.tabsReady guard in saveTabs() means a tab opened from the tray before this
// lands can't clobber the saved set — restore merges it in instead.
state.tabTermInit = (async () => {
  await viewer.restoreTabs();          // rehydrate GitHub/Jira tabs from the last session
  await terminal.rehydrateTerminals(); // reattach PTYs that outlived a window close/reopen
})().catch(e => console.error('[init] tab/terminal restore failed:', e)); // never leave it unhandled — awaiters in ensurePrTerminal() still try/catch

(async () => {
  try {
    const [site, settings] = await Promise.all([api(ROUTES.JIRA_SITE), api(ROUTES.SETTINGS)]);
    state.jiraBase = site.baseUrl || '';
    // taskhub.db is authoritative (survives a localStorage clear, shared across windows);
    // re-sync the theme from it and re-apply if it differs from the pre-paint guess.
    syncThemeFromSettings(settings.theme);
    syncFontsFromSettings(settings); // any terminal rehydrated before this lands is updated in place by applyFonts
  } catch {}
  populateFontMenus(); // fill the font pickers from this machine's installed fonts (replaces the static fallback)
  loadDashboard(); // renderProjectNav is called inside loadDashboard
})();
