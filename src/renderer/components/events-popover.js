// Bell popover: today's activity (the same rows as Settings → Events, via presentEvent) in a small
// card anchored under the sidebar's bell. One popover at a time; toggled by the bell, dismissed by
// an outside click, Escape, or the "All events" footer link (which opens Settings → Events).
import { ROUTES } from '/shared/routes.mjs';
import { api } from '../services/api.js';
import { esc, timeAgo } from '../lib/util.js';
import { ICON } from '../lib/icons.js';
import { presentEvent } from '../pages/logs.js';
import { showEvents } from '../pages/settings.js';

let _el = null;
export const isEventsPopoverOpen = () => !!_el;

export function closeEventsPopover() {
  if (!_el) return;
  _el.remove(); _el = null;
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
}
const onOutside = e => { if (_el && !_el.contains(e.target) && !e.target.closest?.('.app-bell')) closeEventsPopover(); };
// stopPropagation: the global Escape handler in app.js would otherwise ALSO run (and close the split,
// dropping every open tab). app.js checks isEventsPopoverOpen() first as a second guard.
const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEventsPopover(); } };

const isToday = iso => { const d = new Date(iso), n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate(); };

function rowsHtml(events) {
  if (!events.length) return `<div class="events-pop-empty"><span class="events-pop-empty-ic">${ICON.clock}</span>No activity today</div>`;
  return events.map(ev => {
    let p = {}; try { p = ev.payload ? JSON.parse(ev.payload) : {}; } catch { p = { raw: ev.payload }; }
    const v = presentEvent(ev, p);
    return `<div class="act-row">
      <div class="act-icon" style="color:${v.tint};background:${v.bg}">${v.icon}</div>
      <div class="act-body">
        <div>${v.html}</div>
        ${v.detail ? `<div class="act-detail">${v.detail}</div>` : ''}
      </div>
      <div class="act-time" title="${esc(ev.created_at)}">${timeAgo(ev.created_at)}</div>
    </div>`;
  }).join('');
}

// Toggle from the bell. Anchored to the bell's bottom-right corner (fixed positioning, so the
// sidebar's own scroll/overflow can't clip it).
export async function toggleEventsPopover(anchor) {
  if (_el) { closeEventsPopover(); return; }
  const pop = document.createElement('div');
  pop.className = 'events-pop';
  pop.innerHTML = `<div class="events-pop-head">Today</div><div class="events-pop-body"><div class="events-pop-empty">Loading…</div></div>
    <button class="events-pop-foot" type="button">All events</button>`;
  pop.querySelector('.events-pop-foot').onclick = () => { closeEventsPopover(); showEvents(); };
  document.body.appendChild(pop);
  const r = anchor?.getBoundingClientRect?.();
  if (r) {
    pop.style.top = Math.round(r.bottom + 6) + 'px';
    pop.style.left = Math.max(8, Math.round(r.left + r.width / 2 - 40)) + 'px'; // right-leaning from the bell, kept on-screen
  }
  // Following a PR/Jira link in a row opens the viewer — the popover has done its job.
  pop.addEventListener('click', e => { if (e.target.closest('a.link')) setTimeout(closeEventsPopover, 0); });
  _el = pop;
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  await fill(pop);
}

async function fill(pop) {
  let events = [];
  try { events = (await api(ROUTES.EVENTS)).filter(ev => isToday(ev.created_at)); } catch { events = []; }
  if (_el !== pop) return; // closed while loading
  pop.querySelector('.events-pop-body').innerHTML = rowsHtml(events);
}

// Re-fetch while open — app.js calls this on each SSE 'activity' event so a new row appears live.
export function refreshEventsPopover() { if (_el) fill(_el); }
