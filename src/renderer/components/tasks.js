// Task actions behind the sidebar's task rows and the "+" buttons (components/sidebar.js renders
// them from services/tasks.js → taskSessions()): create a task (always on a worktree), open/resume
// one, delete one (terminal + record) or a whole worktree (forced, with its tasks), and the idle-time analysis that
// labels a row's state. The terminal read + extraction and the analysis are the SAME ones the
// workflow runner uses to gate its loop — extract once, analyze once, two consumers.
import { ROUTES } from '/shared/routes.mjs';
import { state, projectById } from '../stores/store.js';
import { apiJson } from '../services/api.js';
import { basename } from '../lib/util.js';
import { toast, toastErr } from './toast.js';
import { workflowRunState } from './workflow.js';
import { openInSplit, activateTab, closeTab } from './viewer.js';
import { createTermView, activateTerminal, closeTerminal, disposeTerm } from './terminal.js';
import { removeWorktree, worktreeHolders } from './split.js';
import { renderTabs } from './sidebar.js';
import { inlineConfirm } from './inline-confirm.js';
import { launchCli } from './cli-launch.js';
import { analyzeTerminal } from '../services/analyzer.js';
import { newTaskId, persistTask, unpersistTask, taskById, taskTerm, loadWorktrees } from '../services/tasks.js';

// Create a worktree for `branch` under the project (idempotent: an existing worktree for that
// branch is adopted). A non-worktree folder in the way is confirmed before it is replaced.
// Returns the worktree path, or null when the user declined / it failed (toasted).
export async function ensureWorktree(project, branch, { create = true } = {}) {
  let r = await apiJson(ROUTES.WORKTREE, 'POST', { path: project.workspace, branch, create });
  if (r && r.folderConflict) {
    const what = r.disposable
      ? `A leftover folder (only editor state, no source) is at:\n${r.path}\n\nDelete it and create the worktree here?`
      : `A folder already exists at:\n${r.path}\n\nIt isn't a git worktree and may contain files. Delete it and create the worktree here?`;
    if (!confirm(what)) return null;
    r = await apiJson(ROUTES.WORKTREE, 'POST', { path: project.workspace, branch, create, override: true });
  }
  if (!r || r.error) { toastErr(r?.error || 'Worktree creation failed'); return null; }
  loadWorktrees(project); // refresh the sidebar's worktree list
  return r.path;
}

// Sidebar "+" on a project: a NEW worktree (branch name asked) with a task on it.
export async function newWorktreeTask(projectId) {
  const project = projectById(projectId);
  if (!project?.workspace) { toastErr('Project has no local workspace'); return; }
  const branch = (prompt('Branch name for the new worktree', '') || '').trim();
  if (!branch) return;
  const worktree = await ensureWorktree(project, branch);
  if (!worktree) return;
  await createTask(project, worktree, { branch });
}

// Sidebar "+" on a worktree row: another task on that worktree.
export async function newWorktreeTaskIn(projectId, worktree) {
  const project = projectById(projectId);
  if (!project?.workspace || !worktree) return;
  const wt = (state.worktrees[project.id] || []).find(w => w.path === worktree);
  await createTask(project, worktree, { branch: wt?.branch || '' });
}

// Record a task on `worktree` and open its terminal as a standalone view (no linked page).
async function createTask(project, worktree, { branch = '' } = {}) {
  const task = await persistTask({ id: newTaskId(), projectId: project.id, workspace: project.workspace, worktree,
    branch, title: basename(worktree), kind: '', url: '', jiraKey: '', cli: '', sessionId: '' });
  try {
    const termId = await createTermView(worktree, task.title, { paired: true, pairKey: task.id });
    activateTerminal(termId);
  } catch (e) { toastErr('Terminal failed: ' + e.message); }
}

// Analyze a session's last message into { summary, state } — called ONLY when its turn-done (Stop)
// hook fires (see app.js), never on render. Skips sessions a workflow run is driving (the runner
// makes its own analyze call with decision context); everything else (settle, dedupe, gen guard,
// recording, failure cleanup) lives in the shared analyzeTerminal service. A result re-renders the
// sidebar so the row's state dot + summary tooltip update.
export function analyzeSession(termId) {
  const t = state.terms.get(termId);
  if (!t || !t.paired) return;
  const task = taskById(t.pairKey);
  const tab = state.tabs.find(x => x.termId === termId) || (task?.url ? state.tabs.find(x => x.url === task.url) : null);
  if (tab && workflowRunState(tab.id)) return; // workflow runner handles its own steps
  analyzeTerminal(termId).then(r => { if (r) renderTabs(); });
}

// Click a task row. A task linked to a page: focus its open tab (revealing the working terminal),
// or reopen the link — the panel re-adopts the surviving terminal by task id, and a stopped task's
// agent is resumed by openPrPanel. A standalone task: show its terminal full-width, recreating it
// on its worktree (and resuming the agent) if the shell is gone.
export async function openTaskSession(id) {
  const task = taskById(id);
  if (!task) return;
  if (task.url) {
    const tab = state.tabs.find(t => t.url === task.url);
    if (tab) { tab.prSplit = true; activateTab(tab.id); return; }
    const kind = task.kind || 'github';
    openInSplit(task.url, task.title || task.url, kind, { prSplit: true, jiraKey: task.jiraKey });
    return;
  }
  const live = taskTerm(task);
  if (live) { activateTerminal(live[0]); return; }
  try {
    const termId = await createTermView(task.worktree, task.title, { paired: true, pairKey: task.id });
    activateTerminal(termId);
    if (task.cli) {
      const r = await launchCli(termId, null, task.cli, { sessionId: task.sessionId || '', resume: !!task.sessionId });
      if (r?.sessionId && r.sessionId !== task.sessionId) persistTask({ id: task.id, sessionId: r.sessionId });
    }
  } catch (e) { toastErr('Terminal failed: ' + e.message); }
}

// The row the trash click came from (inline confirm anchors under it).
const rowOf = ev => ev?.target?.closest?.('.opentab, .wt-row') || null;

// The task row's trash: delete the TASK — stop its terminal (inline Delete/Cancel while a shell is
// live) and forget the record. The worktree is untouched; removing it is the worktree row's own
// trash (deleteWorktree). A STOPPED task goes without asking — nothing is running.
export async function deleteTaskSession(id, ev) {
  const task = taskById(id);
  if (!task) return;
  const live = taskTerm(task);
  const termId = live ? live[0] : null;
  if (termId && !(await inlineConfirm(rowOf(ev), { text: 'Stop the terminal and delete this task? The worktree stays.' }))) return;
  await removeTaskRecord(task, termId);
}

// Stop a task's terminal (if any), close its linked tab, and forget the record. termId is cleared
// on the tab before closeTab so closePairedTerm no-ops on the already-disposed PTY.
async function removeTaskRecord(task, termId) {
  const openTab = task.url ? (state.tabs.find(x => x.termId === termId) || state.tabs.find(x => x.url === task.url)) : null;
  if (termId) { if (state.activeTermId === termId) closeTerminal(termId); else disposeTerm(termId); }
  if (openTab) { openTab.termId = null; closeTab(openTab.id); }
  await unpersistTask(task.id);
}

// The worktree row's trash: delete the WORKTREE and every task on it — everything, after ONE inline
// Delete/Cancel that spells it out: uncommitted changes lost, apps lsof sees holding files there
// (Xcode is told to close its documents), the tasks' terminals stopped. Forced on the server, so a
// stale or unregistered worktree never blocks; the branch itself is kept.
export async function deleteWorktree(projectId, worktree, ev) {
  const project = projectById(projectId);
  if (!project?.workspace || !worktree) return;
  const row = rowOf(ev);
  const tasks = state.tasks.filter(t => t.worktree === worktree);
  const holders = await worktreeHolders(worktree);
  const parts = ['Delete the folder — uncommitted changes are lost'];
  if (tasks.length) parts.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'} stopped`);
  if (holders.length) parts.push(`${holders.map(h => h.command).join(', ')} ${holders.length === 1 ? 'has' : 'have'} files open${holders.some(h => /xcode/i.test(h.command)) ? ' (Xcode will close them)' : ''}`);
  if (!(await inlineConfirm(row, { text: parts.join(' · ') + '.' }))) return;
  for (const task of tasks) { const live = taskTerm(task); await removeTaskRecord(task, live ? live[0] : null); }
  const r = await removeWorktree(project.workspace, worktree, { force: true });
  if (r.error) toastErr(`Worktree could not be removed — ${r.error}`);
  else toast('Worktree removed');
  loadWorktrees(project);
}
