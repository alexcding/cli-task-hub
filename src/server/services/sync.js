// Stale-while-revalidate snapshot orchestration, shared by the PR and Jira routes.
// The UI always reads the snapshot the sync loop writes — never `gh`/`acli` directly.
// On read we kick a background sync if the snapshot is stale; when it lands the new
// data is pushed to open pages over SSE (see routes/sse.js).
const db = require('../database/db');
const poller = require('./poller');

// Missing or corrupt timestamps must trigger revalidation too.
const staleAfter = ms => snap => !Number.isFinite(Date.parse(snap?.lastSynced)) || (Date.now() - Date.parse(snap.lastSynced) > ms);

const isStale = staleAfter(30_000);
// Jira changes less often than PR CI, so its staleness window is longer.
const jiraStale = staleAfter(90_000);

// Return the cached snapshot for a project, revalidating in the background if stale.
function snapshotFor(project) {
  const snap = db.getSnapshot(project.id);
  if (project.repo && isStale(snap)) poller.syncProject(project).catch(() => {});
  return snap;
}

function prSnapshotFor(project, state, force = false) {
  if (!project.repo) return { prs: [], lastSynced: null, error: null, refreshing: false };
  const snap = state === 'open' ? db.getSnapshot(project.id) : db.getPRScopeSnapshot(project, state);
  if (force || isStale(snap)) {
    (state === 'open' ? poller.syncProject(project) : poller.syncPRScope(project, state)).catch(() => {});
  }
  return { prs: snap?.prs || [], lastSynced: snap?.lastSynced || null, error: snap?.error || null,
    refreshing: poller.prScopeSyncing(project, state) };
}

module.exports = { snapshotFor, prSnapshotFor, jiraStale };
