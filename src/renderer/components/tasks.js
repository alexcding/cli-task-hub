// Task actions behind the sidebar's task rows and the "+" buttons (components/sidebar.js renders
// them from services/tasks.js → taskSessions()): create a task (always on a worktree), open/resume
// one, delete one (terminal + record) or a whole worktree (forced, with its tasks), and the idle-time analysis that
// labels a row's state. The terminal read + extraction and the analysis are the SAME ones the
// workflow runner uses to gate its loop — extract once, analyze once, two consumers.
import { ROUTES } from '/shared/routes.mjs';
import { state, projectById } from '../stores/store.js';
import { api, apiJson } from '../services/api.js';
import { basename, sessionUrl } from '../lib/util.js';
import { toast, toastErr } from './toast.js';
import { workflowRunState } from './workflow.js';
import { openInSplit, activateTab, removeTaskTab } from './viewer.js';
import { closeTerminal, disposeTerm } from './terminal.js';
import { removeWorktree, worktreeHolders } from './split.js';
import { renderTabs } from './sidebar.js';
import { confirmDialog } from './confirm.js';
import { analyzeTerminal } from '../services/analyzer.js';
import { newTaskId, persistTask, unpersistTask, taskById, taskTerm } from '../services/tasks.js';
import { newSessionDialog } from './new-session-dialog.js';

// Create a worktree for `branch` under the project (idempotent: an existing worktree for that
// branch is adopted). A brand-new branch forks from `base` (else the repo's default branch). A
// non-worktree folder in the way is confirmed (in-app — the webview swallows native confirm())
// before it is replaced. Returns the worktree path, or null when the user declined / it failed (toasted).
export async function ensureWorktree(project, branch, { create = true, base = '' } = {}) {
  const body = { path: project.workspace, branch, create, ...(base && { base }) };
  let r = await apiJson(ROUTES.WORKTREE, 'POST', body);
  if (r && r.folderConflict) {
    const message = r.disposable
      ? `A leftover folder (only editor state, no source) is at ${r.path}. Delete it and create the worktree here?`
      : `A folder already exists at ${r.path}. It isn't a git worktree and may contain files. Delete it and create the worktree here?`;
    if (!(await confirmDialog({ title: 'Replace folder?', message, label: 'Delete & create' }))) return null;
    r = await apiJson(ROUTES.WORKTREE, 'POST', { ...body, override: true });
  }
  if (!r || r.error) { toastErr(r?.error || 'Worktree creation failed'); return null; }
  return r.path;
}

// Sidebar "+" on a project: the New session dialog (branch name, base branch, agent), then a NEW
// worktree with a task on it and the chosen agent launched in its terminal.
export async function newWorktreeTask(projectId) {
  const project = projectById(projectId);
  if (!project?.workspace) { toastErr('Project has no local workspace'); return; }
  const pick = await newSessionDialog(project);
  if (!pick) return;
  // A LINK names a specific piece of work, and that work has one checkout: if this project already
  // has a worktree for that ticket or that PR's branch, the session runs there instead of forking a
  // second one beside it. Only for a link — a typed branch name is a request to make a new branch,
  // and two sessions on two new branches are two different things.
  // It matters most for a ticket: its branch carries the summary (feature/KEY-what-broke), so the
  // name derived before the summary loaded and the one derived after are different strings for the
  // same ticket. The key is the identity; the server matches on it (worktreeForJiraKey).
  const existing = pick.page ? await existingWorktree(project, pick.page, pick.branch) : null;
  const fromPr = pick.page?.kind === 'github';
  // A PR's head branch already exists on the remote, so its worktree adopts it rather than forking.
  const worktree = existing?.path || await ensureWorktree(project, pick.branch, { base: pick.base, create: !fromPr });
  if (!worktree) return;
  await createTask(project, worktree, { branch: existing?.branch || pick.branch, cli: pick.cli, page: pick.page });
}

// This project's existing worktree for a pasted PR/ticket, or null. The match is the server's
// (ROUTES.WORKTREE: exact branch for a PR, the key embedded in a branch name for a ticket, and
// nothing when two worktrees both match — ambiguous is not reuse). The main checkout is never it:
// a session runs on a worktree. The second call is only to learn that worktree's own branch, which
// may differ from the one we derived.
async function existingWorktree(project, page, branch) {
  const q = page.kind === 'jira' ? `key=${encodeURIComponent(page.jiraKey)}` : `branch=${encodeURIComponent(branch || '')}`;
  if (q.endsWith('=')) return null;
  const found = await api(`${ROUTES.WORKTREE}?path=${encodeURIComponent(project.workspace)}&${q}`).catch(() => null);
  if (!found?.matched || !found.isWorktree) return null;
  const all = await api(`${ROUTES.WORKTREES}?path=${encodeURIComponent(project.workspace)}`).catch(() => []);
  return { path: found.path, branch: (all || []).find(w => w.path === found.path)?.branch || branch };
}

// Record a task on `worktree` and open it. A session with no page of its own still gets a CONTEXT
// (a viewer tab on a synthetic `session:` url), so from here on it is indistinguishable from a
// PR/Jira-backed session: the same tab opens the same terminal panel, split toggle, diff view and
// web tabs. `cli` is stamped on the record first, which is what makes openPrPanel launch that agent
// (and, later, resume the same conversation) — one launch path, not a second one here.
// A session started from a PR or a ticket is NAMED by it — "RECORD-8383 Something broke", the PR's
// title — because that is what you are looking for in the sidebar; the worktree folder is a detail
// of where it runs. A session with no page keeps the folder name, which is all it has.
// Capped: a Jira summary or a PR title runs to whatever length its author felt like, and the row is
// one line in a narrow sidebar — it is also the tooltip, the tray entry and the terminal's title.
// Cut at the last word boundary, with NO ellipsis: the row's own CSS ellipsis is what says "there
// was more", and a second one baked into the string reads as part of the name.
const TITLE_MAX = 60;
function capTitle(t) {
  if (!t || t.length <= TITLE_MAX) return t;
  const cut = t.slice(0, TITLE_MAX);
  const sp = cut.lastIndexOf(' ');
  return (sp > TITLE_MAX / 2 ? cut.slice(0, sp) : cut).trimEnd();
}

async function createTask(project, worktree, { branch = '', cli = '', page = null } = {}) {
  const id = newTaskId();
  // `page` also decides what the context SHOWS — the PR/ticket page it was started from, or the
  // synthetic session: url that has no page of its own. Everything downstream (terminal, split,
  // diff, tabs) is the one code path either way.
  const title = capTitle(page?.title) || basename(worktree);
  const task = await persistTask({ id, projectId: project.id, workspace: project.workspace, worktree,
    branch, title, kind: page?.kind || 'web', url: page?.url || sessionUrl(id), jiraKey: page?.jiraKey || '',
    cli, sessionId: '', createdAt: new Date().toISOString() });
  openInSplit(task.url, title, task.kind, { jiraKey: task.jiraKey });
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

// Click a task row — ONE path for every session, page-backed or not: focus its context tab if it's
// open, else open it. The panel re-adopts the surviving terminal by task id, and a stopped task's
// terminal is recreated on its recorded worktree with its agent resumed (openPrPanel). A session
// recorded before contexts were universal has no url — give it one now (its terminal, if still
// running, is keyed by task id, so it is re-adopted rather than restarted).
export async function openTaskSession(id) {
  let task = taskById(id);
  if (!task) return;
  if (!task.url) task = await persistTask({ id: task.id, kind: 'web', url: sessionUrl(task.id) });
  const tab = state.tabs.find(t => t.url === task.url);
  if (tab) { activateTab(tab.id); return; }
  openInSplit(task.url, task.title || task.url, task.kind || 'github', { jiraKey: task.jiraKey });
}

// Stop a task's terminal (if any), drop its linked tab, and forget the record. This is the ONLY
// place a task's tab is removed (closeTab refuses task tabs). termId is cleared on the tab first so
// closePairedTerm no-ops on the already-disposed PTY.
async function removeTaskRecord(task, termId) {
  const openTab = task.url ? (state.tabs.find(x => x.termId === termId) || state.tabs.find(x => x.url === task.url)) : null;
  if (termId) { if (state.activeTermId === termId) closeTerminal(termId); else disposeTerm(termId); }
  if (openTab) { openTab.termId = null; removeTaskTab(openTab.id); }
  await unpersistTask(task.id);
}

// THE single worktree-removal path — the session row's Remove session (deleteTaskSession) and the
// folder chip's Delete worktree both come here. Removes EVERY session record on the
// worktree (a url-linked task from a PR tab can share the folder with a standalone one), after ONE
// confirm dialog that spells it out — terminals stopped, the folder removed (uncommitted changes
// lost, the branch kept), apps lsof sees holding files there (Xcode is told to close its documents).
// Forced on the server, so a stale or unregistered worktree never blocks. Resolves true on removal.
export async function deleteWorktreeAt(workspace, worktree) {
  if (!workspace || !worktree) return false;
  const tasks = state.tasks.filter(t => t.worktree === worktree);
  const liveCount = tasks.filter(t => taskTerm(t)).length;
  const holders = await worktreeHolders(worktree);
  const parts = [];
  if (tasks.length > 1) parts.push(`${tasks.length} sessions share this worktree — all are removed.`);
  parts.push(`${liveCount ? (liveCount === 1 ? 'Its terminal is stopped and the' : 'Their terminals are stopped and the') : 'The'} worktree folder is removed; uncommitted changes there are lost, the branch is kept.`);
  if (holders.length) parts.push(`${holders.map(h => h.command).join(', ')} ${holders.length === 1 ? 'has' : 'have'} files open there${holders.some(h => /xcode/i.test(h.command)) ? ' (Xcode will close them)' : ''}.`);
  const title = tasks.length ? `Remove session “${basename(worktree)}”?` : `Delete worktree “${basename(worktree)}”?`;
  if (!(await confirmDialog({ title, message: parts.join(' '), label: tasks.length ? 'Remove' : 'Delete' }))) return false;
  for (const task of tasks) { const live = taskTerm(task); await removeTaskRecord(task, live ? live[0] : null); }
  const r = await removeWorktree(workspace, worktree, { force: true });
  if (r.error) { toastErr(`Worktree could not be removed — ${r.error}`); return false; }
  toast(tasks.length ? 'Session removed' : 'Worktree removed');
  return true;
}

// Session row → Remove session: the session and its worktree go together (one unit).
export async function deleteTaskSession(id) {
  const task = taskById(id);
  if (!task) return;
  const project = projectById(task.projectId);
  // Project gone (orphan): there is no workspace to remove a worktree from — stop the terminal and
  // forget the record; the folder is left alone.
  if (!project?.workspace || !task.worktree) {
    const name = basename(task.worktree || '') || task.title || 'session';
    if (!(await confirmDialog({ title: `Remove session “${name}”?`, message: 'Its project is no longer configured; the terminal is stopped and the session forgotten. The folder is left alone.', label: 'Remove' }))) return;
    const live = taskTerm(task);
    await removeTaskRecord(task, live ? live[0] : null);
    return;
  }
  await deleteWorktreeAt(project.workspace, task.worktree);
}
