// Project page: a paged "digest" — a header (project name + gear-to-edit, plus clickable
// repo/Jira/forwarding tags) over the shared segmented control (.seg-tabs), which pages between
// four sections shown one at a time: Pull Requests, Jira, Git (the full git-tab.js surface), and
// Automation (webhook forwarding + on-merge Jira). The header + picker stay fixed; only the
// section body (.pd-body) scrolls. PRs and Jira load on open; Git and Automation lazy-load the
// first time their page is shown (projShowSection → lazyOnce).
import { ROUTES } from '/shared/routes.mjs';
import { state, projectById as proj } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { esc, escJs, jiraUrl, setActiveSegTab } from '../lib/util.js';
import { ICON, TAB_ICON } from '../lib/icons.js';
import { toast, toastErr } from '../components/toast.js';
import { renderProjectNav } from '../components/sidebar.js';
import { prListHtml } from '../components/cards.js';
import { loadProjectJira, renderProjJira } from './jira.js';
import { loadGitTab } from './git-tab.js';

// Forwarding tag (header): refresh icon + a state dot, "Live" when webhooks are actually being
// forwarded, "Polled" otherwise. Inner content is factored so paintForwardTag can swap it in place.
const FWD_TITLE = {
  live: 'Live — webhook updates are forwarded in real time',
  off:  'Polled — updates arrive on the next poll',
  idle: 'Forwarding is enabled but not running yet — updates arrive on the next poll',
};
const fwdTagInner = live => `${ICON.refresh}<span class="pd-dot${live ? ' on' : ''}"></span>${live ? 'Live' : 'Polled'}`;

// Reconcile the header's forwarding tag with reality: when forwarding is enabled, probe the live
// forwarder list (same source as the Automation section's status line) and downgrade to "Polled"
// if it isn't actually running. Forwarding off → the initial "Polled" is already correct.
async function paintForwardTag(id) {
  const el = document.getElementById(`pd-fwd-${id}`);
  const p = proj(id);
  if (!el || !p?.repo || p.forwardWebhooks === false) return;
  try {
    const fwds = await api(ROUTES.FORWARDERS);
    const running = Array.isArray(fwds) && fwds.includes(p.repo);
    el.innerHTML = fwdTagInner(running);
    el.title = running ? FWD_TITLE.live : FWD_TITLE.idle;
  } catch { /* transient — leave the optimistic "Live" rather than flapping the header */ }
}

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
  // Live = webhooks forwarded in real time; Polled = updates arrive on the next poll. The initial
  // paint shows the saved intent; paintForwardTag (below) then probes the live forwarder list and
  // downgrades to "Polled" if forwarding is enabled but not actually running — so the header can't
  // claim real-time delivery that isn't happening (the Automation section shows the same truth).
  const fwdOn = p.forwardWebhooks !== false;
  const fwdTag = p.repo
    ? `<span class="pd-tag" id="pd-fwd-${id}" title="${fwdOn ? FWD_TITLE.live : FWD_TITLE.off}">${fwdTagInner(fwdOn)}</span>`
    : '';

  // The shared segmented control (.seg-tabs, same as Settings/Activity) pages between sections.
  const seg = (sec, label) =>
    `<button class="seg-tab${sec === 'prs' ? ' active' : ''}" data-sec="${sec}" onclick="projShowSection('${id}','${sec}',this)">${label}</button>`;

  el.innerHTML = `
    <div class="proj-digest">
      <!-- Header block: title (left) ↔ tags (right) on top, then the section picker
           directly beneath. -->
      <div class="pd-hero">
        <div class="pd-hero-row">
          <div class="pd-titlewrap">
            <h1 class="pd-title">${esc(p.name || 'Project')}</h1>
            <button class="pd-edit" onclick="openEditProjectModal('${id}')" title="Edit project" aria-label="Edit project">${ICON.gear}</button>
          </div>
          <div class="pd-tags">${repoTag}${jiraTag}${fwdTag}</div>
        </div>
        <!-- Section picker: each tab shows one section at a time (paged, not scrolled). -->
        <div class="seg-tabs pd-segs" role="tablist">
          ${seg('prs', 'Pull Requests')}${seg('jira', 'Jira')}${seg('git', 'Git')}${seg('settings', 'Automation')}
        </div>
      </div>

      <!-- Scroll body: only the active section scrolls — the header above stays put. -->
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
          <h2 class="pd-sec-title"><span class="pd-sec-ic tint-neutral">${ICON.zap}</span>Automation</h2>
        </div>
        <div id="proj-webhooks-${id}"></div>
      </section>
      </div><!-- /.pd-body -->
    </div>`;

  // Load the default PR page now. Jira loads only when configured (a project key or saved
  // JQL); otherwise render the section's empty state without a fetch. Git and Settings
  // lazy-load the first time their page is shown (projShowSection).
  if (p.repo) { reloadProjectPRs(id, 'open'); paintForwardTag(id); }
  if (p.jiraProjectKey || p.jql) loadProjectJira(id);
  else renderProjJira(id);
}

// ── Paging: the segmented tabs swap which section is shown ────────────────────────────
// One section is visible at a time. Git and Settings lazy-load the first time their page
// is shown; PRs and Jira are already loaded by loadProjectPage. The scroller resets to the
// top so each page starts at its heading. `btn` is always the clicked seg-tab (every caller is
// an inline onclick passing `this`).
const SECTIONS = ['prs', 'jira', 'git', 'settings'];
export function projShowSection(id, sec, btn) {
  if (btn) setActiveSegTab(btn);
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

// Automation form — event forwarding (its own card) + the on-merge action series (set Fix
// Version → transition), shown as ordered steps since they run in sequence on each linked ticket.
export function loadProjectWebhooks(id) {
  const el = document.getElementById(`proj-webhooks-${id}`);
  if (!el) return;
  const p = proj(id);
  if (!p) { el.innerHTML = '<div class="empty">Project not found.</div>'; return; }

  // No repo → forwarding can't run; reuse the standard empty-state instead of dead controls.
  if (!p.repo) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">${ICON.branch}</div><p>Webhook forwarding needs a GitHub repo. Add one to this project (the gear beside the project name) and it'll show up here.</p></div>`;
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

      <!-- On GitHub PR merge: a series of actions run, in order, against each linked Jira ticket. -->
      <div class="card">
        <div class="card-header"><h3>On GitHub PR merge</h3></div>
        <div class="card-pad">
          <p class="card-intro">When a forwarded PR merges, these steps run in order on every linked Jira ticket. Each is optional.</p>

          <div class="merge-step">
            <span class="merge-step-n">1</span>
            <div class="merge-step-body">
              <label class="switch-row">
                <input type="checkbox" id="wh-fixver-enabled-${id}" ${p.fixVersionEnabled ? 'checked' : ''} onchange="document.getElementById('wh-fixver-body-${id}').hidden = !this.checked">
                <span class="switch-row-text">
                  <span class="switch-row-title">Set Fix Version</span>
                  <span class="switch-row-sub">Build a version name, create it in Jira if missing, and stamp it on the ticket. Needs a Jira API token (Settings → Jira).</span>
                </span>
              </label>
              <div id="wh-fixver-body-${id}" ${p.fixVersionEnabled ? '' : 'hidden'} style="margin-top:14px">
                <div class="form-group">
                  <label class="form-label" for="wh-fixver-prefix-${id}">Platform prefix</label>
                  <input type="text" id="wh-fixver-prefix-${id}" placeholder="e.g. ios-" value="${esc(p.fixVersionPrefix || '')}" oninput="previewFixVersion('${id}')">
                </div>
                <div class="form-group">
                  <label class="form-label" for="wh-fixver-script-${id}">Version script (JS)</label>
                  <textarea id="wh-fixver-script-${id}" rows="3" spellcheck="false" placeholder="\`0.\${now.getUTCMonth()+1}.\${now.getUTCDate()}\`" oninput="previewFixVersion('${id}')">${esc(p.fixVersionScript || '')}</textarea>
                  <p class="form-hint">A JS expression that evaluates to the <strong>number</strong> part (e.g. <code class="code-chip">\`0.\${isoWeek(now)}\`</code>) — no <code class="code-chip">return</code> needed, though a multi-line body with <code class="code-chip">return</code> also works. Inputs: <code class="code-chip">now</code>, <code class="code-chip">pr</code>, <code class="code-chip">versions</code>, helpers <code class="code-chip">isoWeek()</code>/<code class="code-chip">pad()</code>. Final version = prefix + number.</p>
                </div>
                <div class="fixver-preview" id="wh-fixver-preview-${id}"></div>
              </div>
            </div>
          </div>

          <div class="merge-step">
            <span class="merge-step-n">2</span>
            <div class="merge-step-body">
              <div class="form-group" style="margin:0">
                <label class="form-label" for="wh-merge-${id}">Transition the ticket</label>
                <input type="text" id="wh-merge-${id}" placeholder="e.g. Ready for QA" value="${esc(p.mergeTransition || '')}">
                <p class="form-hint">Move the ticket to this status. Leave blank to take no transition. Must match a status the ticket's workflow allows.</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="webhooks-actions">
        <button class="btn btn-primary" onclick="saveProjectWebhooks('${id}')">Save changes</button>
      </div>
    </div>`;
  showForwardStatus(id);
  previewFixVersion(id);   // paint the initial preview from the saved script
}

// Live preview for the Fix Version automation: evaluate the (unsaved) prefix + script on the
// server (same sandbox the merge uses) and show the assembled name, debounced as the user types.
const _fixverTimers = {};
export function previewFixVersion(id) {
  clearTimeout(_fixverTimers[id]);
  _fixverTimers[id] = setTimeout(async () => {
    const el = document.getElementById(`wh-fixver-preview-${id}`);
    if (!el) return;
    const script = document.getElementById(`wh-fixver-script-${id}`)?.value || '';
    if (!script.trim()) { el.className = 'fixver-preview'; el.innerHTML = ''; return; }
    const prefix = document.getElementById(`wh-fixver-prefix-${id}`)?.value || '';
    try {
      const r = await apiJson(ROUTES.projectFixversionPreview(id), 'POST', { prefix, script });
      el.className = 'fixver-preview ok';
      el.innerHTML = `Preview: <strong>${esc(r.version)}</strong> ${r.exists
        ? '<span class="fixver-tag">already exists</span>'
        : '<span class="fixver-tag new">will be created</span>'}`;
    } catch (e) {
      el.className = 'fixver-preview err';
      el.textContent = `Script error: ${e.message}`;
    }
  }, 250);
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
      fixVersionEnabled: document.getElementById(`wh-fixver-enabled-${id}`).checked,
      fixVersionPrefix: document.getElementById(`wh-fixver-prefix-${id}`).value.trim(),
      fixVersionScript: document.getElementById(`wh-fixver-script-${id}`).value,
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
}
