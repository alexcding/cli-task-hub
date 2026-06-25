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
  // Never refetch/rebuild the board mid-drag. This is the SSE-refresh entry point, and its error
  // and no-project branches write body.innerHTML DIRECTLY (bypassing renderScrumboard's guard) —
  // a fetch failure landing during a drag would wipe #scrumboard-body and destroy the live
  // SortableJS instance, freezing the drag. Guarding here keeps the invariant at the loader level
  // so onEnd always fires (the dragged DOM survives); the skipped snapshot lands on the next sync.
  if (_boardDragging) return;
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
// True between a drag's start and end. Every path that rebuilds #scrumboard-body bails while it's
// set — loadScrumboard (the SSE-refresh entry, incl. its direct error/empty innerHTML writes) and
// renderScrumboard as a backstop — because rebuilding the DOM mid-drag would destroy the SortableJS
// instance being dragged and freeze it. Guarding at the loader means the dragged DOM survives the
// whole drag, so onEnd always fires and the flag can't get stuck. Skipped snapshots land on the
// next sync; the post-drag render (onEnd → doTransition) catches up.
let _boardDragging = false;

// Ring/tint whichever status lane the drag is currently over. Cleared on drop/cancel (onEnd)
// and before each move so only one lane lights up at a time.
function clearColHighlight() {
  document.querySelectorAll('.board-lane-drop').forEach(el => el.classList.remove('board-lane-drop'));
}

function initBoardSort() {
  // Reaching a fresh board build means no drag is mid-flight, so clear any stale drag state here.
  // This is the recovery hatch if a drag ever ends without onEnd firing: a missed onEnd would
  // otherwise leave _boardDragging stuck (freezing SSE refresh) and the board stuck in its
  // exploded `.dragging` layout — any subsequent render (a move, a project/filter switch) now
  // unsticks it. The loadScrumboard guard makes onEnd reliable; this is the backstop.
  _boardDragging = false;
  document.querySelector('#scrumboard-body .board')?.classList.remove('dragging');
  _boardSortables.forEach(s => s.destroy());
  _boardSortables = [];
  if (typeof Sortable === 'undefined') return;
  document.querySelectorAll('#scrumboard-body .board-lane-body').forEach(body => {
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
      // Freeze board re-renders for the duration (see _boardDragging) and flip the board into
      // drag mode: CSS turns each column into equal-sized per-status drop zones (.dragging).
      onStart() { _boardDragging = true; document.querySelector('#scrumboard-body .board')?.classList.add('dragging'); },
      onMove(evt) {
        clearColHighlight();
        evt.to?.closest('.board-lane')?.classList.add('board-lane-drop');
      },
      onEnd(evt) {
        _boardDragging = false;
        document.querySelector('#scrumboard-body .board')?.classList.remove('dragging');
        clearColHighlight();
        onBoardDrop(evt);
      },
    }));
  });
}

// A card was dropped. `from`/`to` are the status-lane bodies; same lane ⇒ no status change
// (incl. dropping back where it started, even within the same column). The target lane carries
// its status on data-status/-id (blank for the "Other" bucket, which can't be a transition
// target). doTransition re-renders the board from state, which rebuilds the DOM Sortable
// mutated — so a rejected drop just snaps back on re-render.
function onBoardDrop(evt) {
  // Same lane ⇒ no status change, but a sync may have been skipped mid-drag — re-render to catch up.
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

// Columns in board order, each split into per-status sub-lanes — exactly mirroring the web
// board (a "To Do" column holds "Ready for Dev", "In Specification", … as labelled lanes).
// Prefer the board's configured columns (snap.columns groups status ids into ordered, named
// columns + carries each status's name). When that's unavailable (no API token), fall back to
// grouping by status name, ordered by workflow category (To Do → In Progress → Done).
//
// Shape: [{ name, lanes: [{ status, statusId, items }], total, multi }]. Each LANE is a drop
// target: `status` is the status NAME acli transitions into (it transitions by name, not column)
// and `statusId` re-columns the card optimistically. A lane is rendered even with no items (an
// empty status you can drag into); its name comes from cfg.statuses, falling back to a loaded
// ticket, else ''. `total` (card count) and `multi` (>1 lane ⇒ show sub-lane headers) are
// precomputed so the renderer stays pure presentation. The "Other" bucket collects statuses no
// column claims; its single lane has no status, so it's not a drop target.
function buildColumns(items, cfg) {
  let cols;
  if (Array.isArray(cfg) && cfg.length) {
    const nameOf = new Map();                // statusId -> status name
    for (const c of cfg) for (const s of (c.statuses || [])) if (s.id != null) nameOf.set(String(s.id), s.name || '');
    // Loaded tickets fill any name the config didn't carry (older cached snapshot, or a status
    // the global list missed).
    for (const it of items) if (it.statusId != null && !nameOf.get(String(it.statusId))) nameOf.set(String(it.statusId), it.status || '');
    const laneOf = new Map();                // statusId -> lane object, for bucketing
    cols = cfg.map(c => ({
      name: c.name,
      lanes: (c.statusIds || []).map(id => {
        const lane = { statusId: String(id), status: nameOf.get(String(id)) || '', items: [] };
        laneOf.set(String(id), lane);
        return lane;
      }),
    }));
    const other = { name: 'Other', lanes: [{ statusId: '', status: '', items: [] }] };
    for (const it of items) (laneOf.get(String(it.statusId)) || other.lanes[0]).items.push(it);
    if (other.lanes[0].items.length) cols.push(other);
  } else {
    // Fallback: one column per status, a single lane that IS the column (no sub-lane header).
    const map = new Map();
    for (const it of items) {
      const name = it.status || '—';
      if (!map.has(name)) map.set(name, { name, cat: it.statusCategory || '',
        lanes: [{ status: it.status || '', statusId: it.statusId != null ? String(it.statusId) : '', items: [] }] });
      map.get(name).lanes[0].items.push(it);
    }
    cols = [...map.values()].sort((a, b) =>
      (CAT_RANK[a.cat] ?? 1) - (CAT_RANK[b.cat] ?? 1) || a.name.localeCompare(b.name));
  }
  for (const c of cols) {
    c.total = c.lanes.reduce((n, l) => n + l.items.length, 0);
    c.multi = c.lanes.length > 1; // single-status columns (and the fallback) show no sub-lane header
  }
  return cols;
}

// Render the board from the cached snapshot (on load and after a status change). The
// status-transition menu is reused via each card's move button, so moving a ticket here
// works exactly like the Jira tables.
export function renderScrumboard() {
  const el = document.getElementById('scrumboard-body');
  if (!el) return;
  // Mid-drag rebuilds are prevented upstream at loadScrumboard (the SSE-refresh entry); no other
  // caller reaches here during a drag (doTransition fires post-onEnd; project/filter switches need
  // a click). So we DON'T hard-block on _boardDragging here — that would make a stuck flag
  // un-recoverable (initBoardSort, which clears it, would never run). See initBoardSort.
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

  let html;
  if (!items.length) {
    const proj = projectById(state.boardProjectId);
    const emptyMsg = snap.error ? esc(snap.error)
      : all.length ? 'No tickets match this filter.'
      : proj && !proj.jiraProjectKey ? 'This project has no Jira key.'
      : snap.query ? `No tickets match “${esc(snap.query)}” in the active sprint.`
      : 'No active sprint, or no tickets in it.';
    html = `<div class="empty" style="padding:16px;color:var(--text-3)">${emptyMsg}</div>`;
  } else {
    const ordered = buildColumns(items, snap.columns);
    html = `<div class="board">
    ${ordered.map(col => `
      <div class="board-col">
        <div class="board-col-head">
          <span class="board-col-name">${esc(col.name)}</span>
          <span class="board-col-count">${col.total}</span>
        </div>
        <div class="board-col-body">
          ${col.lanes.map(lane => `
            <div class="board-lane${lane.status ? '' : ' board-lane-nostatus'}">
              ${col.multi ? `<div class="board-lane-head"><span class="board-lane-name">${esc(lane.status || '—')}</span><span class="board-lane-count">${lane.items.length}</span></div>` : ''}
              <div class="board-lane-body" data-status="${esc(lane.status)}" data-status-id="${esc(lane.statusId)}">
                ${lane.items.map(it => boardCard(it, mineKeys.has(it.key))).join('')}
              </div>
            </div>`).join('')}
        </div>
      </div>`).join('')}
  </div>`;
  }
  // Skip the innerHTML churn (and Sortable teardown/rebuild) when nothing changed — SSE refreshes
  // re-render frequently but the board rarely differs (mirrors sidebar's renderTabs dirty-check).
  // Safe vs. drag: a same-column drop leaves the markup identical (sort:false moves nothing) so we
  // skip and keep the live instances; a real move changes the markup, so it re-renders + re-inits.
  if (el._lastBoardHtml === html) return;
  el.innerHTML = html;
  el._lastBoardHtml = html;
  initBoardSort();
}
