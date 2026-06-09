// ── config.db — the app's durable database (SQLite via Node's built-in node:sqlite) ──
// Single source of truth for everything the app owns and must keep across restarts:
//   • projects / links / events / config — domain data (was taskhub.json)
//   • tabs / settings                     — UI prefs (open viewer tabs, theme, filters)
// The volatile CLI cache (PR + Jira snapshots) lives separately in data.db (lib/datadb.js),
// so it can be wiped/rebuilt without touching anything here.
//
// node:sqlite is bundled with Node 22+ / Electron 24+ (the packaged app runs under
// Electron's Node), so there's no native dependency to rebuild. Data volumes are tiny,
// but rows give us per-record atomic writes (vs. rewriting a whole JSON file) and real
// relations for projects↔links.
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { dataDir } = require('./datadir');
const datadb = require('./datadb'); // cache store — deleteProject cascades into it

const dbPath = path.join(dataDir, 'config.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS config   (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS projects (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL DEFAULT '',
    color            TEXT NOT NULL DEFAULT '#6366f1',
    repo             TEXT NOT NULL DEFAULT '',
    workspace        TEXT NOT NULL DEFAULT '',
    jira_project_key TEXT NOT NULL DEFAULT '',
    jql              TEXT NOT NULL DEFAULT '',
    merge_transition TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS links (
    id         TEXT PRIMARY KEY,
    pr_number  INTEGER,
    pr_repo    TEXT,
    jira_key   TEXT,
    project_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT,
    type       TEXT,
    payload    TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tabs (
    url      TEXT PRIMARY KEY,
    kind     TEXT NOT NULL,
    title    TEXT,
    repo     TEXT,
    branch   TEXT,
    pr_split INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    active   INTEGER NOT NULL DEFAULT 0
  );
`);

// Columns added after a table first shipped — idempotent (throws "duplicate column"
// on DBs that already have them, which we ignore). Keeps existing installs in sync.
for (const stmt of [
  `ALTER TABLE tabs ADD COLUMN category TEXT NOT NULL DEFAULT ''`,
]) { try { db.exec(stmt); } catch { /* column already exists */ } }

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// ── Config (backend k/v: poll_interval, JQL overrides, jira_base_url, …) ─────────
const configGet = key => { const r = db.prepare('SELECT value FROM config WHERE key = ?').get(key); return r ? r.value : null; };
const configSet = (key, val) => db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(val));
const configAll = () => Object.fromEntries(db.prepare('SELECT key, value FROM config').all().map(r => [r.key, r.value]));

// ── Projects ──────────────────────────────────────────────────────────────────
// Object shape (camelCase) matches the old JSON store; columns are snake_case.
const PROJECT_FIELDS = ['name', 'color', 'repo', 'workspace', 'jiraProjectKey', 'jql', 'mergeTransition'];
const COL = { name: 'name', color: 'color', repo: 'repo', workspace: 'workspace', jiraProjectKey: 'jira_project_key', jql: 'jql', mergeTransition: 'merge_transition' };
const _project = r => r && {
  id: r.id, name: r.name, color: r.color, repo: r.repo, workspace: r.workspace,
  jiraProjectKey: r.jira_project_key, jql: r.jql, mergeTransition: r.merge_transition, created_at: r.created_at,
};

const getProjects = () => db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all().map(_project);
const getProject  = id => _project(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));

const addProject = (fields = {}) => {
  const p = {
    id: uuid(), name: fields.name || '', color: fields.color || '#6366f1',
    repo: fields.repo || '', workspace: fields.workspace || '',
    jiraProjectKey: fields.jiraProjectKey || '', jql: fields.jql || '',
    mergeTransition: fields.mergeTransition || '', created_at: fields.created_at || now(),
  };
  db.prepare(`INSERT INTO projects (id, name, color, repo, workspace, jira_project_key, jql, merge_transition, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.id, p.name, p.color, p.repo, p.workspace, p.jiraProjectKey, p.jql, p.mergeTransition, p.created_at);
  return p;
};

const updateProject = (id, patch = {}) => {
  if (!getProject(id)) return null;
  const sets = [], vals = [];
  for (const f of PROJECT_FIELDS) if (patch[f] !== undefined) { sets.push(`${COL[f]} = ?`); vals.push(patch[f]); }
  if (sets.length) db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getProject(id);
};

const deleteProject = id => {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  db.prepare('DELETE FROM links WHERE project_id = ?').run(id);
  datadb.deleteSnapshot(id);
  datadb.deleteJiraSnapshot(id);
};

const projectForRepo = repo => _project(db.prepare('SELECT * FROM projects WHERE repo = ? LIMIT 1').get(repo));
const getAllRepos = () => db.prepare("SELECT DISTINCT repo FROM projects WHERE repo <> ''").all().map(r => r.repo);

// ── Links (PR ↔ Jira) ───────────────────────────────────────────────────────────
const _link = r => ({ id: r.id, pr_number: r.pr_number, pr_repo: r.pr_repo, jira_key: r.jira_key, project_id: r.project_id, created_at: r.created_at });
const getLinks = projectId => (projectId
  ? db.prepare('SELECT * FROM links WHERE project_id = ?').all(projectId)
  : db.prepare('SELECT * FROM links').all()).map(_link);
const getLinksByPR = (prNumber, prRepo) =>
  db.prepare('SELECT * FROM links WHERE pr_number = ? AND pr_repo = ?').all(prNumber, prRepo).map(_link);

const addLink = (prNumber, prRepo, jiraKey, projectId = null) => {
  const key = jiraKey.toUpperCase();
  const dup = db.prepare('SELECT 1 FROM links WHERE pr_number = ? AND pr_repo = ? AND jira_key = ?').get(prNumber, prRepo, key);
  if (dup) return;
  db.prepare('INSERT INTO links (id, pr_number, pr_repo, jira_key, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuid(), prNumber, prRepo, key, projectId || null, now());
};
const removeLink = id => db.prepare('DELETE FROM links WHERE id = ?').run(id);

// ── Events (capped activity log) ─────────────────────────────────────────────────
const addEvent = (type, payload) => {
  db.prepare('INSERT INTO events (id, type, payload, created_at) VALUES (?, ?, ?, ?)')
    .run(uuid(), type, JSON.stringify(payload), now());
  db.prepare('DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - 500').run();
};
const getEvents = (limit = 100) =>
  db.prepare('SELECT id, type, payload, created_at FROM events ORDER BY seq DESC LIMIT ?').all(limit);

// ── Tabs (open viewer tabs — see openInSplit/restoreTabs in the renderer) ────────
function getTabs() {
  const rows = db.prepare('SELECT * FROM tabs ORDER BY position ASC').all();
  const active = rows.find(r => r.active);
  return {
    tabs: rows.map(r => ({ kind: r.kind, title: r.title, url: r.url, repo: r.repo || '', branch: r.branch || '', prSplit: !!r.pr_split, category: r.category || '' })),
    active: active ? active.url : null,
  };
}
const _insertTab = db.prepare(
  `INSERT INTO tabs (url, kind, title, repo, branch, pr_split, category, position, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
function setTabs(tabs = [], active = null) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM tabs');
    tabs.forEach((t, i) => {
      if (!t || !t.url) return;
      _insertTab.run(t.url, t.kind === 'jira' ? 'jira' : 'github', t.title || t.url,
        t.repo || '', t.branch || '', t.prSplit ? 1 : 0, t.category || '', i, active && t.url === active ? 1 : 0);
    });
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

// ── Settings (UI k/v — theme, ticket filter prefs) ───────────────────────────────
const getSetting = key => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : null; };
const setSetting = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value == null ? null : String(value));
const getAllSettings = () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));

module.exports = {
  dbPath,
  configGet, configSet, configAll,
  getProjects, getProject, addProject, updateProject, deleteProject, projectForRepo, getAllRepos,
  getLinks, getLinksByPR, addLink, removeLink,
  addEvent, getEvents,
  getTabs, setTabs,
  getSetting, setSetting, getAllSettings,
};
