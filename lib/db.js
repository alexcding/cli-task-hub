// Thin facade over the two SQLite stores, kept so every caller can keep doing
// `require('./db')` with the same API:
//   • configdb (config.db) — durable app data: config, projects, links, events, tabs, settings
//   • datadb   (data.db)   — volatile CLI cache: PR + Jira snapshots
// The split is purpose, not technology: config.db is source of truth; data.db is
// regenerable cache. db.get/set/getConfig map to the backend config k/v table.
const { dataDir } = require('./datadir');
const configdb = require('./configdb');
const datadb = require('./datadb');

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
  getAllRepos: configdb.getAllRepos,

  // Links (PR ↔ Jira)
  getLinks: configdb.getLinks,
  getLinksByPR: configdb.getLinksByPR,
  addLink: configdb.addLink,
  removeLink: configdb.removeLink,

  // Events
  addEvent: configdb.addEvent,
  getEvents: configdb.getEvents,

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
