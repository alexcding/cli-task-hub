// Tasks page (left nav → Tasks). A live, card-based view of the current working CLI sessions:
// every paired terminal (a GitHub/Jira tab with a running terminal) is one card. While a session
// is working the card shows a live preview of the terminal's last lines; when it goes idle a
// one-shot headless analysis (see /api/agent-analyze) labels it with a summary + state. Pure view
// over renderer state; sessions/terminals live in state.terms (in-memory), not the server.
//
// The terminal read + extraction (terminalTailLines / readAgentMessage in components/terminal.js)
// and the analysis are the SAME ones the workflow runner uses to gate its loop — extract once,
// analyze once, two consumers. Clicking a card opens/refocuses its tab (or recreates it).
import { state, projectByRepo, projectByPrUrl, projectByJiraKey } from '../stores/store.js';
import { esc, escJs, jiraKeyFromUrl } from '../lib/util.js';
import { ICON, TAB_ICON } from '../lib/icons.js';
import { workflowRunState } from '../components/workflow.js';
import { openInSplit, activateTab } from '../components/viewer.js';
import { terminalTailLines } from '../components/terminal.js';
import { analyzeTerminal } from '../services/analyzer.js';

const CLI_LABEL = { claude: 'Claude', codex: 'Codex' };
const PREVIEW_LINES = 6; // lines of the live terminal preview shown while working

// One entry per paired terminal. The tab carries the human title/kind/branch; an orphan PTY
// (its tab was closed but the contextful terminal kept alive) still shows, resolved by url.
function sessions() {
  const out = [];
  for (const [id, t] of state.terms) {
    if (!t.paired) continue;
    const url = t.pairKey || '';
    const tab = state.tabs.find(x => x.url === url) || null;
    const kind = tab?.kind || (jiraKeyFromUrl(url) ? 'jira' : 'github');
    out.push({ id, url, tab, kind, busy: !!t.busy, cli: t.cli || '',
               summary: t.summary || '', state: t.state || '', title: tab?.title || t.title || url });
  }
  return out;
}

const previewHtml = lines => lines.length
  ? `<div class="tc-term-text">${esc(lines.join('\n'))}</div>`
  : '<div class="tc-term-text tc-term-empty">No output yet</div>';

// The project that owns a session, for the meta line — same lookups the workflow runner uses.
function projectName(s) {
  const p = s.kind === 'jira'
    ? projectByJiraKey(s.tab?.jiraKey || jiraKeyFromUrl(s.url))
    : (projectByRepo(s.tab?.repo) || projectByPrUrl(s.url));
  return p?.name || '';
}

// "project · branch-or-key" — whatever context we know, omitting blanks.
function metaLine(s) {
  const parts = [];
  const proj = projectName(s);
  if (proj) parts.push(esc(proj));
  if (s.kind === 'jira') { const k = s.tab?.jiraKey || jiraKeyFromUrl(s.url); if (k) parts.push(esc(k)); }
  else if (s.tab?.branch) parts.push(esc(s.tab.branch));
  return parts.join(' · ');
}

// The left state pill: working (live), or the analyzed resting state once idle.
function statePill(running, st) {
  if (running) return { label: 'Working', cls: 'live' };
  if (st === 'needs_input') return { label: 'Needs input', cls: 'attn' };
  if (st === 'blocked') return { label: 'Blocked', cls: 'err' };
  if (st === 'done') return { label: 'Done', cls: 'done' };
  return { label: 'Idle', cls: '' };
}

// Segmented step progress for a workflow run: filled = done, the current step pulses.
function progressHtml(wf) {
  const segs = Array.from({ length: wf.total }, (_, i) =>
    `<span class="tc-seg ${i < wf.step ? 'done' : ''} ${i === wf.step - 1 ? 'cur' : ''}"></span>`).join('');
  const label = `${esc(wf.name)} · step ${wf.step}/${wf.total}${wf.stepTitle ? ` · ${esc(wf.stepTitle)}` : ''}`;
  return `<div class="tc-wf"><div class="tc-segs">${segs}</div><div class="tc-wf-label">${label}</div></div>`;
}

function cardHtml(s) {
  const wf = workflowRunState(s.tab?.id);
  const running = s.busy || !!wf;
  const cli = CLI_LABEL[s.cli] || CLI_LABEL[wf?.cli] || '';
  const meta = metaLine(s);
  const pill = statePill(running, s.state);
  // Working (or un-analyzed) → live terminal preview; idle with an analysis → the summary line.
  const body = (!running && s.summary)
    ? `<div class="tc-summary">${esc(s.summary)}</div>`
    : `<div class="tc-term" data-term="${esc(s.id)}">${previewHtml(terminalTailLines(s.id, PREVIEW_LINES))}</div>`;
  return `<div class="task-card ${running ? 'running' : ''}" onclick="openTaskSession('${escJs(s.url)}')" title="${esc(s.url)}">
      <div class="tc-top">
        <span class="tc-state ${pill.cls}"><span class="tc-dot"></span>${pill.label}</span>
        ${cli ? `<span class="tc-cli">${esc(cli)}</span>` : ''}
      </div>
      <div class="tc-head">
        <span class="tc-ic">${TAB_ICON[s.kind] || TAB_ICON.github}</span>
        <span class="tc-title">${esc(s.title)}</span>
      </div>
      ${meta ? `<div class="tc-meta">${meta}</div>` : ''}
      ${body}
      ${wf ? progressHtml(wf) : ''}
    </div>`;
}

// Analyze a session's last message into { summary, state } — called ONLY when its turn-done (Stop)
// hook fires (see app.js), never on render. Skips sessions a workflow run is driving (the runner
// makes its own analyze call with decision context); everything else (settle, dedupe, gen guard,
// recording, failure cleanup) lives in the shared analyzeTerminal service.
export function analyzeSession(termId) {
  const t = state.terms.get(termId);
  if (!t || !t.paired) return;
  const tab = state.tabs.find(x => x.termId === termId) || state.tabs.find(x => x.url === t.pairKey);
  if (tab && workflowRunState(tab.id)) return; // workflow runner handles its own steps
  analyzeTerminal(termId).then(r => { if (r && document.querySelector('.page.active')?.id === 'page-tasks') loadTasks(); });
}

// Refresh just the terminal-preview blocks in place (no full rebuild) so the pulsing dot's
// animation never restarts. Runs while the Tasks page is the active view, then stops itself.
let _ticker = null;
function startTicker() {
  if (_ticker) return;
  _ticker = setInterval(() => {
    if (document.querySelector('.page.active')?.id !== 'page-tasks') { clearInterval(_ticker); _ticker = null; return; }
    document.querySelectorAll('#tasks-list .tc-term[data-term]').forEach(el => {
      // Only re-read terminals whose output can actually be changing (a live turn). Idle/frozen
      // buffers don't change, so re-parsing them every tick is wasted work.
      if (!state.terms.get(el.dataset.term)?.busy) return;
      el.innerHTML = previewHtml(terminalTailLines(el.dataset.term, PREVIEW_LINES));
    });
  }, 1500);
}

export function loadTasks() {
  const list = sessions();
  // Working first (active sessions on top), then by title for a stable order.
  list.sort((a, b) => (Number(b.busy) - Number(a.busy)) || a.title.localeCompare(b.title));

  const countEl = document.getElementById('tasks-count');
  if (countEl) {
    const running = list.filter(s => s.busy || workflowRunState(s.tab?.id)).length;
    countEl.textContent = list.length
      ? `${list.length} session${list.length === 1 ? '' : 's'}${running ? ` · ${running} working` : ''}`
      : '';
  }

  const el = document.getElementById('tasks-list');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = `<div class="card"><div class="empty"><div class="empty-icon">${ICON.cpu}</div>
      <p>No active sessions.</p>
      <p style="font-size:12px;margin-top:4px">Open a PR or ticket and start a terminal (or run a workflow) to see it here.</p></div></div>`;
    return;
  }
  el.innerHTML = `<div class="task-grid">${list.map(cardHtml).join('')}</div>`;
  startTicker();
}

// Click a card: focus its open tab (revealing the working terminal), or recreate the tab for a
// PTY that outlived it — ensurePrTerminal re-adopts the surviving terminal by url.
export function openTaskSession(url) {
  const tab = state.tabs.find(t => t.url === url);
  if (tab) {
    tab.prSplit = true;            // show the working terminal beside the page
    activateTab(tab.id);
    return;
  }
  const kind = jiraKeyFromUrl(url) ? 'jira' : 'github';
  openInSplit(url, url, kind, { prSplit: true });
}
