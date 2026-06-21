// Tasks page (left nav → Tasks). A live, card-based view of the current working CLI sessions:
// every paired terminal (a GitHub/Jira tab with a running terminal) is one card, showing whether
// its CLI is working right now, what it was asked to do (goal), what it's doing this moment
// (activity), and — when a workflow drives it — a step progress bar. Pure view over renderer
// state; sessions/terminals live in state.terms (in-memory), not the server. Clicking a card
// opens that tab in the viewer (or recreates it for a PTY that outlived its tab).
//
// Live status comes from the chosen CLI's hooks over SSE (app.js): goal ← UserPromptSubmit,
// activity ← PreToolUse, busy ← turn-start/turn-done. FUTURE: scheduled/cron Jira tasks would
// slot in here as extra cards once the server grows a task registry.
import { state, projectByRepo, projectByPrUrl, projectByJiraKey } from '../stores/store.js';
import { esc, escJs, jiraKeyFromUrl } from '../lib/util.js';
import { ICON, TAB_ICON } from '../lib/icons.js';
import { workflowRunState } from '../components/workflow.js';
import { openInSplit, activateTab } from '../components/viewer.js';

const CLI_LABEL = { claude: 'Claude', codex: 'Codex' };

// One entry per paired terminal. The tab carries the human title/kind/branch; an orphan PTY
// (its tab was closed but the contextful terminal kept alive) still shows, resolved by url.
function sessions() {
  const out = [];
  for (const [id, t] of state.terms) {
    if (!t.paired) continue;
    const url = t.pairKey || '';
    const tab = state.tabs.find(x => x.url === url) || null;
    const kind = tab?.kind || (jiraKeyFromUrl(url) ? 'jira' : 'github');
    out.push({ id, url, tab, kind, busy: !!t.busy, title: tab?.title || t.title || url,
               goal: t.goal || '', activity: t.activity || '', cli: t.cli || '' });
  }
  return out;
}

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

// Segmented step progress for a workflow run: filled = done, the current step pulses.
function progressHtml(wf) {
  const segs = Array.from({ length: wf.total }, (_, i) =>
    `<span class="tc-seg ${i < wf.step ? 'done' : ''} ${i === wf.step - 1 ? 'cur' : ''}"></span>`).join('');
  const label = `${esc(wf.name)} · step ${wf.step}/${wf.total}${wf.stepTitle ? ` · ${esc(wf.stepTitle)}` : ''}`;
  return `<div class="tc-wf"><div class="tc-segs">${segs}</div><div class="tc-wf-label">${label}</div></div>`;
}

function cardHtml(s) {
  const wf = workflowRunState(s.tab?.id);
  // A workflow is "working" even between steps; a bare session is working only while its CLI
  // turn is live (the hook-driven busy flag).
  const running = s.busy || !!wf;
  const cli = CLI_LABEL[s.cli] || CLI_LABEL[wf?.cli] || '';
  const meta = metaLine(s);
  // Live activity (this moment) takes the spotlight while running; otherwise the goal (what it
  // was asked) describes the task. Both render when known.
  const activity = running && s.activity
    ? `<div class="tc-activity"><span class="tc-activity-ic">${ICON.zap}</span>${esc(s.activity)}</div>` : '';
  const goal = s.goal ? `<div class="tc-goal">${esc(s.goal)}</div>` : '';
  return `<div class="task-card ${running ? 'running' : ''}" onclick="openTaskSession('${escJs(s.url)}')" title="${esc(s.url)}">
      <div class="tc-top">
        <span class="tc-state ${running ? 'live' : ''}"><span class="tc-dot"></span>${running ? 'Working' : 'Idle'}</span>
        ${cli ? `<span class="tc-cli">${esc(cli)}</span>` : ''}
      </div>
      <div class="tc-head">
        <span class="tc-ic">${TAB_ICON[s.kind] || TAB_ICON.github}</span>
        <span class="tc-title">${esc(s.title)}</span>
      </div>
      ${meta ? `<div class="tc-meta">${meta}</div>` : ''}
      ${goal}
      ${activity}
      ${wf ? progressHtml(wf) : ''}
    </div>`;
}

export function loadTasks() {
  const list = sessions();
  // Running first (active work on top), then by title for a stable order.
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
