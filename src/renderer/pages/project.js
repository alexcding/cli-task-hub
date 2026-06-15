// Project page: a paged "digest" — an overview hero (clickable repo/Jira/forwarding tags +
// live stat chips) over the shared segmented control (.seg-tabs), which pages between four
// sections shown one at a time: Pull Requests, Jira, Git (the full git-tab.js surface), and
// Settings (webhook forwarding). The hero + picker stay fixed; only the section body
// (.pd-body) scrolls. PRs and Jira load on open (Jira hidden, to feed its chip); Git and
// Settings lazy-load the first time their page is shown (projShowSection → lazyOnce).
import { ROUTES } from '/shared/routes.mjs';
import { state, prGroup, projectById as proj } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { esc, escJs, jiraUrl, setActiveSegTab } from '../lib/util.js';
import { ICON, TAB_ICON } from '../lib/icons.js';
import { toast, toastErr } from '../components/toast.js';
import { renderProjectNav } from '../components/sidebar.js';
import { prListHtml } from '../components/cards.js';
import { loadProjectJira, renderProjJira, itemsMatching } from './jira.js';
import { loadGitTab } from './git-tab.js';

export async function loadProjectPage(id) {
  const el = document.getElementById('project-page-content');
  const p = proj(id);
  if (!p) { el.innerHTML = '<div class="empty">Project not found.</div>'; return; }

  // Overview tags (all from cached project data — no fetch): repo, Jira key, forwarding intent.
  // The repo tag is the whole "record": clicking it (icon or text) opens the repo on GitHub.
  // (escJs for the onclick arg, not esc — see util.js: HTML entities decode before the JS runs.)
  const repoTag = p.repo
    ? `<button class="pd-tag pd-tag-mono pd-tag-btn" onclick="openRepo('${escJs(p.repo)}')" title="Open ${esc(p.repo)} on GitHub">${TAB_ICON.github}${esc(p.repo)}</button>`
    : `<span class="pd-tag pd-tag-mono">${TAB_ICON.github}No repository</span>`;
  // Jira tag opens the project in the default browser — but only when a Jira base URL was
  // detected; otherwise it's plain text (jiraUrl would be a dead '#').
  const jiraTag = !p.jiraProjectKey ? ''
    : state.jiraBase
      ? `<button class="pd-tag pd-tag-btn" onclick="openExternal('${escJs(jiraUrl(p.jiraProjectKey))}')" title="Open ${esc(p.jiraProjectKey)} in Jira">${TAB_ICON.jira}${esc(p.jiraProjectKey)}</button>`
      : `<span class="pd-tag">${TAB_ICON.jira}${esc(p.jiraProjectKey)}</span>`;
  const fwdTag = p.repo
    ? `<span class="pd-tag"><span class="pd-dot${p.forwardWebhooks !== false ? ' on' : ''}"></span>${p.forwardWebhooks !== false ? 'Forwarding on' : 'Forwarding off'}</span>`
    : '';

  // The shared segmented control (.seg-tabs, same as Settings/Activity) pages between sections.
  const seg = (sec, label) =>
    `<button class="seg-tab${sec === 'prs' ? ' active' : ''}" data-sec="${sec}" onclick="projShowSection('${id}','${sec}',this)">${label}</button>`;

  el.innerHTML = `
    <div class="proj-digest">
      <!-- Overview hero: project name + tags on the left, live stat chips on the right. -->
      <div class="pd-hero">
        <div class="pd-headline">
          <h1 class="pd-title">${esc(p.name || 'Project')}</h1>
          <div class="pd-tags">${repoTag}${jiraTag}${fwdTag}</div>
        </div>
        <div class="stat-chips" id="pd-stats-${id}"></div>
      </div>

      <!-- Section picker: each tab shows one section at a time (paged, not scrolled). -->
      <div class="seg-tabs pd-segs" role="tablist" id="pd-jump-${id}">
        ${seg('prs', 'Pull Requests')}${seg('jira', 'Jira')}${seg('git', 'Git')}${seg('settings', 'Settings')}
      </div>

      <!-- Scroll body: only the active section scrolls — the hero + picker above stay put. -->
      <div class="pd-body">
      <!-- Pull Requests (the default page) -->
      <section class="pd-sec" id="pd-prs-${id}" data-sec="prs">
        <div class="pd-sec-head">
          <h2 class="pd-sec-title"><span class="pd-sec-ic tint-accent">${ICON.branch}</span>Pull Requests</h2>
          ${p.repo ? `
          <div class="pd-sec-ctl">
            <select class="filter-select" id="pr-state-${id}" onchange="reloadProjectPRs('${id}',this.value)">
              <option value="open">Open</option>
              <option value="merged">Merged</option>
              <option value="all">All</option>
            </select>
          </div>` : ''}
        </div>
        <div id="proj-prs-${id}">${p.repo
          ? '<div class="loading-row"><div class="spinner"></div> Loading pull requests…</div>'
          : prListHtml([], '', 'open')}</div>
      </section>

      <!-- Jira -->
      <section class="pd-sec" id="pd-jira-${id}" data-sec="jira" hidden>
        <div class="pd-sec-head">
          <h2 class="pd-sec-title"><span class="pd-sec-ic tint-neutral">${TAB_ICON.jira}</span>Jira</h2>
          <div class="pd-sec-ctl">
            <div id="proj-jira-filter-${id}" class="ticket-filter" style="margin-bottom:0"></div>
            <button class="btn btn-secondary btn-sm" onclick="loadProjectJira('${id}')">${ICON.refresh} Refresh</button>
          </div>
        </div>
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
      </section>

      <!-- Git: the full branches/worktrees + commit-graph surface (git-tab.js) -->
      <section class="pd-sec" id="pd-git-${id}" data-sec="git" hidden>
        <div class="pd-sec-head">
          <h2 class="pd-sec-title"><span class="pd-sec-ic tint-success">${ICON.worktree}</span>Git</h2>
        </div>
        <div class="pd-git-host" id="proj-gittab-${id}"></div>
      </section>

      <!-- Settings: webhook forwarding, lazy-loaded the first time its page is shown -->
      <section class="pd-sec" id="pd-settings-${id}" data-sec="settings" hidden>
        <div class="pd-sec-head">
          <h2 class="pd-sec-title"><span class="pd-sec-ic tint-neutral">${ICON.zap}</span>Settings</h2>
        </div>
        <div id="proj-webhooks-${id}"></div>
      </section>
      </div><!-- /.pd-body -->
    </div>`;

  // Feed the hero chips from each section's data as it lands (no eager stale paint):
  //  • PRs: reloadProjectPRs re-renders the chips when the open set loads.
  //  • Jira: load only when configured (a project key or saved JQL) — it feeds the hidden
  //    table + the 'Open Tickets' chip; otherwise just render the section's empty state (no fetch).
  // Git and Settings lazy-load the first time their page is shown (projShowSection).
  if (p.repo) reloadProjectPRs(id, 'open');                                 // calls renderOverview on completion
  if (p.jiraProjectKey || p.jql) loadProjectJira(id).then(() => renderOverview(id));
  else renderProjJira(id);
  if (!p.repo) renderOverview(id);   // no PR loader to paint the chips → render once (also collapses an empty row)
}

// Overview stat chips — live counts in the same idiom as the dashboard hero. Computed from
// the renderer's cached state (open PRs in the project snapshot, awaiting-review via the
// shared prGroup, the project's Jira snapshot), so re-running it after a loader refreshes it.
function renderOverview(id) {
  const host = document.getElementById(`pd-stats-${id}`);
  if (!host) return;
  const p = proj(id);
  const prs = (p?.prs || []).filter(pr => !pr.error);
  const review = prs.filter(pr => prGroup(pr) === 'review').length;
  // Count tickets the SAME way the Jira section does — through the saved per-project filter —
  // so the chip and the list it links to agree. A fetch error leaves no count to show.
  const snap = state.projJiraSnap[id];
  const tickets = itemsMatching(snap?.items || [], state.projJiraFilters[id] || {}, null).length;
  const chip = (val, label, icon, tint, sec) => `
    <button class="stat-chip" onclick="projShowSection('${id}','${sec}')">
      <span class="stat-chip-icon tint-${tint}">${icon}</span>
      <span><div class="stat-chip-val">${val}</div><div class="stat-chip-label">${label}</div></span>
    </button>`;
  const chips = [];
  if (p?.repo) {
    chips.push(chip(prs.length, 'Open PRs', ICON.branch, 'accent', 'prs'));
    chips.push(chip(review, 'To Review', ICON.eye, 'warn', 'prs'));
  }
  // Skip the tickets chip when the Jira fetch errored — a '0' would be indistinguishable from
  // a real zero, and the section already surfaces the error.
  if (!snap?.error && (p?.jiraProjectKey || p?.jql || tickets)) chips.push(chip(tickets, 'Open Tickets', ICON.checkCircle, 'success', 'jira'));
  host.innerHTML = chips.join('');
  host.style.display = chips.length ? '' : 'none';
}

// ── Paging: the segmented tabs (and stat chips) swap which section is shown ───────────
// One section is visible at a time. Git and Settings lazy-load the first time their page
// is shown; PRs and Jira are already loaded by loadProjectPage. The scroller resets to the
// top so each page starts at its heading. `btn` is the clicked tab; stat chips pass none,
// so we locate the matching tab to keep the segmented control's active state in sync.
const SECTIONS = ['prs', 'jira', 'git', 'settings'];
export function projShowSection(id, sec, btn) {
  const tab = btn || document.querySelector(`#pd-jump-${id} .seg-tab[data-sec="${sec}"]`);
  if (tab) setActiveSegTab(tab);
  SECTIONS.forEach(s => { const el = document.getElementById(`pd-${s}-${id}`); if (el) el.hidden = s !== sec; });
  if (sec === 'git') lazyOnce(`proj-gittab-${id}`, () => loadGitTab(id));
  if (sec === 'settings') {
    // Build the form once; on every (re)show, re-read the live 'gh webhook forward' status so
    // it reconciles after a Save (which only reflects the saved intent — see saveProjectWebhooks).
    const built = lazyOnce(`proj-webhooks-${id}`, () => loadProjectWebhooks(id));
    if (!built) showForwardStatus(id);
  }
  document.querySelector(`#pd-prs-${id}`)?.closest('.pd-body')?.scrollTo({ top: 0 });
}

// Run `load` only the first time a section's body is shown (tracked on the element). Returns
// true when it ran the load this call. If `load` is async and rejects, the flag is cleared so
// a later show retries — otherwise a one-off failure (e.g. the diff2html bundle failing to
// load) would latch the section on its spinner forever.
function lazyOnce(bodyId, load) {
  const body = document.getElementById(bodyId);
  if (!body || body.dataset.loaded) return false;
  body.dataset.loaded = '1';
  try {
    const r = load();
    if (r && typeof r.then === 'function') r.catch(() => { delete body.dataset.loaded; });
  } catch { delete body.dataset.loaded; }
  return true;
}

// Webhooks form — the forwarding toggle + on-merge Jira transition, grouped into sections.
export function loadProjectWebhooks(id) {
  const el = document.getElementById(`proj-webhooks-${id}`);
  if (!el) return;
  const p = proj(id);
  if (!p) { el.innerHTML = '<div class="empty">Project not found.</div>'; return; }

  // No repo → forwarding can't run; reuse the standard empty-state instead of dead controls.
  if (!p.repo) {
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
            <input type="checkbox" id="wh-forward-${id}" ${p.forwardWebhooks !== false ? 'checked' : ''}>
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
            <input type="text" id="wh-merge-${id}" placeholder="e.g. In Review" value="${esc(p.mergeTransition || '')}">
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
  const repo = proj(id)?.repo;
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
    // status re-syncs the next time the section is opened.
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
  const p = proj(id);
  // Cache-first: open PRs are already in the snapshot we loaded (state.projects), so render
  // them instantly — no spinner. The fetch below revalidates and reconciles, and an SSE `sync`
  // keeps it live afterward. Merged/all aren't cached (the snapshot holds only open), so they
  // show the loading state while their live `gh` fetch runs.
  const cached = prState === 'open' ? p?.prs : null;
  if (cached) el.innerHTML = prListHtml(cached.filter(pr => !pr.error), p?.repo, 'open');
  else if (!silent) el.innerHTML = '<div class="loading-row"><div class="spinner"></div> Loading…</div>';

  const prs = await api(`${ROUTES.projectPrs(id)}?state=${prState}`);
  // Reconcile the render cache to the DB so the next open-view render is cache-first from
  // current data, not a copy that only refreshes on a dashboard visit. Open only — merged/all
  // aren't snapshotted, so they must not overwrite the cached open set.
  if (prState === 'open' && p) p.prs = prs;
  const target = document.getElementById(`proj-prs-${id}`); // may have re-rendered; re-query
  if (target) target.innerHTML = prListHtml(prs.filter(pr => !pr.error), p?.repo, prState);
  if (prState === 'open') renderOverview(id); // open set drives the chip counts; merged/all don't
}

// Refresh just the open-PR snapshot + hero chips, WITHOUT touching the visible PR list. Used
// on sync when the list is showing merged/all (which never updates the open set), so the
// 'Open PRs'/'To Review' chips don't freeze at their last open-view counts.
export async function refreshProjectStats(id) {
  const p = proj(id);
  if (!p?.repo) return;
  try {
    p.prs = await api(`${ROUTES.projectPrs(id)}?state=open`);
    renderOverview(id);
  } catch { /* transient — keep the last counts rather than clobbering them */ }
}
