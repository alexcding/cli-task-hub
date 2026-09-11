// Tasks: one agent session on a worktree of a project. The durable record lives in taskhub.db
// (ROUTES.TASKS) and is mirrored in state.tasks; the paired terminal's pairKey is the task id. A task
// is created from the sidebar ("+" on a project = new worktree + task) or from a PR/Jira tab's New
// Task, which links it to that tab by url (and may land on a worktree that already has a task —
// removal always takes every task on the folder, see components/tasks.js → deleteWorktreeAt). Every change re-renders the sidebar (window.__refreshTabs — the bridge avoids
// a services→components import).
import { ROUTES } from '/shared/routes.mjs';
import { state } from '../stores/store.js';
import { api, apiJson } from './api.js';
import { basename } from '../lib/util.js';

const refreshSidebar = () => window.__refreshTabs?.();

export const newTaskId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

// Read the durable task list into state.tasks (called at bootstrap). Leaves state.tasks intact on error.
export async function loadPersistedTasks() {
  try { const t = await api(ROUTES.TASKS); if (Array.isArray(t)) state.tasks = t; }
  catch { /* server briefly unreachable — keep whatever we have */ }
  refreshSidebar();
}

// Record a task (keyed by id). Optimistically updates state.tasks, then writes through to the db.
// A partial record merges into the stored one (the server upsert replaces every column).
export async function persistTask(rec) {
  if (!rec || !rec.id) return null;
  const i = state.tasks.findIndex(t => t.id === rec.id);
  const merged = i >= 0 ? { ...state.tasks[i], ...rec } : { ...rec };
  if (i >= 0) state.tasks[i] = merged; else state.tasks.push(merged);
  refreshSidebar();
  try { await apiJson(ROUTES.TASKS, 'POST', merged); } catch { /* will re-persist next change */ }
  return merged;
}

// Forget a task (the row's trash, after its worktree is dealt with).
export async function unpersistTask(id) {
  if (!id) return;
  state.tasks = state.tasks.filter(t => t.id !== id);
  refreshSidebar();
  try { await api(`${ROUTES.TASKS}?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch {}
}

export const taskById = id => state.tasks.find(t => t.id === id) || null;
// The tasks linked to a PR/Jira tab (by url). A tab's terminal pane shows the first one with a
// live terminal, else the first one.
const tasksForUrl = url => (url ? state.tasks.filter(t => t.url === url) : []);
export const taskTerm = task => [...state.terms.entries()].find(([, t]) => t.paired && t.pairKey === task.id) || null;
export function taskForTab(tab) {
  const list = tasksForUrl(tab?.url);
  return list.find(t => taskTerm(t)) || list[0] || null;
}
// The urls that are tasks — their tabs render as task rows, not as plain open-tab rows.
export const taskUrls = () => new Set(state.tasks.filter(t => t.url).map(t => t.url));

// One entry per TASK with its runtime state overlaid from state.terms (the paired terminal keyed by
// the task id ⇒ `live`/`busy`, plus the analyzer's summary/state). The linked open tab, if any,
// supplies the freshest title.
export function taskSessions() {
  return state.tasks.map(task => {
    const s = { ...task, title: task.title || basename(task.worktree) || task.branch || task.url, tab: null, termId: null,
      live: false, busy: false, summary: '', state: '' };
    const term = taskTerm(task);
    if (term) { const [id, t] = term; s.termId = id; s.live = true; s.busy = !!t.busy; s.cli = t.cli || s.cli; s.summary = t.summary || ''; s.state = t.state || ''; }
    const tab = task.url ? state.tabs.find(x => x.url === task.url) : null;
    if (tab) { s.tab = tab; s.title = tab.title || s.title; }
    return s;
  });
}

