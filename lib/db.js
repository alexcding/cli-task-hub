// Thin facade over the two SQLite stores, kept so every caller can keep doing
// `require('./db')` with the same API:
//   • configdb (config.db) — durable app data: config, projects, links, events, tabs, settings
//   • datadb   (data.db)   — volatile CLI cache: PR + Jira snapshots
// The split is purpose, not technology: config.db is source of truth; data.db is
// regenerable cache. db.get/set/getConfig map to the backend config k/v table.
const { dataDir } = require('./datadir');
const configdb = require('./configdb');
const datadb = require('./datadb');
const logdb = require('./logdb');

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

  // Activity feed + structured logs (logs.db). Events are just category='event';
  // other categories (webhook, poller, …) carry diagnostic logs. See lib/logdb.js.
  addEvent: (type, payload) => logdb.addLog({ category: 'event', level: /fail|error/i.test(type) ? 'error' : 'info', type, payload }),
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

// One-time migration: the activity feed moved from config.db's `events` table to logs.db
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
