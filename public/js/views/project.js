// Project page: PR list + per-project Jira tab shell.
import { state } from '../store.js';
import { api } from '../api.js';
import { ICON } from '../icons.js';
import { prListHtml } from './cards.js';
import { loadProjectJira } from './jira.js';

export async function loadProjectPage(id) {
  const el = document.getElementById('project-page-content');

  // Render the full shell immediately from cached project data — only the
  // PR list (and Jira tab) show their own loading state.
  const proj = state.projects.find(p => p.id === id);
  if (!proj) { el.innerHTML = '<div class="empty">Project not found.</div>'; return; }

  el.innerHTML = `
    <!-- Tab bar: the segmented tab widget (same as Settings/Activity) on the left,
         the active tab's controls on the right of the same row — so neither costs a
         filter row above its content. PR state is a dropdown (like the Jira filters);
         Jira shows its ticket filters + Refresh. -->
    <div class="proj-tabbar">
      <div class="seg-tabs" role="tablist">
        <button class="seg-tab active" onclick="switchTab('${id}','prs',this)">Pull Requests</button>
        <button class="seg-tab" onclick="switchTab('${id}','jira',this)">Jira</button>
      </div>
      <div class="proj-tab-controls">
        ${proj.repo ? `
        <select class="filter-select" id="pr-state-${id}" onchange="reloadProjectPRs('${id}',this.value)">
          <option value="open">Open</option>
          <option value="merged">Merged</option>
          <option value="all">All</option>
        </select>` : ''}
        <div class="tab-controls" id="jira-controls-${id}" style="display:none;gap:8px;align-items:center">
          <div id="proj-jira-filter-${id}" class="ticket-filter" style="margin-bottom:0"></div>
          <button class="btn btn-secondary btn-sm" onclick="loadProjectJira('${id}')">${ICON.refresh} Refresh</button>
        </div>
      </div>
    </div>

    <!-- PR tab -->
    <div class="tab-panel active" id="tab-prs-${id}">
      <div id="proj-prs-${id}">${proj.repo
        ? '<div class="loading-row"><div class="spinner"></div> Loading pull requests…</div>'
        : prListHtml([], '', 'open')}</div>
    </div>

    <!-- Jira tab -->
    <div class="tab-panel" id="tab-jira-${id}">
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Key</th><th>Summary</th><th>Status</th><th>Type</th><th>Priority</th></tr></thead>
            <tbody id="proj-jira-${id}">
              <tr><td colspan="5"><div class="loading-row"><div class="spinner"></div> Loading…</div></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Load PRs into the tab without blocking the shell.
  if (proj.repo) reloadProjectPRs(id, 'open');
}

export function switchTab(projectId, tab, btn) {
  ['prs','jira'].forEach(t => {
    document.getElementById(`tab-${t}-${projectId}`)?.classList.toggle('active', t === tab);
  });
  btn.closest('.seg-tabs').querySelectorAll('.seg-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // Each tab's controls live on the tab bar; show only the active tab's.
  const prState = document.getElementById(`pr-state-${projectId}`);
  if (prState) prState.style.display = tab === 'prs' ? '' : 'none';
  const jiraCtl = document.getElementById(`jira-controls-${projectId}`);
  if (jiraCtl) jiraCtl.style.display = tab === 'jira' ? 'flex' : 'none';
  if (tab === 'jira') loadProjectJira(projectId);
}

export async function reloadProjectPRs(id, prState, { silent = false } = {}) {
  const el = document.getElementById(`proj-prs-${id}`);
  if (!el) return;
  if (!silent) el.innerHTML = '<div class="loading-row"><div class="spinner"></div> Loading…</div>';
  const prs = await api(`/api/projects/${id}/prs?state=${prState}`);
  const proj = state.projects.find(p => p.id === id);
  const target = document.getElementById(`proj-prs-${id}`); // may have re-rendered; re-query
  if (target) target.innerHTML = prListHtml(prs.filter(p=>!p.error), proj?.repo, prState);
}
