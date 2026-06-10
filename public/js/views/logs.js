// Logs / Activity (Settings → Activity tab). One log store (logs.db) with a
// `category` column. category='event' is the activity feed (rich descriptions);
// other categories (webhook, poller, …) render generically.
import { api, apiJson } from '../api.js';
import { esc, timeAgo } from '../util.js';
import { ICON } from '../icons.js';
import { toastErr } from '../toast.js';

let _logCategory = 'event'; // 'all' | 'event' | 'webhook' | …
let _logCats = null;        // cached category list (categories change rarely); null → refetch
let _logChipsKey = null;    // signature of the last-rendered chip set, to avoid rebuilding it
const LOG_LEVEL_COLOR = { error: 'var(--danger)', warn: 'var(--warning, #f59e0b)', info: 'var(--text-3)' };

export async function loadLogs() {
  const errorsOnly = document.getElementById('log-errors-only')?.checked;
  const params = new URLSearchParams();
  if (_logCategory && _logCategory !== 'all') params.set('category', _logCategory);
  if (errorsOnly) params.set('level', 'error');
  const logsP = api('/api/logs?' + params);          // the only request a filter click needs
  if (_logCats === null) { try { _logCats = await api('/api/logs/categories'); } catch { _logCats = []; } }
  renderLogChips(_logCats);
  renderLogs(await logsP);
}

function renderLogChips(cats) {
  // Always offer All + Activity(event), then any other categories that exist.
  const known = ['all', 'event', ...cats.filter(c => c !== 'event')];
  const key = known.join('|');
  if (key !== _logChipsKey) { // rebuild the row only when the category set actually changes
    const label = c => c === 'all' ? 'All' : c === 'event' ? 'Activity' : c[0].toUpperCase() + c.slice(1);
    document.getElementById('log-cats').innerHTML = known.map(c =>
      `<button class="log-chip" data-cat="${c}" onclick="setLogCategory('${c}')">${label(c)}</button>`).join('');
    _logChipsKey = key;
  }
  // Active state flips on every filter click — toggle the class instead of rebuilding.
  document.querySelectorAll('#log-cats .log-chip').forEach(b => b.classList.toggle('active', b.dataset.cat === _logCategory));
}

export function setLogCategory(c) { _logCategory = c; loadLogs(); }

export async function clearLogs() {
  const scope = _logCategory === 'all' ? 'all logs' : `"${_logCategory}" logs`;
  if (!confirm(`Clear ${scope}?`)) return;
  try {
    await apiJson('/api/logs/clear', 'POST', { category: _logCategory });
    _logCats = null; // a cleared category may vanish — refetch the chip set
    loadLogs();
  } catch (e) { toastErr(e.message); }
}

// Rich descriptions for activity events; other categories fall through to generic.
function describeEvent(type, p) {
  if (type === 'pr_opened')              return { desc: `PR #${p.pr?.number} opened in ${p.repo}`,    color: 'var(--accent)' };
  if (type === 'pr_merged')              return { desc: `PR #${p.pr?.number} in ${p.repo} merged`,    color: 'var(--merged)' };
  if (type === 'pr_closed')              return { desc: `PR #${p.pr?.number} in ${p.repo} closed`,    color: 'var(--text-3)' };
  if (type === 'jira_transitioned')      return { desc: `${p.key} → ${p.transition} (${p.trigger})`,  color: 'var(--success)' };
  if (type === 'jira_transition_failed') return { desc: `Failed: ${p.key} — ${p.error}`,              color: 'var(--danger)' };
  if (type === 'sync_failed')            return { desc: `Sync failed for ${p.repo}: ${p.error}`,      color: 'var(--danger)' };
  return null;
}

function renderLogs(logs) {
  const el = document.getElementById('events-list');
  if (!logs.length) { el.innerHTML = `<div class="empty"><div class="empty-icon">${ICON.clock}</div><p>No logs yet.</p></div>`; return; }
  el.innerHTML = logs.map(ev => {
    let p = {}; try { p = ev.payload ? JSON.parse(ev.payload) : {}; } catch { p = { raw: ev.payload }; }
    const known = describeEvent(ev.type, p);
    const color = known ? known.color : (LOG_LEVEL_COLOR[ev.level] || 'var(--text-3)');
    const desc = known ? known.desc : (p.raw != null ? String(p.raw) : JSON.stringify(p));
    const typeText = esc((ev.type || '').replace(/_/g, ' '));
    const title = p.pr?.url
      ? `<a class="link" href="${esc(p.pr.url).replace(/"/g, '&quot;')}" target="_blank">${typeText}</a>`
      : typeText;
    // Show category + level badges when viewing across categories or non-activity streams.
    const badge = (ev.category && ev.category !== 'event')
      ? `<span class="log-level" style="background:${color}22;color:${color}">${esc(ev.category)}</span> ` : '';
    return `<div class="event-row">
      <div class="event-dot" style="background:${color};margin-top:5px;width:8px;height:8px;border-radius:50%;flex-shrink:0"></div>
      <div class="event-body"><div class="event-type">${badge}${title}</div><div>${esc(desc)}</div></div>
      <div class="event-time">${timeAgo(ev.created_at)}</div>
    </div>`;
  }).join('');
}
