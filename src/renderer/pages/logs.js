// Activity page (left nav → Activity). One log store (logs.db) with a `category`
// column. category='event' is the activity feed (rich, linked descriptions); other
// categories (webhook, poller, …) render generically. Pure view: data comes from
// /api/logs, links reuse the app-wide handlers (jiraClick / openPrSplit) so PRs and
// tickets open in the embedded viewer like everywhere else.
import { ROUTES } from '/shared/routes.mjs';
import { api, apiJson } from '../services/api.js';
import { esc, escJs, jiraUrl, timeAgo } from '../lib/util.js';
import { ICON, TAB_ICON } from '../lib/icons.js';
import { toastErr } from '../components/toast.js';

let _logCategory = 'event'; // 'all' | 'event' | 'webhook' | …
let _logCats = null;        // cached category list (categories change rarely); null → refetch
let _logChipsKey = null;    // signature of the last-rendered chip set, to avoid rebuilding it

export async function loadLogs() {
  const errorsOnly = document.getElementById('log-errors-only')?.checked;
  const params = new URLSearchParams();
  if (_logCategory && _logCategory !== 'all') params.set('category', _logCategory);
  if (errorsOnly) params.set('level', 'error');
  const logsP = api(ROUTES.LOGS + '?' + params);          // the only request a filter click needs
  if (_logCats === null) { try { _logCats = await api(ROUTES.LOGS_CATEGORIES); } catch { _logCats = []; } }
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
      `<button class="seg-tab" data-cat="${c}" onclick="setLogCategory('${c}')">${label(c)}</button>`).join('');
    _logChipsKey = key;
  }
  // Active state flips on every filter click — toggle the class instead of rebuilding.
  document.querySelectorAll('#log-cats .seg-tab').forEach(b => b.classList.toggle('active', b.dataset.cat === _logCategory));
}

export function setLogCategory(c) { _logCategory = c; loadLogs(); }

export async function clearLogs() {
  const scope = _logCategory === 'all' ? 'all logs' : `"${_logCategory}" logs`;
  if (!confirm(`Clear ${scope}?`)) return;
  try {
    await apiJson(ROUTES.LOGS_CLEAR, 'POST', { category: _logCategory });
    _logCats = null; // a cleared category may vanish — refetch the chip set
    loadLogs();
  } catch (e) { toastErr(e.message); }
}

// ── Event presentation ────────────────────────────────────────────────────────
const shortRepo = repo => esc((repo || '').split('/').pop() || repo || '');

// PR number as a link that opens the embedded PR viewer (same as a PR card click).
// Webhook-supplied strings go through escJs: inside an on* attribute, HTML entities
// decode before the JS runs, so esc() alone can't keep a quote from ending the literal.
function prLink(p) {
  const pr = p.pr || {};
  if (!pr.url) return `PR #${esc(pr.number ?? '?')}`;
  return `<a class="link" href="${esc(pr.url)}" target="_blank"
    onclick="event.preventDefault();openPrSplit('${escJs(pr.url)}','#${escJs(pr.number)}','${escJs(p.repo || '')}','')">#${esc(pr.number)}</a>`;
}

// Jira key as a link through the shared jiraClick handler (embedded viewer in Electron).
function jiraLink(key) {
  if (!key) return '';
  return `<a class="link" href="${esc(jiraUrl(key))}" target="_blank" rel="noopener"
    onclick="jiraClick(event, this.href, '${escJs(key)}')">${esc(key)}</a>`;
}

// Each known event type → icon, tint, one-line linked sentence, optional detail line.
function presentEvent(ev, p) {
  const t = ev.type;
  if (t === 'pr_opened') return {
    icon: TAB_ICON.github, tint: 'var(--accent)', bg: 'var(--accent-bg)',
    html: `Pull request ${prLink(p)} opened in <strong>${shortRepo(p.repo)}</strong>`,
    detail: p.pr?.title ? esc(p.pr.title) : '',
  };
  if (t === 'pr_merged') return {
    icon: ICON.branch, tint: 'var(--merged)', bg: 'var(--merged-bg)',
    html: `Pull request ${prLink(p)} merged in <strong>${shortRepo(p.repo)}</strong>`,
    detail: p.pr?.title ? esc(p.pr.title) : '',
  };
  if (t === 'pr_closed') return {
    icon: ICON.close, tint: 'var(--text-3)', bg: 'var(--surface-hover)',
    html: `Pull request ${prLink(p)} closed in <strong>${shortRepo(p.repo)}</strong>`,
    detail: p.pr?.title ? esc(p.pr.title) : '',
  };
  if (t === 'jira_transitioned') return {
    icon: ICON.refresh, tint: 'var(--success)', bg: 'var(--success-bg)',
    // When the merge also set a Fix Version, show it inline so the one entry tells the whole story.
    html: `${jiraLink(p.key)} moved to <strong>${esc(p.transition || '?')}</strong>${p.version ? ` · Fix Version <strong>${esc(p.version)}</strong>` : ''}`,
    detail: p.trigger ? `Triggered by ${esc(p.trigger)}` : '',
  };
  if (t === 'jira_transition_failed') return {
    icon: ICON.warn, tint: 'var(--danger)', bg: 'var(--danger-bg)',
    html: `Failed to transition ${jiraLink(p.key)}`,
    detail: esc(p.error || ''),
  };
  if (t === 'jira_version_created') return {
    icon: ICON.plus, tint: 'var(--accent)', bg: 'var(--accent-bg)',
    html: `Fix Version <strong>${esc(p.version || '?')}</strong> created in <strong>${esc(p.project || '?')}</strong>`,
    detail: p.trigger ? `Triggered by ${esc(p.trigger)}` : '',
  };
  // Standalone "Fix Version set" entry — emitted only when no transition follows (otherwise the
  // version rides on the jira_transitioned entry above).
  if (t === 'jira_fixversion_set') return {
    icon: ICON.checkCircle, tint: 'var(--success)', bg: 'var(--success-bg)',
    html: `Fix Version <strong>${esc(p.version || '?')}</strong> set on ${jiraLink(p.key)}`,
    detail: p.trigger ? `Triggered by ${esc(p.trigger)}` : '',
  };
  if (t === 'jira_fixversion_failed') return {
    icon: ICON.warn, tint: 'var(--danger)', bg: 'var(--danger-bg)',
    html: `Failed to set Fix Version${p.key ? ` on ${jiraLink(p.key)}` : ''}`,
    detail: esc(p.error || ''),
  };
  if (t === 'sync_failed') return {
    icon: ICON.warn, tint: 'var(--danger)', bg: 'var(--danger-bg)',
    html: `Sync failed for <strong>${shortRepo(p.repo)}</strong>`,
    detail: esc(p.error || ''),
  };
  // Generic fallback for non-activity categories (webhook, poller, …).
  const levelTint = ev.level === 'error' ? 'var(--danger)' : ev.level === 'warn' ? 'var(--warn)' : 'var(--text-3)';
  const levelBg   = ev.level === 'error' ? 'var(--danger-bg)' : ev.level === 'warn' ? 'var(--warn-bg)' : 'var(--surface-hover)';
  return {
    icon: ICON.clock, tint: levelTint, bg: levelBg,
    html: esc((ev.type || '').replace(/_/g, ' ')),
    detail: esc(p.raw != null ? String(p.raw) : (Object.keys(p).length ? JSON.stringify(p) : '')),
  };
}

// Day bucket label for the timeline headers: Today / Yesterday / "Mon, Jun 2".
function dayLabel(iso) {
  const d = new Date(iso), now = new Date();
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

const clockTime = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function renderLogs(logs) {
  const el = document.getElementById('events-list');
  if (!logs.length) {
    el.innerHTML = `<div class="card"><div class="empty"><div class="empty-icon">${ICON.clock}</div><p>No activity yet.</p></div></div>`;
    return;
  }
  // Group into day sections (logs arrive newest-first; keep that order).
  const days = [];
  for (const ev of logs) {
    const label = dayLabel(ev.created_at);
    if (!days.length || days[days.length - 1].label !== label) days.push({ label, events: [] });
    days[days.length - 1].events.push(ev);
  }
  el.innerHTML = days.map(({ label, events }) => `
    <div class="act-day">${label}</div>
    <div class="card">${events.map(ev => {
      let p = {}; try { p = ev.payload ? JSON.parse(ev.payload) : {}; } catch { p = { raw: ev.payload }; }
      const v = presentEvent(ev, p);
      const badge = (ev.category && ev.category !== 'event')
        ? `<span class="act-cat">${esc(ev.category)}</span>` : '';
      return `<div class="act-row">
        <div class="act-icon" style="color:${v.tint};background:${v.bg}">${v.icon}</div>
        <div class="act-body">
          <div>${v.html}${badge}</div>
          ${v.detail ? `<div class="act-detail">${v.detail}</div>` : ''}
        </div>
        <div class="act-time" title="${esc(ev.created_at)}">${label === 'Today' ? timeAgo(ev.created_at) : clockTime(ev.created_at)}</div>
      </div>`;
    }).join('')}</div>`).join('');
}
