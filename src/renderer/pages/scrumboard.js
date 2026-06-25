// Scrum board page: the active sprint of a chosen project's Jira board (every assignee),
// rendered as columns by status — a native mirror of a Jira software board. The top-left
// tabs are your configured projects that have a Jira key; clicking one switches boards.
// Each project's board is scoped to its component (e.g. iOS) when one is set, so a
// per-platform project shows just that swimlane. The feed is the project's `board:<id>`
// snapshot (ROUTES.PROJECT_BOARD) — fetched via acli like every other Jira view.
import { ROUTES } from '/shared/routes.mjs';
import { state, setProjects, projectById, applyPendingMoves, reconcilePendingMoves } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { esc, escJs, jiraUrl, businessDaysUntil } from '../lib/util.js';
import { ICON, ISSUE_ICON } from '../lib/icons.js';
import { toast, toastErr } from '../components/toast.js';
import { rememberStatuses, doTransition } from './jira.js';

// Status workflow categories, ordered left→right so the board reads To Do → In Progress
// → Done. acli reports `statusCategory` as one of these keys; an unknown/blank category
// sorts in the middle (alongside In Progress).
const CAT_RANK = { new: 0, indeterminate: 1, done: 2 };

// Centered loading state for the board area (not pinned top-left).
const BOARD_LOADING = `<div class="board-loading"><div class="spinner"></div> Loading…</div>`;

// Up to two initials for the assignee avatar chip ("Alex Ding" → "AD", "alex" → "AL").
function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const a = parts[0][0] || '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : parts[0][1] || '';
  return (a + b).toUpperCase();
}

// Projects eligible for a board tab: those with a Jira key configured.
const boardProjects = () => (state.projects || []).filter(p => p.jiraProjectKey);

// Issue-type key, normalised (sub-tasks reuse the task mark).
const typeKey = (it) => {
  const k = (it.type || '').toLowerCase().trim();
  return (k === 'sub-task' || k === 'subtask') ? 'task' : k;
};
// The Jira-style type icon, shown before the key in the card header. Unknown types fall
// back to their name as a small muted label (so the type is never lost).
function typeIcon(it) {
  const key = typeKey(it);
  if (ISSUE_ICON[key]) return `<span class="board-type type-${key}" title="${esc(it.type)}">${ISSUE_ICON[key]}</span>`;
  return it.type ? `<span class="board-card-meta">${esc(it.type)}</span>` : '';
}
// Priority → chevron count: 3 (high), 2 (medium), 1 (low), or 0 (none/unknown). Checked
// highest/lowest before high/low so "Highest" doesn't match the "high" rule.
function prioCount(p) {
  const s = (p || '').toLowerCase();
  if (/highest|high|blocker|critical|urgent|major/.test(s)) return 3;
  if (/medium|normal/.test(s)) return 2;
  if (/lowest|low|minor|trivial/.test(s)) return 1;
  return 0;
}
// Stacked up-chevrons by level: 3 = high, 2 = medium, 1 = low (each subpath is one chevron,
// stacked bottom→top, vertically centred in the 14×14 box so all variants align).
const PRIO_CHEVRONS = {
  3: 'M4 11 7 8 10 11M4 8 7 5 10 8M4 5 7 2 10 5',
  2: 'M4 9.5 7 6.5 10 9.5M4 6.5 7 3.5 10 6.5',
  1: 'M4 8 7 5 10 8',
};
// The priority indicator shown right after the ticket number: stacked chevrons coloured by
// level (3=high red, 2=medium amber, 1=low grey). Empty when the ticket has no priority;
// the exact Jira priority shows on hover.
function prioMark(it) {
  const n = prioCount(it.priority);
  if (!n) return '';
  const lvl = n === 3 ? 'high' : n === 2 ? 'medium' : 'low';
  return `<span class="board-prio prio-${lvl}" title="${esc(it.priority)} priority"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${PRIO_CHEVRONS[n]}"/></svg></span>`;
}

// Accept a freshly-fetched board snapshot: release any optimistic moves the server has now
// confirmed (reconcilePendingMoves), store it, learn its statuses, and re-render. One helper so
// the three fetch paths (load / switch project / change filter) can't drift — and so the reconcile
// can never be forgotten on a fetch path.
function acceptBoardSnap(snap) {
  reconcilePendingMoves(snap);
  state.boardSnap = snap;
  rememberStatuses(snap.items);
  renderScrumboardQuery();
  renderScrumboard();
}

export async function loadScrumboard() {
  const body = document.getElementById('scrumboard-body');
  if (!body) return;
  try {
    // Settings carry the per-project saved assignee filter (board_filter_<id>). The
    // my-sprint feed lets us highlight my own cards on the team board (non-blocking now
    // that acli is async).
    const [projects, settings, sprintSnap] = await Promise.all([
      api(ROUTES.PROJECTS), api(ROUTES.SETTINGS), api(ROUTES.JIRA_SPRINT).catch(() => null),
    ]);
    setProjects(projects);
    if (sprintSnap) state.sprintSnap = sprintSnap;
    const boardable = boardProjects();
    for (const p of boardable) state.boardFilters[p.id] = settings[`board_filter_${p.id}`] || '';
    // Active project: the remembered one if it still has a board, else the first.
    let id = state.boardProjectId;
    if (!boardable.some(p => p.id === id)) id = boardable[0]?.id || '';
    state.boardProjectId = id;
    renderScrumboardTabs();

    if (!id) {
      setTitle(null);
      body.innerHTML = `<div class="empty" style="padding:16px;color:var(--text-3)">No projects with a Jira key yet. Add one (with an optional component like iOS) to see its board.</div>`;
      return;
    }
    const snap = await api(ROUTES.projectBoard(id));
    if (state.boardProjectId !== id) return; // switched away while this was in flight
    acceptBoardSnap(snap);
  } catch (e) {
    body.innerHTML = `<div class="empty" style="padding:16px;color:var(--danger)">${esc(e.message)}</div>`;
  }
}

// Switch the board to another project (top-left tab click).
export async function setBoardProject(id) {
  if (id === state.boardProjectId && (state.boardSnap.items || []).length) return;
  state.boardProjectId = id;
  renderScrumboardTabs();
  const body = document.getElementById('scrumboard-body');
  if (body) body.innerHTML = BOARD_LOADING;
  try {
    const snap = await api(ROUTES.projectBoard(id));
    if (state.boardProjectId !== id) return; // switched again while this was in flight
    acceptBoardSnap(snap);
  } catch (e) { toastErr(e.message); }
}

// Top-left project picker: a dropdown of the board-capable projects (those with a Jira
// key). Selecting one switches the board. Labelled by project name, with the Jira key
// shown when it differs.
export function renderScrumboardTabs() {
  const el = document.getElementById('scrumboard-tabs');
  if (!el) return;
  const projects = boardProjects();
  if (!projects.length) { el.innerHTML = ''; return; }
  const label = p => {
    const name = p.name || p.jiraProjectKey;
    return p.jiraProjectKey && p.jiraProjectKey !== name ? `${name} (${p.jiraProjectKey})` : name;
  };
  const opt = p => `<option value="${esc(p.id)}" ${p.id === state.boardProjectId ? 'selected' : ''}>${esc(label(p))}</option>`;
  el.innerHTML = `<span class="filter-label">Project</span>
    <select class="filter-select" onchange="setBoardProject(this.value)">${projects.map(opt).join('')}</select>`;
}

function setTitle(snap) {
  // The active sprint's name + days left — the topbar already shows "Scrumboard", so no
  // placeholder when there's no sprint. textContent (not innerHTML) so no escaping needed.
  const el = document.getElementById('scrumboard-title');
  if (!el) return;
  const s = snap?.sprint;
  if (!s?.name) { el.textContent = ''; return; }
  const days = s.endDate ? businessDaysUntil(s.endDate) : 0;
  el.textContent = days > 0 ? `${s.name} · ${days}d left` : s.name;
}

// The board's free-form filter: a JQL clause (e.g. `component = iOS`) ANDed into the
// sprint query, saved per project. Rendered only on load/switch (not on every re-render)
// so typing isn't clobbered by a background refresh. Submits on Enter / blur.
export function renderScrumboardQuery() {
  const el = document.getElementById('scrumboard-query');
  if (!el) return;
  if (!state.boardProjectId) { el.innerHTML = ''; return; }
  const cur = state.boardSnap?.query || '';
  el.innerHTML = `<span class="filter-label">Filter</span>
    <input id="scrumboard-query-input" class="board-query-input" type="text" value="${esc(cur)}" placeholder="e.g. component = iOS"
      title="A JQL clause ANDed into the sprint (blank = whole sprint)"
      onkeydown="if(event.key==='Enter'){event.preventDefault();applyBoardQuery();}">
    <button class="btn btn-secondary btn-sm" onclick="applyBoardQuery()">Go</button>`;
}

// Triggered by the Filter field's Go button / Enter — read the input and apply it.
export function applyBoardQuery() {
  const inp = document.getElementById('scrumboard-query-input');
  if (inp) setBoardQuery(inp.value.trim());
}

export async function setBoardQuery(value) {
  const id = state.boardProjectId;
  if (!id || value === (state.boardSnap?.query || '')) return;
  const body = document.getElementById('scrumboard-body');
  if (body) body.innerHTML = BOARD_LOADING;
  try {
    // Stored in the config store (key board_query_<id>) — that's where the poller reads it
    // via db.get when building the board query, so it survives reloads/restarts.
    await apiJson(ROUTES.CONFIG, 'POST', { [`board_query_${id}`]: value });
    // The clause changes the server query, so re-fetch with ?refresh=1 (re-syncs first).
    const snap = await api(`${ROUTES.projectBoard(id)}?refresh=1`);
    if (state.boardProjectId !== id) return; // switched projects while this was in flight
    acceptBoardSnap(snap);
    toast(value ? 'Board filter saved' : 'Board filter cleared');
  } catch (e) { toastErr(e.message); }
}

// The assignee filter: All / Unassigned / each person on the board. The selection is
// saved per project (board_filter_<id>) so each board remembers its own filter.
export function renderScrumboardFilter() {
  const el = document.getElementById('scrumboard-filter');
  if (!el) return;
  const items = state.boardSnap?.items || [];
  const seen = new Map();        // accountId -> display name
  let hasUnassigned = false;
  for (const it of items) {
    if (it.assigneeId) seen.set(it.assigneeId, it.assignee || it.assigneeId);
    else hasUnassigned = true;
  }
  const cur = state.boardFilters[state.boardProjectId] || '';
  // Keep a selected person visible even if they currently have no cards (so it can be cleared).
  if (cur && cur !== '__unassigned__' && !seen.has(cur)) seen.set(cur, cur);
  const people = [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
  el.innerHTML = `<span class="filter-label">Assignee</span>
    <select class="filter-select" onchange="setBoardFilter(this.value)">
      ${opt('', 'All assignees', !cur)}
      ${hasUnassigned || cur === '__unassigned__' ? opt('__unassigned__', 'Unassigned', cur === '__unassigned__') : ''}
      ${people.map(p => opt(p.id, p.name, cur === p.id)).join('')}
    </select>`;
}

export async function setBoardFilter(value) {
  const id = state.boardProjectId;
  if (!id) return;
  state.boardFilters[id] = value;
  renderScrumboard();
  try { await apiJson(ROUTES.settingsKey(`board_filter_${id}`), 'PUT', { value }); }
  catch (e) { toastErr(e.message); }
}

// One board card: key (links to the ticket) + assignee chip, summary, then a footer with
// type/priority and a move control that reuses the shared status-transition menu
// (openStatusMenu reads data-key/data-status off the button). `mine` tickets get a subtle
// accent edge so your own work stands out on a team board. The card is drag-to-move via
// SortableJS (initBoardSort) — dropping it in another column transitions the ticket; the
// move dropdown stays as the precise path. `data-key` lets the drop handler read which card
// moved (the source column is the Sortable list it came from).
function boardCard(it, mine) {
  const key = esc(it.key || '');
  const keyJs = escJs(it.key || '');  // for the '…'-quoted args in inline on* handlers
  // The avatar is the assign control: click → assignee menu (openAssignMenu reads
  // data-key/data-assignee-id). Unassigned cards show a dashed "+" to invite assigning.
  // `mine` (assigned to me) tints the avatar with the Jira-capsule accent background.
  const av = `<button class="board-av${it.assignee ? '' : ' board-av-empty'}${mine ? ' board-av-mine' : ''}" data-key="${key}" data-assignee-id="${esc(it.assigneeId || '')}" onclick="openAssignMenu(this)" title="${it.assignee ? esc(it.assignee) : 'Assign'}">${it.assignee ? esc(initials(it.assignee)) : ICON.plus}</button>`;
  return `<div class="board-card" data-key="${key}">
    <div class="board-card-sum">${esc(it.summary || '')}</div>
    <div class="board-card-foot">
      ${typeIcon(it)}
      <a class="board-card-key" href="${jiraUrl(it.key)}" target="_blank" onclick="jiraClick(event, this.href, '${keyJs}')">${key}</a>
      ${prioMark(it)}
      ${av}
    </div>
    <button class="board-move" data-key="${key}" data-status="${esc(it.status || '')}" onclick="openStatusMenu(this)" title="Move ${key}">${ICON.caret}</button>
  </div>`;
}

// ── Drag-to-transition (SortableJS) ────────────────────────────────────────────────
// Each column body is a Sortable list sharing one group, so a card drags between columns.
// We use pointer-based SortableJS (the same lib the sidebar uses) rather than native HTML5
// drag-and-drop: Tauri's WKWebView enables an OS-level drag-drop handler that swallows HTML5
// drag events (and that handler is what routes file drops into the terminal — see bridge.js),
// so HTML5 DnD can't work here without breaking that. `sort:false` disables intra-column
// reordering (status only changes between columns); a cross-column drop reuses the shared
// doTransition (optimistic update + next-poll confirm) — exactly what the move dropdown calls.
let _boardSortables = [];
// True between a drag's start and end. renderScrumboard() bails while it's set: a live SSE sync
// re-runs loadScrumboard mid-drag, which would rebuild the board DOM and destroy the SortableJS
// instance being dragged — freezing the drag. The skipped snapshot still lands in state; the
// post-drag render (onEnd) catches up.
let _boardDragging = false;

// Ring/tint whichever column the drag is currently over. Cleared on drop/cancel (onEnd) and
// before each move so only one column lights up at a time.
function clearColHighlight() {
  document.querySelectorAll('.board-col-drop').forEach(el => el.classList.remove('board-col-drop'));
}

function initBoardSort() {
  _boardSortables.forEach(s => s.destroy());
  _boardSortables = [];
  if (typeof Sortable === 'undefined') return;
  document.querySelectorAll('#scrumboard-body .board-col-body').forEach(body => {
    _boardSortables.push(new Sortable(body, {
      group: 'board',
      draggable: '.board-card',
      sort: false,                                   // move between columns only — no reorder within
      animation: 150,
      // Force the mouse-driven fallback instead of SortableJS's default native HTML5-DnD backend:
      // WKWebView (Tauri) mangles native drag — the OS drag-drop handler swallows the events — so
      // native-backed onMove/ghost don't fire. The fallback runs entirely in JS (its own drag clone)
      // and is what makes the column highlight + placeholder work here.
      forceFallback: true,
      fallbackOnBody: true,                          // append the drag clone to <body> so it isn't clipped by a column
      // Clicks on the key link / avatar / move button must stay clicks, not start a drag.
      filter: '.board-card-key, .board-av, .board-move',
      preventOnFilter: false,
      ghostClass: 'board-card-ghost',                // the drop-placeholder shown in the target column
      // Light up the column under the pointer as the card moves over it (replaces the old
      // HTML5 dragover highlight). Returning nothing leaves the move allowed.
      onStart() { _boardDragging = true; },           // freeze board re-renders for the duration (see _boardDragging)
      onMove(evt) {
        clearColHighlight();
        evt.to?.closest('.board-col')?.classList.add('board-col-drop');
      },
      onEnd(evt) { _boardDragging = false; clearColHighlight(); onBoardDrop(evt); },
    }));
  });
}

// A card was dropped. `from`/`to` are the column bodies; same list ⇒ no status change. The
// target column carries its status on data-status/-id (blank for a never-seen empty column,
// which can't be a transition target). doTransition re-renders the board from state, which
// rebuilds the DOM Sortable mutated — so a rejected drop just snaps back on re-render.
function onBoardDrop(evt) {
  // Same column ⇒ no status change, but a sync may have been skipped mid-drag — re-render to catch up.
  if (evt.from === evt.to) { queueMicrotask(renderScrumboard); return; }
  // Capture off the event now — Sortable reuses/clears it after onEnd returns.
  const key = evt.item.dataset.key;
  const status = evt.to.dataset.status || '';
  const statusId = evt.to.dataset.statusId || '';
  if (!key) { queueMicrotask(renderScrumboard); return; }
  // Defer: doTransition/renderScrumboard rebuild #scrumboard-body and destroy these Sortable
  // instances; running that synchronously inside onEnd (mid drop-cleanup) is unsafe. The
  // microtask fires right after Sortable finishes the current operation.
  queueMicrotask(() => {
    if (!status) { toast('Can’t tell which status this column maps to — use the move menu.'); renderScrumboard(); return; }
    doTransition(key, status, statusId);
  });
}

// Columns in board order. Prefer the board's configured columns (snap.columns groups
// status ids into ordered, named columns — exactly mirrors the web board). When that's
// unavailable (no API token), fall back to grouping by status name, ordered by workflow
// category (To Do → In Progress → Done).
//
// Each column carries a drop target: `status` (the status NAME acli transitions into — it
// transitions by name, not column) and `statusId` (so the optimistic re-column moves the
// card's id, which is how configured columns bucket). In the name-grouped fallback both come
// straight from the status. For configured columns they're the first of the column's status
// ids that actually appears on the board, resolved against an id→name map built from loaded
// items — both blank when none appear (an empty, never-seen column), so a drop there is
// rejected with a toast. The "Other" bucket has no single target, so it's never a drop site.
function buildColumns(items, cfg) {
  if (Array.isArray(cfg) && cfg.length) {
    const nameOf = new Map();                // statusId -> status name (from loaded items)
    for (const it of items) if (it.statusId != null) nameOf.set(String(it.statusId), it.status || '');
    const colOf = new Map();                 // statusId -> column index
    cfg.forEach((c, i) => (c.statusIds || []).forEach(id => colOf.set(String(id), i)));
    const cols = cfg.map(c => {
      const id = (c.statusIds || []).map(String).find(sid => nameOf.has(sid)) || '';
      return { name: c.name, status: id ? nameOf.get(id) : '', statusId: id, items: [] };
    });
    const other = { name: 'Other', status: '', statusId: '', items: [] };
    for (const it of items) {
      const idx = colOf.get(String(it.statusId));
      (idx === undefined ? other : cols[idx]).items.push(it);
    }
    return other.items.length ? [...cols, other] : cols;
  }
  const map = new Map();
  for (const it of items) {
    const name = it.status || '—';
    if (!map.has(name)) map.set(name, { name, status: it.status || '', statusId: it.statusId != null ? String(it.statusId) : '', cat: it.statusCategory || '', items: [] });
    map.get(name).items.push(it);
  }
  return [...map.values()].sort((a, b) =>
    (CAT_RANK[a.cat] ?? 1) - (CAT_RANK[b.cat] ?? 1) || a.name.localeCompare(b.name));
}

// Render the board from the cached snapshot (on load and after a status change). The
// status-transition menu is reused via each card's move button, so moving a ticket here
// works exactly like the Jira tables.
export function renderScrumboard() {
  const el = document.getElementById('scrumboard-body');
  if (!el) return;
  if (_boardDragging) return; // don't rebuild the DOM mid-drag — it would destroy the live Sortable instance
  const snap = state.boardSnap || { items: [] };
  // Overlay any optimistic drag/move still awaiting server confirmation so the card shows in
  // its new column even right after a sync re-read the (stale) snapshot.
  const all = applyPendingMoves(snap.items);
  setTitle(snap);
  renderScrumboardFilter(); // keep the assignee list in sync with the loaded board

  // Keys assigned to me (from the my-sprint feed) → tint my cards' avatar on the team board.
  const mineKeys = new Set((state.sprintSnap?.items || []).map(i => i.key));

  // Apply the saved per-project assignee filter.
  const f = state.boardFilters[state.boardProjectId] || '';
  const items = f === '__unassigned__' ? all.filter(i => !i.assigneeId)
    : f ? all.filter(i => i.assigneeId === f)
    : all;

  if (!items.length) {
    const proj = projectById(state.boardProjectId);
    const emptyMsg = snap.error ? esc(snap.error)
      : all.length ? 'No tickets match this filter.'
      : proj && !proj.jiraProjectKey ? 'This project has no Jira key.'
      : snap.query ? `No tickets match “${esc(snap.query)}” in the active sprint.`
      : 'No active sprint, or no tickets in it.';
    el.innerHTML = `<div class="empty" style="padding:16px;color:var(--text-3)">${emptyMsg}</div>`;
    initBoardSort(); // tear down any Sortable instances from a prior non-empty render
    return;
  }

  const ordered = buildColumns(items, snap.columns);

  el.innerHTML = `<div class="board">
    ${ordered.map(col => `
      <div class="board-col">
        <div class="board-col-head">
          <span class="board-col-name">${esc(col.name)}</span>
          <span class="board-col-count">${col.items.length}</span>
        </div>
        <div class="board-col-body" data-status="${esc(col.status)}" data-status-id="${esc(col.statusId)}">
          ${col.items.map(it => boardCard(it, mineKeys.has(it.key))).join('')}
        </div>
      </div>`).join('')}
  </div>`;
  initBoardSort();
}
