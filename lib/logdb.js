// ── logs.db — structured, queryable in-app log (SQLite via node:sqlite) ──────────
// A single `logs` table with a `category` column is the source for the in-app log
// viewer. The user-facing activity feed is just category='event'; diagnostic streams
// (webhook forwarder, poller, …) use their own categories, and any entry can be
// level='error' to surface failures. This is distinct from the file logs (electron-log,
// lib/logger.js): those are the raw firehose for grepping; this is the curated, filtered
// view shown in the UI. It's a rolling log (capped), regenerable, and safe to wipe —
// hence its own DB file rather than living in the durable config.db.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { dataDir } = require('./datadir');

const dbPath = path.join(dataDir, 'logs.db');
const db = new DatabaseSync(dbPath);
try { db.exec('PRAGMA journal_mode = WAL;'); } catch { /* fine without WAL */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL DEFAULT 'event',  -- 'event' | 'webhook' | 'poller' | 'jira' | …
    level      TEXT NOT NULL DEFAULT 'info',   -- 'info' | 'warn' | 'error'
    type       TEXT,                           -- machine tag, e.g. 'pr_merged', 'forwarder_restart'
    payload    TEXT,                           -- JSON blob (or plain string)
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category, seq);
  CREATE INDEX IF NOT EXISTS idx_logs_level    ON logs(level, seq);
`);

const now = () => new Date().toISOString();
const MAX_ROWS = 5000; // rolling cap across all categories

const addLog = ({ category = 'event', level = 'info', type = '', payload = null, created_at } = {}) => {
  const body = payload == null ? null : (typeof payload === 'string' ? payload : JSON.stringify(payload));
  db.prepare('INSERT INTO logs (category, level, type, payload, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(category, level, type, body, created_at || now());
  // Trim oldest rows beyond the cap so the file never grows unbounded.
  db.prepare('DELETE FROM logs WHERE seq <= (SELECT MAX(seq) FROM logs) - ?').run(MAX_ROWS);
};

// Run fn inside a transaction: everything it writes commits together, or rolls back as a
// unit if it throws. The events→logs migration uses this so a mid-copy failure leaves no
// partial rows for the next run to duplicate.
const transaction = (fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (err) { try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ } throw err; }
};

const getLogs = ({ category, level, limit = 200 } = {}) => {
  const where = [], vals = [];
  if (category && category !== 'all') { where.push('category = ?'); vals.push(category); }
  if (level) { where.push('level = ?'); vals.push(level); }
  const sql = `SELECT seq, category, level, type, payload, created_at FROM logs
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY seq DESC LIMIT ?`;
  return db.prepare(sql).all(...vals, Math.max(1, Math.min(2000, limit)));
};

const categories = () => db.prepare('SELECT DISTINCT category FROM logs ORDER BY category').all().map(r => r.category);
const clearLogs = (category) => (category && category !== 'all')
  ? db.prepare('DELETE FROM logs WHERE category = ?').run(category)
  : db.prepare('DELETE FROM logs').run();
const count = () => db.prepare('SELECT COUNT(*) AS c FROM logs').get().c;

module.exports = { dbPath, addLog, transaction, getLogs, categories, clearLogs, count };
