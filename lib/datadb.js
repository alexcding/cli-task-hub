// ── data.db — CLI result cache (SQLite via Node's built-in node:sqlite) ─────────
// Holds the snapshots the sync loop builds from the CLIs: GitHub PRs (via `gh`) and
// Jira tickets (via `acli`). This is VOLATILE cache — the poller rebuilds it from the
// CLIs every cycle, and the UI reads it stale-while-revalidate. Source of truth stays
// remote (GitHub/Jira); deleting data.db just costs one refetch.
//
// The flow is unchanged by moving off JSON files: read cache → if stale, call CLI →
// write here → return/publish. We only swap the storage backend behind db.getSnapshot/
// setSnapshot/… so server.js and lib/poller.js need no changes.
//
// Snapshots are keyed by id (project UUID, or '@me'/'@sprint' for the global Jira
// feeds) and queried only by id — never filtered — so the lean PR/ticket arrays are
// stored as a JSON column rather than normalized into rows. SQLite buys us per-key
// atomic upserts (no whole-file rewrite like the old sidecar JSON) and one tidy file.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { dataDir } = require('./datadir');

const dbPath = path.join(dataDir, 'data.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS pr_snapshots (
    id          TEXT PRIMARY KEY,
    prs         TEXT NOT NULL DEFAULT '[]',  -- JSON array of lean PRs
    last_synced TEXT,
    error       TEXT
  );
  CREATE TABLE IF NOT EXISTS jira_snapshots (
    id          TEXT PRIMARY KEY,
    items       TEXT NOT NULL DEFAULT '[]',  -- JSON array of lean tickets
    jql         TEXT,
    last_synced TEXT,
    error       TEXT
  );
`);

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// ── PR snapshots ────────────────────────────────────────────────────────────────
// Shape returned matches the old JSON store exactly: { prs, lastSynced, error }.
const _prRow = r => r ? { prs: parse(r.prs, []), lastSynced: r.last_synced, error: r.error } : null;

function getSnapshot(id) {
  return _prRow(db.prepare('SELECT * FROM pr_snapshots WHERE id = ?').get(id));
}
function getAllSnapshots() {
  const out = {};
  for (const r of db.prepare('SELECT * FROM pr_snapshots').all()) out[r.id] = _prRow(r);
  return out;
}
function setSnapshot(id, snap = {}) {
  db.prepare(
    `INSERT INTO pr_snapshots (id, prs, last_synced, error) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET prs = excluded.prs, last_synced = excluded.last_synced, error = excluded.error`
  ).run(id, JSON.stringify(snap.prs || []), snap.lastSynced || null, snap.error || null);
}
function deleteSnapshot(id) {
  db.prepare('DELETE FROM pr_snapshots WHERE id = ?').run(id);
}

// ── Jira snapshots ──────────────────────────────────────────────────────────────
// Shape returned matches the old JSON store exactly: { items, jql, lastSynced, error }.
const _jiraRow = r => r ? { items: parse(r.items, []), jql: r.jql || '', lastSynced: r.last_synced, error: r.error } : null;

function getJiraSnapshot(id) {
  return _jiraRow(db.prepare('SELECT * FROM jira_snapshots WHERE id = ?').get(id));
}
function getAllJiraSnapshots() {
  const out = {};
  for (const r of db.prepare('SELECT * FROM jira_snapshots').all()) out[r.id] = _jiraRow(r);
  return out;
}
function setJiraSnapshot(id, snap = {}) {
  db.prepare(
    `INSERT INTO jira_snapshots (id, items, jql, last_synced, error) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET items = excluded.items, jql = excluded.jql, last_synced = excluded.last_synced, error = excluded.error`
  ).run(id, JSON.stringify(snap.items || []), snap.jql || '', snap.lastSynced || null, snap.error || null);
}
function deleteJiraSnapshot(id) {
  db.prepare('DELETE FROM jira_snapshots WHERE id = ?').run(id);
}

module.exports = {
  dbPath,
  getSnapshot, getAllSnapshots, setSnapshot, deleteSnapshot,
  getJiraSnapshot, getAllJiraSnapshots, setJiraSnapshot, deleteJiraSnapshot,
};
