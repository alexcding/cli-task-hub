// ── config.db — durable user/UI state (SQLite via Node's built-in node:sqlite) ──
// Distinct from lib/db.js (JSON config + volatile PR/Jira snapshot caches): this holds
// state the *user* sets and expects to survive restarts — open viewer tabs, theme, and
// any future small settings. node:sqlite is bundled with Node 22+ / Electron 24+ (the
// packaged app runs under Electron's Node), so there's no native dependency to rebuild.
//
// Tabs live as ROWS (not a serialized blob): the previous localStorage model overwrote
// the whole list on every change, which let a single tab opened from the tray clobber
// the rest. A table sidesteps that and lets us query/extend later.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { dataDir } = require('./datadir');

const dbPath = path.join(dataDir, 'config.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS tabs (
    url      TEXT PRIMARY KEY,
    kind     TEXT NOT NULL,
    title    TEXT,
    repo     TEXT,
    branch   TEXT,
    pr_split INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    active   INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ── Tabs ──────────────────────────────────────────────────────────────────────
// Returned in the same shape the renderer persisted: a position-ordered list plus the
// url of the active tab (null if none).
function getTabs() {
  const rows = db.prepare('SELECT * FROM tabs ORDER BY position ASC').all();
  const active = rows.find(r => r.active);
  return {
    tabs: rows.map(r => ({
      kind:    r.kind,
      title:   r.title,
      url:     r.url,
      repo:    r.repo || '',
      branch:  r.branch || '',
      prSplit: !!r.pr_split,
    })),
    active: active ? active.url : null,
  };
}

const _insertTab = db.prepare(
  `INSERT INTO tabs (url, kind, title, repo, branch, pr_split, position, active)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

// Replace the whole tab set in one transaction. `position` is the array index, so the
// sidebar order is preserved on reload; `active` flags the one open tab.
function setTabs(tabs = [], active = null) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM tabs');
    tabs.forEach((t, i) => {
      if (!t || !t.url) return;
      _insertTab.run(
        t.url,
        t.kind === 'jira' ? 'jira' : 'github',
        t.title || t.url,
        t.repo || '',
        t.branch || '',
        t.prSplit ? 1 : 0,
        i,
        active && t.url === active ? 1 : 0
      );
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── Settings (key/value — theme today, room for more) ───────────────────────────
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value == null ? null : String(value));
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

module.exports = {
  dbPath,
  getTabs, setTabs,
  getSetting, setSetting, getAllSettings,
};
