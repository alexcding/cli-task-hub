// Stale-while-revalidate snapshot orchestration, shared by the PR and Jira routes.
// The UI always reads the snapshot the sync loop writes — never `gh`/`acli` directly.
// On read we kick a background sync if the snapshot is stale; when it lands the new
// data is pushed to open pages over SSE (see routes/sse.js).
const db = require('../database/db');
const poller = require('./poller');

const STALE_MS = 30_000;

function isStale(snap) {
  return !snap || !snap.lastSynced || (Date.now() - Date.parse(snap.lastSynced) > STALE_MS);
}

// Return the cached snapshot for a project, revalidating in the background if stale.
function snapshotFor(project) {
  const snap = db.getSnapshot(project.id);
  if (project.repo && isStale(snap)) poller.syncProject(project).catch(() => {});
  return snap;
}

// Jira changes less often than PR CI, so the staleness window is longer.
const JIRA_STALE_MS = 90_000;
const jiraStale = snap => !snap || !snap.lastSynced || (Date.now() - Date.parse(snap.lastSynced) > JIRA_STALE_MS);

module.exports = { snapshotFor, jiraStale };
