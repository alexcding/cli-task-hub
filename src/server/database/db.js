// Thin facade over the two SQLite stores, kept so every caller can keep doing
// `require('./db')` with the same API:
//   • configdb (taskhub.db) — durable app data: config, projects, links, events, tabs,
//                             settings, review_state
//   • datadb   (data.db)    — volatile CLI cache: PR + Jira snapshots
// The split is purpose, not technology: taskhub.db is source of truth; data.db is
// regenerable cache. db.get/set/getConfig map to the backend config k/v table.
const { dataDir } = require('./datadir');
const configdb = require('./configdb');
const datadb = require('./datadb');
const logdb = require('./logdb');

// Optional listener fired for every activity entry (category='event'), wired by the
// server bootstrap to fan-out over SSE (renderer toast + tray native notification).
// A setter (not a hard require of routes/sse) keeps the database layer dependency-free.
let _onActivity = null;

module.exports = {
  dataDir,

  // Config (backend k/v: poll_interval, JQL overrides, jira_base_url, …)
  get: configdb.configGet,
  set: configdb.configSet,
  getConfig: configdb.configAll,

  // Projects
  getProjects: configdb.getProjects,
  getProject: configdb.getProject,
  addProject: configdb.addProject,
  updateProject: configdb.updateProject,
  deleteProject: configdb.deleteProject,
  projectForRepo: configdb.projectForRepo,
  getForwardedRepos: configdb.getForwardedRepos,

  // Links (PR ↔ Jira)
  getLinks: configdb.getLinks,
  getLinksByPR: configdb.getLinksByPR,
  addLink: configdb.addLink,
  removeLink: configdb.removeLink,

  // Review-request tracking (per-PR requested_at / viewed_at) — see configdb.review_state
  getReviewState: configdb.getReviewState,
  setReviewRequestedAt: configdb.setReviewRequestedAt,
  setReviewViewed: configdb.setReviewViewed,
  pruneReviewStateForRepo: configdb.pruneReviewStateForRepo,

  // Activity feed + structured logs (logs.db). Events are just category='event';
  // other categories (webhook, poller, …) carry diagnostic logs. See lib/logdb.js.
  addEvent: (type, payload) => {
    const level = /fail|error/i.test(type) ? 'error' : 'info';
    const created_at = new Date().toISOString();
    logdb.addLog({ category: 'event', level, type, payload, created_at });
    // Push the new entry to live listeners (SSE → in-app toast / native notification).
    // Best-effort: a listener fault must never break the write that already committed.
    if (_onActivity) { try { _onActivity({ type, payload, level, created_at }); } catch { /* ignore */ } }
  },
  setActivityListener: (fn) => { _onActivity = fn; },
  getEvents: (limit) => logdb.getLogs({ category: 'event', limit }),
  addLog: logdb.addLog,
  getLogs: logdb.getLogs,
  logCategories: logdb.categories,
  clearLogs: logdb.clearLogs,

  // CLI result cache (PR + Jira snapshots) — backed by data.db
  getSnapshot: datadb.getSnapshot,
  getAllSnapshots: datadb.getAllSnapshots,
  setSnapshot: datadb.setSnapshot,
  deleteSnapshot: datadb.deleteSnapshot,
  getJiraSnapshot: datadb.getJiraSnapshot,
  getAllJiraSnapshots: datadb.getAllJiraSnapshots,
  setJiraSnapshot: datadb.setJiraSnapshot,
  deleteJiraSnapshot: datadb.deleteJiraSnapshot,
};

// One-time migration: the activity feed moved from taskhub.db's `events` table to logs.db
// (category='event'). Copy any pre-existing events across so history survives the upgrade,
// preserving their timestamps. Guarded by a config flag; best-effort, never blocks startup.
try {
  if (configdb.configGet('events_migrated_to_logs') !== '1') {
    const old = configdb.getEvents(500); // newest-first; the old events table is itself trimmed to 500, so this is the whole table
    // Insert oldest-first (so logs.db seq matches chronology) and atomically: a mid-copy
    // failure rolls the whole batch back, so the flag stays unset and the next run retries
    // from a clean slate rather than duplicating the rows that already landed.
    logdb.transaction(() => {
      for (const e of old.reverse()) {
        logdb.addLog({
          category: 'event',
          level: /fail|error/i.test(e.type) ? 'error' : 'info',
          type: e.type,
          payload: e.payload, // already a JSON string from the events table
          created_at: e.created_at,
        });
      }
    });
    configdb.configSet('events_migrated_to_logs', '1');
  }
} catch (err) {
  console.error('[db] events→logs migration skipped:', err.message);
}
