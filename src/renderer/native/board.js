// Focused board entry point. Reuse the existing board interactions without booting
// the SPA, terminal renderer, sidebar, or Tauri bridge.
import { ROUTES } from '/shared/routes.mjs';
import { state, setProjects } from '../stores/store.js';
import { api } from '../services/api.js';
import { loadScrumboard, setBoardFilter, applyBoardQuery } from '../pages/scrumboard.js';
import { openStatusMenu, openAssignMenu } from '../pages/jira.js';
import { toastErr } from '../components/toast.js';

const projectID = new URLSearchParams(location.search).get('project');
let active = true, stream = null, refreshing = false, pending = false;
let theme = new URLSearchParams(location.search).get('theme') || 'auto';
const scheme = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  document.documentElement.dataset.theme = theme === 'dark' || (theme !== 'light' && scheme.matches) ? 'dark' : 'light';
}
scheme.addEventListener('change', applyTheme);
applyTheme();

function jiraClick(event, url, key) {
  event.preventDefault();
  let address;
  try { address = new URL(url); } catch { /* error below */ }
  if (!address || !['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
    toastErr('Configure the Jira site before opening a ticket.'); return;
  }
  if (window.webkit?.messageHandlers?.board) {
    window.webkit.messageHandlers.board.postMessage({ type: 'openTicket', url: address.href, title: key, external: event.altKey });
  } else { window.open(address.href, '_blank', 'noopener'); }
}

Object.assign(window, { setBoardFilter, applyBoardQuery, openStatusMenu, openAssignMenu, jiraClick });
window.nativeBoard = {
  setActive(value) {
    active = value === true;
    if (active) { connectStream(); refresh(); }
    else { stream?.close(); stream = null; }
  },
  setTheme(value) { theme = ['auto', 'light', 'dark'].includes(value) ? value : 'auto'; applyTheme(); },
  refresh,
};

function connectStream() {
  // The native shell already owns an SSE connection and forwards invalidations.
  // A standalone browser preview supplies its own stream instead.
  if (stream || !active || window.webkit?.messageHandlers?.board) return;
  stream = new EventSource(ROUTES.STREAM);
  stream.onopen = refresh; // SSE has no replay; reread snapshots after reconnect.
  stream.onmessage = event => {
    try { if (['sync', 'jira-sync', 'settings', 'reload'].includes(JSON.parse(event.data).type)) refresh(); }
    catch { /* ignore malformed events */ }
  };
}

async function refresh() {
  pending = true;
  if (refreshing || !active) return;
  refreshing = true;
  try {
    while (pending && active) {
      pending = false;
      try {
        const project = await api(ROUTES.project(projectID));
        setProjects([project]); state.activeProjectId = projectID;
        await loadScrumboard(projectID);
        document.getElementById('board-error').hidden = true;
      } catch (error) {
        const message = document.getElementById('board-error');
        message.textContent = error.message; message.hidden = false;
      }
    }
  } finally { refreshing = false; }
}

document.getElementById('board-retry').addEventListener('click', refresh);
if (!projectID) {
  document.getElementById('scrumboard-body').textContent = 'Choose a project to open its sprint board.';
} else {
  // Site/account discovery can be slow; do not hold back the board snapshot.
  api(ROUTES.JIRA_SITE).then(site => {
    state.jiraBase = site.baseUrl || ''; state.jiraMe = site.me || {};
    refresh(); // The shared loader guards an active drag before rebuilding the board.
  }).catch(error => toastErr(error.message));
  connectStream(); refresh();
}
addEventListener('pagehide', () => { active = false; stream?.close(); stream = null; });
