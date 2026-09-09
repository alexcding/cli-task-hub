// Shared AI-usage widget. A full-width landscape block: one aligned line per plan limit
// (Session/Weekly…) on the left, stat row + day histogram on the right. The section title is
// a dropdown that switches between Claude Code and Codex.
// Pure string builder from the /api/usage payload — no fetching, no DOM access.
//
// Each agent has its own accent (--claude coral, --codex periwinkle) applied through
// the card's `agent-<key>` class; bars read the `--agent` custom property. The header is
// the dashboard's shared section header (title + hairline); the title doubles as the picker.

import { ICON } from '../lib/icons.js';

const fmtTok  = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n);
const fmtCost = c => '$' + (c >= 100 ? Math.round(c).toLocaleString() : c.toFixed(2));
const fmtUntil = (iso) => {
  const m = Math.floor((+new Date(iso) - Date.now()) / 60000);
  if (m <= 0) return null;
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
};

const AGENTS = [
  { key: 'claude', name: 'Claude Code' },
  { key: 'codex',  name: 'Codex' },
];

const hasUse = (u) => !!u && (u.tokens > 0 || (u.history || []).some(h => h.tokens > 0));
// Agents worth a tab: any usage inside the history window.
export const usableAgents = (usage) => usage ? AGENTS.filter(a => hasUse(usage[a.key])) : [];

// One plan-limit section. Bar fill = % used; the tick marks where usage would sit
// if spent evenly over the window (the "pace"); reserve = pace − used. Countdowns
// are computed at render time from raw timestamps so they don't go stale with the
// server's usage cache.
// One plan limit as a three-line block: name, a plain full-width bar, then a quiet line of
// figures — "64% left · 30% in reserve" on the left, "resets in 1h 40m" on the right — all
// in the same muted text style.
const resetTxt = (until) => `<span class="lim-reset">resets in ${until}</span>`;
const limitRow = (name, barHtml, figs, reset) => `
    <div class="lim">
      <div class="lim-name">${name}</div>
      ${barHtml}
      <div class="lim-figs"><span>${figs.filter(Boolean).join('<i class="lim-dot"></i>')}</span>${reset || ''}</div>
    </div>`;
const limitSec = (title, win, winMs) => {
  if (!win) return '';
  const end = win.resetsAt ? +new Date(win.resetsAt) : null;
  const until = end && fmtUntil(win.resetsAt);
  // The bar shows what's LEFT (fills to `left`, drains as you use it) so it agrees
  // with the "X% left" figure. paceLeft is the budget that *should* remain on an even
  // pace (100 − elapsed%); left − paceLeft = the reserve (negative = over pace).
  const left = 100 - win.usedPct;
  const elapsed = end ? Math.min(100, Math.max(0, 100 - (end - Date.now()) / winMs * 100)) : null;
  const paceLeft = elapsed != null ? 100 - elapsed : null;
  const reserve = paceLeft != null ? Math.round(left - paceLeft) : null;
  // Reserve in words, same muted style as the rest of the line — no colour coding.
  const reserveTxt = reserve == null ? '' : reserve >= 0 ? `${reserve}% in reserve` : `${-reserve}% over pace`;
  // Fill to what's left; the green notch marks where the bar would end on an even pace.
  const bar = `<div class="limit-bar"><i style="width:${left}%"></i>${paceLeft != null ? `<s style="left:${paceLeft.toFixed(1)}%"></s>` : ''}</div>`;
  return limitRow(title, bar, [`${left}% left`, reserveTxt], until ? resetTxt(until) : '');
};

// Session/Weekly sections from a {session, weekly, scoped?} limits object — Claude's come from
// the OAuth endpoint, Codex's from the local rollout file (same shape). `scoped` adds one weekly
// bar per model with its own allowance (Fable) below the two, labelled by model name only. `block` is the ccusage 5h block,
// used as a Claude-only fallback when the limits lookup failed.
const limitsHtml = (limits, block) => {
  if (limits) {
    return limitSec('Session', limits.session, 5 * 3600_000)
         + limitSec('Weekly', limits.weekly, 7 * 86_400_000)
         + (limits.scoped || []).map(s => limitSec(s.label, s, 7 * 86_400_000)).join('');
  }
  if (block) {
    const start = +new Date(block.startTime), end = +new Date(block.endTime);
    const until = fmtUntil(block.endTime);
    if (until) return limitRow('Session',
      `<div class="limit-bar"><i style="width:${Math.min(100, (Date.now() - start) / (end - start) * 100).toFixed(1)}%"></i></div>`,
      [fmtCost(block.cost), `${fmtTok(block.tokens)} tok`], resetTxt(until));
  }
  return '';
};

// Day-by-day token histogram (today highlighted, exact numbers in the tooltip).
const histogram = (history) => {
  if (!history?.length) return '';
  const max = Math.max(...history.map(h => h.tokens), 1);
  const last = history.length - 1;
  return `<div class="usage-hist">${history.map((h, i) => {
    const pct = Math.max(3, Math.round(h.tokens / max * 100));
    const day = new Date(h.date + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `<i ${i === last ? 'class="today" ' : ''}style="--h:${pct}%" data-tip="${day} · ${fmtTok(h.tokens)} tok · ${fmtCost(h.cost)}"></i>`;
  }).join('')}</div>`;
};

export function usageWidgetHtml(usage, agentKey) {
  const agents = usableAgents(usage);
  if (!agents.length) return '';
  const agent = agents.find(a => a.key === agentKey) || agents[0];
  const u = usage[agent.key];
  const month = u.history || [];
  const sum = (field) => month.reduce((s, h) => s + h[field], 0);
  // The title is the switcher: a dropdown (title + caret → menu of agents) when there's more
  // than one agent to pick from, a plain title otherwise. openUsageMenu lives in dashboard.js.
  const title = agents.length > 1
    ? `<button class="project-name usage-title" onclick="openUsageMenu(event)" title="Switch agent">${agent.name}${ICON.caret}</button>`
    : `<span class="project-name">${agent.name}</span>`;
  const latest = agent.key === 'claude' ? usage.block?.tokens : null;
  const cell = (label, val) => `<div><label>${label}</label><b>${val}</b></div>`;
  // Session/Weekly bars on the left; stats grid + histogram on the right. Claude's
  // limits come from the OAuth endpoint (with the ccusage block as fallback), Codex's
  // from its rollout file. With no limits the stats column spans the whole card.
  const limits = agent.key === 'claude'
    ? limitsHtml(usage.limits, usage.block)
    : limitsHtml(usage.codexLimits, null);
  return `
    <div class="usage-card agent-${agent.key}">
      <div class="usage-head project-group-header">${title}</div>
      <div class="usage-cols">
        ${limits ? `<div class="usage-limits">${limits}</div>` : ''}
        <div class="usage-stats">
          <div class="usage-grid">
            ${cell('Today', fmtCost(u.cost))}
            ${cell('30d cost', fmtCost(sum('cost')))}
            ${cell('30d tokens', fmtTok(sum('tokens')))}
            ${cell(latest != null ? 'Latest tokens' : 'Today tokens', fmtTok(latest ?? u.tokens))}
          </div>
          ${histogram(month)}
        </div>
      </div>
    </div>`;
}
