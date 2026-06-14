// Project page: PR list + per-project Jira + Webhooks tab shells.
import { ROUTES } from '/shared/routes.mjs';
import { state } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { esc, setActiveSegTab } from '../lib/util.js';
import { ICON } from '../lib/icons.js';
import { toast, toastErr } from '../components/toast.js';
import { renderProjectNav } from '../components/sidebar.js';
import { prListHtml } from '../components/cards.js';
import { loadProjectJira } from './jira.js';
import { loadGitTab } from './git-tab.js';

// Single source of truth for the project page's tabs — drives the seg-tab buttons, the
// panel active-toggle, and the lazy loader so they can't drift. To add a tab: add an entry
// here and a matching <div class="tab-panel" id="tab-<id>-${id}"> in the shell below; the
// button, toggle, and on-switch load all follow. `load` (optional) runs each time the tab
// is shown. (loadProjectWebhooks is a hoisted function declaration, so referencing it here
// before its definition is fine.)
const PROJECT_TABS = [
  { id: 'prs',      label: 'Pull Requests' },
  { id: 'jira',     label: 'Jira',     load: loadProjectJira },
  { id: 'webhooks', label: 'Webhooks', load: loadProjectWebhooks },
  { id: 'git',      label: 'Git',      load: loadGitTab },
];

export async function loadProjectPage(id) {
  const el = document.getElementById('project-page-content');

  // Render the full shell immediately from cached project data — only the
  // PR list (and Jira tab) show their own loading state.
  const proj = state.projects.find(p => p.id === id);
  if (!proj) { el.innerHTML = '<div class="empty">Project not found.</div>'; return; }

  el.innerHTML = `
    <div class="proj-main">
    <!-- Tab bar: the segmented tab widget (same as Settings/Activity) on the left,
         the active tab's controls on the right of the same row — so neither costs a
         filter row above its content. PR state is a dropdown (like the Jira filters);
         Jira shows its ticket filters + Refresh. -->
    <div class="proj-tabbar">
      <div class="seg-tabs" role="tablist">
        ${PROJECT_TABS.map((t, i) =>
          `<button class="seg-tab${i === 0 ? ' active' : ''}" onclick="switchTab('${id}','${t.id}',this)">${t.label}</button>`).join('')}
      </div>
      <div class="proj-tab-controls">
        ${proj.repo ? `
        <select class="filter-select" id="pr-state-${id}" data-tab-controls="prs" onchange="reloadProjectPRs('${id}',this.value)">
          <option value="open">Open</option>
          <option value="merged">Merged</option>
          <option value="all">All</option>
        </select>` : ''}
        <div class="tab-controls" id="jira-controls-${id}" data-tab-controls="jira" style="display:none">
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

    <!-- Webhooks tab -->
    <div class="tab-panel" id="tab-webhooks-${id}">
      <div id="proj-webhooks-${id}"></div>
    </div>

    <!-- Git tab — branch/worktree management + commit graph (views/git-tab.js) -->
    <div class="tab-panel" id="tab-git-${id}">
      <div id="proj-gittab-${id}"></div>
    </div>
    </div><!-- /.proj-main -->
  `;

  // Load PRs into the tab without blocking the shell.
  if (proj.repo) reloadProjectPRs(id, 'open');
}

export function switchTab(projectId, tab, btn) {
  PROJECT_TABS.forEach(t => {
    document.getElementById(`tab-${t.id}-${projectId}`)?.classList.toggle('active', t.id === tab);
  });
  setActiveSegTab(btn);
  // Each tab's controls live on the tab bar tagged with data-tab-controls; show only the
  // active tab's. A tab with no tagged controls (e.g. Webhooks — it has an in-panel Save)
  // simply shows none.
  btn.closest('.proj-tabbar').querySelectorAll('[data-tab-controls]').forEach(c => {
    c.style.display = c.dataset.tabControls === tab ? '' : 'none';
  });
  PROJECT_TABS.find(t => t.id === tab)?.load?.(projectId);
}

// Webhooks tab — the forwarding toggle + on-merge Jira transition, moved here out of
// the Edit Project modal and grouped into sections.
export function loadProjectWebhooks(id) {
  const el = document.getElementById(`proj-webhooks-${id}`);
  if (!el) return;
  const proj = state.projects.find(p => p.id === id);
  if (!proj) { el.innerHTML = '<div class="empty">Project not found.</div>'; return; }

  // No repo → forwarding can't run; reuse the standard empty-state (matching the PR tab's
  // no-repo message in cards.js) instead of dead controls.
  if (!proj.repo) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">${ICON.branch}</div><p>Webhook forwarding needs a GitHub repo. Add one to this project (Edit, top-right) and it'll show up here.</p></div>`;
    return;
  }

  el.innerHTML = `
    <div class="webhooks-form">
      <div class="card">
        <div class="card-header"><h3>Event forwarding</h3></div>
        <div class="card-pad">
          <p class="card-intro">Runs <code class="code-chip">gh webhook forward</code> for this repo so pull-request and CI changes show up immediately, instead of waiting for the next poll.</p>
          <label class="switch-row">
            <input type="checkbox" id="wh-forward-${id}" ${proj.forwardWebhooks !== false ? 'checked' : ''}>
            <span class="switch-row-text">
              <span class="switch-row-title">Forward GitHub webhooks</span>
              <span class="switch-row-sub" id="wh-forward-status-${id}">Checking…</span>
            </span>
          </label>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h3>On merge</h3></div>
        <div class="card-pad">
          <p class="card-intro">When a forwarded PR merges, automatically transition its linked Jira ticket.</p>
          <div class="form-group" style="margin:0">
            <label class="form-label" for="wh-merge-${id}">Jira transition</label>
            <input type="text" id="wh-merge-${id}" placeholder="e.g. In Review" value="${esc(proj.mergeTransition || '')}">
            <p class="form-hint">Leave blank to take no Jira action on merge. Must match a status the ticket's workflow allows.</p>
          </div>
        </div>
      </div>

      <div class="webhooks-actions">
        <button class="btn btn-primary" onclick="saveProjectWebhooks('${id}')">Save changes</button>
      </div>
    </div>`;
  showForwardStatus(id);
}

// Reflect whether `gh webhook forward` is actually running for this project's repo, in the
// toggle's subtitle line. Looks the repo up from the store so callers needn't thread it.
async function showForwardStatus(id) {
  const el = document.getElementById(`wh-forward-status-${id}`);
  if (!el) return;
  const repo = state.projects.find(p => p.id === id)?.repo;
  if (!repo) return;
  try {
    const fwds = await api(ROUTES.FORWARDERS);
    const on = Array.isArray(fwds) && fwds.includes(repo);
    el.textContent = on ? `Active — forwarding ${repo}` : `Not running for ${repo}`;
    el.style.color = on ? 'var(--success)' : 'var(--text-3)';
  } catch {
    el.textContent = 'Status unavailable'; // don't blank the row on a transient fetch error
    el.style.color = 'var(--text-3)';
  }
}

export async function saveProjectWebhooks(id) {
  const forward = document.getElementById(`wh-forward-${id}`).checked;
  try {
    await apiJson(ROUTES.project(id), 'PUT', {
      forwardWebhooks: forward,
      mergeTransition: document.getElementById(`wh-merge-${id}`).value.trim(),
    });
    toast('Webhook settings saved');
    // Refresh the store/sidebar — the same path the edit modal uses (renderProjectNav →
    // setProjects). We deliberately do NOT re-read /api/forwarders here: the server
    // (re)starts the forwarder asynchronously, so an immediate read would race and falsely
    // show "Not running" right after enabling. Reflect the saved intent instead; the live
    // status re-syncs the next time the tab is opened.
    renderProjectNav(await api(ROUTES.PROJECTS));
    const sub = document.getElementById(`wh-forward-status-${id}`);
    if (sub) {
      sub.textContent = forward ? 'Forwarding enabled' : 'Forwarding off';
      sub.style.color = forward ? 'var(--success)' : 'var(--text-3)';
    }
  } catch (e) { toastErr(e.message); }
}

export async function reloadProjectPRs(id, prState, { silent = false } = {}) {
  const el = document.getElementById(`proj-prs-${id}`);
  if (!el) return;
  const proj = state.projects.find(p => p.id === id);
  // Cache-first: open PRs are already in the snapshot we loaded (state.projects), so render
  // them instantly — no spinner. The fetch below revalidates and reconciles, and an SSE `sync`
  // keeps it live afterward. Merged/all aren't cached (the snapshot holds only open), so they
  // show the loading state while their live `gh` fetch runs.
  const cached = prState === 'open' ? proj?.prs : null;
  if (cached) el.innerHTML = prListHtml(cached.filter(p => !p.error), proj?.repo, 'open');
  else if (!silent) el.innerHTML = '<div class="loading-row"><div class="spinner"></div> Loading…</div>';

  const prs = await api(`${ROUTES.projectPrs(id)}?state=${prState}`);
  // Reconcile the render cache to the DB so the next open-view render is cache-first from
  // current data, not a copy that only refreshes on a dashboard visit. Open only — merged/all
  // aren't snapshotted, so they must not overwrite the cached open set.
  if (prState === 'open' && proj) proj.prs = prs;
  const target = document.getElementById(`proj-prs-${id}`); // may have re-rendered; re-query
  if (target) target.innerHTML = prListHtml(prs.filter(p=>!p.error), proj?.repo, prState);
}
