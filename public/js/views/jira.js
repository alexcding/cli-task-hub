// Shared Jira UI: snapshot tables, ticket filters, the assigned-to-me feed, the
// per-project Jira tab, and the status-transition menu.
import { state, setProjects } from '../store.js';
import { api, apiJson } from '../api.js';
import { esc, jiraUrl } from '../util.js';
import { ICON } from '../icons.js';
import { toast, toastErr } from '../toast.js';
import { renderDashboardSprint } from './dashboard.js';

// Shared 5-column row renderer for the snapshot-backed Jira tables (JIRA Tickets +
// per-project tab). `items` are lean tickets from the snapshot endpoints. The status
// cell is a button: clicking it opens a menu of the ticket's possible next statuses.
export function jiraRowsHtml(items) {
  return items.map(item => `<tr>
    <td><a class="link" href="${jiraUrl(item.key)}" target="_blank" onclick="jiraClick(event, this.href, '${esc(item.key)}')">${item.key}</a></td>
    <td>${esc(item.summary || '')}</td>
    <td><button class="badge badge-default status-btn" data-key="${esc(item.key)}" data-status="${esc(item.status || '')}" onclick="openStatusMenu(this)" title="Change status">${esc(item.status || '')} <span class="status-caret">${ICON.caret}</span></button></td>
    <td>${esc(item.type || '')}</td>
    <td>${esc(item.priority || '')}</td>
  </tr>`).join('');
}
export const jiraRow = (msg, color) => `<tr><td colspan="5"><div class="empty" style="padding:16px${color?`;color:${color}`:''}">${msg}</div></td></tr>`;

// Renders a snapshot ({items, lastSynced, error}) into a tbody. Shared by the
// project tab and My Tickets — both read the background-synced snapshot (SWR).
export function renderJiraSnapshot(tbody, snap, { emptyMsg } = {}) {
  if (!tbody) return;
  const items = snap?.items || [];
  if (snap?.error && !items.length) { tbody.innerHTML = jiraRow(esc(snap.error), 'var(--danger)'); return; }
  if (!items.length) { tbody.innerHTML = jiraRow(emptyMsg || 'No tickets found.'); return; }
  tbody.innerHTML = jiraRowsHtml(items);
}

// ── Jira ticket filters (shared: JIRA Tickets page + project Jira tab) ────────────
// A "Filters" bar of compact dropdowns — project, status, type, priority. Filtering
// is AND across dimensions and faceted (each dropdown lists only the values still
// available given the other selections, with counts). Done client-side over the
// snapshot (instant), and the selection is persisted to the config store as JSON.
export const ticketProjectOf = key => (key || '').split('-')[0];

const TICKET_FILTERS = [
  { key: 'project',  label: 'projects',   valueOf: i => ticketProjectOf(i.key) },
  { key: 'status',   label: 'statuses',   valueOf: i => i.status },
  { key: 'type',     label: 'types',      valueOf: i => i.type },
  { key: 'priority', label: 'priorities', valueOf: i => i.priority },
];

// Parse a saved filter value: JSON object, or a legacy bare/comma project string.
export function parseFilters(raw) {
  if (!raw) return {};
  try { const o = JSON.parse(raw); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch {}
  return { project: String(raw).split(',')[0].trim() };
}

// Items matching every active filter except `exceptKey` (used for faceted lists).
export function itemsMatching(items, filters, exceptKey) {
  return items.filter(i => TICKET_FILTERS.every(f =>
    f.key === exceptKey || !filters[f.key] || f.valueOf(i) === filters[f.key]));
}

// Build the "Filters" bar. `onchangeFor(dimKey)` returns the JS expr run on change.
// A dimension's dropdown is shown only when it offers a real choice (2+ values) or
// already has a selection (so it can be cleared). `valuesByKey` lets a caller fix a
// dimension's option list explicitly (e.g. the project dropdown lists the Jira keys
// you've configured on your projects, not whatever keys happen to be in the tickets).
export function ticketFilterBar(items, filters, onchangeFor, valuesByKey = {}) {
  if (!items.length) return '';
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
  const selects = TICKET_FILTERS.map(f => {
    const fixed = Array.isArray(valuesByKey[f.key]) && valuesByKey[f.key].length; // explicit option list
    const base = itemsMatching(items, filters, f.key);
    const values = fixed ? valuesByKey[f.key] : [...new Set(base.map(f.valueOf).filter(Boolean))].sort();
    const cur = filters[f.key] || '';
    // A dimension with a fixed list (e.g. your configured Jira project keys) always shows;
    // a derived dimension shows only when it offers a real choice or already has a selection.
    if (!fixed && values.length < 2 && !cur) return '';
    return `<select class="filter-select" onchange="${onchangeFor(f.key)}">` +
      opt('', `All ${f.label}`, !cur) +
      values.map(v => opt(v, `${v} (${base.filter(i => f.valueOf(i) === v).length})`, cur === v)).join('') +
    `</select>`;
  }).filter(Boolean);
  return selects.length ? `<span class="filter-label">Filters</span>` + selects.join('') : '';
}

// Persist only the active (non-empty) dimensions, as JSON, in taskhub.db's settings
// table (same store as tabs/theme — these are UI prefs, not source-of-truth config).
async function persistFilters(cfgKey, filters) {
  const clean = {};
  for (const f of TICKET_FILTERS) if (filters[f.key]) clean[f.key] = filters[f.key];
  try {
    await apiJson('/api/settings/' + encodeURIComponent(cfgKey), 'PUT', { value: JSON.stringify(clean) });
  } catch(e) { toastErr(e.message); }
}

// ── JIRA Tickets (assigned-to-me feed) ──────────────────────────────────────────
// Jira project keys across all configured projects (uppercased, deduped). Each project's
// key lives in its own record.
function projectJiraKeys() {
  return new Set((state.projects || []).map(p => (p.jiraProjectKey || '').toUpperCase()).filter(Boolean));
}

// The assigned-to-me feed scoped to the projects you've added: when any project declares a
// Jira key, only tickets in those projects are shown (union). With none set, nothing is hidden.
function scopedMineItems() {
  const items = state.mineSnap.items || [];
  const keys = projectJiraKeys();
  return keys.size ? items.filter(i => keys.has(ticketProjectOf(i.key).toUpperCase())) : items;
}

export async function loadMyTickets() {
  const tbody = document.getElementById('mytickets-body');
  if (!tbody) return;
  try {
    // Projects fetched alongside so the per-project Jira-key scoping is current even if the
    // dashboard hasn't loaded yet this session.
    const [snap, settings, projects] = await Promise.all([api('/api/jira/mine'), api('/api/settings'), api('/api/projects')]);
    setProjects(projects);
    if (state.ticketFilters === null) state.ticketFilters = parseFilters(settings.my_ticket_filters);
    state.mineSnap = snap;
    rememberStatuses(snap.items);
    renderMyTicketsFilter();
    renderMyTickets();
  } catch(e) { tbody.innerHTML = jiraRow(esc(e.message), 'var(--danger)'); }
}

export function renderMyTicketsFilter() {
  const el = document.getElementById('mytickets-filter');
  // The project dropdown lists only the Jira keys configured on your projects.
  if (el) el.innerHTML = ticketFilterBar(scopedMineItems(), state.ticketFilters,
    k => `setTicketFilter('${k}', this.value)`, { project: [...projectJiraKeys()].sort() });
}

export function renderMyTickets() {
  const tbody = document.getElementById('mytickets-body');
  if (!tbody) return;
  const items = scopedMineItems();
  const filtered = itemsMatching(items, state.ticketFilters, null);
  const emptyMsg = items.length ? 'No tickets match these filters.' : 'No tickets in your projects assigned to you.';
  renderJiraSnapshot(tbody, { items: filtered, error: items.length ? null : state.mineSnap.error, lastSynced: state.mineSnap.lastSynced }, { emptyMsg });
}

export async function setTicketFilter(key, value) {
  state.ticketFilters[key] = value;
  renderMyTicketsFilter(); // faceted options shift with each selection
  renderMyTickets();
  await persistFilters('my_ticket_filters', state.ticketFilters);
}

// ── Project Jira tab (the active project's saved JQL) ────────────────────────────
export async function loadProjectJira(id) {
  const tbody = document.getElementById(`proj-jira-${id}`);
  if (!tbody) return;
  try {
    const [snap, settings] = await Promise.all([api(`/api/projects/${id}/jira`), api('/api/settings')]);
    if (state.projJiraFilters[id] === undefined) state.projJiraFilters[id] = parseFilters(settings['ticket_filter_' + id]);
    state.projJiraSnap[id] = snap;
    rememberStatuses(snap.items);
    renderProjJiraFilter(id);
    renderProjJira(id);
  } catch(e) { tbody.innerHTML = jiraRow(esc(e.message), 'var(--danger)'); }
}

export function renderProjJiraFilter(id) {
  const fEl = document.getElementById(`proj-jira-filter-${id}`);
  if (fEl) fEl.innerHTML = ticketFilterBar((state.projJiraSnap[id] || {}).items || [], state.projJiraFilters[id] || {}, k => `setProjJiraFilter('${id}', '${k}', this.value)`);
}

export function renderProjJira(id) {
  const tbody = document.getElementById(`proj-jira-${id}`);
  if (!tbody) return;
  const snap = state.projJiraSnap[id] || { items: [] };
  const items = snap.items || [];
  const filtered = itemsMatching(items, state.projJiraFilters[id] || {}, null);
  const emptyMsg = !snap.jql ? 'Set a Jira project key or JQL in this project’s settings.'
    : items.length ? 'No tickets match these filters.' : 'No Jira items found.';
  renderJiraSnapshot(tbody, { items: filtered, error: items.length ? null : snap.error, lastSynced: snap.lastSynced }, { emptyMsg });
}

export async function setProjJiraFilter(id, key, value) {
  if (!state.projJiraFilters[id]) state.projJiraFilters[id] = {};
  state.projJiraFilters[id][key] = value;
  renderProjJiraFilter(id);
  renderProjJira(id);
  await persistFilters('ticket_filter_' + id, state.projJiraFilters[id]);
}

// ── Jira transition (status menu) ───────────────────────────────────────────────
// acli can't list a ticket's real transitions, so we offer the workflow statuses
// seen across loaded tickets (minus the current one). acli validates the move on
// submit and surfaces an error if it isn't a permitted transition.
export const rememberStatuses = items => (items || []).forEach(i => { if (i.status) state.knownStatuses.add(i.status); });

let _statusMenuEl = null;
function closeStatusMenu() {
  if (_statusMenuEl) { _statusMenuEl.remove(); _statusMenuEl = null; }
  document.removeEventListener('click', onStatusMenuOutside, true);
  document.removeEventListener('keydown', onStatusMenuKey);
}
function onStatusMenuOutside(e) { if (_statusMenuEl && !_statusMenuEl.contains(e.target)) closeStatusMenu(); }
function onStatusMenuKey(e) { if (e.key === 'Escape') closeStatusMenu(); }

export function openStatusMenu(btn) {
  const open = _statusMenuEl;
  closeStatusMenu();
  if (open) return; // second click on the same trigger just closes it
  const key = btn.dataset.key, current = btn.dataset.status;
  const targets = [...state.knownStatuses].filter(s => s !== current).sort();
  if (!targets.length) { toast('No other statuses known yet — open more tickets first.'); return; }

  const menu = document.createElement('div');
  menu.className = 'status-menu';
  const head = document.createElement('div');
  head.className = 'status-menu-head';
  head.textContent = `Move ${key} to…`;
  menu.appendChild(head);
  for (const s of targets) {
    const item = document.createElement('button');
    item.className = 'status-menu-item';
    item.textContent = s;
    item.onclick = () => { closeStatusMenu(); doTransition(key, s); };
    menu.appendChild(item);
  }
  document.body.appendChild(menu);

  const r = btn.getBoundingClientRect();
  // Flip above the button if it would overflow the viewport bottom.
  const below = r.bottom + menu.offsetHeight + 6 < window.innerHeight;
  menu.style.top  = window.scrollY + (below ? r.bottom + 4 : r.top - menu.offsetHeight - 4) + 'px';
  menu.style.left = Math.min(window.scrollX + r.left, window.scrollX + window.innerWidth - menu.offsetWidth - 8) + 'px';
  _statusMenuEl = menu;
  setTimeout(() => {
    document.addEventListener('click', onStatusMenuOutside, true);
    document.addEventListener('keydown', onStatusMenuKey);
  }, 0);
}

async function doTransition(key, status) {
  try {
    await apiJson(`/api/jira/${key}/transition`, 'POST', { transition: status });
    toast(`${key} → ${status}`);
    applyStatusLocally(key, status); // optimistic — the next poll confirms
  } catch(e) { toastErr(e.message); }
}

// Update the cached snapshots so the new status shows immediately, then re-render
// whichever view is active.
function applyStatusLocally(key, status) {
  state.knownStatuses.add(status);
  const patch = snap => { const it = (snap?.items || []).find(i => i.key === key); if (it) it.status = status; };
  patch(state.mineSnap);
  patch(state.sprintSnap);
  Object.values(state.projJiraSnap).forEach(patch);
  if (document.getElementById('page-dashboard')?.classList.contains('active')) renderDashboardSprint();
  if (document.getElementById('page-mytickets')?.classList.contains('active')) { renderMyTicketsFilter(); renderMyTickets(); }
  if (state.activeProjectId && document.getElementById(`tab-jira-${state.activeProjectId}`)?.classList.contains('active')) { renderProjJiraFilter(state.activeProjectId); renderProjJira(state.activeProjectId); }
}
