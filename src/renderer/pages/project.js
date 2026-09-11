// Project page: a paged "digest". Its chrome all lives in the topbar (paintTopbar): the project
// name on the left and the shared segmented control (.seg-tabs) centred — no toolbar actions.
// Each section heading doubles as the link to its service (repo → GitHub, Jira
// project → Jira). The picker pages between
// sections shown one at a time: Pull Requests, Jira, Automation
// (webhook forwarding + on-merge Jira), Workflows and Settings (this project's own config — name,
// local repo, Jira key, delete — which used to be the topbar's edit gear + modal). The Jira section has its own view switcher
// (projJiraView): Board (sprint columns, scrumboard.js) and Tickets (the project's saved JQL with
// an inline ad-hoc JQL search, jira.js). The page itself is only the section body (.pd-body),
// which scrolls under the fixed toolbar. PRs load on open; everything else lazy-loads
// the first time it's shown (projShowSection / projJiraView → lazyOnce).
import { ROUTES } from '/shared/routes.mjs';
import { state, projectById as proj } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { esc, escJs, jiraUrl, setActiveSegTab } from '../lib/util.js';
import { wfBranchName, normalizeSteps, resolvePlaceholders } from '../lib/workflow.mjs';
import { ICON, TAB_ICON } from '../lib/icons.js';
import { toast, toastErr } from '../components/toast.js';
import { renderProjectNav } from '../components/sidebar.js';
import { prListHtml } from '../components/cards.js';
import { loadProjectJira, renderProjJira } from './jira.js';
import { IDES, ideIcon } from '../lib/ides.js';
import { updateFolderChip } from '../components/viewer.js';
import { loadScrumboard } from './scrumboard.js';

export async function loadProjectPage(id) {
  const el = document.getElementById('project-page-content');
  const p = proj(id);
  if (!p) { el.innerHTML = '<div class="empty">Project not found.</div>'; return; }

  // The Jira section's view switcher (a compact .seg-tabs). Remembers the last view per project.
  const view = _jiraView.get(id) || 'board';
  const jv = (v, label) =>
    `<button class="seg-tab${v === view ? ' active' : ''}" data-view="${v}" onclick="projJiraView('${id}','${v}',this)">${label}</button>`;

  el.innerHTML = `
    <div class="proj-digest">
      <!-- No header block: the project name and the section picker live in the topbar
           (paintTopbar below / app.js showPage); each section heading carries the
           link to its own service. -->
      <div class="pd-body">
      <!-- Pull Requests (the default page). The whole heading is the repo link: GitHub mark,
           "Pull Requests", and the repo slug — one hit target that opens the repo on GitHub
           (that's why the mark isn't in the topbar). No repo → a plain, inert heading. -->
      <section class="pd-sec" id="pd-prs-${id}" data-sec="prs">
        <div class="pd-sec-head">
          ${p.repo
            ? `<h2 class="pd-sec-title"><button class="pd-sec-link" onclick="openRepo('${escJs(p.repo)}')" title="Open ${esc(p.repo)} on GitHub"><span class="pd-sec-ic tint-neutral">${TAB_ICON.github}</span>Pull Requests<span class="pd-sec-sub">${esc(p.repo)}</span></button></h2>`
            : `<h2 class="pd-sec-title"><span class="pd-sec-ic tint-accent">${ICON.branch}</span>Pull Requests</h2>`}
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

      <!-- Jira: one section, two views (Board / Tickets) picked by the small segmented control
           in the header, under a shared filter bar that narrows both. Board is the sprint
           snapshot (scrumboard.js — the scrumboard-* ids are its contract); Tickets is the
           project's saved JQL with an inline keyword/JQL search box (jira.js). -->
      <section class="pd-sec" id="pd-jira-${id}" data-sec="jira" hidden>
        <!-- Header row: the Jira project itself is the title — the mark plus the project key,
             no generic "Jira" label (only used as the fallback when no key is configured); the
             whole heading opens the project in Jira, as in Pull Requests.
             Then the shared filters (apply to BOTH views: the assignee is
             client-side, the JQL clause is server-side — ANDed into the sprint and Tickets
             queries; scrumboard.js fills them once the sprint snapshot lands, which the section
             always loads), then the view switcher on the right. Live data refreshes over SSE, so no
             Refresh button. -->
        <div class="pd-sec-head jv-head">
          ${p.jiraProjectKey && state.jiraBase
            ? `<h2 class="pd-sec-title"><button class="pd-sec-link" onclick="openExternal('${escJs(jiraUrl(p.jiraProjectKey))}')" title="Open ${esc(p.jiraProjectKey)} in Jira"><span class="pd-sec-ic tint-neutral">${TAB_ICON.jira}</span>${esc(p.jiraProjectKey)}</button></h2>`
            : `<h2 class="pd-sec-title"><span class="pd-sec-ic tint-neutral">${TAB_ICON.jira}</span>${esc(p.jiraProjectKey || 'Jira')}</h2>`}
          <div class="jv-filters">
            <span id="scrumboard-filter" class="ticket-filter"></span>
            <span id="scrumboard-query" class="ticket-filter"></span>
          </div>
          <div class="pd-sec-ctl">
            <div class="seg-tabs jv-segs" role="tablist">
              ${jv('board', 'Board')}${jv('tickets', 'Tickets')}
            </div>
          </div>
        </div>

        <!-- Board: the active sprint as status columns -->
        <div class="jv" id="jv-board-${id}" data-view="board" ${view === 'board' ? '' : 'hidden'}>
          <div class="board-subtitle" id="scrumboard-title"></div>
          <div id="scrumboard-body"><div class="board-loading"><div class="spinner"></div> Loading…</div></div>
        </div>

        <!-- Tickets: the project's saved JQL (or its key's in-flight tickets), with an inline JQL
             search — a query swaps the table for live results, blank restores the list. -->
        <div class="jv" id="jv-tickets-${id}" data-view="tickets" ${view === 'tickets' ? '' : 'hidden'}>
          <form class="jv-bar" onsubmit="event.preventDefault();jiraSearch('${id}')">
            <input id="jira-search-${id}" class="board-query-input jv-search-input" type="search" value="${esc(state.jiraSearchSnap[id]?.typed || '')}"
              placeholder="Search ${p.jiraProjectKey ? esc(p.jiraProjectKey) + ' ' : ''}tickets — keywords, a key like ${p.jiraProjectKey ? esc(p.jiraProjectKey) : 'ABC'}-123, or JQL"
              autocomplete="off" spellcheck="false"
              oninput="if(!this.value.trim())jiraSearch('${id}')"
              onkeydown="if(event.key==='Escape'){this.value='';jiraSearch('${id}');}">
            <div id="proj-jira-filter-${id}" class="ticket-filter"></div>
          </form>
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

      <!-- Automation: webhook forwarding + on-merge Jira, lazy-loaded the first time it's shown -->
      <section class="pd-sec" id="pd-automation-${id}" data-sec="automation" hidden>
        <div class="pd-sec-head">
          <h2 class="pd-sec-title"><span class="pd-sec-ic tint-neutral">${ICON.cpu}</span>Automation</h2>
        </div>
        <div id="proj-webhooks-${id}"></div>
      </section>

      <!-- Workflows: per-project automation recipes, lazy-loaded the first time shown -->
      <section class="pd-sec" id="pd-workflows-${id}" data-sec="workflows" hidden>
        <div class="pd-sec-head">
          <h2 class="pd-sec-title"><span class="pd-sec-ic tint-accent">${ICON.zap}</span>Workflows</h2>
          <div class="pd-sec-ctl">
            <button class="btn btn-secondary btn-sm" onclick="wfNew('${id}')">${ICON.plus} New workflow</button>
          </div>
        </div>
        <div id="proj-workflows-${id}"></div>
      </section>

      <!-- Settings: this project's own config (name, local repo, Jira key) — the last tab,
           where the topbar gear used to be. Lazy-loaded the first time it's shown. -->
      <section class="pd-sec" id="pd-settings-${id}" data-sec="settings" hidden>
        <div class="pd-sec-head">
          <h2 class="pd-sec-title"><span class="pd-sec-ic tint-neutral">${ICON.gear}</span>Settings</h2>
        </div>
        <div id="proj-settings-${id}"></div>
      </section>
      </div><!-- /.pd-body -->
    </div>`;

  paintTopbar(id);   // the section picker: the page's chrome all lives in the topbar

  // Load the default PR page now. Every other section (Jira views, Automation, Workflows, Settings)
  // lazy-loads the first time it's shown (projShowSection / projJiraView).
  if (p.repo) reloadProjectPRs(id, 'open');
}

// The page's chrome is the topbar (native-mac unified toolbar): the project name left and the
// section picker centred (app.js showPage). No links here — each section's
// own heading is the link to its service. showPage clears the picker slot on every nav, so this
// repaints on each visit; a section switch only re-marks the active tab (projShowSection →
// setActiveSegTab).
function paintTopbar(id) {
  const picker = document.getElementById('topbar-picker');
  if (!picker) return;

  // Short labels: the centre slot shares the bar with the title and the actions, so .topbar-segs
  // sizes to content instead of the usual equal columns.
  const seg = ([sec, label]) =>
    `<button class="seg-tab${sec === 'prs' ? ' active' : ''}" data-sec="${sec}" onclick="projShowSection('${id}','${sec}',this)">${label}</button>`;
  picker.innerHTML = `<div class="seg-tabs topbar-segs" role="tablist">${SECTION_TABS.map(seg).join('')}</div>`;
}

// ── Jira section views ────────────────────────────────────────────────────────────────
// Board / Tickets, under one shared filter bar (assignee + JQL clause — both views obey it).
// Board is the sprint snapshot (loadScrumboard, lazyOnce keyed off #scrumboard-body). Tickets loads the project's saved JQL only when one is configured — otherwise
// its empty state says so; its inline JQL box runs a live search on submit (jira.js jiraSearch).
// The chosen view is remembered per project (module-local: view-only).
const JIRA_VIEWS = ['board', 'tickets'];
const _jiraView = new Map();
export function projJiraView(id, view, btn) {
  if (btn) setActiveSegTab(btn);
  _jiraView.set(id, view);
  JIRA_VIEWS.forEach(v => { const el = document.getElementById(`jv-${v}-${id}`); if (el) el.hidden = v !== view; });
  // The sprint snapshot loads whichever view is shown: it fills the shared bar (assignee roster,
  // filter clause) that both views use.
  lazyOnce('scrumboard-body', () => loadScrumboard(id));
  if (view === 'tickets') lazyOnce(`jv-tickets-${id}`, () => { const p = proj(id); return (p?.jiraProjectKey || p?.jql) ? loadProjectJira(id) : renderProjJira(id); });
}


// ── Paging: the segmented tabs swap which section is shown ────────────────────────────
// One section is visible at a time. Jira (its active view), Automation, Workflows and
// Settings lazy-load the first
// time their page is shown; PRs are already loaded by loadProjectPage. The scroller resets to the
// top so each page starts at its heading. `btn` is always the clicked seg-tab (every caller is
// an inline onclick passing `this`).
// [section id, topbar label] — the picker's tabs and the set of pageable sections, in order.
const SECTION_TABS = [['prs', 'PRs'], ['jira', 'Jira'], ['automation', 'Automation'], ['workflows', 'Workflows'], ['settings', 'Settings']];
const SECTIONS = SECTION_TABS.map(([s]) => s);
export function projShowSection(id, sec, btn) {
  if (btn) setActiveSegTab(btn);
  SECTIONS.forEach(s => { const el = document.getElementById(`pd-${s}-${id}`); if (el) el.hidden = s !== sec; });
  if (sec === 'jira') projJiraView(id, _jiraView.get(id) || 'board');
  if (sec === 'workflows') lazyOnce(`proj-workflows-${id}`, () => loadProjectWorkflows(id));
  if (sec === 'automation') {
    // Build the form once; on every (re)show, re-read the live 'gh webhook forward' status so
    // it reconciles after a Save (which only reflects the saved intent — see saveProjectWebhooks).
    const built = lazyOnce(`proj-webhooks-${id}`, () => loadProjectWebhooks(id));
    if (!built) showForwardStatus(id);
  }
  if (sec === 'settings') lazyOnce(`proj-settings-${id}`, () => loadProjectSettings(id));
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
    el.innerHTML = `<div class="empty"><div class="empty-icon">${ICON.branch}</div><p>Webhook forwarding needs a GitHub repo. Add one in this project's Settings tab and it'll show up here.</p></div>`;
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

// ── Settings tab ──────────────────────────────────────────────────────────────────────
// The project's own config, as the last tab (it used to be the topbar gear + the shared
// New/Edit Project modal — the modal now only serves New Project, from the sidebar). Fields are
// id-scoped per project so they can't collide with the modal's. The GitHub repo is not editable:
// it's auto-detected from the local checkout's git origin (same rule as the modal).
export function loadProjectSettings(id) {
  const el = document.getElementById(`proj-settings-${id}`);
  if (!el) return;
  const p = proj(id);
  if (!p) { el.innerHTML = '<div class="empty">Project not found.</div>'; return; }

  el.innerHTML = `
    <div class="webhooks-form">
      <div class="card">
        <div class="card-header"><h3>Project</h3></div>
        <div class="card-pad">
          <div class="form-group">
            <label class="form-label" for="ps-name-${id}">Project name</label>
            <input type="text" id="ps-name-${id}" placeholder="e.g. Record iOS" value="${esc(p.name || '')}">
          </div>
          <div class="form-group">
            <label class="form-label" for="ps-workspace-${id}">Local Git Repo</label>
            <div style="display:flex;gap:8px">
              <input type="text" id="ps-workspace-${id}" placeholder="/path/to/local/checkout" style="flex:1" value="${esc(p.workspace || '')}">
              <button type="button" class="btn btn-secondary btn-sm" onclick="chooseProjectWorkspace('${id}')">Choose…</button>
            </div>
            <input type="hidden" id="ps-repo-${id}" value="${esc(p.repo || '')}">
            <p class="form-hint" id="ps-repo-hint-${id}"></p>
          </div>
        </div>
      </div>

      <!-- IDE: the second launcher on the terminal toolbar's folder chip. Per project, because
           which editor a checkout belongs in is a property of the repo — the git client next to
           it stays app-level (Settings → Appearance). -->
      <div class="card">
        <div class="card-header"><h3>IDE</h3></div>
        <div class="card-pad">
          <div class="form-group">
            <label class="form-label" for="ps-ide-${id}">Open folders in</label>
            <div style="display:flex;align-items:center;gap:8px">
              <select id="ps-ide-${id}" class="filter-select" onchange="projIdeChange('${id}')">
                <option value=""${p.ide ? '' : ' selected'}>None</option>
                ${IDES.map(i => `<option value="${i.id}"${p.ide === i.id ? ' selected' : ''}>${esc(i.label)}</option>`).join('')}
                <option value="custom"${p.ide === 'custom' ? ' selected' : ''}>Custom…</option>
              </select>
              <!-- The app's own mark, so what you picked here is visibly the same button that
                   turns up on the terminal toolbar. Hidden for None and Custom (no brand mark). -->
              <img class="ide-mark" id="ps-ide-mark-${id}" alt="" src="${ideIcon(p.ide)}" ${ideIcon(p.ide) ? '' : 'hidden'}>
            </div>
            <p class="form-hint">Adds an <strong>open in IDE</strong> button to the terminal toolbar's folder chip — it launches this project's worktree (or its main checkout).</p>
          </div>
          <div class="form-group" id="ps-ide-custom-${id}" ${p.ide === 'custom' ? '' : 'hidden'}>
            <label class="form-label" for="ps-ide-cmd-${id}">Command template</label>
            <input type="text" id="ps-ide-cmd-${id}" spellcheck="false" placeholder='open -a "Visual Studio Code" {path}' value="${esc(p.ideCmd || '')}">
            <p class="form-hint"><code class="code-chip">{path}</code> is replaced by whatever is opened. Run without a shell, so quotes group an app name — no pipes or redirects.</p>
          </div>
          <div class="form-group" id="ps-ide-target-row-${id}" style="margin:0" ${p.ide ? '' : 'hidden'}>
            <label class="form-label" for="ps-ide-target-${id}">Open this file</label>
            <div style="display:flex;gap:8px">
              <input type="text" id="ps-ide-target-${id}" spellcheck="false" placeholder="ios/MyApp.xcworkspace" style="flex:1" value="${esc(p.ideTarget || '')}">
              <button type="button" class="btn btn-secondary btn-sm" onclick="chooseProjectIdeTarget('${id}')">Choose…</button>
            </div>
            <p class="form-hint">Pick it with <strong>Choose…</strong> or type it. Stored relative to the checkout, so it resolves inside <em>every</em> branch's worktree — an absolute path would always point at one branch. Leave blank to open the folder itself; Xcode can't do that, so with nothing set it opens the first <code class="code-chip">.xcworkspace</code>, <code class="code-chip">.xcodeproj</code> or <code class="code-chip">Package.swift</code> it finds.</p>
          </div>
          <!-- Build/run script — same card as the IDE, since it's the other half of "work on this
               checkout": open it, or build it. Runs in the worktree, so it's per project, not per
               branch. Multi-line is fine (it's a script, not one argv). -->
          <div class="form-group" id="ps-run-row-${id}" style="margin:0" ${p.ide || p.runCmd ? '' : 'hidden'}>
            <label class="form-label" for="ps-run-${id}">Build / run command</label>
            <textarea id="ps-run-${id}" rows="3" spellcheck="false" placeholder="xcodebuildmcp simulator build-and-run {targetFlag} {target} --scheme MyApp --simulator-name 'iPhone 16'">${esc(p.runCmd || '')}</textarea>
            <p class="form-hint">Run in the worktree by the toolbar's <strong>Run</strong> button. <code class="code-chip">{path}</code> is the folder and <code class="code-chip">{target}</code> the resolved file above; <code class="code-chip">{targetFlag}</code> becomes <code class="code-chip">--workspace-path</code> or <code class="code-chip">--project-path</code> to match it. Blank = no Run button.</p>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h3>Jira</h3></div>
        <div class="card-pad">
          <div class="form-group" style="margin:0">
            <label class="form-label" for="ps-jira-key-${id}">Project key</label>
            <input type="text" id="ps-jira-key-${id}" placeholder="e.g. RECORD" style="text-transform:uppercase" value="${esc(p.jiraProjectKey || '')}">
            <p class="form-hint">Drives this project's <strong>Jira</strong> tab (Board, Tickets). Narrow both with the tab's filter clause (e.g. <code class="code-chip">component = iOS</code>).</p>
          </div>
        </div>
      </div>

      <div class="webhooks-actions">
        <button class="btn btn-danger" style="margin-right:auto" onclick="deleteProject('${id}')">Delete project</button>
        <button class="btn btn-primary" onclick="saveProjectSettings('${id}')">Save changes</button>
      </div>
    </div>`;
  paintProjRepoHint(id);
}

// The repo slug is derived, not typed: show whatever is stored (or the rule, when nothing is).
function paintProjRepoHint(id) {
  const hint = document.getElementById(`ps-repo-hint-${id}`);
  if (!hint) return;
  const repo = document.getElementById(`ps-repo-${id}`)?.value || '';
  hint.innerHTML = repo
    ? `GitHub repo: <code class="code-chip">${esc(repo)}</code>`
    : `Sets the terminal's working directory; the GitHub repo is auto-detected from its <code class="code-chip">git</code> origin.`;
}

// Native folder picker for the Local Git Repo field, then re-detect the GitHub repo from the
// chosen folder's git origin (only overwrites the stored slug when a remote is actually found).
export async function chooseProjectWorkspace(id) {
  if (!window.taskhub?.chooseFolder) { toastErr('Folder picker is only available in the app'); return; }
  const dir = await window.taskhub.chooseFolder();
  if (!dir) return;
  const ws = document.getElementById(`ps-workspace-${id}`);
  if (ws) ws.value = dir;
  try {
    const { repo } = await api(`${ROUTES.DETECT_REPO}?path=${encodeURIComponent(dir)}`);
    if (repo) {
      const f = document.getElementById(`ps-repo-${id}`);
      if (f) f.value = repo;
      paintProjRepoHint(id);
      toast(`Detected ${repo}`);
    } else toast('No GitHub remote found in that folder');
  } catch {}
}

// Pick the IDE target with the native file picker instead of typing a path. It opens inside the
// project's checkout and stores the choice RELATIVE to it, which is the whole point — the same
// setting has to resolve in every branch's worktree. macOS treats bundles as files in a file
// panel, so an `.xcworkspace` / `.xcodeproj` is pickable as one item.
export async function chooseProjectIdeTarget(id) {
  if (!window.taskhub?.chooseFile) { toastErr('File picker is only available in the app'); return; }
  // Read the workspace from the form, not the record — it may have just been changed here.
  const ws = (document.getElementById(`ps-workspace-${id}`)?.value.trim() || proj(id)?.workspace || '').replace(/\/+$/, '');
  if (!ws) { toastErr('Set the Local Git Repo first — the target is stored relative to it'); return; }
  const picked = await window.taskhub.chooseFile({ start: ws, title: 'Choose what the IDE opens' });
  if (!picked) return;
  if (!picked.startsWith(ws + '/')) { toastErr('Pick something inside the checkout — the target is stored relative to it'); return; }
  const field = document.getElementById(`ps-ide-target-${id}`);
  if (field) field.value = picked.slice(ws.length + 1);
}

// "Custom…" reveals the command-template field, and picking any IDE reveals the target field
// (there's nothing to open when the answer is "None"). Everything is persisted by Save changes.
export function projIdeChange(id) {
  const sel = document.getElementById(`ps-ide-${id}`)?.value || '';
  const box = document.getElementById(`ps-ide-custom-${id}`);
  if (box) box.hidden = sel !== 'custom';
  const row = document.getElementById(`ps-ide-target-row-${id}`);
  if (row) row.hidden = !sel;
  const mark = document.getElementById(`ps-ide-mark-${id}`);
  if (mark) { const icon = ideIcon(sel); mark.src = icon; mark.hidden = !icon; }
  // The run script is independent of the IDE, but it's the same card — reveal it with the picker
  // rather than leaving it stranded above a "None". A script already written keeps it open.
  const run = document.getElementById(`ps-run-row-${id}`);
  if (run) run.hidden = !sel && !document.getElementById(`ps-run-${id}`)?.value.trim();
}

export async function saveProjectSettings(id) {
  const name = document.getElementById(`ps-name-${id}`)?.value.trim();
  if (!name) { toastErr('Name required'); return; }
  try {
    const ide = document.getElementById(`ps-ide-${id}`)?.value || '';
    await apiJson(ROUTES.project(id), 'PUT', {
      name,
      workspace:      document.getElementById(`ps-workspace-${id}`)?.value.trim() || '',
      repo:           document.getElementById(`ps-repo-${id}`)?.value.trim() || '',
      jiraProjectKey: document.getElementById(`ps-jira-key-${id}`)?.value.trim() || '',
      ide,
      ideCmd:         document.getElementById(`ps-ide-cmd-${id}`)?.value.trim() || '',
      ideTarget:      document.getElementById(`ps-ide-target-${id}`)?.value.trim() || '',
      runCmd:         document.getElementById(`ps-run-${id}`)?.value.trim() || '',
    });
    toast('Project updated');
    // The sidebar and the topbar title carry the name; the rest of the page (PRs, Jira) is
    // keyed off repo/jiraProjectKey, so reload the whole page from the refreshed store.
    renderProjectNav(await api(ROUTES.PROJECTS));
    document.getElementById('page-title').textContent = name;
    updateFolderChip(true); // the IDE half of the folder chip reads this project record
    loadProjectPage(id);
    projShowSection(id, 'settings', document.querySelector(`#topbar-picker .seg-tab[data-sec="settings"]`));
  } catch (e) { toastErr(e.message); }
}

// ── Workflows tab ─────────────────────────────────────────────────────────────────────
// A project owns a list of workflows; each is a CLI + an ordered set of command lines. The
// Workflow button on a ticket/PR (later) opens the item's worktree, launches the CLI, and types
// each command. Edits live in a module-local buffer per project (commands/cards add-remove, so
// rows re-render) and the whole list is saved at once. The buffer is the source of truth while
// editing — every input syncs to it, so re-rendering never loses unsaved text.
const _wfBuf = {}; // projectId -> [ { id, name, cli, steps:[{ title, command }] } ]
const _rid = () => (self.crypto?.randomUUID ? self.crypto.randomUUID() : 'wf-' + Math.random().toString(36).slice(2));
const _emptyStep = () => ({ title: '', command: '' });
// Editor steps: the shared normalizer (tolerates the legacy commands:[string] shape) plus a UI
// default of one empty row so a fresh/empty workflow always has something to type into.
const _wfSteps = w => { const s = normalizeSteps(w); return s.length ? s : [_emptyStep()]; };
function wfList(id) {
  if (!_wfBuf[id]) {
    const arr = Array.isArray(proj(id)?.workflows) ? proj(id).workflows : [];
    _wfBuf[id] = arr.map(w => ({
      id: w.id || _rid(),
      name: w.name || '',
      cli: w.cli === 'codex' ? 'codex' : 'claude',
      steps: _wfSteps(w),
    }));
  }
  return _wfBuf[id];
}
const wfGet = (id, wfId) => wfList(id).find(w => w.id === wfId);

// A representative context so the preview shows resolved commands before any real run.
function wfSampleCtx(p) {
  const key = `${p?.jiraProjectKey || 'ABC'}-123`;
  return {
    key,
    url: state.jiraBase ? jiraUrl(key) : `https://example.atlassian.net/browse/${key}`,
    branch: wfBranchName(key, 'sample task'),
    pr: '42',
    repo: p?.repo || 'owner/repo',
    workspace: p?.workspace || '',
    worktree: '',
  };
}

export function loadProjectWorkflows(id) {
  const el = document.getElementById(`proj-workflows-${id}`);
  if (!el) return;
  const p = proj(id);
  if (!p) { el.innerHTML = '<div class="empty">Project not found.</div>'; return; }
  const list = wfList(id);
  if (!list.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">${ICON.zap}</div>
      <p>No workflows yet. A workflow runs a saved set of commands on a ticket or pull request — it opens the item's worktree, launches your CLI, and types each command in turn.</p>
      <button class="btn btn-primary" onclick="wfNew('${id}')">${ICON.plus} New workflow</button></div>`;
    return;
  }
  el.innerHTML = `<div class="webhooks-form">
      ${list.map(w => workflowCardHtml(id, w)).join('')}
      <div class="webhooks-actions"><button class="btn btn-primary" onclick="saveWorkflows('${id}')">Save changes</button></div>
    </div>`;
  list.forEach(w => wfPreview(id, w.id));
}

function workflowCardHtml(id, w) {
  const cli = c => `<button type="button" class="wf-cli wf-cli-${c}${w.cli === c ? ' on' : ''}" onclick="wfSetCli('${id}','${w.id}','${c}')"><span class="wf-cli-mk"></span>${c === 'claude' ? 'Claude' : 'Codex'}</button>`;
  return `<div class="card wf-card" data-wf="${w.id}">
      <div class="card-header wf-card-head">
        <input type="text" class="wf-name" value="${esc(w.name)}" placeholder="Workflow name" oninput="wfSetName('${id}','${w.id}',this.value)">
        <button type="button" class="wf-card-del" title="Delete workflow" aria-label="Delete workflow" onclick="wfDelete('${id}','${w.id}')">${ICON.close}</button>
      </div>
      <div class="card-pad">
        <div class="form-group">
          <label class="form-label">Run with</label>
          <div class="wf-clis">${cli('claude')}${cli('codex')}</div>
        </div>
        <div class="form-group">
          <label class="form-label">Steps — run in order</label>
          <div class="wf-steps" id="wf-steps-${id}-${w.id}">${wfStepsHtml(id, w)}</div>
          <button type="button" class="wf-add" onclick="wfAddStep('${id}','${w.id}')">${ICON.plus} Add step</button>
        </div>
        <p class="form-hint">Each step is a command plus a short goal. The command is typed into the CLI; the goal is what the headless CLI checks to tell whether the step finished. Use <code class="code-chip">{url}</code>, <code class="code-chip">{key}</code>, <code class="code-chip">{pr}</code>, <code class="code-chip">{branch}</code>, <code class="code-chip">{repo}</code> — filled in from the ticket or PR (<code class="code-chip">{pr}</code> is the GitHub PR number). A worktree is created automatically when the item has none; existing worktrees are reused.</p>
        <div class="wf-preview" id="wf-preview-${id}-${w.id}"></div>
      </div>
    </div>`;
}

function wfStepsHtml(id, w) {
  return w.steps.map((s, i) => `<div class="wf-step">
      <div class="wf-step-head">
        <span class="wf-ord">${i + 1}</span>
        <input type="text" class="wf-step-title" value="${esc(s.title)}" placeholder="Goal — e.g. “feature implemented and committed” (used to check the step is done)" oninput="wfEditStepTitle('${id}','${w.id}',${i},this.value)">
        <button type="button" class="wf-del" title="Remove step" aria-label="Remove step" onclick="wfRemoveStep('${id}','${w.id}',${i})">${ICON.close}</button>
      </div>
      <input type="text" class="wf-step-cmd" spellcheck="false" value="${esc(s.command)}" placeholder="/feature_dev {url}" oninput="wfEditStepCommand('${id}','${w.id}',${i},this.value)">
    </div>`).join('');
}

export function wfNew(id) {
  const list = wfList(id);
  list.push({ id: _rid(), name: `Workflow ${list.length + 1}`, cli: 'claude', steps: [_emptyStep()] });
  loadProjectWorkflows(id);
}
export function wfDelete(id, wfId) {
  const list = wfList(id);
  const i = list.findIndex(w => w.id === wfId);
  if (i >= 0) list.splice(i, 1);
  loadProjectWorkflows(id);
}
export function wfSetName(id, wfId, val) { const w = wfGet(id, wfId); if (w) w.name = val; }
export function wfSetCli(id, wfId, cli) {
  const w = wfGet(id, wfId);
  if (!w) return;
  w.cli = cli === 'codex' ? 'codex' : 'claude';
  document.querySelector(`#proj-workflows-${id} .wf-card[data-wf="${wfId}"]`)
    ?.querySelectorAll('.wf-cli').forEach(b => b.classList.toggle('on', b.classList.contains(`wf-cli-${w.cli}`)));
  wfPreview(id, wfId);
}
export function wfAddStep(id, wfId) { const w = wfGet(id, wfId); if (w) { w.steps.push(_emptyStep()); wfRedrawSteps(id, wfId); } }
export function wfRemoveStep(id, wfId, i) {
  const w = wfGet(id, wfId);
  if (!w) return;
  w.steps.splice(i, 1);
  if (!w.steps.length) w.steps.push(_emptyStep());
  wfRedrawSteps(id, wfId);
}
export function wfEditStepCommand(id, wfId, i, val) { const w = wfGet(id, wfId); if (w?.steps[i]) { w.steps[i].command = val; wfPreview(id, wfId); } }
export function wfEditStepTitle(id, wfId, i, val) { const w = wfGet(id, wfId); if (w?.steps[i]) { w.steps[i].title = val; wfPreview(id, wfId); } }
function wfRedrawSteps(id, wfId) {
  const el = document.getElementById(`wf-steps-${id}-${wfId}`);
  const w = wfGet(id, wfId);
  if (el && w) el.innerHTML = wfStepsHtml(id, w);
  wfPreview(id, wfId);
}

// Live, client-side preview: resolve placeholders against a sample item and list the steps the
// run would take (worktree → launch CLI → each command + Enter). No server round-trip needed.
export function wfPreview(id, wfId) {
  const el = document.getElementById(`wf-preview-${id}-${wfId}`);
  if (!el) return;
  const w = wfGet(id, wfId);
  if (!w) return;
  const ctx = wfSampleCtx(proj(id));
  const steps = w.steps.filter(s => s.command.trim());
  if (!steps.length) { el.className = 'wf-preview'; el.innerHTML = ''; return; }
  const rows = [
    `<div class="wf-pv"><span class="wf-arr">›</span><span>create worktree <span class="wf-mut">${esc(ctx.branch)}</span></span></div>`,
    `<div class="wf-pv"><span class="wf-arr">›</span><span>launch <span class="wf-cli-name wf-cli-name-${w.cli}">${esc(w.cli)}</span></span></div>`,
    ...steps.map(s => `<div class="wf-pv"><span class="wf-arr">›</span><span>${esc(resolvePlaceholders(s.command, ctx))}</span><span class="wf-ent">⏎</span></div>` +
      (s.title.trim() ? `<div class="wf-pv-goal">done when: ${esc(resolvePlaceholders(s.title, ctx))}</div>` : '')),
  ];
  el.className = 'wf-preview ok';
  el.innerHTML = `<div class="wf-pv-head">Preview <span class="wf-pv-key">${esc(ctx.key)}</span></div><div class="wf-pv-body">${rows.join('')}</div>`;
}

export async function saveWorkflows(id) {
  const workflows = wfList(id).map(w => ({
    id: w.id,
    name: (w.name || '').trim() || 'Untitled workflow',
    cli: w.cli,
    steps: w.steps
      .map(s => ({ title: s.title.trim(), command: s.command.trim() }))
      .filter(s => s.command),
  }));
  try {
    await apiJson(ROUTES.project(id), 'PUT', { workflows });
    delete _wfBuf[id];                              // reseed from the saved (sanitized) state
    toast('Workflows saved');
    renderProjectNav(await api(ROUTES.PROJECTS));   // refresh store/sidebar (same path as the webhook save)
    loadProjectWorkflows(id);
  } catch (e) { toastErr(e.message); }
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
