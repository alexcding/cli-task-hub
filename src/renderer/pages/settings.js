// Settings page: config form + DB inspector, grouped into horizontal tabs.
import { ROUTES } from '/shared/routes.mjs';
import { state } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { esc, timeAgo, setActiveSegTab } from '../lib/util.js';
import { toast, toastErr } from '../components/toast.js';
import { renderProjectNav, applySidebarGroupUI } from '../components/sidebar.js';
import { GIT_CLIENTS, resolveGitClientCmd } from '../lib/git-clients.js';
import { updateGitClient } from '../components/viewer.js';

export async function loadSettings() {
  const [cfg, dbinfo, settings, sounds] = await Promise.all([
    api(ROUTES.CONFIG), api(ROUTES.DB), api(ROUTES.SETTINGS), api(ROUTES.SOUNDS),
  ]);

  populateSoundPicker(sounds, settings?.reviewSound);
  setActivityNotifyUI(settings?.activityNotify !== 'off'); // default on when unset
  applySidebarGroupUI(); // reflect the persisted sidebar-grouping choice on its toggle
  populateGitClientPicker(settings);

  if (cfg.poll_interval)      document.getElementById('poll-interval').value = cfg.poll_interval;
  if (cfg.jira_base_url)      document.getElementById('jira-base-url').value = cfg.jira_base_url;
  if (cfg.sprint_jql)         document.getElementById('sprint-jql').value = cfg.sprint_jql;
  // Show the auto-detected site as the placeholder so it's clear what's in effect.
  api(ROUTES.JIRA_SITE).then(s => { if (s.baseUrl) document.getElementById('jira-base-url').placeholder = `${s.baseUrl} (auto-detected)`; }).catch(()=>{});
  if (cfg.jira_poll_interval) document.getElementById('jira-poll-interval').value = cfg.jira_poll_interval;
  if (cfg.jira_limit)         document.getElementById('jira-limit').value = cfg.jira_limit;
  if (cfg.jira_api_token)     document.getElementById('jira-api-token').value = cfg.jira_api_token;

  renderDbInspector(dbinfo);
  initUsage();
  initAutostart();
  loadHookStatus();
  // CLI detection spawns a process per CLI, so run it lazily — only when the CLIs tab is the one
  // on screen (e.g. returning to Settings with it already active). Switching to it also triggers it.
  if (document.getElementById('settings-tab-clis')?.classList.contains('active')) loadCliTools();
}

// ── CLI detection (Settings → CLIs) ─────────────────────────────────────────────
// Show whether each CLI TaskHub drives is on the user's PATH, so a missing binary
// explains an empty feed. Server probes with `<bin> --version` (see services/cli-tools.js).
const CLI_IDS = ['claude', 'codex', 'gh', 'acli'];
// The login command we point users at when a present CLI is signed out — shown as the pill's tooltip.
const LOGIN_CMD = { gh: 'gh auth login', acli: 'acli jira auth login' };
// Each row's pill reflects the worst-known state: missing → not signed in → ready. `authed` is
// undefined for the agent CLIs (no auth probe), where presence alone is the full story.
function renderCliStatus(id, info) {
  const present = !!info?.present;
  const pill = document.getElementById(`cli-status-${id}`);
  if (pill) {
    let text, cls, title = '';
    if (!present)                   { text = 'Not found';     cls = ''; }
    else if (info.authed === false) { text = 'Not signed in'; cls = ' warn'; title = `Run \`${LOGIN_CMD[id] || ''}\` in a terminal to sign in`; }
    else                            { text = 'Installed';     cls = ' on'; }
    pill.textContent = text;
    pill.className = `hook-pill${cls}`;
    if (title) pill.title = title; else pill.removeAttribute('title');
  }
  // gh/acli rows carry an "Install" help link (→ official docs); show it only when missing.
  const link = document.getElementById(`cli-install-${id}`);
  if (link) link.hidden = present;
}
export async function loadCliTools() {
  try {
    const d = await api(ROUTES.CLI_TOOLS);
    CLI_IDS.forEach(id => renderCliStatus(id, d[id]));
  } catch { /* not reachable (e.g. plain browser) — leave the pills as-is */ }
}

// ── Workflow hooks (Settings → CLIs) ────────────────────────────────────────────
// Install a "turn finished" hook into Claude Code / Codex so Workflows get a reliable
// signal. Separate concern from "is the CLI installed" (that's the CLI integration card
// above). The server merges idempotently and reports status; we reflect it on the pill + button.
const HOOK_LABEL = { claude: 'Claude Code', codex: 'Codex' };
function renderHookRow(cli, status) {
  const pill = document.getElementById(`hook-status-${cli}`);
  const btn = document.getElementById(`hook-btn-${cli}`);
  if (!btn) return;
  const installed = status === 'installed';
  if (pill) {
    pill.textContent = installed ? 'Installed' : 'Not installed';
    pill.className = `hook-pill${installed ? ' on' : ''}`;
  }
  btn.textContent = installed ? 'Remove hook' : 'Install hook';
  btn.className = `btn btn-sm ${installed ? 'btn-secondary' : 'btn-primary'}`;
  btn.dataset.installed = installed ? '1' : '';
}
export async function loadHookStatus() {
  try {
    const st = await api(ROUTES.AGENT_HOOKS);
    renderHookRow('claude', st.claude);
    renderHookRow('codex', st.codex);
  } catch { /* not reachable (e.g. plain browser) — leave the rows as-is */ }
}
export async function toggleHook(cli) {
  const installed = document.getElementById(`hook-btn-${cli}`)?.dataset.installed === '1';
  try {
    const r = await api(ROUTES.agentHook(cli), { method: installed ? 'DELETE' : 'POST' });
    renderHookRow('claude', r.status.claude);
    renderHookRow('codex', r.status.codex);
    toast(`${HOOK_LABEL[cli]} hook ${installed ? 'removed' : 'installed'}`);
  } catch (e) { toastErr(e.message); }
}

// Reveal/hide a password field — the eye button inside an .input-reveal wrapper toggles
// its sibling input between password and text.
export function toggleSecret(btn) {
  const input = btn.closest('.input-reveal')?.querySelector('input');
  if (!input) return;
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  btn.classList.toggle('on', reveal);
}

// Horizontal tab picker for the Settings panels. Panels live in
// index.html (#settings-tab-<name>); all fields stay in the DOM regardless of the
// active tab, so loadSettings() can populate them whether or not a panel is shown.
export function switchSettingsTab(tab, btn) {
  ['appearance','clis','jira','system'].forEach(t => {
    document.getElementById(`settings-tab-${t}`)?.classList.toggle('active', t === tab);
  });
  setActiveSegTab(btn);
  // Lazily probe the CLIs (process spawns + a network auth check) only when that tab is opened,
  // and re-probe on each visit so a just-completed install/login is reflected (no server cache).
  if (tab === 'clis') loadCliTools();
}

// ── Review sound ──────────────────────────────────────────────────────────────
// A dropdown of the macOS notification sounds (from /api/sounds). The chosen sound's
// path is stored as the `reviewSound` setting ('system' = the default Glass chime);
// main plays it on a new review request (see main/notifications.js).
function populateSoundPicker(sounds, current) {
  const sel = document.getElementById('review-sound');
  if (!sel) return;
  const opts = ['<option value="system">macOS default (Glass)</option>'];
  for (const s of (Array.isArray(sounds) ? sounds : [])) opts.push(`<option value="${esc(s.path)}">${esc(s.name)}</option>`);
  sel.innerHTML = opts.join('');
  // Fall back to the default if the saved sound is gone (e.g. a removed user sound).
  sel.value = current && [...sel.options].some(o => o.value === current) ? current : 'system';
}

export async function setReviewSound(value) {
  try {
    await apiJson(ROUTES.settingsKey('reviewSound'), 'PUT', { value });
    previewReviewSound(); // play the new choice as confirmation
  } catch (e) { toastErr(e.message); }
}

// Preview through main (afplay) — the same path the live notification uses, so the
// macOS sound (which the sandboxed renderer can't decode/serve) plays identically.
// Plays only in the desktop app; in a plain browser there's no main process to reach,
// so say so rather than failing silently. Surfaces afplay errors too.
export function previewReviewSound() {
  const value = document.getElementById('review-sound')?.value || 'system';
  if (!window.taskhub?.previewSound) { toastErr('Sound preview is only available in the desktop app'); return; }
  Promise.resolve(window.taskhub.previewSound(value)).catch(e => toastErr('Preview failed: ' + (e?.message || e)));
}

// ── Git client ──────────────────────────────────────────────────────────────────
// The viewer's split bar gets an "Open in git client" button when a client is chosen here.
// Built-in presets fill the command field from GIT_CLIENTS; "Custom…" lets the user author
// their own command/deeplink (with a {path} placeholder). Both `gitClient` (id) and
// `gitClientCmd` (template) are persisted; main runs the template (see native/git-client.js).
function populateGitClientPicker(settings) {
  const sel = document.getElementById('git-client');
  if (!sel) return;
  const opts = ['<option value="">None</option>'];
  for (const c of GIT_CLIENTS) opts.push(`<option value="${esc(c.id)}">${esc(c.label)}</option>`);
  opts.push('<option value="custom">Custom…</option>');
  sel.innerHTML = opts.join('');
  const id = settings?.gitClient || '';
  sel.value = [...sel.options].some(o => o.value === id) ? id : '';
  document.getElementById('git-client-cmd').value = settings?.gitClientCmd || '';
  reflectGitClientRow(sel.value);
}

// The editable command field is shown only for "Custom…"; presets use their built-in template.
function reflectGitClientRow(id) {
  const row = document.getElementById('git-client-cmd-row');
  if (row) row.hidden = id !== 'custom';
}

// Choose a client. We persist only the id (`gitClient`) — the command for a preset is derived
// from GIT_CLIENTS at use time, and the custom template lives under `gitClientCmd` (written by
// setGitClientCmd). One write, so the stored id and command can't drift; switching to a preset
// leaves the user's custom template intact for when they switch back. The cmd input keeps its
// own (custom) text — for a preset its placeholder previews the built-in template.
export async function setGitClient(id) {
  reflectGitClientRow(id);
  const customCmd = document.getElementById('git-client-cmd')?.value.trim() || '';
  try {
    await apiJson(ROUTES.settingsKey('gitClient'), 'PUT', { value: id });
    updateGitClient(id, resolveGitClientCmd(id, customCmd)); // refresh the chip now, not on next tab activate
  } catch (e) { toastErr(e.message); }
}

// Persist the custom command template (fires on change/blur, so not per keystroke). Only
// reachable while "Custom…" is selected (the field is hidden otherwise).
export async function setGitClientCmd(cmd) {
  const value = (cmd || '').trim();
  try {
    await apiJson(ROUTES.settingsKey('gitClientCmd'), 'PUT', { value });
    updateGitClient('custom', value);
  } catch (e) { toastErr(e.message); }
}

// ── Activity notifications ──────────────────────────────────────────────────────
// On = a focused window toasts each new activity entry; the tray fires a native macOS
// notification when the window isn't focused. The main process is the single decider for
// both (see src/main/app/main.js) and reads this `activityNotify` setting ('on'/'off') —
// the renderer only persists it here, so there's one source of truth, not a mirrored copy.
function setActivityNotifyUI(on) {
  document.querySelectorAll('#activity-notify-toggle .theme-opt')
    .forEach(b => b.classList.toggle('active', (b.dataset.notifyOpt === 'on') === on));
}

export async function setActivityNotify(on) {
  try {
    await apiJson(ROUTES.settingsKey('activityNotify'), 'PUT', { value: on ? 'on' : 'off' });
    setActivityNotifyUI(on);           // reflect the toggle only once it's actually persisted
    window.taskhub?.refreshTray?.();   // let the tray re-read the setting now, not on its next tick
  } catch (e) { toastErr(e.message); }
}

// ── Launch at login ───────────────────────────────────────────────────────────
// The login-item state is owned by macOS (a LaunchAgent the host manages), not the settings
// DB — so we read it live from window.taskhub.autostart and write straight back, with no server
// round-trip and no mirrored copy to drift. Desktop-only: in a plain browser the bridge is
// absent, so the card stays hidden (like the usage card).
function setAutostartUI(on) {
  document.querySelectorAll('#autostart-toggle .theme-opt')
    .forEach(b => b.classList.toggle('active', (b.dataset.autostartOpt === 'on') === on));
}

async function initAutostart() {
  const card = document.getElementById('autostart-card');
  if (!card) return;
  if (!window.taskhub?.autostart) { card.hidden = true; return; } // plain browser — not available
  try { setAutostartUI(await window.taskhub.autostart.get()); card.hidden = false; }
  catch { card.hidden = true; } // couldn't read the OS state — don't show a toggle we can't trust
}

export async function setAutostart(on) {
  try {
    // set() echoes back the OS's actual resulting state, so reflect that — not the request.
    setAutostartUI(await window.taskhub.autostart.set(on));
  } catch (e) { toastErr(e.message); }
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
      <td>${esc(p.name)}</td>
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
    await api(ROUTES.project(id), {method:'DELETE'});
    toast('Project deleted');
    const projects = await api(ROUTES.PROJECTS);
    renderProjectNav(projects);
    window.showPage('dashboard');
  } catch(e) { toastErr(e.message); }
}

export async function saveConfig() {
  try {
    await apiJson(ROUTES.CONFIG, 'POST', {
      poll_interval:      document.getElementById('poll-interval').value || '60',
      jira_base_url:      document.getElementById('jira-base-url').value.trim(), // blank = auto-detect
      sprint_jql:         document.getElementById('sprint-jql').value.trim() || 'assignee = currentUser() AND sprint is not EMPTY AND statusCategory != Done ORDER BY updated DESC',
      jira_poll_interval: document.getElementById('jira-poll-interval').value || '120',
      jira_limit:         document.getElementById('jira-limit').value || '100',
      jira_api_token:     document.getElementById('jira-api-token').value.trim(),
    });
    // Ticket links depend on the base URL — refresh it after a save.
    try { state.jiraBase = (await api(ROUTES.JIRA_SITE)).baseUrl || state.jiraBase; } catch {}
    // No client-side resync: the server refreshes the Jira feeds after a config change and
    // broadcasts jira-sync, which the active page reacts to (see routes/config.js).
    toast('Settings saved');
  } catch(e) { toastErr(e.message); }
}
