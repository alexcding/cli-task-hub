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
  initUsage();
}

// ── Resource usage ──────────────────────────────────────────────────────────────
// Live RAM/CPU readout, mirroring what the tray menu used to show. The figures come
// from the Electron main process (getAppMetrics, ps), reached via window.taskhub — so
// outside the app (a plain browser) the card is simply hidden. main caches its ps pass
// for ~3s, so a 3s poll is as fresh as it gets without extra shell-outs. The interval
// stops itself once Settings is no longer the active page (showPage has no teardown hook).
let _usageTimer = null;

const fmtKB = kb => { const mb = kb / 1024; return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`; };

async function pollUsage() {
  if (!document.getElementById('page-settings').classList.contains('active')) {
    clearInterval(_usageTimer); _usageTimer = null; return;
  }
  let u; try { u = await window.taskhub.getUsage(); } catch { return; }
  const rows = u.breakdown.map(b =>
    `<tr><td>${esc(b.label)}</td><td>${fmtKB(b.kb)}</td><td>${Math.round(b.cpu)}%</td></tr>`).join('');
  document.getElementById('usage-readout').innerHTML = `
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:14px;font-size:13px;color:var(--text-2)">
      <span>Memory <b style="color:var(--text)">${fmtKB(u.totalKB)}</b></span>
      <span>CPU <b style="color:var(--text)">${Math.round(u.totalCPU)}%</b></span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Component</th><th>Memory</th><th>CPU</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" style="color:var(--text-3)">No data.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function initUsage() {
  const card = document.getElementById('usage-card');
  if (!window.taskhub?.getUsage) { card.hidden = true; return; } // plain browser — not available
  card.hidden = false;
  pollUsage();
  if (!_usageTimer) _usageTimer = setInterval(pollUsage, 3000);
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
