// Dashboard hero usage figures. The hero's right side is the chosen agent's plan limits:
// an agent line ("Claude Code · resets in 1h 16m") over one big figure per limit (Session / Weekly / per-model) — the percentage left as a large
// numeral over a thin underline that fills to the same value. Pure string builders from the
// /api/usage payload — no fetching, no DOM access.
//
// Each agent has its own accent (--claude coral, --codex periwinkle) applied through the
// `agent-<key>` class on the figures block; the ring fill reads `--agent`.
import { esc } from '../lib/util.js';

const fmtUntil = (iso) => {
  const m = Math.floor((+new Date(iso) - Date.now()) / 60000);
  if (m <= 0) return null;
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
};

const AGENTS = [
  { key: 'claude', label: 'Claude', name: 'Claude Code' },
  { key: 'codex',  label: 'Codex',  name: 'Codex' },
];

const hasUse = (u) => !!u && (u.tokens > 0 || (u.history || []).some(h => h.tokens > 0));
// Agents worth listing: any usage inside the history window.
const usableAgents = (usage) => usage ? AGENTS.filter(a => hasUse(usage[a.key])) : [];

// One limit → { label, left, until, tip }. `left` is what remains (the figure); the tooltip
// carries the pace reading — reserve = left − what should remain on an even spend.
const limitFig = (label, win, winMs) => {
  if (!win) return null;
  const end = win.resetsAt ? +new Date(win.resetsAt) : null;
  const until = end && fmtUntil(win.resetsAt);
  const left = Math.max(0, Math.min(100, Math.round(100 - win.usedPct)));
  const elapsed = end ? Math.min(100, Math.max(0, 100 - (end - Date.now()) / winMs * 100)) : null;
  const reserve = elapsed != null ? Math.round(left - (100 - elapsed)) : null;
  const pace = reserve == null ? '' : reserve >= 0 ? ` · ${reserve}% in reserve` : ` · ${-reserve}% over pace`;
  return { label, left, until, tip: `${left}% of the ${label} allowance left${pace}${until ? ` · resets in ${until}` : ''}` };
};

// Session/Weekly (+ one per scoped model, labelled by model name) from a {session, weekly,
// scoped?} limits object — Claude's from the OAuth endpoint, Codex's from its rollout file.
const limitFigs = (limits) => limits ? [
  limitFig('Session', limits.session, 5 * 3600_000),
  limitFig('Weekly', limits.weekly, 7 * 86_400_000),
  ...(limits.scoped || []).map(s => limitFig(s.label, s, 7 * 86_400_000)),
].filter(Boolean) : [];

// SVG ring, 20px: the used part is a light tint of the agent colour, the remaining part the full
// colour — an arc whose dash length is pct of the circumference over the tinted track.
const ring = (pct) => {
  const size = 20, stroke = 2.5, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return `<svg class="fig-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="color-mix(in srgb, var(--agent) 22%, transparent)" stroke-width="${stroke}"></circle>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--agent)" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${(c * pct / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"></circle>
  </svg>`;
};

// Hero pieces for the chosen agent: `agentLine` (the Claude/Codex picker) sits before `figures`
// on the hero's right. Both '' when nothing has been used.
export function usageHero(usage, agentKey) {
  const agents = usableAgents(usage);
  if (!agents.length) return { agentLine: '', figures: '' };
  const agent = agents.find(a => a.key === agentKey) || agents[0];
  // The picker: a compact segmented control listing every agent with usage (a plain label when
  // there's only one). Picking one calls setUsageAgent (dashboard.js), persisted as `usageAgent`.
  const agentLine = agents.length > 1
    ? `<div class="usage-tabs" role="tablist">${agents.map(a =>
        `<button class="usage-tab${a.key === agent.key ? ' active' : ''}" onclick="setUsageAgent('${a.key}')">${a.label}</button>`).join('')}</div>`
    : `<span class="usage-name">${agent.name}</span>`;
  const figs = limitFigs(agent.key === 'claude' ? usage.limits : usage.codexLimits);
  // Ring chips: a small ring (stroke fills to what's left, in the agent colour) beside two short
  // lines — the percentage over "name · reset" — as one soft pill per limit.
  const figures = figs.length ? `<div class="dash-figs agent-${agent.key}">${figs.map(f => `
    <div class="fig" title="${esc(f.tip)}">${ring(f.left)}<span class="fig-text"><span class="fig-val">${f.left}%</span><span class="fig-lbl">${esc(f.label)}${f.until ? `<span class="fig-reset">${f.until}</span>` : ''}</span></span></div>`).join('')}</div>` : '';
  return { agentLine, figures };
}
