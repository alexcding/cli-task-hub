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
import { esc, escJs, jiraKeyFromUrl, basename } from '../lib/util.js';
import { ICON, TAB_ICON } from '../lib/icons.js';
import { toast, toastErr } from '../components/toast.js';
import { workflowRunState } from '../components/workflow.js';
import { openInSplit, activateTab, closeTab } from '../components/viewer.js';
import { terminalTailLines, disposeTerm } from '../components/terminal.js';
import { resolveTabFolder, removeWorktree, worktreeHolders } from '../components/split.js';
import { analyzeTerminal } from '../services/analyzer.js';
import { unpersistTask } from '../services/tasks.js';

const CLI_LABEL = { claude: 'Claude', codex: 'Codex' };
const PREVIEW_LINES = 6; // lines of the live terminal preview shown while working

// One entry per TASK, keyed by url. The durable list is state.tasks (persisted — survives tab
// close, terminal death, app restart); each entry's runtime state is overlaid from state.terms
// (a paired terminal for that url ⇒ `live`/`busy`). A live terminal with no persisted task (legacy)
// still shows. The open tab, if any, supplies the freshest title/branch.
function sessions() {
  const byUrl = new Map();
  for (const task of state.tasks) {
    byUrl.set(task.url, { url: task.url, kind: task.kind || (jiraKeyFromUrl(task.url) ? 'jira' : 'github'),
      title: task.title || task.url, repo: task.repo || '', branch: task.branch || '', jiraKey: task.jiraKey || '',
      task, tab: null, termId: null, live: false, busy: false, cli: task.cli || '', summary: '', state: '' });
  }
  for (const [id, t] of state.terms) {
    if (!t.paired) continue;
    const url = t.pairKey || '';
    let s = byUrl.get(url);
    if (!s) { s = { url, kind: jiraKeyFromUrl(url) ? 'jira' : 'github', title: t.title || url, repo: '',
      branch: '', jiraKey: '', task: null, tab: null, termId: null, live: false, busy: false, cli: '', summary: '', state: '' };
      byUrl.set(url, s); }
    s.termId = id; s.live = true; s.busy = !!t.busy; s.cli = t.cli || s.cli; s.summary = t.summary || ''; s.state = t.state || '';
  }
  for (const s of byUrl.values()) {
    const tab = state.tabs.find(x => x.url === s.url);
    if (tab) { s.tab = tab; s.title = tab.title || s.title; s.kind = tab.kind || s.kind;
      s.repo = tab.repo || s.repo; s.branch = tab.branch || s.branch; s.jiraKey = tab.jiraKey || s.jiraKey; }
  }
  return [...byUrl.values()];
}

const previewHtml = lines => lines.length
  ? `<div class="tc-term-text">${esc(lines.join('\n'))}</div>`
  : '<div class="tc-term-text tc-term-empty">No output yet</div>';

// The project that owns a session, for the meta line — same lookups the workflow runner uses.
function projectName(s) {
  const p = s.kind === 'jira'
    ? projectByJiraKey(s.jiraKey || jiraKeyFromUrl(s.url))
    : (projectByRepo(s.repo) || projectByPrUrl(s.url));
  return p?.name || '';
}

// "project · branch-or-key" — whatever context we know, omitting blanks.
function metaLine(s) {
  const parts = [];
  const proj = projectName(s);
  if (proj) parts.push(esc(proj));
  if (s.kind === 'jira') { const k = s.jiraKey || jiraKeyFromUrl(s.url); if (k) parts.push(esc(k)); }
  else if (s.branch) parts.push(esc(s.branch));
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
  // Dormant task (no live terminal — e.g. after restart): a "Stopped" pill + resume hint, no preview.
  const pill = s.live ? statePill(running, s.state) : { label: 'Stopped', cls: '' };
  const body = !s.live
    ? '<div class="tc-summary tc-dormant">Not running — click to resume</div>'
    : (!running && s.summary)
      ? `<div class="tc-summary">${esc(s.summary)}</div>`
      : `<div class="tc-term" data-term="${esc(s.termId)}">${previewHtml(terminalTailLines(s.termId, PREVIEW_LINES))}</div>`;
  return `<div class="task-card ${running ? 'running' : ''}" onclick="openTaskSession('${escJs(s.url)}')" title="${esc(s.url)}">
      <div class="tc-top">
        <span class="tc-state ${pill.cls}"><span class="tc-dot"></span>${pill.label}</span>
        <span class="tc-actions">
          ${cli ? `<span class="tc-cli">${esc(cli)}</span>` : ''}
          <button class="tc-del" title="Delete task (removes its worktree)" onclick="event.stopPropagation();deleteTaskSession('${escJs(s.url)}')">${ICON.trash}</button>
        </span>
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

// The left-nav "Tasks" badge: how many sessions are running right now (busy terminal or a workflow
// in flight) — the same predicate the page uses for "working". Empty string when none, so the
// `.nav-count:empty` rule hides the badge entirely at 0. Updated on every busy↔idle edge
// (refreshTermBusy) and workflow step change (notifyTasksUpdated), so it stays live off-page too.
export function updateTasksBadge() {
  const el = document.getElementById('tasks-nav-count');
  if (!el) return;
  let n = 0;
  for (const [, t] of state.terms) {
    if (!t.paired) continue;
    const tab = state.tabs.find(x => x.url === (t.pairKey || ''));
    if (t.busy || workflowRunState(tab?.id)) n++;
  }
  el.textContent = n ? String(n) : '';
  el.title = n ? `${n} task${n === 1 ? '' : 's'} running` : '';
}

export function loadTasks() {
  updateTasksBadge();
  const list = sessions();
  // Working first, then live (running terminal) over dormant, then by title for a stable order.
  list.sort((a, b) => (Number(!!b.busy) - Number(!!a.busy)) || (Number(b.live) - Number(a.live)) || a.title.localeCompare(b.title));

  const countEl = document.getElementById('tasks-count');
  if (countEl) {
    const running = list.filter(s => s.busy || workflowRunState(s.tab?.id)).length;
    countEl.textContent = list.length
      ? `${list.length} task${list.length === 1 ? '' : 's'}${running ? ` · ${running} working` : ''}`
      : '';
  }

  const el = document.getElementById('tasks-list');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = `<div class="card"><div class="empty"><div class="empty-icon">${ICON.cpu}</div>
      <p>No tasks yet.</p>
      <p style="font-size:12px;margin-top:4px">Open a PR or ticket, hit New Task to start one. Tasks stay here — resumable — until you delete them.</p></div></div>`;
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
  // No open tab — open the link (carrying the task's metadata so the worktree resolves); expanding
  // the panel recovers the terminal via the persisted record (openPrPanel).
  const task = state.tasks.find(t => t.url === url);
  const kind = task?.kind || (jiraKeyFromUrl(url) ? 'jira' : 'github');
  openInSplit(url, task?.title || url, kind, { prSplit: true, repo: task?.repo, branch: task?.branch, jiraKey: task?.jiraKey });
}

// The card's trash button (keyed by url): delete the task. A task OWNS its worktree, so deleting it
// removes the worktree too — but never destroys unsaved work: `git worktree remove` is non-forced,
// so a dirty tree blocks removal (we keep everything and hint). Works for a DORMANT task (no live
// terminal): the worktree to remove comes from the persisted record, else a git resolve / cwd
// fallback. Clean → worktree removed + terminal stopped + tab closed + record forgotten.
export async function deleteTaskSession(url) {
  if (!url) return;
  const termPair = [...state.terms.entries()].find(([, t]) => t.paired && t.pairKey === url);
  const termId = termPair ? termPair[0] : null;
  const task = state.tasks.find(t => t.url === url);
  // Worktree to remove: prefer the persisted record (robust); else resolve via the tab; else the
  // live terminal's cwd if it sits under <ws>.worktrees (trailing slash guards against siblings).
  let ws = task?.workspace || '';
  let worktree = task?.worktree || '';
  if (!worktree) {
    const synthetic = { kind: jiraKeyFromUrl(url) ? 'jira' : 'github', url, jiraKey: jiraKeyFromUrl(url), repo: '', branch: '' };
    let info = null;
    try { info = await resolveTabFolder(state.tabs.find(x => x.url === url) || synthetic); } catch {}
    ws = (info && info.workspace) || ws;
    const wsRoot = ws.replace(/[/\\]+$/, '');
    const cwd = termId ? state.terms.get(termId)?.cwd : '';
    worktree = (info && info.isWorktree && info.path) ? info.path
      : (wsRoot && cwd && cwd.startsWith(`${wsRoot}.worktrees/`)) ? cwd : '';
  }
  const hasWorktree = !!(ws && worktree);
  // Probe for external apps sitting on the worktree (only here, on an explicit delete). They won't
  // block removal, but an open Xcode re-saves state into the just-removed folder and leaves a husk —
  // so name them in the confirm and nudge the user to quit them first. Advisory; never blocks.
  const holders = hasWorktree ? await worktreeHolders(worktree) : [];
  const holderWarn = holders.length
    ? `\n\nWarning: ${holders.map(h => h.command).join(', ')} ${holders.length === 1 ? 'is' : 'are'} open on this worktree — quit ${holders.length === 1 ? 'it' : 'them'} first, or leftover files may remain.`
    : '';
  const msg = hasWorktree
    ? `Delete this task?\n\nIts worktree (${basename(worktree)}) will be removed${termId ? ' and the terminal stopped' : ''}.${holderWarn}`
    : 'Delete this task?';
  if (!confirm(msg)) return;
  // Remove the worktree first; a dirty tree blocks it → keep everything and tell the user why.
  if (hasWorktree) {
    const r = await removeWorktree(ws, worktree);
    if (r.error) { toastErr(`Worktree kept — ${r.error}`); return; }
    toast('Worktree removed');
  }
  // Stop the terminal (if any) + close its tab, and forget the durable record. termId is cleared
  // before closeTab so closePairedTerm no-ops on the already-disposed PTY.
  const openTab = state.tabs.find(x => x.termId === termId) || state.tabs.find(x => x.url === url);
  if (termId) disposeTerm(termId);
  if (openTab) { openTab.termId = null; closeTab(openTab.id); }
  unpersistTask(url);
  loadTasks();
}
