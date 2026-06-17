// Shared Jira UI: snapshot tables, ticket filters, the assigned-to-me feed, the
// per-project Jira tab, and the status-transition menu.
import { ROUTES } from '/shared/routes.mjs';
import { state, recordPendingMove, clearPendingMove, applyPendingMoves, reconcilePendingMoves } from '../stores/store.js';
import { api, apiJson, forceSync } from '../services/api.js';
import { esc, jiraUrl } from '../lib/util.js';
import { ICON } from '../lib/icons.js';
import { toast, toastErr } from '../components/toast.js';
import { renderDashboardSprint } from './dashboard.js';
import { renderScrumboard } from './scrumboard.js';

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
    await apiJson(ROUTES.settingsKey(cfgKey), 'PUT', { value: JSON.stringify(clean) });
  } catch(e) { toastErr(e.message); }
}

// ── Project Jira tab (the active project's saved JQL) ────────────────────────────
export async function loadProjectJira(id) {
  const tbody = document.getElementById(`proj-jira-${id}`);
  if (!tbody) return;
  try {
    // The per-project filter is seeded once from settings, then lives in memory — so only read
    // settings the first time. loadProjectJira runs on every open AND every sync; refetching
    // settings each time would be pure waste on the hot path.
    const needSettings = state.projJiraFilters[id] === undefined;
    const [snap, settings] = await Promise.all([api(ROUTES.projectJira(id)), needSettings ? api(ROUTES.SETTINGS) : null]);
    if (needSettings) state.projJiraFilters[id] = parseFilters(settings['ticket_filter_' + id]);
    reconcilePendingMoves(snap);
    state.projJiraSnap[id] = snap;
    rememberStatuses(snap.items);
    renderProjJiraFilter(id);
    renderProjJira(id);
  } catch(e) {
    // Record the error so the snapshot's state is consistent (the hero chip suppresses its
    // count on error instead of showing a misleading 0).
    state.projJiraSnap[id] = { items: [], error: e.message };
    tbody.innerHTML = jiraRow(esc(e.message), 'var(--danger)');
  }
}

export function renderProjJiraFilter(id) {
  const fEl = document.getElementById(`proj-jira-filter-${id}`);
  if (fEl) fEl.innerHTML = ticketFilterBar((state.projJiraSnap[id] || {}).items || [], state.projJiraFilters[id] || {}, k => `setProjJiraFilter('${id}', '${k}', this.value)`);
}

export function renderProjJira(id) {
  const tbody = document.getElementById(`proj-jira-${id}`);
  if (!tbody) return;
  const snap = state.projJiraSnap[id] || { items: [] };
  const items = applyPendingMoves(snap.items);  // overlay any sticky-optimistic status change
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

let _menuEl = null;
function closePopupMenu() {
  if (_menuEl) { _menuEl.remove(); _menuEl = null; }
  document.removeEventListener('click', onMenuOutside, true);
  document.removeEventListener('keydown', onMenuKey);
}
function onMenuOutside(e) { if (_menuEl && !_menuEl.contains(e.target)) closePopupMenu(); }
function onMenuKey(e) { if (e.key === 'Escape') closePopupMenu(); }

// A macOS-style popup menu anchored to `btn`. `items`: { label, danger?, onClick }.
// Shared by the status-transition and assignee menus (same look, same positioning).
function openPopupMenu(btn, headText, items) {
  const open = _menuEl;
  closePopupMenu();
  if (open) return;      // second click on the same trigger just closes it
  if (!items.length) return;

  const menu = document.createElement('div');
  menu.className = 'status-menu';
  const head = document.createElement('div');
  head.className = 'status-menu-head';
  head.textContent = headText;
  menu.appendChild(head);
  for (const it of items) {
    const item = document.createElement('button');
    item.className = 'status-menu-item' + (it.danger ? ' danger' : '');
    item.textContent = it.label;
    item.onclick = () => { closePopupMenu(); it.onClick(); };
    menu.appendChild(item);
  }
  document.body.appendChild(menu);

  const r = btn.getBoundingClientRect();
  // Flip above the button if it would overflow the viewport bottom.
  const below = r.bottom + menu.offsetHeight + 6 < window.innerHeight;
  menu.style.top  = window.scrollY + (below ? r.bottom + 4 : r.top - menu.offsetHeight - 4) + 'px';
  menu.style.left = Math.min(window.scrollX + r.left, window.scrollX + window.innerWidth - menu.offsetWidth - 8) + 'px';
  _menuEl = menu;
  setTimeout(() => {
    document.addEventListener('click', onMenuOutside, true);
    document.addEventListener('keydown', onMenuKey);
  }, 0);
}

export function openStatusMenu(btn) {
  const key = btn.dataset.key, current = btn.dataset.status;
  const targets = [...state.knownStatuses].filter(s => s !== current).sort();
  if (!targets.length) { toast('No other statuses known yet — open more tickets first.'); return; }
  openPopupMenu(btn, `Move ${key} to…`, targets.map(s => ({ label: s, onClick: () => doTransition(key, s) })));
}

// `statusId` is optional and only the Scrumboard passes it: its configured columns bucket
// by status id, so the local patch must move the id too (the status name alone wouldn't
// re-column the card). The Jira tables bucket by name and omit it.
//
// Optimistic-FIRST: the card moves before the (slow) acli round-trip, not after, via a sticky
// pending move (recordPendingMove) that every Jira view overlays and holds across the snapshot
// reloads each sync triggers — otherwise the next sync re-reads a still-stale snapshot and
// bounces the card back. The move carries a token so a rejected transition only reverts ITS OWN
// move: if the user has already re-moved the same ticket, clearPendingMove(seq) is a no-op and
// the newer move stands.
export async function doTransition(key, status, statusId) {
  const seq = recordPendingMove(key, status, statusId);
  rerenderActiveJira();
  try {
    await apiJson(ROUTES.jiraKeyTransition(key), 'POST', { transition: status });
    toast(`${key} → ${status}`);
  } catch(e) {
    clearPendingMove(key, seq);
    rerenderActiveJira();
    toastErr(e.message);
  }
}

// ── Jira assignee (assign menu) ──────────────────────────────────────────────────
// acli assigns by account id/email, so we offer the people already seen across loaded
// tickets (the sprint's roster), plus "Assign to me" and "Unassign". Reassigning to
// someone not yet on the board isn't offered (no user search) — pick from the roster.
function assigneeRoster() {
  const seen = new Map(); // accountId -> display name
  const add = snap => (snap?.items || []).forEach(i => { if (i.assigneeId && !seen.has(i.assigneeId)) seen.set(i.assigneeId, i.assignee || i.assigneeId); });
  add(state.boardSnap); add(state.sprintSnap);
  Object.values(state.projJiraSnap).forEach(add);
  return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function openAssignMenu(btn) {
  const key = btn.dataset.key, currentId = btn.dataset.assigneeId || '';
  const items = [{ label: 'Assign to me', onClick: () => doAssign(key, '@me', '', '') }];
  for (const p of assigneeRoster()) {
    if (p.id === currentId) continue;
    items.push({ label: p.name, onClick: () => doAssign(key, p.id, p.name, p.id) });
  }
  if (currentId) items.push({ label: 'Unassign', danger: true, onClick: () => doAssign(key, '', '', '') });
  openPopupMenu(btn, `Assign ${key}…`, items);
}

async function doAssign(key, assignee, name, id) {
  try {
    await apiJson(ROUTES.jiraKeyAssign(key), 'POST', { assignee });
    if (assignee === '@me') {
      toast(`${key} assigned to me`);
      forceSync(); // we don't know my Jira display name locally — let the next sync fill it
    } else {
      toast(assignee ? `${key} → ${name}` : `${key} unassigned`);
      applyAssigneeLocally(key, name, id); // optimistic — the next poll confirms
    }
  } catch(e) { toastErr(e.message); }
}

// Update the cached snapshots so the new status/assignee shows immediately, then
// re-render whichever view is active.
function rerenderActiveJira() {
  if (document.getElementById('page-dashboard')?.classList.contains('active')) renderDashboardSprint();
  if (document.getElementById('page-scrumboard')?.classList.contains('active')) renderScrumboard();
  if (state.activeProjectId && document.getElementById(`proj-jira-${state.activeProjectId}`)) { renderProjJiraFilter(state.activeProjectId); renderProjJira(state.activeProjectId); }
}
function patchSnaps(key, fn) {
  [state.sprintSnap, state.boardSnap, ...Object.values(state.projJiraSnap)]
    .forEach(snap => { const it = (snap?.items || []).find(i => i.key === key); if (it) fn(it); });
}
function applyAssigneeLocally(key, name, id) {
  patchSnaps(key, it => { it.assignee = name; it.assigneeId = id; });
  rerenderActiveJira();
}
