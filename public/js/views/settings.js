// Settings page: config form + DB inspector.
import { state } from '../store.js';
import { api, apiJson } from '../api.js';
import { esc, timeAgo } from '../util.js';
import { toast, toastErr } from '../toast.js';
import { renderProjectNav } from '../sidebar.js';

export async function loadSettings() {
  const [cfg, dbinfo] = await Promise.all([api('/api/config'), api('/api/db')]);

  if (cfg.poll_interval)      document.getElementById('poll-interval').value = cfg.poll_interval;
  if (cfg.jira_base_url)      document.getElementById('jira-base-url').value = cfg.jira_base_url;
  if (cfg.my_jql)             document.getElementById('my-jql').value = cfg.my_jql;
  if (cfg.sprint_jql)         document.getElementById('sprint-jql').value = cfg.sprint_jql;
  // Show the auto-detected site as the placeholder so it's clear what's in effect.
  api('/api/jira/site').then(s => { if (s.baseUrl) document.getElementById('jira-base-url').placeholder = `${s.baseUrl} (auto-detected)`; }).catch(()=>{});
  if (cfg.jira_poll_interval) document.getElementById('jira-poll-interval').value = cfg.jira_poll_interval;
  if (cfg.jira_limit)         document.getElementById('jira-limit').value = cfg.jira_limit;

  renderDbInspector(dbinfo);
}

function renderDbInspector(d) {
  const rows = d.projects.map(p => {
    const snap = d.snapshots[p.id] || {};
    return `<tr>
      <td><span class="nav-dot" style="background:${p.color};display:inline-block;margin-right:6px"></span>${esc(p.name)}</td>
      <td>${p.repo ? esc(p.repo) : '<span style="color:var(--text-3)">—</span>'}</td>
      <td>${esc(p.mergeTransition || '—')}</td>
      <td>${snap.open ?? 0}</td>
      <td>${snap.error ? `<span style="color:var(--danger)">error</span>` : snap.lastSynced ? timeAgo(snap.lastSynced) : '<span style="color:var(--text-3)">never</span>'}</td>
    </tr>`;
  }).join('');

  document.getElementById('db-inspector').innerHTML = `
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px;font-size:13px;color:var(--text-2)">
      <span><b>${d.counts.projects}</b> projects</span>
      <span><b>${d.counts.links}</b> links</span>
      <span><b>${d.counts.events}</b> events</span>
    </div>
    <div class="table-wrap" style="margin-bottom:18px">
      <table>
        <thead><tr><th>Project</th><th>Repo</th><th>On merge →</th><th>Open PRs</th><th>Synced</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" style="color:var(--text-3)">No projects.</td></tr>'}</tbody>
      </table>
    </div>`;
}

export async function deleteProject(id) {
  const proj = state.projects.find(p=>p.id===id);
  if (!confirm(`Delete project "${proj?.name}"? This also removes its links.`)) return;
  try {
    await api(`/api/projects/${id}`, {method:'DELETE'});
    toast('Project deleted');
    const projects = await api('/api/projects');
    renderProjectNav(projects);
    window.showPage('dashboard');
  } catch(e) { toastErr(e.message); }
}

export async function saveConfig() {
  try {
    await apiJson('/api/config', 'POST', {
      poll_interval:      document.getElementById('poll-interval').value || '60',
      jira_base_url:      document.getElementById('jira-base-url').value.trim(), // blank = auto-detect
      my_jql:             document.getElementById('my-jql').value.trim() || 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
      sprint_jql:         document.getElementById('sprint-jql').value.trim() || 'assignee = currentUser() AND sprint is not EMPTY AND statusCategory != Done ORDER BY updated DESC',
      jira_poll_interval: document.getElementById('jira-poll-interval').value || '120',
      jira_limit:         document.getElementById('jira-limit').value || '100',
    });
    // Ticket links depend on the base URL — refresh it after a save.
    try { state.jiraBase = (await api('/api/jira/site')).baseUrl || state.jiraBase; } catch {}
    toast('Settings saved');
  } catch(e) { toastErr(e.message); }
}
