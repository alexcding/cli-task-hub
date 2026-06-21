// ── taskhub.db — the app's durable database (SQLite via Node's built-in node:sqlite) ──
// Single source of truth for everything the app owns and must keep across restarts:
//   • projects / links / events / config — domain data (was taskhub.json)
//   • tabs / settings                     — UI prefs (open viewer tabs, theme, filters)
//   • review_state                        — per-PR review-request tracking
// The volatile CLI cache (PR + Jira snapshots) lives separately in data.db (src/server/database/datadb.js),
// so it can be wiped/rebuilt without touching anything here.
//
// node:sqlite is bundled with Node 22+ / Electron 24+ (the packaged app runs under
// Electron's Node), so there's no native dependency to rebuild. Data volumes are tiny,
// but rows give us per-record atomic writes (vs. rewriting a whole JSON file) and real
// relations for projects↔links.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { dataDir } = require('./datadir');
const datadb = require('./datadb'); // cache store — deleteProject cascades into it

const dbPath = path.join(dataDir, 'taskhub.db');

// One-time rename of the legacy filename (config.db → taskhub.db). Done on the raw files
// before opening, so an existing install keeps its projects/tabs/settings. Move the WAL/
// SHM/journal sidecars too if present, so no half-checkpointed state is left behind. Only
// runs when the new file doesn't exist yet; best-effort — a failure just opens fresh.
try {
  if (!fs.existsSync(dbPath) && fs.existsSync(path.join(dataDir, 'config.db'))) {
    for (const ext of ['', '-wal', '-shm', '-journal']) {
      const from = path.join(dataDir, `config.db${ext}`);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dataDir, `taskhub.db${ext}`));
    }
  }
} catch (err) {
  console.error('[db] config.db → taskhub.db rename skipped:', err.message);
}

const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS config   (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS projects (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL DEFAULT '',
    repo             TEXT NOT NULL DEFAULT '',
    workspace        TEXT NOT NULL DEFAULT '',
    jira_project_key TEXT NOT NULL DEFAULT '',
    jql              TEXT NOT NULL DEFAULT '',
    merge_transition TEXT NOT NULL DEFAULT '',
    forward_webhooks INTEGER NOT NULL DEFAULT 1,
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
    url       TEXT PRIMARY KEY,
    kind      TEXT NOT NULL,
    title     TEXT,
    repo      TEXT,
    branch    TEXT,
    pr_split  INTEGER NOT NULL DEFAULT 0,
    pane_view TEXT NOT NULL DEFAULT 'term',
    category  TEXT NOT NULL DEFAULT '',
    login     TEXT NOT NULL DEFAULT '',
    avatar    TEXT NOT NULL DEFAULT '',
    position  INTEGER NOT NULL DEFAULT 0,
    active    INTEGER NOT NULL DEFAULT 0
  );
  -- Per-PR review-request tracking, keyed "repo#number". requested_at is the latest
  -- time GitHub requested MY review (from the PR timeline); viewed_at is when I opened
  -- it from the tray's "Review requested" list. The list shows a PR while
  -- requested_at > viewed_at, so a click hides it durably (survives restarts) and a
  -- genuine re-request (newer requested_at) re-surfaces it. Source of truth, so it
  -- lives in taskhub.db, not the regenerable cache.
  CREATE TABLE IF NOT EXISTS review_state (
    key          TEXT PRIMARY KEY,
    requested_at TEXT,
    viewed_at    TEXT
  );
`);

// Columns added after a table first shipped — idempotent (throws "duplicate column"
// on DBs that already have them, which we ignore). Keeps existing installs in sync.
for (const stmt of [
  `ALTER TABLE tabs ADD COLUMN category TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE tabs ADD COLUMN pane_view TEXT NOT NULL DEFAULT 'term'`,
  `ALTER TABLE tabs ADD COLUMN login TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE tabs ADD COLUMN avatar TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE projects ADD COLUMN forward_webhooks INTEGER NOT NULL DEFAULT 1`,
  // On-merge "set Fix Version" automation (gated by fix_version_enabled): a platform prefix
  // (e.g. "ios-") + a JS script that returns the number part ("0.0.0"); the final version is
  // prefix+number. The Jira API token to write it is a global config key, not per-project.
  `ALTER TABLE projects ADD COLUMN fix_version_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE projects ADD COLUMN fix_version_prefix TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE projects ADD COLUMN fix_version_script TEXT NOT NULL DEFAULT ''`,
  // Per-project automation recipes: a JSON array of { id, name, cli, commands[] }. The Workflow
  // button on a ticket/PR opens its worktree, launches the CLI, and types each command in turn.
  `ALTER TABLE projects ADD COLUMN workflows TEXT NOT NULL DEFAULT ''`,
  // Project color was dropped — projects show an icon, not a swatch. Drop the column
  // from installs that still have it (throws "no such column" on fresh DBs, ignored).
  `ALTER TABLE projects DROP COLUMN color`,
]) { try { db.exec(stmt); } catch { /* column already exists / already gone */ } }

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// ── Config (backend k/v: poll_interval, JQL overrides, jira_base_url, …) ─────────
const configGet = key => { const r = db.prepare('SELECT value FROM config WHERE key = ?').get(key); return r ? r.value : null; };
const configSet = (key, val) => db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(val));
const configAll = () => Object.fromEntries(db.prepare('SELECT key, value FROM config').all().map(r => [r.key, r.value]));

// ── Projects ──────────────────────────────────────────────────────────────────
// Object shape (camelCase) matches the old JSON store; columns are snake_case.
const PROJECT_FIELDS = ['name', 'repo', 'workspace', 'jiraProjectKey', 'jql', 'mergeTransition', 'forwardWebhooks', 'fixVersionEnabled', 'fixVersionPrefix', 'fixVersionScript', 'workflows'];
const COL = { name: 'name', repo: 'repo', workspace: 'workspace', jiraProjectKey: 'jira_project_key', jql: 'jql', mergeTransition: 'merge_transition', forwardWebhooks: 'forward_webhooks', fixVersionEnabled: 'fix_version_enabled', fixVersionPrefix: 'fix_version_prefix', fixVersionScript: 'fix_version_script', workflows: 'workflows' };
// Fields stored as 0/1 INTEGER (SQLite has no bool type). One place to coerce on write.
const BOOL_FIELDS = new Set(['forwardWebhooks', 'fixVersionEnabled']);
// Fields stored as a JSON-encoded TEXT column (objects/arrays). Encoded on write, parsed on read.
const JSON_FIELDS = new Set(['workflows']);
const toColValue = (field, value) =>
  JSON_FIELDS.has(field) ? JSON.stringify(value == null ? [] : value)
    : BOOL_FIELDS.has(field) ? (value ? 1 : 0)
      : value;
const _safeJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const _project = r => r && {
  id: r.id, name: r.name, repo: r.repo, workspace: r.workspace,
  jiraProjectKey: r.jira_project_key, jql: r.jql, mergeTransition: r.merge_transition,
  forwardWebhooks: !!r.forward_webhooks, created_at: r.created_at,
  fixVersionEnabled: !!r.fix_version_enabled, fixVersionPrefix: r.fix_version_prefix || '', fixVersionScript: r.fix_version_script || '',
  workflows: _safeJson(r.workflows, []),
};

const getProjects = () => db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all().map(_project);
const getProject  = id => _project(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));

const addProject = (fields = {}) => {
  const p = {
    id: uuid(), name: fields.name || '',
    repo: fields.repo || '', workspace: fields.workspace || '',
    jiraProjectKey: fields.jiraProjectKey || '', jql: fields.jql || '',
    mergeTransition: fields.mergeTransition || '',
    forwardWebhooks: fields.forwardWebhooks === undefined ? true : !!fields.forwardWebhooks,
    fixVersionEnabled: !!fields.fixVersionEnabled,
    fixVersionPrefix: fields.fixVersionPrefix || '', fixVersionScript: fields.fixVersionScript || '',
    created_at: fields.created_at || now(),
  };
  db.prepare(`INSERT INTO projects (id, name, repo, workspace, jira_project_key, jql, merge_transition, forward_webhooks,
                                    fix_version_enabled, fix_version_prefix, fix_version_script, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.id, p.name, p.repo, p.workspace, p.jiraProjectKey, p.jql, p.mergeTransition,
         toColValue('forwardWebhooks', p.forwardWebhooks),
         toColValue('fixVersionEnabled', p.fixVersionEnabled), p.fixVersionPrefix, p.fixVersionScript,
         p.created_at);
  return p;
};

const updateProject = (id, patch = {}) => {
  if (!getProject(id)) return null;
  const sets = [], vals = [];
  for (const f of PROJECT_FIELDS) if (patch[f] !== undefined) {
    sets.push(`${COL[f]} = ?`);
    vals.push(toColValue(f, patch[f]));
  }
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
// Repos to run `gh webhook forward` for — only projects with forwarding enabled.
const getForwardedRepos = () => db.prepare("SELECT DISTINCT repo FROM projects WHERE repo <> '' AND forward_webhooks = 1").all().map(r => r.repo);

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
    tabs: rows.map(r => ({ kind: r.kind, title: r.title, url: r.url, repo: r.repo || '', branch: r.branch || '', prSplit: !!r.pr_split, paneView: r.pane_view || 'term', category: r.category || '', login: r.login || '', avatar: r.avatar || '' })),
    active: active ? active.url : null,
  };
}
const _insertTab = db.prepare(
  `INSERT INTO tabs (url, kind, title, repo, branch, pr_split, pane_view, category, login, avatar, position, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
function setTabs(tabs = [], active = null) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM tabs');
    tabs.forEach((t, i) => {
      if (!t || !t.url) return;
      _insertTab.run(t.url, t.kind === 'jira' ? 'jira' : 'github', t.title || t.url,
        t.repo || '', t.branch || '', t.prSplit ? 1 : 0, t.paneView === 'diff' ? 'diff' : 'term',
        t.category || '', t.login || '', t.avatar || '', i, active && t.url === active ? 1 : 0);
    });
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

// ── Review state (per-PR review-request tracking — see the review_state table) ────
const getReviewState = key => db.prepare('SELECT requested_at, viewed_at FROM review_state WHERE key = ?').get(key) || null;
// Record the latest time my review was requested. Preserves viewed_at; only writes
// when the timestamp actually advances, so a no-op poll never churns the row.
const setReviewRequestedAt = (key, ts) => db.prepare(
  `INSERT INTO review_state (key, requested_at) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET requested_at = excluded.requested_at
   WHERE review_state.requested_at IS NULL OR review_state.requested_at < excluded.requested_at`
).run(key, ts);
// Record that I opened this PR from the tray (acknowledges the current request).
const setReviewViewed = (key, ts) => db.prepare(
  `INSERT INTO review_state (key, viewed_at) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET viewed_at = excluded.viewed_at`
).run(key, ts);
// Drop rows for PRs no longer open in a repo (merged/closed) so the table stays bounded.
// `openNumbers` is the current open-PR number list for `repo`.
const pruneReviewStateForRepo = (repo, openNumbers) => {
  const keep = new Set(openNumbers.map(n => `${repo}#${n}`));
  for (const r of db.prepare('SELECT key FROM review_state WHERE key LIKE ?').all(`${repo}#%`)) {
    if (!keep.has(r.key)) db.prepare('DELETE FROM review_state WHERE key = ?').run(r.key);
  }
};

// ── Settings (UI k/v — theme, ticket filter prefs) ───────────────────────────────
const getSetting = key => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : null; };
const setSetting = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value == null ? null : String(value));
const getAllSettings = () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));

module.exports = {
  dbPath,
  configGet, configSet, configAll,
  getProjects, getProject, addProject, updateProject, deleteProject, projectForRepo, getForwardedRepos,
  getLinks, getLinksByPR, addLink, removeLink,
  addEvent, getEvents,
  getTabs, setTabs,
  getReviewState, setReviewRequestedAt, setReviewViewed, pruneReviewStateForRepo,
  getSetting, setSetting, getAllSettings,
};
