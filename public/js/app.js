// Entry point: navigation, SSE live updates, init, and the window bridge that keeps
// the inline on* handlers in markup working (ES modules aren't globals).
import { state } from './store.js';
import { api } from './api.js';
import { ICON } from './icons.js';
import { initTheme, setAppTheme, syncThemeFromSettings } from './theme.js';
import { renderTabs, renderProjectNav, tabMenu, closeTabMenu, isTabMenuOpen, initSidebarResize } from './sidebar.js';
import * as viewer from './viewer.js';
import * as terminal from './terminal.js';
import * as split from './split.js';
import { toggleCommitPop, commitAction } from './commit.js';
import { loadDashboard } from './views/dashboard.js';
import { loadProjectPage, switchTab, reloadProjectPRs } from './views/project.js';
import * as jiraView from './views/jira.js';
import { loadLogs, setLogCategory, clearLogs } from './views/logs.js';
import { loadSettings, saveConfig } from './views/settings.js';
import * as modal from './views/modal.js';

// ── Navigation ────────────────────────────────────────────────────────────────
function showPage(name, projectId) {
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
  } else if (name === 'mytickets') {
    document.getElementById('page-title').textContent = 'JIRA Tickets';
    jiraView.loadMyTickets();
  } else if (name === 'project' && projectId) {
    state.activeProjectId = projectId;
    const proj = state.projects.find(p=>p.id===projectId);
    document.getElementById('page-title').textContent = proj?.name || 'Project';
    document.getElementById('topbar-actions').innerHTML =
      `<button class="btn btn-secondary btn-sm" onclick="openEditProjectModal('${projectId}')">${ICON.edit} Edit</button>`;
    document.querySelectorAll('.nav-btn[data-project]').forEach(b => { if(b.dataset.project===projectId) b.classList.add('active'); });
    loadProjectPage(projectId);
  } else if (name === 'activity') {
    document.getElementById('page-title').textContent = 'Activity';
    loadLogs();
  } else if (name === 'settings') {
    document.getElementById('page-title').textContent = 'Settings';
    loadSettings();
  }
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (isTabMenuOpen()) { closeTabMenu(); return; }   // close the tab menu first
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
  } else if (active === 'page-mytickets') {
    jiraView.loadMyTickets();
  } else if (active === 'page-project' && state.activeProjectId) {
    const prPanel = document.getElementById(`tab-prs-${state.activeProjectId}`);
    if (prPanel?.classList.contains('active')) {
      const sel = document.querySelector(`#tab-prs-${state.activeProjectId} select`);
      reloadProjectPRs(state.activeProjectId, sel?.value || 'open', { silent: true });
    }
    const jiraPanel = document.getElementById(`tab-jira-${state.activeProjectId}`);
    if (jiraPanel?.classList.contains('active')) jiraView.loadProjectJira(state.activeProjectId);
  }
}
function scheduleRefresh() {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(refreshActivePage, 400);
}

function connectStream() {
  let everConnected = false;
  const es = new EventSource('/api/stream');
  es.onopen = () => {
    // Reconnect after a drop = the dev server restarted → reload to pick up changes.
    if (everConnected) location.reload();
    everConnected = true;
  };
  es.onmessage = (e) => {
    let d = {}; try { d = JSON.parse(e.data); } catch {}
    if (d.type === 'reload') { location.reload(); return; } // dev: a file changed
    scheduleRefresh();
  };
  es.onerror = () => {}; // EventSource auto-reconnects
}

// ── Window bridge ─────────────────────────────────────────────────────────────
// Everything referenced from inline on* attributes (static markup and JS-built HTML
// strings) must be a global. One explicit assignment keeps the list auditable.
Object.assign(window, {
  showPage, setAppTheme,
  // sidebar / tabs
  activateTab: viewer.activateTab, closeTab: viewer.closeTab, tabMenu,
  openPrSplit: viewer.openPrSplit, jiraClick: viewer.jiraClick,
  // viewer toolbar
  splitBack: viewer.splitBack, splitHome: viewer.splitHome,
  togglePrSplit: split.togglePrSplit, clearVisibleTerm: terminal.clearVisibleTerm,
  setPaneView: split.setPaneView, toggleCommitPop, commitAction,
  // views
  loadMyTickets: jiraView.loadMyTickets, setTicketFilter: jiraView.setTicketFilter,
  loadProjectJira: jiraView.loadProjectJira, setProjJiraFilter: jiraView.setProjJiraFilter,
  openStatusMenu: jiraView.openStatusMenu,
  switchTab, reloadProjectPRs,
  loadLogs, setLogCategory, clearLogs,
  loadSettings, saveConfig,
  // project modal
  openNewProjectModal: modal.openNewProjectModal, openEditProjectModal: modal.openEditProjectModal,
  closeModal: modal.closeModal, saveProject: modal.saveProject,
  deleteProjectFromModal: modal.deleteProjectFromModal, selectColor: modal.selectColor,
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
    const [site, settings] = await Promise.all([api('/api/jira/site'), api('/api/settings')]);
    state.jiraBase = site.baseUrl || '';
    // config.db is authoritative (survives a localStorage clear, shared across windows);
    // re-sync the theme from it and re-apply if it differs from the pre-paint guess.
    syncThemeFromSettings(settings.theme);
  } catch {}
  loadDashboard(); // renderProjectNav is called inside loadDashboard
})();
