// Stale-while-revalidate snapshot orchestration, shared by the PR and Jira routes.
// The UI always reads the snapshot the sync loop writes — never `gh`/`acli` directly.
// On read we kick a background sync if the snapshot is stale; when it lands the new
// data is pushed to open pages over SSE (see routes/sse.js).
const db = require('../database/db');
const poller = require('./poller');

// One staleness predicate, parameterized by max-age. A missing/NaN lastSynced is treated as
// stale (revalidate) — note `Date.now() - NaN > ms` is false, so the explicit !lastSynced
// guard is what forces a refresh for an absent/corrupt timestamp.
const staleAfter = ms => snap => !snap || !snap.lastSynced || (Date.now() - Date.parse(snap.lastSynced) > ms);

const isStale = staleAfter(30_000);
// Jira changes less often than PR CI, so its staleness window is longer.
const jiraStale = staleAfter(90_000);

// Return the cached snapshot for a project, revalidating in the background if stale.
function snapshotFor(project) {
  const snap = db.getSnapshot(project.id);
  if (project.repo && isStale(snap)) poller.syncProject(project).catch(() => {});
  return snap;
}

module.exports = { snapshotFor, jiraStale };
