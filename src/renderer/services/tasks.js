// Task persistence: a "New Task" (worktree + terminal) is durable — it survives the tab closing,
// the terminal dying, and an app restart, so people resume work from the Tasks page. The record
// lives in taskhub.db (ROUTES.TASKS) AND mirrored in state.tasks for the Tasks page to read.
// Created → persistTask; deleted (Tasks-page trash) → unpersistTask; on launch → loadPersistedTasks.
import { ROUTES } from '/shared/routes.mjs';
import { state } from '../stores/store.js';
import { api, apiJson } from './api.js';

// Read the durable task list into state.tasks (called at bootstrap). Leaves state.tasks intact on error.
export async function loadPersistedTasks() {
  try { const t = await api(ROUTES.TASKS); if (Array.isArray(t)) state.tasks = t; }
  catch { /* server briefly unreachable — keep whatever we have */ }
}

// Record a task (keyed by url). Optimistically updates state.tasks, then writes through to the db.
export async function persistTask(rec) {
  if (!rec || !rec.url) return;
  const i = state.tasks.findIndex(t => t.url === rec.url);
  if (i >= 0) state.tasks[i] = { ...state.tasks[i], ...rec };
  else state.tasks.push(rec);
  try { await apiJson(ROUTES.TASKS, 'POST', rec); } catch { /* will re-persist next change */ }
}

// Forget a task (the Tasks-page trash, after its worktree is removed).
export async function unpersistTask(url) {
  if (!url) return;
  state.tasks = state.tasks.filter(t => t.url !== url);
  try { await api(`${ROUTES.TASKS}?url=${encodeURIComponent(url)}`, { method: 'DELETE' }); } catch {}
}
